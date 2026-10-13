// L1 · domain —— subdir-install.js（「从这个子目录安装」：先落地该子目录，再按既有**本地目录来源**装）
//
// 真机现场（2026-10-13 用户实测，第二轮）：`Fei2411/DeepSeek-Bot` 根目录没有 package.json，
// 插件清单在 `ds-bot/` 里。0.5.46 已经能**认出来**并给出可复制的一段文字 —— 但**装不了**：
// 用户拿到"插件在 ds-bot/ 下"之后还得自己想办法（把子目录并进独立仓库 / 等作者发 npm 包）。
// 本轮补上**可执行的那一步**：面板上点「从这个子目录安装」→ 这里跑完整条路。
//
// 实现方式（三条备选里选"先落地再本地装"，理由写死在这里）：
//   ① 本地目录来源**本来就是这个仓的既有能力**（source-spec.js 的判据 C：`link:` 是本地目录的正常路径，
//      外加 link-self-sufficiency 的依赖/peer 垫片补齐）—— 不需要给 pnpm 编一个新协议；
//   ② GitHub 侧不需要新接口：既有 `gitCloneRepo(..., { sparse: [dir] })` 就能**只拉那一个目录**
//      （批次 D-② 的能力，预设通道已在用），代价与定位子包同一量级；
//   ③ 已落地仓库优先复用（`findLandedRepo`）⇒ 用户先点过「仓库落地」时**零网络请求**。
//
// 判据一个字都不放松（用户点名："不许降低任何既有校验标准"）：
//   · **清单校验**：先去仓库读 `<dir>/package.json`（走 infra/http.js 的既有读取通道，
//     与根清单探测同一把尺子），必须是合法 JSON、必须有 name、必须带 dsh 标记（dsh.bundle.patch / dsh.client）
//     —— 与识别阶段（subdir-detect.js）用**同一个** describeDshManifest/dshMarkersOf；
//   · **来源校验**：包名以**清单**为准（前端传什么都不算数），且取到源码之后**读回本地清单再核一次**
//     （名字不一致 ⇒ 当场拒绝，绝不按别人的包名装一份不知道是什么的东西）；
//   · **装后/收口**：与普通安装同一条路 —— verifyInstalledEntry（只提示）+ bundle patch 引用的包必须
//     能解析（缺一个就拒绝注册，理由同 install-job.js 那段崩溃事故）+ finalizeInstallPersistence
//     （清单 + lock + 挂载行）。
//
// 分层：L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）；进程/出网都只经
// 可注入的单点（`deps.channels.pnpmInstall` / deps.gitClone / deps.readManifest），测试一律注入替身。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readBundlePatchRefNames } from './bundle-refs.js'
import { PLUGIN_SRC_DIR, linkSpecFor, sameSourceSpec } from './dep-source.js'
import { noteChannel } from './git-channel.js'
import { addBundleToManifest, detectBundleOnly } from './install.js'
import { finalizeInstallPersistence } from './install-finalize.js'
import { alreadyInstalledTarget, verifyInstalledEntry } from './install-verify.js'
import { ensureLinkSelfSufficiency } from './link-self-sufficiency.js'
import { setProfileDependency } from './manifest.js'
import { fetchRepoPathText } from './market.js'
import { findLandedRepo, gitCloneRepo } from './repoland.js'
import { listEntries } from './runtime.js'
import { orderedRegistries, readSources } from './sources.js'
import { describeDshManifest } from './subdir-detect.js'
import { fetchRepoMeta } from './suite.js'
import { copyTree, disposeDir, disposeNote } from '../infra/fsx.js'
import { dshHome, findPatchPath, packageNameOf, resolvePackageJson } from '../infra/paths.js'

/** 落地源码的暂存目录名（`<DSH_HOME>/plugin-console/<这个名字>/<repo>__<dir>`）：
 * 与 `source-specs/` / 自足记录同族都在 `plugin-console/` 下 —— 它是"取下来的工作副本"，
 * 插件的**正式家**仍是 `<DSH_HOME>/plugin-src/<包名>`（pnpm 管不到、跨 lock 重建稳定存在）。 */
