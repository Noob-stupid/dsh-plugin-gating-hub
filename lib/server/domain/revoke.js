// L1 · domain —— revoke.js（按安装任务撤销「已安装但尚未生效」的安装）
//
// 动机（2026-09-20 真装真卸演练实测）：面板装完插件后 /install 返回 entryId: null，
// 对比安装前后的 GET /state，**新增 loader 条目 = 0**（bundle 型插件要重启才被加载，
// 重启后条目才出现，如 include:dsh-whale-widget）；而 POST /uninstall 过去只按「运行中」
// loader 条目查找，找不到就 404「没有名为 X 的插件条目」——于是**刚装错的插件在重启前
// 无法从面板卸载**，用户只能手改 patch + package.json + 删 node_modules 才能撤回。
//
// 安装任务（lib/server/state.js 的 installJobs）里其实记着撤销所需的全部信息：
//   · job.packageName（install-job.js:294）
//   · job.bundle（install-job.js:341，注册进 <profile>/package.json 的 dsh.profile.bundles）
//   · job.entryId（install-job.js:356-357 deriveEntryId + appendInsert 追加的补丁行）
// 本模块据此撤销：删补丁行 → 退 bundles 清单 → 移除包目录 → 逐项回读核实。
//
// ★ 回读核实是硬要求：删除类操作在本机某些环境下会**静默落空**（不抛错、目录仍在，见
//   infra/fsx.js removeDirVerified 的注释）。删完直接报成功就是对用户撒谎，所以三个子项
//   都要在动作之后回读判定，并把结果如实交给调用方（verified / warn）。
//
// 分层：本模块只接收路径与已注入的 pnpmRemove（形参名 ports/无 ctx），不认识 cordis ctx。

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { removeBundleFromManifest } from './install.js'
import { parseInsertNames, readPatchState, removeDisableBlock, removeInsertRow } from './patch.js'
import { packageNameOf } from '../infra/paths.js'

/** profile 内 node_modules/<pkg> 的目录（作用域包按 / 分段，与 pnpm 布局一致）。 */
function packageDirIn(profileDir, packageName) {
  const name = String(packageName)
  const segments = name.startsWith('@') ? name.split('/') : [name]
  return join(profileDir, 'node_modules', ...segments)
}

/** profile 的 package.json 是否还把这个包当依赖（pnpm add 会写进 dependencies）。 */
async function manifestRefsPackage(profileDir, packageName) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .some((key) => manifest?.[key] !== null && typeof manifest?.[key] === 'object'
        && Object.prototype.hasOwnProperty.call(manifest[key], packageName))
  } catch {
    return false
  }
}

/**
 * 这个包是否还需要一次 pnpm remove：目录还在盘上，或 manifest 还引用它（pnpm add 会写 dependencies）。
 * 两者都不成立时拉 pnpm 只会得到一句没有信息量的 "Command failed: corepack pnpm remove …"（本机演练实测）
 * —— 但 manifest 仍引用时必须跑，否则 package.json 会留下指向空目录的幽灵依赖。
 */
async function needsPnpmRemove(profileDir, packageName) {
  return existsSync(packageDirIn(profileDir, packageName)) || await manifestRefsPackage(profileDir, packageName)
}

/**
 * bundle 包自带 patch（node_modules/<pkg>/cordis.patch.yml）里**归属该包**的 insert 行 id。
 * 为什么要它：这类行由 bundle 的补丁在下次启动时组合进树，profile 补丁里不会有 insert 块，
 * 但可能留着它们的 `- id: X` + `disabled: true` 覆盖块（聚合包完整性检查自动禁用 / 用户手动停用）。
 * 只认模块名等于该包或它的子路径的行 —— 聚合包补丁里常引用**别人家**的包（如 @deepseek-ai/dsh-root），
 * 那些行的覆盖块不属于本次撤销，动了就是越界。
 */
async function bundleOwnRowIds(profileDir, packageName) {
  const ids = new Set()
  try {
    const text = await readFile(join(packageDirIn(profileDir, packageName), 'cordis.patch.yml'), 'utf8')
    for (const [rowId, moduleName] of parseInsertNames(text)) {
      if (moduleName === packageName || String(moduleName).startsWith(`${packageName}/`)) ids.add(rowId)
    }
  } catch {}
  return ids
}

/**
 * 撤销一个「已安装但未生效」的安装任务。三个子项各自 try/catch，成败如实汇报；本函数不抛错。
 * 返回 { packageName, bundle, rowIds, verified: { patchClean, bundlesClean, packageGone }, warn, uninstallError }
 */
