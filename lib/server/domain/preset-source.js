// L1 · domain —— preset-source.js（预设型子包的**源码装配**：稀疏取源码 → 定位 → 装配到 ~/.dsh/.agent-presets）
//
// 真机事故（2026-09-27，用户实测 yjh051108/dsh-routing-suite「三件套只装到两件」）：
//   该仓库三件套 = `graded/`（release 有 tgz，已装）、`injector/`（release 有 tgz，已装）、
//   **`preset/`（= dsh-router-standard，「思维模式路由预设」：npm 双 404、release 无资产 →
//   只存在于仓库源码里）**。旧流程对"根包 private"的仓库一刀切禁用源码通道（批次 A-③），
//   于是第三件连一次机会都没有；而"添加并启用"这条路上，按包名的通道（registry/curl/release）
//   对它必然是 404 —— 缺的就是"从仓库里把那一个目录取下来，按预设装配"这条能力。
//
// 本模块提供三件事：
//   ① findPresetDirs / isPresetDir —— 预设目录识别（从 suite.js **原样搬来**，suite.js 改为 re-export）
//   ② fetchPresetSource / tryPresetSourceChannel —— 稀疏取源码（`--filter=blob:none --sparse`
//      + `git sparse-checkout set <subdir>`；不支持时降级普通 clone）并装配
//   ③ 装配本身（assemblePreset / 校验 / 备份 / 读回核实）**已搬到 domain/preset-install.js**
//      （0.5.26 改错 F2+F3+F4：默认改为"只补不覆盖"、写前校验、备份路径唯一）。
//      本模块只做 re-export，既有调用方与测试一个字都不用改 —— 写盘逻辑全项目只有一份。
//
// 进程管理一律复用 repoland.js 的 runGitArgs / gitCloneRepo（kill-tree + wait-for-exit + `.tryN` +
// `.trash-*` 降级）—— 本模块**不新造任何进程管理**。

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitCloneRepo, runGitArgs } from './repoland.js'
import { noteChannel } from './git-channel.js'
import { readPresetManifest } from './preset-declare.js'
import { evaluateSourceChannel } from './repo-size.js'
import { disposeDir } from '../infra/fsx.js'
import { dshHome } from '../infra/paths.js'
import {
  PRESET_MARKER_FILES, PRESET_MANIFEST_FILE, assemblePreset, declarationClauseForReports, listTreeFiles,
  presetSourceOf, recordPresetSource, suggestedOverwritePresetAction,
} from './preset-install.js'

/** git 只读命令（ls-tree / show / sparse-checkout）的超时：都是元数据或单个 blob。 */
const GIT_READ_TIMEOUT_MS = 60000

/** 递归找含 preset.yml + agent.cordis.yml 的 agent 预设目录（深度 ≤ maxDepth）。
 * 2026-09-27 从 suite.js **原样搬来**（只搬移未改逻辑）：两个调用方（套装装配 / 预设子包装配）
 * 必须用**同一份**判据，否则"套装装得下、候选装不下"这类漂移又会回来。 */