const SUBDIR_SRC_DIR = 'subdir-src'

/** 子目录路径的一节：字母数字 . _ -，且**不许**是 `.` / `..`（路径穿越）。 */
const SUBDIR_SEGMENT_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u
/** 识别阶段的口径：只认第 1～2 层子目录（`<dir>` / `<dir>/<sub>`），与市场探针完全一致。 */
const SUBDIR_MAX_SEGMENTS = 2

/** 归一化用户/前端给的子目录：合法则返回规范形，否则 null（绝不抛）。 */
function normalizeSubdir(raw) {
  const text = String(raw ?? '').trim().replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (text === '') return null
  if (text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/u.test(text)) return null
  const parts = text.split('/')
  if (parts.length === 0 || parts.length > SUBDIR_MAX_SEGMENTS) return null
  if (!parts.every((part) => SUBDIR_SEGMENT_RE.test(part))) return null
  return parts.join('/')
}

/** 暂存目录名（同一仓库的同一个子目录复用同一格；重跑会覆盖前一次的骨架）。 */
function subdirSlug(repo, dir) {
  return `${String(repo).replace(/[^A-Za-z0-9._-]+/gu, '__')}__${String(dir).replace(/[^A-Za-z0-9._-]+/gu, '_')}`
}

/** 失败收口（唯一出口）：状态 + 文案 + 附带的展示字段，绝不留半句话的结论。 */
function failSubdirInstall(job, text, extra = {}) {
  job.status = 'failed'
  job.error = text
  for (const [key, value] of Object.entries(extra)) job[key] = value
  return false
}

/** 子目录安装的**前置校验**：读 `<dir>/package.json` 并核实"它确实是 DSH 插件"。
 * 返回 `{ ok, packageName, markers }` 或 `{ ok:false, error }`（文案即用户可见结论）。
 * `readManifest(repo, branch, path)` 可注入（单测 ⇒ 零出网）；生产走 market.fetchRepoPathText。 */
async function verifySubdirManifest({ repo, branch, dir, readManifest }) {
  const path = `${dir}/package.json`
  let text = null
  let readError = null
  try {
    text = await readManifest(repo, branch, path)
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
  }
  if (text === null || text === undefined || readError !== null) {
    // "没读到"绝不许冒充"没有"（本仓既有口径）：只说没读到 + 为什么 + 出路。
    return {
      ok: false,
      error: `读不到 ${repo}（${branch} 分支）的 ${path}${readError === null ? '（404 / 超时 / 网络不可达）' : `：${readError}`}`
        + ` —— 没能核实这个子目录里到底是什么，**没有**下"它不是插件"的结论。请重试；`
        + `或先按「仓库落地」把仓库克隆到本地，本控制台会直接复用那份已落地的副本（零网络请求）。`,
    }
  }
  const info = describeDshManifest(text)
  if (info === null) {
    return { ok: false, error: `${path} 不是合法的包描述（JSON 解析失败或缺少 name 字段）—— 无法作为插件安装。` }
  }
  if (info.markers.length === 0) {
    return {
      ok: false,
      error: `${path} 里那个包（${info.name}）没有声明任何 dsh 标记（dsh.bundle.patch / dsh.client）`
        + ` —— 它不是 DSH 插件（判据与"是不是插件"的识别完全一致，不为安装放宽）。`,
    }
  }
  return { ok: true, packageName: info.name, markers: info.markers }
}

/** 取子目录源码：先复用**已落地**仓库（零网络），否则稀疏取源码只拉这一个目录。
 * 返回 `{ ok, dir, reused, notes }` / `{ ok:false, notes, error }`。clone 可注入（单测零进程/零网络）。 */
