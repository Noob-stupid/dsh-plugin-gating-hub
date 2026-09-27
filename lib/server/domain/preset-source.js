// L1 · domain —— preset-source.js（预设型子包的**源码装配**：稀疏取源码 → 定位 → 装配到 ~/.dsh/.agent-presets）
//
// 真机事故（2026-09-27，用户实测 yjh051108/dsh-routing-suite「三件套只装到两件」）：
//   该仓库三件套 = `graded/`（release 有 tgz，已装）、`injector/`（release 有 tgz，已装）、
//   **`preset/`（= dsh-router-standard，「思维模式路由预设」：npm 双 404、release 无资产 →
//   只存在于仓库源码里）**。旧流程对"根包 private"的仓库一刀切禁用源码通道（批次 A-③），
//   于是第三件连一次机会都没有；而"添加并启用"这条路上，按包名的通道（registry/curl/release）
//   对它必然是 404 —— 缺的就是"从仓库里把那一个目录取下来，按预设装配"这条能力。
//
// 本模块提供三件事（**唯一实现**，套装路径与候选路径共用，绝不复制粘贴第二套）：
//   ① findPresetDirs / isPresetDir —— 预设目录识别（从 suite.js **原样搬来**，suite.js 改为 re-export）
//   ② assemblePreset —— 装配一个预设到 `<DSH_HOME>/.agent-presets/<name>`（**已存在同名预设时
//      绝不静默覆盖**：先整目录备份，再逐文件合并；同名不同内容的逐条报告）
//   ③ fetchPresetSource / tryPresetSourceChannel —— 稀疏取源码（`--filter=blob:none --sparse`
//      + `git sparse-checkout set <subdir>`；不支持时降级普通 clone）并装配
//
// 进程管理一律复用 repoland.js 的 runGitArgs / gitCloneRepo（kill-tree + wait-for-exit + `.tryN` +
// `.trash-*` 降级）—— 本模块**不新造任何进程管理**。

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { gitCloneRepo, runGitArgs } from './repoland.js'
import { noteChannel } from './git-channel.js'
import { evaluateSourceChannel } from './repo-size.js'
import { copyTree, disposeDir } from '../infra/fsx.js'
import { dshHome } from '../infra/paths.js'

/** 预设的判别文件（框架发现预设看的就是这个：`~/.dsh/.agent-presets/<name>/agent.cordis.yml`）。 */
const PRESET_MARKER_FILES = ['agent.cordis.yml', 'agent.cordis.yaml']
/** 预设清单（可选，面板文案用）。 */
const PRESET_MANIFEST_FILE = 'preset.yml'
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

/** 读预设清单（preset.yml 的 name/description/order；读不到返回 null，不抛）。 */
function readPresetManifest(dir) {
  try {
    const text = readFileSync(join(dir, PRESET_MANIFEST_FILE), 'utf8')
    const pick = (key) => {
      const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mu'))
      return m === null ? null : m[1].trim().replace(/^["']|["']$/gu, '')
    }
    return { name: pick('name'), description: pick('description'), order: pick('order') }
  } catch {
    return null
  }
}

/** 目录树里的文件清单（相对路径 + 字节数）——只读，best-effort，绝不抛。 */
function listTreeFiles(root, { maxDepth = 8 } = {}) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const child = join(dir, e.name)
      try {
        if (e.isDirectory()) walk(child, depth + 1)
        else if (e.isFile()) out.push({ rel: relative(root, child).split(sep).join('/'), bytes: statSync(child).size })
      } catch {}
    }
  }
  walk(String(root), 0)
  return out
}

/** 装配一个预设到 `<presetsRoot>/<name>`（**唯一实现**）。
 * 已存在同名预设时**绝不静默覆盖**：
 *   ① 先把原目录整份备份成 `<name>.bak-<ts>`（备份失败就**不合并**，如实报冲突）；
 *   ② 再逐文件合并：源里有、目标里没有的算「新增」；两边都有且内容不同的算「覆盖」并逐条列出
 *      （内容相同的算「一致」，只在统计里体现，不刷屏）。
 * 这是**加法**：旧代码（suite.js 里那三行）是 `rmSync(dest)` + `copyTree` —— 用户手上的同名预设
 * 会被无声抹掉（真机 `.agent-presets` 下就有 router-standard / router-spec / router-react 三个在用）。
 * 返回 { ok, name, dest, backup, added, overwritten, identical, conflicts, bytes, note }。 */