function findPresetDirs(root, maxDepth = 2) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (existsSync(join(dir, PRESET_MANIFEST_FILE)) && existsSync(join(dir, 'agent.cordis.yml'))) {
      out.push(dir)
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** 这个目录自己就是一个 agent 预设吗（直接含 agent.cordis.yml/.yaml）。
 * 与 findPresetDirs 的差别：findPresetDirs 还要求 preset.yml（列表展示用）；这里更宽 ——
 * 只要框架能挂载就算预设（有的预设不写 preset.yml）。 */
function isPresetDir(dir) {
  return PRESET_MARKER_FILES.some((f) => existsSync(join(dir, f)))
}

/** 「预设型包名」的形状判据（**纯函数**，只是**便宜的初筛**，不作最终判据）。
 * 最终判据永远是"目录里真的有 agent.cordis.yml"（见 tryPresetSourceChannel）：
 * 名字猜错只损失一次便宜的源码探测；而拿名字当判据会把普通插件误当预设装配。
 * 覆盖：dsh-router-standard / dsh_router_standard / router-preset / @scope/dsh-preset-* 等。 */
function looksLikePresetPackageName(name) {
  return /(?:^|[-_/])(?:router|preset)(?:[-_/]|$)/iu.test(String(name ?? '').trim())
}

/** 读预设清单（preset.yml 的 name/description/order；读不到返回 null，不抛）。
 *  实现已搬到 preset-declare.js（那里也要用它，且依赖方向必须单向 preset-source → preset-declare）——
 *  这里 re-export，既有调用方与测试一个字都不用改。 */
export { readPresetManifest } from './preset-declare.js'

/** 跑一条 git 命令并取回 stdout（ls-tree/show 要的就是输出）。仍然走 repoland 的 runGitArgs：
 * 那边已经把停滞判据 + kill-tree + wait-for-exit 做完了，这里只转发（`stdout` 由 runGitArgs 采集）。 */
function gitCapture(argv, { cwd, timeout, runGit = null } = {}) {
  const run = typeof runGit === 'function' ? runGit : runGitArgs
  return run(argv, { cwd, timeout })
}

/** 用 git 在**本地**定位候选对应的子包目录（零额外网络）：
 * `git ls-tree -r --name-only HEAD` 列出全部路径 → 只挑第 1/2 层的 package.json（与
 * market.js#fetchSubpackageNamesOnBranch 的检索面一致）→ `git show HEAD:<path>` 核对 name
 * （partial clone 会按需只拉这一个 blob）。
 * 返回 { subdir, pkg, error }；subdir 为 null 表示没找到。 */
async function locateSubpackageViaGit({ root, candidateName, runGit = null, timeout = GIT_READ_TIMEOUT_MS }) {
  const want = String(candidateName ?? '').trim()
  if (want === '') return { subdir: null, pkg: null, error: '候选包名为空' }
  const listed = await gitCapture(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: root, timeout, runGit })
  if (listed.code !== 0) return { subdir: null, pkg: null, error: `git ls-tree 失败：${String(listed.stderr ?? '').slice(0, 200)}` }
  const paths = String(listed.stdout ?? '').split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => /^(?!node_modules\/)[^/]+(?:\/[^/]+)?\/package\.json$/u.test(l))
  for (const path of paths) {
    // eslint-disable-next-line no-await-in-loop
    const shown = await gitCapture(['show', `HEAD:${path}`], { cwd: root, timeout, runGit })
    if (shown.code !== 0) continue
    try {
      const pkg = JSON.parse(String(shown.stdout ?? ''))
      if (pkg !== null && typeof pkg === 'object' && pkg.name === want) {
        return { subdir: path.split('/').slice(0, -1).join('/'), pkg, error: null }
      }
    } catch {}
  }
  return { subdir: null, pkg: null, error: null }
}

/** 稀疏/定向取源码（**批次 D-② 的实现**）：
 *   ① 骨架稀疏克隆 `git clone --depth 1 --filter=blob:none --sparse`（只取提交/树对象 + 根目录文件）
 *      —— 走 gitCloneRepo，因此自动带 `.tryN` / 探活 / kill-tree / wait-for-exit / `.trash-*` 降级 / archive 兜底；
 *   ② `git ls-tree` 在**本地**定位候选对应的子包目录（零额外网络）；
 *   ③ `git sparse-checkout set <subdir>` 只把那一个目录的 blob 拉下来。
 * 任一步"不被支持"（旧 git / 服务端不支持 partial clone）→ **降级到普通 clone** 并如实记 notes。
 * 返回 { ok, root, subdir, sparse, downgraded, notes, error, missing }。 */