async function acquireSubdirSource({ repo, dir, source = 'github', deps = {} }) {
  const notes = []
  const findLanded = typeof deps.findLandedRepo === 'function' ? deps.findLandedRepo : findLandedRepo
  let landed = { hit: false, path: null }
  try {
    landed = findLanded(repo) ?? landed
  } catch {
    landed = { hit: false, path: null }
  }
  if (landed?.hit === true && typeof landed.path === 'string' && landed.path !== '') {
    const candidate = join(landed.path, ...dir.split('/'))
    if (existsSync(join(candidate, 'package.json'))) {
      notes.push(`复用已落地仓库里的子目录：${candidate}（零网络请求）`)
      return { ok: true, dir: candidate, reused: true, notes }
    }
    notes.push(`本机有已落地仓库 ${landed.path}，但里面没有 ${dir}/package.json —— 改用稀疏取源码`)
  }
  const scratchRoot = typeof deps.srcRoot === 'string' && deps.srcRoot !== ''
    ? deps.srcRoot
    : join(dshHome(), 'plugin-console', SUBDIR_SRC_DIR)
  const dest = join(scratchRoot, subdirSlug(repo, dir))
  const clone = typeof deps.gitClone === 'function' ? deps.gitClone : gitCloneRepo
  const timeout = Number.isFinite(deps.cloneTimeoutMs) && deps.cloneTimeoutMs > 0 ? deps.cloneTimeoutMs : undefined
  let cloned = null
  try {
    cloned = await clone(repo, dest, source, timeout, { sparse: [dir] })
  } catch (error) {
    return { ok: false, notes, error: `取子目录源码失败（${dir}/）：${error instanceof Error ? error.message : String(error)}` }
  }
  if (cloned?.sparse === true) notes.push(`已用稀疏取源码（--filter=blob:none --sparse + sparse-checkout set ${dir}）：只拉这 1 个子目录`)
  else notes.push('稀疏取源码不被本机/对端支持（已降级到普通 clone）—— 体积更大，结果一样')
  const src = join(dest, ...dir.split('/'))
  if (!existsSync(join(src, 'package.json'))) {
    return { ok: false, notes, error: `取到的源码里没有 ${dir}/package.json（克隆目标：${dest}）—— 仓库布局可能已经变了` }
  }
  return { ok: true, dir: src, reused: cloned?.reused === true, notes }
}

/** 把取到的子目录放成插件的**正式家**：`<DSH_HOME>/plugin-src/<包名>`。
 * 为什么必须先落这里再装：`link:` 的目标要能跨 pnpm 的 node_modules 重建活下来（plugin-src 是
 * pnpm 不管的独立目录，见 dep-source.js 的 materializePackageForLink 注释）。
 * 目标已存在 ⇒ 先让开（删除失败会降级改名成 `.trash-*`，原路径照样让开）。 */
