// L1 · domain —— link-self-sufficiency.js（`link:` 依赖的**自足性**）
//
// 为什么需要它（2026-10-05/06 真机现场，ds-h-opencode-go 实测）：
//   `link:` 只把**一个目录**挂进 profile —— pnpm 建完那条链接就结束了。可一个插件要能被
//   `import` 起来，还差两样东西，而这两样**没有任何人负责**：
//     ① 目标目录自己的 `dependencies`（插件通常不发 node_modules，作者的开发目录里才有）；
//     ② 它声明过的**框架 peer**（`@deepseek-ai/*`）——目标目录在 profile 树**之外**时，
//        Node 的解析链走不到 profile 的 node_modules，`import` 当场 `ERR_MODULE_NOT_FOUND`。
//   真机症状就是"面板报安装成功、插件却一直是 [no-fiber]"：包在、链接在、就是加载不起来。
//   现场实测（插件目录 = D:\…\plugin-src\dsh-opencode-go）：
//     修前 `import()` 失败于 `Cannot find package 'opencode-go-pi-ai'`
//     （而 `opencode-go-pi-ai` 的实体**早就装好**在 `.pnpm` 里，只是顶层链接被 pnpm 挪进了
//      `node_modules/.ignored` —— 所以"补齐"必须包含"把已有实体接回可达位置"）。
//
// 三条硬规矩（本模块是它们的唯一承担者，别在别处再写一份判据）：
//   ① **只补缺的**：目标存在/可解析 ⇒ 一个字节都不写（幂等；自足插件是 no-op）。
//   ② **绝不覆盖**：目标位置上**已经有任何东西**（含悬空链接）就跳过并如实记 skipped。
//   ③ **绝不因此拒绝安装**：任何失败都返回 `{ ready:false, note, action }` 并让安装继续 ——
//      插件装上了但没就绪，是"如实报未就绪 + 给动作"，不是"安装失败"。
//
// 垫片根的形状沿用生态既有约定（与 `docs/http-endpoints` 之外的现场一致）：
//   `<目标目录>/node_modules/@deepseek-ai/<包>`  →  `<DSH_HOME>/profiles/node_modules/@deepseek-ai/<包>`
// 为什么必须**链接**而不是复制：Cordis service 类 / LLM error 类等靠**模块身份**相认
// （`instanceof` / 单例注册表）；复制一份就是第二个类对象，宿主与插件会互相不认。
// 链接指向的是同一份真实文件 ⇒ realpath 相同 ⇒ 身份共享（真机已验：
// `realpath(插件侧) === realpath(profiles/node_modules 侧)`）。
//
// 记录的用途：垫片是**我们造的**，卸载时必须只清掉**我们造的**这些（`removeLinkSelfSufficiency`），
// 记在 `<DSH_HOME>/plugin-console/link-self-sufficiency/<包名>.json`，删除前逐个核对
// "它现在仍是指向当初那个目标的链接"——被人改过/换过的东西一律不碰。

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildPnpmEnv, runPnpmWithFallback, unknownPnpmOption } from '../infra/exec.js'
import { dshHome } from '../infra/paths.js'
import { canonicalSourceSpec, sourceSpecTarget, suggestedPinAction } from './dep-source.js'

/** 框架包的 scope：垫片只补这一族（peer 声明里也只有它需要"框架根"这一层）。 */
const FRAMEWORK_SCOPE = '@deepseek-ai'

/** 垫片根（框架安装时建立的、profile 共用的解析根）：`<DSH_HOME>/profiles/node_modules/@deepseek-ai`。 */
function frameworkShimRoot(home) {
  return join(home, 'profiles', 'node_modules', FRAMEWORK_SCOPE)
}