async function fetchPresetSource({ repo, candidateName, dest, source = 'github', timeout = undefined, deps = {} }) {
  const gitClone = typeof deps.gitClone === 'function' ? deps.gitClone : gitCloneRepo
  const runGit = typeof deps.runGit === 'function' ? deps.runGit : null
  const cloneOpts = { ...(deps.cloneOpts ?? {}), sparse: [] }
  const notes = []
  let cloned = null
  try {
    cloned = await gitClone(repo, dest, source, timeout, cloneOpts)
  } catch (error) {
    return { ok: false, sparse: false, downgraded: false, notes, error: `稀疏取源码失败（clone）：${error instanceof Error ? error.message : String(error)}` }
  }
  const sparse = cloned?.sparse === true
  const downgradedFromSparse = cloned?.downgradedFromSparse === true
  if (sparse) notes.push(`已用稀疏取源码（--filter=blob:none --sparse）：只取提交/树对象 + 根目录文件${typeof cloned?.url === 'string' ? `（源：${cloned.url}）` : ''}`)
  if (downgradedFromSparse) notes.push('稀疏取源码不被支持，已降级到普通 clone')
  const runTimeout = Number.isFinite(timeout) && timeout > 0 ? timeout : GIT_READ_TIMEOUT_MS
  const locate = await locateSubpackageViaGit({ root: dest, candidateName, runGit, timeout: runTimeout })
  if (locate.error !== null && locate.error !== undefined) {
    return { ok: false, sparse, downgraded: downgradedFromSparse, notes, error: locate.error }
  }
  if (locate.subdir === null) {
    return { ok: false, sparse, downgraded: downgradedFromSparse, notes, missing: true, error: `仓库里没有名为 ${candidateName} 的子包（第 1/2 层 package.json 都没匹配上）` }
  }
  if (!sparse) return { ok: true, root: dest, subdir: locate.subdir, pkg: locate.pkg, sparse: false, downgraded: downgradedFromSparse, notes }
  const set = await gitCapture(['sparse-checkout', 'set', locate.subdir], { cwd: dest, timeout: runTimeout, runGit })
  if (set.code === 0) {
    notes.push(`已用 git sparse-checkout set ${locate.subdir} 定向拉取该目录`)
    return { ok: true, root: dest, subdir: locate.subdir, pkg: locate.pkg, sparse: true, downgraded: false, notes }
  }
  // sparse-checkout 不可用（旧 git）→ 降级普通 clone 再定位一次（不把候选判死）
  notes.push(`git sparse-checkout 不可用（${String(set.stderr ?? '').slice(0, 160)}），已降级到普通 clone`)
  const plainDest = `${dest}-plain`
  try { disposeDir(plainDest) } catch {}
  try {
    await gitClone(repo, plainDest, source, timeout, { ...(deps.cloneOpts ?? {}), sparse: null })
  } catch (error) {
    return { ok: false, sparse: true, downgraded: true, notes, error: `稀疏不被支持、降级普通 clone 也失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const again = await locateSubpackageViaGit({ root: plainDest, candidateName, runGit, timeout: runTimeout })
  if (again.subdir === null) {
    return { ok: false, sparse: true, downgraded: true, notes, error: again.error ?? `普通 clone 后仍未找到子包 ${candidateName}` }
  }
  return { ok: true, root: plainDest, subdir: again.subdir, pkg: again.pkg, sparse: true, downgraded: true, notes }
}

/** 候选级「源码通道」：预设型子包的源码装配（install-job 在所有按包名的通道失败后调用）。
 * 判据链（每一条都写进 job.channelNotes，用户能看到"试了什么、为什么没试"）：
 *   ① 名字不像预设型（looksLikePresetPackageName）→ 直接返回，**不联网、不取源码**；
 *   ② 源码通道体积门禁（repo-size 的缓存判据）→ 不允许就带 note 返回；
 *   ③ 稀疏取源码 → 本地定位子包目录 → 目录里有 agent.cordis.yml 才算预设（最终判据）；
 *   ④ 逐个 assemblePreset 到 `<DSH_HOME>/.agent-presets/<name>`。
 * 返回 { handled, installed, name, presets, note, error }。
 *   handled=false → "这个候选与预设无关"，上层照旧走后续通道；
 *   handled=true 且 installed=false → "确实是预设型但没装成"，error 是**具体原因**。 */
async function tryPresetSourceChannel({ job, name, source = 'github', limit = 4, deps = {} } = {}) {
  const candidateName = String(name ?? '').trim()
  if (!looksLikePresetPackageName(candidateName)) return { handled: false, installed: false, error: null }
  const repo = String(job?.repo ?? '').trim()
  if (repo === '') return { handled: false, installed: false, error: null }
  // 同一作业里同一个候选只试一次（防止上游重入把一次源码取下来了两次）
  const tried = Array.isArray(job?.presetTried) ? job.presetTried : []
  if (tried.includes(candidateName)) return { handled: true, installed: false, error: null }
  if (job !== null && job !== undefined) job.presetTried = [...tried, candidateName]
  const gate = await evaluateSourceChannel(repo, deps.sizeDeps ?? {})
  if (gate.allow !== true) {
    noteChannel(job, `预设型候选 ${candidateName} 的源码装配被跳过：${gate.note}`)
    return { handled: true, installed: false, error: new Error(`预设型子包 ${candidateName} 需要从仓库源码装配，但源码通道不可用：${gate.note}`) }
  }
  const tmpRoot = deps.tmpRoot ?? join(tmpdir(), `dsh-preset-${job?.id ?? 'job'}-${Date.now()}`)
  const dest = join(tmpRoot, 'repo')
  try { mkdirSync(tmpRoot, { recursive: true }) } catch {}
  try {
    const fetched = await fetchPresetSource({ repo, candidateName, dest, source, timeout: deps.cloneTimeoutMs, deps: deps.fetchDeps ?? {} })
    for (const n of fetched.notes ?? []) noteChannel(job, n)
    if (fetched.ok !== true) {
      noteChannel(job, `预设型子包 ${candidateName} 的源码装配失败：${fetched.error}`)
      return { handled: true, installed: false, error: new Error(`预设型子包 ${candidateName}：${fetched.error}`), presets: [] }
    }
    const subDir = join(fetched.root, ...String(fetched.subdir).split('/'))
    const presets = findPresetDirs(subDir, 2)
    // 兜底：子包目录自己就是预设（有的仓库直接把 agent.cordis.yml 放在子包根）
    if (presets.length === 0 && isPresetDir(subDir)) presets.push(subDir)
    if (presets.length === 0) {
      const why = `${candidateName} 的子包目录（${fetched.subdir}）里没有 agent.cordis.yml —— 它不是预设型子包，不能按预设装配`
      noteChannel(job, why)
      return { handled: true, installed: false, error: new Error(`预设型子包 ${candidateName}：${why}`), presets: [] }
    }
    const presetsRoot = deps.presetsRoot ?? join(dshHome(), '.agent-presets')
    // 目标 profile 的补丁文件（可选）：给了就**同时写声明行** —— 框架 0.1.7-rc.x 起预设不再靠目录
    // 发现，只落文件不写声明行 = 用户看不见（见 preset-declare.js 顶部）。安装路径由 install-job.js
    // 传 findPatchPath(ports)，线上一律非空；离线单测不传 → 不写、且 note 如实说明。
    const patchPath = typeof deps.patchPath === 'string' && deps.patchPath !== '' ? deps.patchPath : null
    const reports = []
    const skipped = Math.max(0, presets.length - limit)
    for (const p of presets.slice(0, limit)) {
      // eslint-disable-next-line no-await-in-loop
      // overwrite **永不**在这里为真：安装路径必须走"只补不覆盖"的默认语义。
      // 覆盖只能由用户显式点「覆盖该预设」→ 白名单动作 overwrite-preset 触发（见 plugin-actions.js）。
      const report = await assemblePreset(p, basename(p), {
        presetsRoot, patchPath, ...(deps.now === undefined ? {} : { now: deps.now }),
      })
      reports.push({ ...report, manifest: readPresetManifest(p), sparse: fetched.sparse === true, subdir: fetched.subdir })
    }
    const failed = reports.filter((r) => r.ok !== true)
    if (job !== null && job !== undefined) {
      // 面板可读的结构化结果。0.5.26 加法：mode / skipped / skippedInvalid / verified ——
      // 「默认只补不覆盖」必须**在数据里看得见**（跳过了哪几个同名文件、为什么），不能只在 note 里叙述。
      job.presetInstalled = reports.map((r) => ({
        name: r.name, dest: r.dest, ok: r.ok === true, added: r.added?.length ?? 0, overwritten: r.overwritten?.length ?? 0,
        identical: r.identical?.length ?? 0, backup: r.backup ?? null, bytes: r.bytes ?? 0, error: r.error ?? null,
        marker: r.ok === true ? 'agent.cordis.yml' : null, subdir: r.subdir ?? null, sparse: r.sparse === true,
        mode: r.mode ?? null, existed: r.existed === true,
        skipped: Array.isArray(r.skipped) ? r.skipped : [],
        skippedInvalid: Array.isArray(r.skippedInvalid) ? r.skippedInvalid : [],
        verified: r.verified === null || r.verified === undefined ? null : r.verified.ok === true,
        // 声明行结果（0.5.28 加法）：面板据此显示"已声明为 preset-x（重启实例后可选）"，
        // 或如实显示"文件已就位但没写成声明行" —— 结构字段 + note 两处都下发，绝不只在一处叙述。
        declaration: r.declaration === null || r.declaration === undefined ? null : {
          ok: r.declaration.ok === true, status: r.declaration.status ?? null, rowId: r.declaration.rowId ?? null,
          patchPath: r.declaration.patchPath ?? null, backup: r.declaration.backup ?? null,
          reason: r.declaration.reason ?? null, detail: r.declaration.detail ?? null,
        },
      }))
      job.presetSource = { repo, subdir: fetched.subdir, sparse: fetched.sparse === true, downgraded: fetched.downgraded === true, root: fetched.root }
      // 源码出处落盘：`overwrite-preset` 动作据此**重新取源码**（临时 clone 目录在 finally 里已清理，
      // 所以"仅靠内存里的路径"是做不到的）。只记 repo / 候选名 / 子目录，不记任何路径或凭据。
      try {
        recordPresetSource(reports.filter((r) => r.ok === true).map((r) => ({
          name: r.name, repo, candidateName, subdir: fetched.subdir, sparse: fetched.sparse === true, dest: r.dest,
        })), { home: deps.home, now: deps.now })
      } catch {}
      // 同名冲突 / 校验跳过 → 给面板一个**显式**的「覆盖该预设」按钮（结构化动作，见 plugin-actions.js）。
      // 只在真的有冲突时出现；用户不点，一个字节都不会被覆盖。
      const conflicted = reports.filter((r) => r.ok === true && ((r.skipped?.length ?? 0) > 0 || (r.skippedInvalid?.length ?? 0) > 0))
      if (conflicted.length > 0 && job.suggestedAction === undefined) {
        const first = conflicted[0]
        job.suggestedAction = suggestedOverwritePresetAction({
          presetName: first.name,
          repo,
          reason: `预设 ${first.name} 已存在同名文件（${(first.skipped ?? []).join('、') || '配置未通过校验'}），本次**按默认语义保留了你手上的版本**；如需用仓库版本覆盖，点这个按钮（会先把原目录整份备份）`,
        })
        job.presetOverwriteCandidates = conflicted.map((r) => r.name)
      }
    }
    if (failed.length > 0 && failed.length === reports.length) {
      return { handled: true, installed: false, error: new Error(`预设装配失败：${failed[0].error}`), presets: reports }
    }
    const okNames = reports.filter((r) => r.ok === true).map((r) => r.name)
    const skippedFiles = reports.reduce((sum, r) => sum + (r.skipped?.length ?? 0), 0)
    const invalidFiles = reports.reduce((sum, r) => sum + (r.skippedInvalid?.length ?? 0), 0)
    const backedUp = reports.filter((r) => r.ok === true && typeof r.backup === 'string' && r.backup !== '')
    const note = `预设已装配：${okNames.join('、')}（落盘 ${presetsRoot}）`
      + declarationClauseForReports(reports)
      + (fetched.sparse === true ? '；源码用稀疏取源码（--filter=blob:none --sparse + sparse-checkout set），只取该子包目录' : '')
      + (skipped > 0 ? `；该仓库还有 ${skipped} 个预设本次未装配（单次上限 ${limit} 个）` : '')
      // 默认语义必须在面板上说清（用户要先知道"你的文件没被动过"，才谈得上要不要覆盖）
      + (skippedFiles > 0
        ? `；**预设装配默认只补不覆盖**：${skippedFiles} 个同名文件与你手上的内容不同，已原样保留未动 —— 如需覆盖，请点「覆盖该预设」（会先把原目录整份备份）`
        : '')
      + (invalidFiles > 0
        ? `；${invalidFiles} 个预设配置文件未通过结构校验（非法 YAML），**已跳过未写入**（避免把原本可用的预设写坏）`
        : '')
      + (backedUp.length > 0
        ? `；已存在同名预设 ${backedUp.map((r) => r.name).join('、')}：原目录已备份（${backedUp.map((r) => r.backup).join('、')}），本次覆盖 ${backedUp.reduce((s, r) => s + r.overwritten.length, 0)} 个、内容一致 ${backedUp.reduce((s, r) => s + r.identical.length, 0)} 个`
        : '')
      + (failed.length > 0 ? `；${failed.length} 个预设装配失败：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}` : '')
    return { handled: true, installed: true, name: candidateName, presets: reports, note }
  } finally {
    // 临时目录清理复用既有降级（删不掉就改名成 .trash-*），绝不静默留下垃圾
    try { disposeDir(tmpRoot) } catch {}
  }
}

/** 「覆盖该预设」的**执行体**（0.5.26 加法，修 F2；只由显式动作 `overwrite-preset` 调用）。
 *
 * 为什么需要它：默认语义改成"只补不覆盖"之后，用户必须有**一条明确的出路**才能拿到仓库版本。
 * 这条出路不能靠"临时 clone 目录"——那个目录在 tryPresetSourceChannel 的 finally 里已经清理了，
 * 所以要**按记录重新取一次源码**（记录见 preset-install.js#recordPresetSource），再走
 * `assemblePreset(..., { overwrite: true })`（先整目录备份 → 覆盖 → 写后读回核实）。
 *
 * 安全边界（与 allow-builds / pin-dependency 同一套，配套断言钉死）：
 *   · 只认**已存在**于 `<presetsRoot>/<name>` 的目录，名字由服务端校验（客户端说了不算）；
 *   · 只有**记过源码出处**的预设才能覆盖（没记录 = 不是本控制台装的 → 让它走正常安装流程）；
 *   · 源码通道体积门禁照旧（巨仓不放行）；取源码走既有 gitCloneRepo（不新造进程管理）；
 *   · 本函数**不执行任何客户端传来的字符串**，也不接受任何命令参数。
 *
 * 返回 { ok, status, name, backup, overwritten, added, identical, verified, note, error, reason }。 */
async function overwritePreset({ presetName, deps = {} } = {}) {
  const raw = String(presetName ?? '').trim()
  // 目录名判据与 assemblePreset 完全一致（含"不得含路径分隔符"），这里先做一次**便宜**的拒绝
  if (raw === '' || raw === '.' || raw === '..' || /[\\/]/u.test(raw)) {
    return { ok: false, status: 400, name: raw, error: `预设名不合法：${JSON.stringify(presetName)}` }
  }
  const presetsRoot = deps.presetsRoot ?? join(dshHome(), '.agent-presets')
  const dest = join(presetsRoot, raw)
  if (!existsSync(dest)) {
    return { ok: false, status: 400, name: raw, error: `预设 ${raw} 不存在（${dest}），没有可覆盖的对象 —— 本动作只改已存在的预设` }
  }
  const home = deps.home
  const explicitRepo = typeof deps.repo === 'string' && deps.repo.trim() !== '' ? deps.repo.trim() : null
  const record = presetSourceOf(raw, home)
  const repo = explicitRepo ?? (typeof record?.repo === 'string' && record.repo !== '' ? record.repo : null)
  if (repo === null) {
    return {
      ok: false, status: 400, name: raw,
      error: `没有 ${raw} 的源码出处记录（它可能不是本控制台装配的）。请用市场卡片重新安装这个预设，安装后即可覆盖。`,
    }
  }
  const candidateName = (typeof record?.candidateName === 'string' && record.candidateName !== '') ? record.candidateName : `dsh-${raw}`
  const source = typeof deps.source === 'string' && deps.source !== '' ? deps.source : 'github'
  const gate = await evaluateSourceChannel(repo, deps.sizeDeps ?? {})
  if (gate.allow !== true) {
    return { ok: false, status: 400, name: raw, repo, error: `覆盖需要重新取源码，但源码通道不可用：${gate.note}` }
  }
  const tmpRoot = deps.tmpRoot ?? join(tmpdir(), `dsh-preset-overwrite-${raw}-${Date.now()}`)
  const destClone = join(tmpRoot, 'repo')
  try { mkdirSync(tmpRoot, { recursive: true }) } catch {}
  try {
    const fetched = await fetchPresetSource({ repo, candidateName, dest: destClone, source, timeout: deps.cloneTimeoutMs, deps: deps.fetchDeps ?? {} })
    if (fetched.ok !== true) {
      return { ok: false, status: 200, name: raw, repo, error: `重新取源码失败：${fetched.error}` }
    }
    const subDir = join(fetched.root, ...String(fetched.subdir).split('/'))
    const found = findPresetDirs(subDir, 2)
    if (found.length === 0 && isPresetDir(subDir)) found.push(subDir)
    // 优先取**同名**的那个预设目录（一个子包里可能有多个预设）
    const pick = found.find((p) => basename(p) === raw) ?? found[0] ?? null
    if (pick === null) {
      return { ok: false, status: 200, name: raw, repo, error: `仓库 ${repo} 的 ${fetched.subdir} 里没有找到预设目录` }
    }
    // 覆盖的永远是**用户点名的那一个**名字（不是源目录的 basename）：用户点的是哪个就改哪个
    const patchPath = typeof deps.patchPath === 'string' && deps.patchPath !== '' ? deps.patchPath : null
    const report = await assemblePreset(pick, raw, {
      presetsRoot, overwrite: true, patchPath, ...(deps.now === undefined ? {} : { now: deps.now }),
    })
    if (report.ok !== true) {
      return { ok: false, status: 200, name: raw, repo, backup: report.backup ?? null, error: report.error ?? '覆盖失败（文件未改动）', report }
    }
    // 覆盖后刷新源码出处记录（时间戳更新；repo/子目录可能与旧记录不同）
    try {
      recordPresetSource([{ name: raw, repo, candidateName, subdir: fetched.subdir, sparse: fetched.sparse === true, dest: report.dest }], { home, now: deps.now })
    } catch {}
    return {
      ok: true, status: 200, name: raw, repo, dest: report.dest,
      backup: report.backup, added: report.added, overwritten: report.overwritten, identical: report.identical,
      skippedInvalid: report.skippedInvalid, verified: report.verified, bytes: report.bytes, hashes: report.hashes,
      mode: 'overwrite', note: report.note, error: null,
      reason: `已用仓库 ${repo} 的版本覆盖预设 ${raw}（覆盖 ${report.overwritten.length} 个文件`
        + `${report.overwritten.length > 0 ? `：${report.overwritten.slice(0, 6).join('、')}${report.overwritten.length > 6 ? ' 等' : ''}` : ''}`
        + `、新增 ${report.added.length} 个；原目录已备份到 ${report.backup}）`,
    }
  } finally {
    try { disposeDir(tmpRoot) } catch {}
  }
}

export {
  PRESET_MARKER_FILES, PRESET_MANIFEST_FILE, GIT_READ_TIMEOUT_MS,
  findPresetDirs, isPresetDir, looksLikePresetPackageName, listTreeFiles,
  assemblePreset, locateSubpackageViaGit, fetchPresetSource, gitCapture, tryPresetSourceChannel,
  overwritePreset,
}