async function revokePendingInstall(job, { profileDir, patchPath, pnpmRemove }) {
  const packageName = typeof job?.packageName === 'string' ? job.packageName.trim() : ''
  const isBundle = job?.bundle === true
  // 兜底（路由已先拦）：没有包名就什么都别碰 —— 靠 entryId 单点删除可能误伤别的包
  if (packageName === '') {
    return {
      packageName, bundle: isBundle, rowIds: [],
      verified: { patchClean: false, bundlesClean: false, packageGone: false },
      warn: '该安装任务没有记录包名，未执行任何删除（补丁行 / bundles 清单 / 包目录都未处理）',
      uninstallError: null,
    }
  }
  // ── a) 补丁行：删掉这次安装注册的 insert 行 + 它的 disabled/forced 覆盖块 ──────────
  const rowIds = new Set()
  let patchClean = false
  let patchProblem = null
  try {
    const before = await readPatchState(patchPath)
    const declared = parseInsertNames(before.text) // insert 行 id → 模块名
    if (typeof job?.entryId === 'string' && job.entryId !== '') {
      const owner = declared.get(job.entryId)
      // 补丁里这一行若明确属于**别的包**，绝不按 entryId 删（归属判定以补丁文本为准）
      if (owner === undefined || owner === packageName) rowIds.add(job.entryId)
    }
    for (const [rowId, moduleName] of declared) if (moduleName === packageName) rowIds.add(rowId)
    for (const rowId of await bundleOwnRowIds(profileDir, packageName)) rowIds.add(rowId)
    for (const rowId of rowIds) {
      if (before.inserts.includes(rowId)) await removeInsertRow(patchPath, rowId)
      await removeDisableBlock(patchPath, rowId)
    }
    // 回读核实：目标行（insert / disabled / forced）都不在了，补丁文本也不该再出现这个包名
    const after = await readPatchState(patchPath)
    const leakedRows = [...rowIds].filter((id) => after.inserts.includes(id) || after.disables.includes(id) || after.forced.includes(id))
    const leakedNames = [...parseInsertNames(after.text).values()].filter((name) => name === packageName)
    patchClean = leakedRows.length === 0 && leakedNames.length === 0 && !String(after.text ?? '').includes(packageName)
    if (!patchClean) patchProblem = `仍有残留行 ${[...new Set([...leakedRows, ...leakedNames])].join('、') || packageName}`
  } catch (error) {
    patchProblem = error instanceof Error ? error.message : String(error)
  }
  // ── b) bundles 清单：只删这一个包名（保留顺序、保留其余项）──────────────────────
  let bundlesClean = !isBundle
  let bundlesProblem = null
  if (isBundle) {
    try {
      await removeBundleFromManifest(profileDir, packageName)
      const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      bundlesClean = !(manifest?.dsh?.profile?.bundles ?? []).includes(packageName)
      if (!bundlesClean) bundlesProblem = `dsh.profile.bundles 里仍有 ${packageName}`
    } catch (error) {
      bundlesProblem = error instanceof Error ? error.message : String(error)
    }
  }
  // ── c) 包目录：pnpm remove（与安装同一管理器）──────────────────────────────────
  const packageDir = packageDirIn(profileDir, packageName)
  let uninstallError = null
  if (await needsPnpmRemove(profileDir, packageName)) {
    try {
      await pnpmRemove(profileDir, packageName)
    } catch (error) {
      uninstallError = error instanceof Error ? error.message : String(error)
    }
  }
  const packageGone = !existsSync(packageDir)
  // ── d) 核实汇总：任一子项没清干净 → ok 仍为 true，但必须带 warn 说清是哪项、路径在哪 ──
  const verified = { patchClean, bundlesClean, packageGone }
  const problems = []
  if (!patchClean) problems.push(`补丁未清干净（${patchPath}）：${patchProblem ?? '仍有残留行'}`)
  if (!bundlesClean) problems.push(`bundles 清单未清干净（${join(profileDir, 'package.json')}）：${bundlesProblem ?? `仍有 ${packageName}`}`)
  if (!packageGone) problems.push(`包目录仍在（${packageDir}）${uninstallError !== null ? `，pnpm remove 失败：${uninstallError}` : ''}`)
  const warn = problems.length > 0 ? `撤销未完全生效 —— ${problems.join('；')}；请手动处理后重试` : null
  return { packageName, bundle: isBundle, rowIds: [...rowIds], verified, warn, uninstallError }
}

/**
 * 「已安装 · 重启后生效」清单：status === 'done'、未撤销、有包名，且该包**不在**运行中的
 * loader 条目里。bundle 型插件要重启才被加载（演练实测：装完新增 loader 条目 = 0），
 * 前端据此把这类任务渲染成带待重启徽标的行，并允许按 jobId 撤销。
 * entries 传 listEntries(ports) 的结果（含子路径条目 → 归一到根包名再比）。
 */
function pendingRestartJobs(jobs, entries) {
  const running = new Set()
  for (const entry of entries ?? []) {
    const moduleName = entry?.moduleName
    if (typeof moduleName !== 'string' || moduleName === '' || moduleName.startsWith('cordis:')) continue
    running.add(moduleName)
    const root = packageNameOf(moduleName)
    if (typeof root === 'string' && root !== '') running.add(root)
  }
  // 同一包名的多次安装/更新（安装表里会有多条 done 记录）只留最后一次：
  // 否则一个插件在面板上会出现好几行「已安装·重启后生效」。
  const latest = new Map()
  for (const job of jobs ?? []) {
    if (job?.status !== 'done' || job.revokedAt !== undefined) continue
    if (typeof job.packageName !== 'string' || job.packageName.trim() === '') continue
    if (running.has(job.packageName)) continue
    latest.set(job.packageName, job)
  }
  return [...latest.values()].map((job) => ({
    jobId: job.id,
    repo: job.repo ?? null,
    packageName: job.packageName,
    bundle: job.bundle === true,
    finishedAt: job.finishedAt ?? null,
  }))
}

export { revokePendingInstall, pendingRestartJobs, packageDirIn, needsPnpmRemove }