function assemblePreset(srcDir, name, { presetsRoot = null, now = Date.now } = {}) {
  const root = presetsRoot ?? join(dshHome(), '.agent-presets')
  const presetName = String(name ?? basename(srcDir)).trim()
  if (presetName === '' || presetName === '.' || /[\\/]/u.test(presetName)) {
    return { ok: false, name: presetName, dest: null, error: `预设目录名不合法：${JSON.stringify(name)}` }
  }
  const dest = join(root, presetName)
  const srcFiles = listTreeFiles(srcDir)
  if (srcFiles.length === 0) return { ok: false, name: presetName, dest, error: `源目录里没有任何文件：${srcDir}` }
  const bytes = srcFiles.reduce((sum, f) => sum + f.bytes, 0)
  let backup = null
  const existed = existsSync(dest)
  if (existed) {
    backup = `${dest}.bak-${now()}`
    try {
      copyTree(dest, backup)
    } catch (error) {
      return {
        ok: false,
        name: presetName,
        dest,
        error: `已存在同名预设且备份失败（绝不在没备份的情况下覆盖）：${error instanceof Error ? error.message : String(error)}`,
        conflicts: srcFiles.map((f) => f.rel),
      }
    }
  }
  mkdirSync(root, { recursive: true })
  const added = []
  const overwritten = []
  const identical = []
  for (const file of srcFiles) {
    const from = join(srcDir, ...file.rel.split('/'))
    const target = join(dest, ...file.rel.split('/'))
    const had = existsSync(target)
    let same = false
    if (had) {
      try { same = readFileSync(target).equals(readFileSync(from)) } catch { same = false }
    }
    if (same) { identical.push(file.rel); continue }
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readFileSync(from))
    } catch (error) {
      return { ok: false, name: presetName, dest, backup, error: `合并 ${file.rel} 失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (had) overwritten.push(file.rel)
    else added.push(file.rel)
  }
  const note = existed
    ? `预设 ${presetName}：已存在同名预设，原目录已备份到 ${backup}；本次合并新增 ${added.length} 个、覆盖 ${overwritten.length} 个同名文件、内容一致 ${identical.length} 个`
      + (overwritten.length > 0 ? `（被覆盖的：${overwritten.slice(0, 6).join('、')}${overwritten.length > 6 ? ' 等' : ''}）` : '')
    : `预设 ${presetName} 已装配到 ${dest}（新增 ${added.length} 个文件）`
  return { ok: true, name: presetName, dest, backup, added, overwritten, identical, conflicts: overwritten, bytes, files: srcFiles.map((f) => f.rel), note }
}

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
    const reports = []
    const skipped = Math.max(0, presets.length - limit)
    for (const p of presets.slice(0, limit)) {
      // eslint-disable-next-line no-await-in-loop
      const report = assemblePreset(p, basename(p), { presetsRoot, ...(deps.now === undefined ? {} : { now: deps.now }) })
      reports.push({ ...report, manifest: readPresetManifest(p), sparse: fetched.sparse === true, subdir: fetched.subdir })
    }
    const failed = reports.filter((r) => r.ok !== true)
    if (job !== null && job !== undefined) {
      job.presetInstalled = reports.map((r) => ({
        name: r.name, dest: r.dest, ok: r.ok === true, added: r.added?.length ?? 0, overwritten: r.overwritten?.length ?? 0,
        identical: r.identical?.length ?? 0, backup: r.backup ?? null, bytes: r.bytes ?? 0, error: r.error ?? null,
        marker: r.ok === true ? 'agent.cordis.yml' : null, subdir: r.subdir ?? null, sparse: r.sparse === true,
      }))
      job.presetSource = { repo, subdir: fetched.subdir, sparse: fetched.sparse === true, downgraded: fetched.downgraded === true, root: fetched.root }
    }
    if (failed.length > 0 && failed.length === reports.length) {
      return { handled: true, installed: false, error: new Error(`预设装配失败：${failed[0].error}`), presets: reports }
    }
    const okNames = reports.filter((r) => r.ok === true).map((r) => r.name)
    // 只要**建过备份**就必须说（哪怕本次一个文件都没覆盖）——否则用户不知道多了一个 .bak 目录，
    // 也不知道"这次其实什么都没改"。
    const merged = reports.filter((r) => r.ok === true && typeof r.backup === 'string' && r.backup !== '')
    const note = `预设已装配：${okNames.join('、')}（落盘 ${presetsRoot}；**新建会话时选择**）`
      + (fetched.sparse === true ? '；源码用稀疏取源码（--filter=blob:none --sparse + sparse-checkout set），只取该子包目录' : '')
      + (skipped > 0 ? `；该仓库还有 ${skipped} 个预设本次未装配（单次上限 ${limit} 个）` : '')
      + (merged.length > 0
        ? `；已存在同名预设 ${merged.map((r) => r.name).join('、')}：原目录已备份（${merged.map((r) => r.backup).join('、')}），本次按文件合并（覆盖 ${merged.reduce((s, r) => s + r.overwritten.length, 0)} 个、内容一致 ${merged.reduce((s, r) => s + r.identical.length, 0)} 个）`
        : '')
      + (failed.length > 0 ? `；${failed.length} 个预设装配失败：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}` : '')
    return { handled: true, installed: true, name: candidateName, presets: reports, note }
  } finally {
    // 临时目录清理复用既有降级（删不掉就改名成 .trash-*），绝不静默留下垃圾
    try { disposeDir(tmpRoot) } catch {}
  }
}

export {
  PRESET_MARKER_FILES, PRESET_MANIFEST_FILE, GIT_READ_TIMEOUT_MS,
  findPresetDirs, isPresetDir, looksLikePresetPackageName, readPresetManifest, listTreeFiles,
  assemblePreset, locateSubpackageViaGit, fetchPresetSource, gitCapture, tryPresetSourceChannel,
}