/** 记录目录/记录文件（一个包一份，便于卸载时精确定位）。 */
function selfSufficiencyRecordDir(home) {
  return join(home, 'plugin-console', 'link-self-sufficiency')
}
function recordFileNameOf(packageName) {
  return `${String(packageName).replace(/[^A-Za-z0-9._-]+/gu, '_')}.json`
}
function selfSufficiencyRecordPath(home, packageName) {
  return join(selfSufficiencyRecordDir(home), recordFileNameOf(packageName))
}

/** 读 JSON（读不到/坏文件都返回 null，绝不抛）。 */
function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 路径上**是否已经有东西**（含悬空链接）——"绝不覆盖"的判据必须用 lstat，不能用 exists。 */
function pathTaken(p) {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 从 `startDir` 起按 Node 的规矩向上找 `node_modules/<包名>`（最多 12 层）。
 * 为什么向上走而不是只看目标目录：目标目录若本身位于某个 profile 之内，
 * 祖先链上的 node_modules **本来就能被 Node 解析到** —— 那时再补垫片就是多余写盘（违反规矩①）。
 */
function resolveFromDir(startDir, packageName, depth = 12) {
  let current = startDir
  for (let i = 0; i < depth; i += 1) {
    const candidate = join(current, 'node_modules', ...String(packageName).split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** 读 profile 清单里该包的 spec（读不到返回 null）。 */
function manifestSpecOf(profileDir, packageName) {
  const manifest = readJsonSafe(join(profileDir, 'package.json'))
  const spec = manifest?.dependencies?.[packageName]
  return typeof spec === 'string' && spec !== '' ? spec : null
}

/** 是否路径型来源（`link:` / `file:`）——只有这一族才有"目标目录"可补齐。 */
function isPathSpec(spec) {
  const canonical = canonicalSourceSpec(spec)
  return typeof canonical === 'string' && /^(?:link:|file:)/u.test(canonical)
}

/**
 * 只读判据：这个 `link:` 依赖当前**自足**吗？缺什么？能不能补？
 * 纯读盘、零写盘、不联网 —— 调用方拿它决定要不要动手（以及向用户怎么如实汇报）。
 * 返回 `{ applies, ready, target, targetExists, declaredDeps, declaredPeers, missingDeps,
 *          missingPeers, shimmablePeers, unavailablePeers, note, action }`。
 */
function planLinkSelfSufficiency({ profileDir, packageName, spec = null, home = null } = {}) {
  const base = {
    applies: false, ready: true, profileDir, packageName, spec: null, target: null, targetExists: false,
    declaredDeps: [], declaredPeers: [], missingDeps: [], missingPeers: [], shimmablePeers: [], unavailablePeers: [], foreignPeers: [],
    note: null, action: null,
  }
  const homeDir = typeof home === 'string' && home !== '' ? home : dshHome()
  const resolvedSpec = typeof spec === 'string' && spec !== '' ? spec : manifestSpecOf(profileDir, packageName)
  if (resolvedSpec === null) return { ...base, reason: `${packageName}：清单里没有该依赖（或 spec 为空）—— 无需补齐` }
  if (!isPathSpec(resolvedSpec)) {
    return { ...base, spec: resolvedSpec, reason: `${packageName}：spec 不是路径型来源（${resolvedSpec}）—— 依赖与 peer 由包管理器保证，无需补齐` }
  }
  const target = sourceSpecTarget(profileDir, resolvedSpec)
  if (target === null) return { ...base, spec: resolvedSpec, reason: `${packageName}：spec（${resolvedSpec}）解析不出目标目录 —— 无需补齐` }
  const pkg = readJsonSafe(join(target, 'package.json'))
  if (pkg === null) {
    return {
      ...base,
      applies: true,
      ready: false,
      spec: resolvedSpec,
      target,
      targetExists: false,
      note: `${packageName}：链接目标 ${target} 里没有 package.json —— 本地目录被移动/删除，或还从未安装过；垫片无从补起（未改动任何东西）`,
      action: suggestedPinAction({ packageName, profileDir }),
    }
  }
  const declaredDeps = Object.keys(pkg.dependencies ?? {})
  const declaredPeers = Object.keys(pkg.peerDependencies ?? {})
  const missingDeps = declaredDeps.filter((name) => resolveFromDir(target, name) === null)
  const missingPeers = declaredPeers.filter((name) => resolveFromDir(target, name) === null)
  const root = frameworkShimRoot(homeDir)
  const shimmablePeers = []
  const unavailablePeers = []
  for (const name of missingPeers) {
    const short = name.startsWith(`${FRAMEWORK_SCOPE}/`) ? name.slice(FRAMEWORK_SCOPE.length + 1) : null
    if (short !== null && existsSync(join(root, short, 'package.json'))) shimmablePeers.push(name)
    else unavailablePeers.push(name)
  }
  // 「能解析」不等于「解析到宿主那一份」：声明过的框架 peer 若解析到**别处**（例如某次 pnpm install
  // 从 registry 自动装进来的一份），模块身份就不共享。这里**只报告、不动手** —— 绝不覆盖是硬规矩。
  const foreignPeers = []
  for (const name of declaredPeers) {
    if (missingPeers.includes(name)) continue
    const short = name.startsWith(`${FRAMEWORK_SCOPE}/`) ? name.slice(FRAMEWORK_SCOPE.length + 1) : null
    if (short === null) continue
    const rootPkg = join(root, short)
    if (!existsSync(join(rootPkg, 'package.json'))) continue
    const found = resolveFromDir(target, name)
    try {
      if (found !== null && realpathSync(found) !== realpathSync(rootPkg)) foreignPeers.push({ name, resolved: found, frameworkRoot: rootPkg })
    } catch {
      foreignPeers.push({ name, resolved: found, frameworkRoot: rootPkg })
    }
  }
  const ready = missingDeps.length === 0 && missingPeers.length === 0
  return {
    ...base,
    applies: true,
    ready,
    spec: resolvedSpec,
    target,
    targetExists: true,
    declaredDeps,
    declaredPeers,
    missingDeps,
    missingPeers,
    shimmablePeers,
    unavailablePeers,
    foreignPeers,
    note: ready
      ? null
      : `${packageName}：链接目标 ${target} 尚不自足 —— 缺依赖 [${missingDeps.join(', ')}]` +
        `${missingPeers.length === 0 ? '' : `、缺框架 peer [${missingPeers.join(', ')}]`}`,
    action: ready ? null : suggestedPinAction({ packageName, profileDir }),
  }
}

/** 在**目标目录内**装它的 dependencies（pnpm install）。失败一律如实返回，绝不抛。
 *
 * ★ 绝不让 pnpm **自动装 peer**（pnpm 8+ 默认 `auto-install-peers=true`）—— 真机实测（2026-10-06）：
 *   夹具声明 `@deepseek-ai/dsh-llm` 为 peer，跑 `pnpm install` 后 pnpm 从 **registry** 装了一份
 *   `0.1.5-rc.3` 进目标目录，而宿主用的是它**自己那一份**（本机框架根 = 0.2.0-rc.2）。
 *   两份不同的模块 ⇒ Cordis service / LLM error 的**类身份不共享** —— 正是"补了反而更糟"。
 *   peer 的正确来源是**框架根垫片**（指向同一份真实文件），所以这里必须把自动装 peer 关掉，
 *   分工才是干净的：**dependencies 交给 pnpm，peer 交给垫片**。
 *   选项不认识（老 pnpm）时退回不带该选项重试一次 —— 与 infra/exec.js#runPnpmAdd 同一条规矩，
 *   绝不让"加固"变成"跑不成"。 */
async function installTargetDependencies({ target, deps = {} } = {}) {
  const run = typeof deps.runPnpm === 'function' ? deps.runPnpm : runPnpmWithFallback
  const unknownOption = typeof deps.unknownOption === 'function' ? deps.unknownOption : unknownPnpmOption
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 180000
  const execOpts = { cwd: target, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: buildPnpmEnv(null) }
  const base = ['install', '--prefer-offline']
  const attempts = [[...base, '--config.auto-install-peers=false'], base]
  let lastError = null
  for (const argv of attempts) {
    try {
      const out = await run(argv, { execOpts })
      return { ok: true, error: null, argv, stdoutTail: String(out?.stdout ?? '').slice(-400) }
    } catch (error) {
      lastError = error
      if (!unknownOption(String(error?.message ?? ''))) break
    }
  }
  return {
    ok: false,
    error: String(lastError?.message ?? lastError).slice(0, 600),
    argv: attempts[0],
    exitCode: Number.isInteger(lastError?.code) ? lastError.code : null,
  }
}

/** 建 peer 垫片（只补缺、绝不覆盖）。返回 `{ created, skipped }`。 */
function createPeerShims({ target, peers, home, deps = {} }) {
  const symlink = typeof deps.symlink === 'function' ? deps.symlink : (t, p) => symlinkSync(t, p, 'junction')
  const root = frameworkShimRoot(home)
  const created = []
  const skipped = []
  for (const name of peers) {
    const short = String(name).slice(FRAMEWORK_SCOPE.length + 1)
    const linkPath = join(target, 'node_modules', FRAMEWORK_SCOPE, short)
    const targetPath = join(root, short)
    if (pathTaken(linkPath)) { skipped.push({ name, link: linkPath, reason: 'occupied（已存在任何东西，含悬空链接）—— 不覆盖' }); continue }
    if (!existsSync(join(targetPath, 'package.json'))) { skipped.push({ name, reason: `框架根里没有 ${short}（无法补）` }); continue }
    try {
      mkdirSync(dirname(linkPath), { recursive: true })
      symlink(targetPath, linkPath)
      created.push({ name, link: linkPath, target: targetPath })
    } catch (error) {
      skipped.push({ name, reason: `建链接失败：${String(error?.message ?? error).slice(0, 200)}` })
    }
  }
  return { created, skipped }
}

/** 写记录（与既有记录取并集，绝不丢掉早先造过的垫片 —— 否则卸载会漏清）。 */
function writeSelfSufficiencyRecord(home, packageName, created) {
  if (created.length === 0) return null
  const file = selfSufficiencyRecordPath(home, packageName)
  const previous = readJsonSafe(file)
  const known = Array.isArray(previous?.shims) ? previous.shims : []
  const seen = new Set(known.map((s) => s?.link))
  const merged = [...known]
  for (const item of created) if (!seen.has(item.link)) merged.push({ name: item.name, link: item.link, target: item.target })
  const record = { packageName, updatedAt: new Date().toISOString(), shims: merged }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return file
  } catch {
    return null
  }
}

/** 这次尝试的人话小结（空段自动跳过；只拼接、不覆盖 —— 覆盖就是谎报的来源）。 */
function composeSelfSufficiencyNote({ packageName, installed, created, skipped, finalPlan }) {
  const parts = []
  if (installed !== null) {
    parts.push(installed.ok === true
      ? `${packageName}：已在链接目标内装齐 dependencies`
      : `${packageName}：在链接目标内装 dependencies 失败（${installed.error}）`)
  }
  if (created.length > 0) parts.push(`已补框架 peer 垫片 ${created.length} 个（${created.map((c) => c.name).join(', ')}）`)
  if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个（${skipped.map((s) => `${s.name}: ${s.reason}`).join('；')}）`)
  if ((finalPlan?.foreignPeers ?? []).length > 0) parts.push(`注意：${finalPlan.foreignPeers.map((p) => `${p.name} 解析到别处（${p.resolved}），与框架根不是同一份 ⇒ 模块身份可能与宿主不共享（未改动，仅如实提示）`).join('；')}`)
  if (finalPlan?.ready === true) parts.push('链接目标现已自足')
  else if (finalPlan?.applies === true) {
    const missing = [...(finalPlan.missingDeps ?? []), ...(finalPlan.missingPeers ?? [])]
    parts.push(`仍未就绪：缺 ${missing.join(', ') || '（目标目录不可用）'}`)
  }
  return parts.length === 0 ? null : parts.join('；')
}

/**
 * 让一个 `link:` 依赖自足（**安装主路径上的唯一入口**）。
 * 顺序是刻意的：**先装依赖、后建垫片** —— `pnpm install` 会按 lock 修剪 node_modules，
 * 先建垫片会被它顺手清掉。
 * 返回 `{ ok, applies, ready, changed, installed, created, skipped, note, action, plan }`。
 * `ok` 表示"这次尝试本身没出意外"，**不**表示插件一定可用；可用性看 `ready`。
 * 任何情况都**不抛**：调用方（安装/钉住流程）绝不因为它而拒绝安装。
 */
async function ensureLinkSelfSufficiency({ profileDir, packageName, spec = null, home = null, deps = {} } = {}) {
  const homeDir = typeof home === 'string' && home !== '' ? home : dshHome()
  const empty = { ok: true, applies: false, ready: true, changed: false, installed: null, created: [], skipped: [], note: null, action: null }
  try {
    const plan = planLinkSelfSufficiency({ profileDir, packageName, spec, home: homeDir })
    if (plan.applies !== true) return { ...empty, note: plan.reason, plan }
    if (plan.ready === true) return { ...empty, applies: true, note: null, plan } // 规矩①：自足 ⇒ 零写盘
    if (plan.targetExists !== true) return { ...empty, applies: true, ready: false, note: plan.note, action: plan.action, plan }

    let installed = null
    if (plan.missingDeps.length > 0) {
      installed = await installTargetDependencies({ target: plan.target, deps })
    }
    const afterDeps = planLinkSelfSufficiency({ profileDir, packageName, spec: plan.spec, home: homeDir })
    const { created, skipped } = createPeerShims({ target: plan.target, peers: afterDeps.shimmablePeers, home: homeDir, deps })
    if (created.length > 0) writeSelfSufficiencyRecord(homeDir, packageName, created)

    const finalPlan = planLinkSelfSufficiency({ profileDir, packageName, spec: plan.spec, home: homeDir })
    return {
      ok: true,
      applies: true,
      ready: finalPlan.ready === true,
      changed: created.length > 0 || installed?.ok === true,
      installed,
      created,
      skipped,
      note: composeSelfSufficiencyNote({ packageName, installed, created, skipped, finalPlan }),
      action: finalPlan.ready === true ? null : finalPlan.action,
      plan: finalPlan,
    }
  } catch (error) {
    // 规矩③：意外也只如实报，绝不把它变成安装失败
    return { ...empty, applies: true, ready: false, note: `${packageName}：补齐链接自足性时出错（${String(error?.message ?? error).slice(0, 300)}）—— 已跳过，安装继续`, plan: null }
  }
}

/** 列出全部自足性记录（报告/体检用；读不到就是空数组）。 */
function listSelfSufficiencyRecords({ home = null } = {}) {
  const homeDir = typeof home === 'string' && home !== '' ? home : dshHome()
  const dir = selfSufficiencyRecordDir(homeDir)
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: join(dir, f), record: readJsonSafe(join(dir, f)) }))
  } catch {
    return []
  }
}

/**
 * 删掉一个**链接本身**（不动它指向的目标）。
 * ★ 这里踩过一次真坑（2026-10-06 本机实测）：Windows 上 `fs.rmSync(junction, {recursive:false})`
 *   **一声不响地什么都不删**（不抛错、链接还在）—— 与 pnpm 改名被挡留下的 `*_tmp_*` 是同一族现场。
 *   实测：`unlinkSync` 与 `rmdirSync` 都能删掉链接且目标存活；`rmSync` 两种写法都无效。
 *   所以顺序是 unlink → rmdir，并逐个复核"真的没了"，删不掉如实上报（绝不谎报已清理）。
 */
function removeLinkEntry(link) {
  for (const attempt of [() => unlinkSync(link), () => rmdirSync(link)]) {
    try { attempt() } catch {}
    if (!pathTaken(link)) return true
  }
  return !pathTaken(link)
}

/**
 * 卸载时清掉**我们造的**垫片（卸载即撤销：与 `undeclareProfileDependency` 同一时机调用）。
 * 只删"现在仍是指向当初记录目标的链接"的那些；被人改过/换成真实目录的一律保留并如实报。
 * 返回 `{ removed, kept, note }`；不抛。
 */
function removeLinkSelfSufficiency({ packageName, home = null } = {}) {
  const homeDir = typeof home === 'string' && home !== '' ? home : dshHome()
  const file = selfSufficiencyRecordPath(homeDir, packageName)
  const record = readJsonSafe(file)
  const shims = Array.isArray(record?.shims) ? record.shims : []
  const removed = []
  const kept = []
  for (const item of shims) {
    const link = typeof item?.link === 'string' ? item.link : null
    const target = typeof item?.target === 'string' ? item.target : null
    if (link === null || target === null || !pathTaken(link)) { kept.push({ link, reason: '链接已不在（可能已被用户/其它工具处理）' }); continue }
    let stillOurs = false
    try {
      stillOurs = lstatSync(link).isSymbolicLink() && readlinkSync(link) === target
    } catch {
      stillOurs = false
    }
    if (!stillOurs) { kept.push({ link, reason: '它现在不是指向当初目标的链接（已被改动）—— 不碰' }); continue }
    if (removeLinkEntry(link)) removed.push(link)
    else kept.push({ link, reason: '删除未生效（可能被占用）—— 保留' })
  }
  let recordRemoved = false
  let recordEmptied = false
  if (existsSync(file)) {
    try { rmSync(file, { force: true }) } catch {}
    recordRemoved = !existsSync(file)
    if (!recordRemoved) {
      // 删不掉时**退而求其次清空内容**（真机实测：`<DSH_HOME>/plugin-console/` 下的文件在本机
      // 删除会静默落空 —— 与 `*_tmp_*`、junction 是同一族的 Windows 静默失败）。
      // 不能留下指向**已删垫片**的陈旧条目：下一次清理会"找不到"而误报，也让人误以为东西还在。
      try {
        writeFileSync(file, `${JSON.stringify({ packageName, updatedAt: new Date().toISOString(), shims: [], note: '垫片已清理；文件本身删除未生效，已清空以免留下陈旧条目' }, null, 2)}\n`, 'utf8')
        recordEmptied = (readJsonSafe(file)?.shims ?? null)?.length === 0
      } catch { recordEmptied = false }
    }
  }
  const note = removed.length === 0 && kept.length === 0
    ? null
    : `垫片清理：删除 ${removed.length} 个${kept.length === 0 ? '' : `，保留 ${kept.length} 个（${kept.map((k) => `${k.link}：${k.reason}`).join('；')}）`}` +
      (recordRemoved || recordEmptied || !existsSync(file) ? '' : '；记录文件删除未生效且无法清空（已如实保留）')
  return { removed, kept, recordRemoved, recordEmptied, note }
}

export {
  FRAMEWORK_SCOPE,
  frameworkShimRoot,
  selfSufficiencyRecordDir,
  selfSufficiencyRecordPath,
  planLinkSelfSufficiency,
  ensureLinkSelfSufficiency,
  removeLinkSelfSufficiency,
  listSelfSufficiencyRecords,
  installTargetDependencies,
  createPeerShims,
  resolveFromDir,
  isPathSpec,
}