function placeSubdirSource({ srcDir, packageName, home = null, deps = {} }) {
  const base = typeof home === 'string' && home !== '' ? home : dshHome()
  const dest = join(base, PLUGIN_SRC_DIR, ...String(packageName).split('/'))
  const dispose = typeof deps.disposeDir === 'function' ? deps.disposeDir : disposeDir
  try {
    if (existsSync(dest)) {
      const result = dispose(dest)
      if (result?.ok !== true) return { ok: false, dir: dest, error: `目标目录 ${dest} 无法让开（${disposeNote(result)}）` }
    }
    copyTree(srcDir, dest)
  } catch (error) {
    return { ok: false, dir: dest, error: `把子目录源码铺进 ${dest} 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!existsSync(join(dest, 'package.json'))) return { ok: false, dir: dest, error: `铺进 ${dest} 后读不到 package.json（复制未生效）` }
  return { ok: true, dir: dest }
}

/** 铺好之后**读回本地清单再核一次**（来源校验）：名字必须与远端读到的那个一致。
 * 不一致 ⇒ 拒绝安装（绝不按 A 的名字装一份 B 的东西）。返回 `{ ok, version, error }`。 */
function verifyPlacedManifest({ dir, packageName }) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (pkg === null || typeof pkg !== 'object') return { ok: false, version: null, error: `${dir}/package.json 不是对象` }
    if (pkg.name !== packageName) {
      return { ok: false, version: null, error: `${dir}/package.json 里的包名是 ${String(pkg.name)}，与远端读到的 ${packageName} 不一致 —— 已拒绝安装（来源存疑）` }
    }
    return { ok: true, version: typeof pkg.version === 'string' ? pkg.version : null, error: null }
  } catch (error) {
    return { ok: false, version: null, error: `读回 ${dir}/package.json 失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 收口之后确保清单里记的是**来源规格**（`link:`），而不是被顺手写成的版本号。
 *
 * 为什么需要这一步（本轮施工实测到的一条真链路）：`persist.js` 在 **bundle 模式**且该 bundle 的补丁里
 * 读不到 insert 行时会调 `manifest.js#addBundleToManifest` 收尾，而那个实现会顺手把
 * `dependencies[包名]` 写成**已装版本号**（"安装即声明"的副产物）—— 对 registry 包没问题，
 * 对**本地目录来源**就是丢了来源：下次任何 pnpm 操作都会按版本号去 registry 解析 → 404
 * （本仓 0.5.20 / 0.5.38 / 0.5.39 反复修过的病根）。子目录安装天生就是"本地目录来源 + 可能带 bundle"，
 * 所以在**本模块自己的出口**把这件事故意补回来（只动"确实写歪了"的那一次；等价即零写盘）。
 * 返回写入结果或 null（没动手）。 */
async function keepLinkSpec({ profileDir, packageName, spec, job = null }) {
  if (typeof spec !== 'string' || !spec.startsWith('link:')) return null
  let current = null
  try {
    current = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))?.dependencies?.[packageName] ?? null
  } catch {
    return null
  }
  if (sameSourceSpec(profileDir, current, spec)) return null
  let written = null
  try {
    written = await setProfileDependency(profileDir, packageName, spec)
  } catch (error) {
    noteChannel(job, `${packageName}：清单里的依赖规格是 ${String(current)}，改回来源规格失败（${error instanceof Error ? error.message : String(error)}）—— 重试一次即可`)
    return null
  }
  noteChannel(job, `${packageName}：清单里的依赖规格被写成了 ${String(current)}（bundle 收尾"安装即声明"的副作用），已改回**来源规格** ${spec} —— 否则下次 pnpm 操作会按版本号去 registry 解析并 404`)
  return written
}

/** 「从这个子目录安装」的完整作业体（install-job 在 `job.subdir` 非空时把作业交给它）。
 * 步骤与理由见文件头；任何一步失败都**如实失败 + 原因**，绝不留下"半装"的糊涂账。
 * deps 是离线测试缝（与 marketProbes/sourceDeps 同一风格）：readManifest / gitClone / channels /
 * selfSufficiency / persistDeps / srcRoot / home 都可替换；生产调用方只传 `channels`。
 * `deps.channels` 由 install-job 传入（沿用它的 `installChannels` 注入缝，不在这里再解释一遍那个缝）。 */
async function runSubdirInstallJob(job, ports, deps = {}) {
  try {
    return await runSubdirInstallJobInner(job, ports, deps)
  } catch (error) {
    // 作业体是"安装主路径"的一部分：**绝不把异常抛给调用方**（那会让面板永远转圈/整个请求 500）。
    // 未预期的错误也如实收口：状态 + 原因 + 可重试。
    return failSubdirInstall(job, `子目录安装失败（未预期错误）：${error instanceof Error ? error.message : String(error)} —— 未完成的部分已如实停下，可重试。`)
  }
}

async function runSubdirInstallJobInner(job, ports, deps = {}) {
  const repo = String(job?.repo ?? '')
  const requested = String(job?.packageName ?? '').trim() // 前端给的名字（只用来对账，绝不当判据）
  const source = job?.source === 'gitee' ? 'gitee' : 'github'
  const dir = normalizeSubdir(job?.subdir)
  if (dir === null) {
    return failSubdirInstall(job, `子目录路径不合法：${String(job?.subdir ?? '（空）')} —— 只接受仓库里第 1～2 层的相对目录（如 ds-bot 或 packages/foo），不接受绝对路径、盘符、反斜杠与 . / ..`)
  }
  // 分支：面板带着识别当时的默认分支来；没带就自己探一次（与其它路径同一个探测入口）。
  let branch = typeof job?.branch === 'string' && job.branch.trim() !== '' ? job.branch.trim() : ''
  if (branch === '') {
    let meta = null
    try {
      meta = await (typeof deps.fetchRepoMeta === 'function' ? deps.fetchRepoMeta(repo) : fetchRepoMeta(repo))
    } catch {
      meta = null
    }
    branch = typeof meta?.default_branch === 'string' && meta.default_branch !== '' ? meta.default_branch : 'main'
  }
  job.stage = 'preparing'
  const readManifest = typeof deps.readManifest === 'function'
    ? deps.readManifest
    : (r, b, p) => fetchRepoPathText(r, b, p, deps.readDeps ?? {})
  // ① 清单校验（== 识别阶段同一把尺子）
  const verified = await verifySubdirManifest({ repo, branch, dir, readManifest })
  if (verified.ok !== true) {
    // 核实没过 ⇒ **不**下"插件在 <子目录>/ 下"的结论（那正是要被纠正的误导）：
    // 只给"为什么没核实成 / 怎么办"，下一步是重试或「仓库落地」（hint 沿用既有取值）。
    return failSubdirInstall(job, verified.error, { hint: 'repo-land', subdirDir: dir, subplugin: null })
  }
  const packageName = verified.packageName
  job.packageName = packageName
  job.subdirDir = dir
  job.subdirMarkers = verified.markers
  if (requested !== '' && requested !== packageName) {
    // 前端给的名字与清单不一致：以清单为准，但如实记一条（不悄悄改用户的意图）
    noteChannel(job, `前端请求的包名是 ${requested}，而 ${dir}/package.json 里的包名是 ${packageName} —— 以**清单**为准（来源校验一视同仁）`)
  }
  // ② 目标 profile
  const patchPath = findPatchPath(ports)
  const profileDir = dirname(patchPath)
  const channels = deps.channels ?? {}
  if (typeof channels.pnpmInstall !== 'function') {
    return failSubdirInstall(job, '内部错误：子目录安装需要安装通道（ports.installChannels.pnpmInstall），本次没拿到 —— 未改动任何东西。')
  }
  const home = typeof deps.home === 'string' && deps.home !== '' ? deps.home : dshHome()
  // ③ 已经装上了？（用户被"报失败"误导过的正是这一类）——命中就不重复下载，直接走收口/启用
  let linkSpec = null
  const already = alreadyInstalledTarget(profileDir, packageName, job)
  if (already !== null) {
    job.curlNote = already
    noteChannel(job, already)
  } else {
    job.stage = 'installing'
    // ④ 取源码（已落地仓库优先，零网络；否则稀疏只拉这一个子目录）
    const acquired = await acquireSubdirSource({ repo, dir, source, deps })
    for (const note of acquired.notes ?? []) noteChannel(job, note)
    if (acquired.ok !== true) {
      return failSubdirInstall(job, `${acquired.error}。请重试；也可先按「仓库落地」把仓库克隆到本地，本控制台会直接复用那份副本。`)
    }
    // ⑤′ 先核实**刚取到的那份源码**（读回本地清单核对包名）——绝不在核实之前覆盖用户已装好的副本
    const srcCheck = verifyPlacedManifest({ dir: acquired.dir, packageName })
    if (srcCheck.ok !== true) return failSubdirInstall(job, `${srcCheck.error}（取到的源码：${acquired.dir}）`)
    // ⑤ 放成插件的正式家（plugin-src/<包名>）并再核实一次（复制是否真的生效）
    const placed = placeSubdirSource({ srcDir: acquired.dir, packageName, home, deps })
    if (placed.ok !== true) return failSubdirInstall(job, placed.error)
    const recheck = verifyPlacedManifest({ dir: placed.dir, packageName })
    if (recheck.ok !== true) return failSubdirInstall(job, recheck.error)
    const spec = linkSpecFor(placed.dir)
    linkSpec = spec
    job.subdirSource = { dir, from: acquired.dir, reused: acquired.reused === true, placed: placed.dir, version: recheck.version }
    // ⑥ 本地目录来源 = 既有安装通道：`pnpm add link:<目录>` 建起 node_modules 里的那条链接
    //    （link: 是本地目录的正常形态，见 source-spec.js 判据 C；依赖由下一步的自足性补齐）
    try {
      await channels.pnpmInstall(profileDir, spec, undefined)
    } catch (error) {
      return failSubdirInstall(job, `从子目录 ${dir}/ 安装失败（本地目录来源 ${spec}）：${error instanceof Error ? error.message : String(error)}。`
        + `源码已取到本地（${placed.dir}），可重试；重试会复用已取到的源码。`)
    }
    // ⑦ 自足性（link: 的依赖 + 框架 peer 垫片）：既有能力，失败只如实记 note，不影响安装判定
    try {
      const ensureSelf = typeof deps.selfSufficiency === 'function' ? deps.selfSufficiency : ensureLinkSelfSufficiency
      const self = await ensureSelf({ profileDir, packageName, spec, home, deps: deps.selfDeps ?? {} })
      if (self?.applies === true && typeof self.note === 'string' && self.note !== '') noteChannel(job, self.note)
    } catch (error) {
      noteChannel(job, `link 自足性补齐失败（不影响安装本身）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  job.stage = 'configuring'
  job.entryCheck = verifyInstalledEntry(profileDir, packageName)
  // ⑧ 挂载：bundle 层（dsh.bundle.patch）或普通 insert 行 —— 注册前的引用校验与 install-job 同一条规矩
  const entries = listEntries(ports)
  const served = entries.some((entry) => String(entry.moduleName).startsWith(packageName)
    || String(entry.moduleName) === packageName
    || packageNameOf(entry.moduleName) === packageName)
  let mode = 'insert'
  if (await detectBundleOnly(profileDir, packageName)) {
    mode = 'bundle'
    if (!served) {
      const refs = readBundlePatchRefNames(profileDir, packageName)
      const missing = refs.filter((n) => resolvePackageJson(n, profileDir) === null)
      if (missing.length > 0) {
        return failSubdirInstall(job, `该聚合包（${packageName}）的插件组引用以下未安装模块：${missing.join('、')}。`
          + `若这些是框架内部包（@deepseek-ai/*），该包不能作为插件安装（会导致服务启动失败）；若为本应随包安装的依赖，请重试或检查网络。已取消注册。`)
      }
      await addBundleToManifest(profileDir, packageName)
      job.bundle = true
    } else {
      job.bundleNote = `${packageName} 已由已安装条目提供，仅更新包本身，不再注册重复行`
    }
  } else if (served) {
    mode = 'served'
    job.note = `${packageName} 已由已安装条目提供，只更新包本身，不重复注册`
  }
  // ⑨ 收口：清单 + lock + 挂载行（唯一入口 domain/persist.js；结果 → 作业字段的唯一映射 install-finalize.js）
  await finalizeInstallPersistence({
    job, profileDir, patchPath, packageName, mode,
    taken: new Set(entries.map((entry) => entry.rowId)), entries,
    registries: orderedRegistries(readSources()),
    source: { spec: null, origin: 'local-dir', kind: 'subdir' },
    deps: deps.persistDeps ?? {},
  })
  // ⑩ 收口之后再看一眼**来源规格**：bundle 模式下的收尾补写可能把 link: 写成版本号（见 keepLinkSpec）
  if (linkSpec !== null) await keepLinkSpec({ profileDir, packageName, spec: linkSpec, job })
  job.status = 'done'
  return true
}

export {
  SUBDIR_SRC_DIR, SUBDIR_MAX_SEGMENTS,
  normalizeSubdir, subdirSlug, verifySubdirManifest, acquireSubdirSource, placeSubdirSource, verifyPlacedManifest,
  keepLinkSpec, runSubdirInstallJob,
}
