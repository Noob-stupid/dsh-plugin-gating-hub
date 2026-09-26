// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra

import { existsSync, rmSync, readdirSync, mkdirSync, copyFileSync, chmodSync, lstatSync, renameSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 递归复制目录树（绕开 fs.cpSync 在本环境的目录复制 EIO bug：
 * cpSync 复制含子目录的树必报 `EIO, Access is denied`，而逐文件 copyFileSync 正常）。
 * 跳过 .git（技能/包副本不需要版本库元数据）。
 */

/** 清理陈旧包目录与 pnpm _tmp_ 残留（Windows 原子替换 EPERM 的根因），返回清理数量。 */

/** 串行化补丁文件写入，避免并发 toggle 的读改写竞争。 */

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to)
    } else if (entry.isFile()) {
      copyFileSync(from, to)
    }
  }
}
function queuedWrite(fn) {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}
function cleanupStalePackageDir(profileDir, packageName) {
  const segments = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  const dir = join(profileDir, 'node_modules', ...segments)
  const base = basename(dir)
  const parent = dirname(dir)
  let removed = 0
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
    }
  } catch {}
  try {
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(`${base}_tmp_`)) {
        try {
          rmSync(join(parent, entry), { recursive: true, force: true })
          removed += 1
        } catch {}
      }
    }
  } catch {}
  return removed
}
let writeQueue = Promise.resolve()

/**
 * 删除目录树并**核实删除结果**。
 * 为什么要核实：本机某些环境（受限令牌/沙箱/杀软占用）下 `rmSync` 会**静默落空**——不抛错、目录仍在。
 * 路由若删完直接 `{ok:true}` 就是对用户撒谎（2026-09-20 多类型演练实测：同一个 `rmSync` 在
 * `D:\dsh\repos` 删得掉，在 `C:\Users\<user>\.dsh\...` 下返回成功但目录原封不动）。
 * 返回 `{ok, attempts, error}`；`ok:false` 时调用方必须如实报错，不能吞。
 */
function removeDirVerified(dir) {
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch (error) {
      lastError = error
    }
    if (!existsSync(dir)) return { ok: true, attempts: attempt }
  }
  return { ok: false, attempts: 2, error: lastError instanceof Error ? lastError.message : null }
}

/**
 * 清掉树里的只读位（Windows 上 `rmSync` 遇只读文件直接 EPERM，`force` **不会**替你清属性）。
 * 返回清掉的文件数，供日志核对。
 */
function clearReadonly(dir) {
  let cleared = 0
  const walk = (p) => {
    let st = null
    try { st = lstatSync(p) } catch { return }
    try {
      if (st.isDirectory()) {
        for (const name of readdirSync(p)) walk(join(p, name))
      } else if ((st.mode & 0o200) === 0) {
        chmodSync(p, 0o666)
        cleared += 1
      }
    } catch {}
  }
  walk(dir)
  return cleared
}

/** 轮询等待目录真的消失（Windows「删除挂起」期间名字仍可见，立刻 existsSync 会误判失败）。 */
function waitGone(dir, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const tick = () => {
      if (!existsSync(dir)) { resolve(true); return }
      if (Date.now() - startedAt >= timeoutMs) { resolve(false); return }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/** 外部删除兜底：实测本机 PowerShell/.NET 能删掉 Node `rmSync` 静默删不掉的树。 */
async function removeViaShell(dir, timeoutMs = 120000) {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true, timeout: timeoutMs })
      return { ok: true, method: 'rmdir' }
    }
    await execFileAsync('rm', ['-rf', '--', dir], { timeout: timeoutMs })
    return { ok: true, method: 'rm' }
  } catch (error) {
    return { ok: false, method: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 强化版目录删除（清理残余专用，2026-09-24 真机诊断后新增）：
 *   ① 清只读位 → ② `rmSync` → ③ **轮询核实**（容忍删除挂起）→ ④ 失败则外部 `rmdir /s /q` 兜底 → ⑤ 再核实。
 * 为什么不能只用 `rmSync` + 立刻 `existsSync`：真机上出现过「`rmSync` 不抛错、目录仍在」，
 * 面板于是报「有 N 项没能删除（目录仍存在）——当前环境可能禁止删除」，把用户引向并不存在的权限问题；
 * 实测同一棵树用 .NET/PowerShell 能删掉，所以这里补上兜底与轮询，并把真实错误码带回去。
 * `shellTimeoutMs` 是 2026-09-26 的加法参数（默认 120000＝旧行为），只为后台清理用：它不想让一条
 * 卡住的 `rmdir` 占着两分钟。 */
async function removeDirVerifiedAsync(dir, { attempts = 2, pollMs = 600, shellTimeoutMs = 120000 } = {}) {
  let lastError = null
  let method = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!existsSync(dir)) return { ok: true, attempts: attempt, method: method ?? 'already-gone', error: null }
    try { clearReadonly(dir) } catch {}
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch (error) {
      lastError = error
    }
    if (await waitGone(dir, pollMs)) return { ok: true, attempts: attempt, method: 'rmSync', error: null }
    const shell = await removeViaShell(dir, shellTimeoutMs)
    if (shell.ok && await waitGone(dir, pollMs * 3)) return { ok: true, attempts: attempt, method: shell.method, error: null }
    if (shell.error !== undefined && shell.error !== null) lastError = shell.error
  }
  const detail = lastError === null
    ? '删除后目录仍存在（未抛出错误：Windows 删除挂起或占用）'
    : `${lastError.code ?? ''} ${lastError.message ?? lastError}`.trim()
  return { ok: false, attempts, method: null, error: detail }
}

/**
 * 「带重试的核实删除」（2026-09-26 真机加法）：专治 Windows「杀完进程但句柄晚一拍释放」。
 * 真机证据：git 整棵树已经杀干净（`git` 进程 0），可上一次尝试里 `removeDirVerified` **一次**判失败，
 * 就被上游当成「残留被占用」写进用户可见的错误里。
 * 每一轮都：`removeDirVerified` → 等 pollMs → 仍不消失就**外部 `rmdir /s /q` 兜底**（同步版）→ 再核实。
 * 为什么要外部兜底（2026-09-26 本机实测）：同一个 `rmSync(…, {recursive:true, force:true, maxRetries:3})`
 *   在 `C:\Users\<user>\AppData\Local\Temp\…` 下**不抛错、目录原封不动**，而 `cmd /c rmdir /s /q` 一次就删掉
 *   （与 removeDirVerifiedAsync 已有的兜底同源，这里补上同步版）。只有确实清不掉才回 ok:false。
 * 注：`Atomics.wait` 是 Node 里唯一可靠的同步 sleep（本函数是同步签名，调用点都在同步清理路径上）。
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {}
}

/** 外部删除兜底（同步版）：实测本机 `cmd /c rmdir /s /q` 能删掉 Node `rmSync` 静默删不掉的树。 */
function removeViaShellSync(dir, timeoutMs = 120000) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true, timeout: timeoutMs, stdio: 'ignore' })
      return { ok: true, method: 'rmdir' }
    }
    execFileSync('rm', ['-rf', '--', dir], { timeout: timeoutMs, stdio: 'ignore' })
    return { ok: true, method: 'rm' }
  } catch (error) {
    return { ok: false, method: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function removeDirVerifiedWithRetry(dir, { attempts = 3, pollMs = 250, remover = removeDirVerified, shellRemover = removeViaShellSync, viaShell = true } = {}) {
  if (!existsSync(dir)) return { ok: true, attempts: 0, rounds: 1, method: 'already-gone', error: null }
  let last = { ok: false, attempts: 0, error: null }
  for (let round = 1; round <= attempts; round += 1) {
    last = remover(dir)
    if (last !== null && last !== undefined && last.ok === true) return { ok: true, attempts: last.attempts ?? 0, rounds: round, method: 'rmSync', error: null }
    sleepSync(pollMs)
    if (!existsSync(dir)) return { ok: true, attempts: last?.attempts ?? 0, rounds: round, method: 'rmSync(等待后消失)', error: null }
    if (viaShell === true) {
      const shell = shellRemover(dir)
      sleepSync(pollMs)
      if (!existsSync(dir)) return { ok: true, attempts: last?.attempts ?? 0, rounds: round, method: shell === null || shell === undefined ? null : shell.method, error: null }
      if (shell !== null && shell !== undefined && shell.ok !== true) last = { ...last, error: shell.error ?? last?.error ?? null }
    }
  }
  return { ok: false, attempts: last?.attempts ?? 0, rounds: attempts, method: null, error: last?.error ?? null }
}

/** 「删除失败就改名降级」用的占用判据（2026-09-26 加法）。
 * 借自 2BingLing/dsh-market 的 plugin/core/src/installer.ts#isLockFailure（正则逐字沿用）：
 * 命中即"占用/权限类失败"——这类失败**重试也不会好**，该做的是把目录改名让开、交给后台清理，
 * 而不是把「请手动删除」甩给用户。 */
function isLockFailure(outputOrMessage) {
  return /EPERM|EACCES|EBUSY|being used by another process|resource busy|in use by another|Access is denied|Cannot create file/iu.test(String(outputOrMessage ?? ''))
}

const TRASH_PREFIX = '.trash-'
const TRASH_RE = /^\.trash-\d+-[A-Za-z0-9]{1,16}$/u
const TRASH_SCAN_MAX_DEPTH = 2
const TRASH_CLEAN_LIMIT = 20
const TRASH_CLEAN_ITEM_MS = 1000

/** `.trash-<时间戳>-<随机>`：与目标**同父目录**（同卷 rename 才可能成功）。 */
function trashPathFor(dir, { now = Date.now, random = Math.random } = {}) {
  const suffix = Math.floor(random() * 0xffffffff).toString(36).slice(0, 8) || '0'
  return join(dirname(dir), `${TRASH_PREFIX}${now()}-${suffix}`)
}

/**
 * 目录删除的唯一健壮入口（2026-09-26 加法）：**先删，删不掉就改名降级**。
 *   ① `removeDirVerifiedWithRetry`（清只读位 → rmSync → 轮询核实 → `rmdir /s /q` 兜底，3 轮 × 250ms）
 *   ② 仍失败 → 同父目录 rename 成 `.trash-<ts>-<rand>`，返回 `{ status:'trashed', trashPath }`
 * 为什么 rename 能救（做法借自 2BingLing/dsh-market 的 `.bak-<ts>` + renameSync）：
 * rename **不动目录内容**、只改目录项，所以"目录里有进程正在用的文件"这类占用通常挡不住它；
 * 改完原路径就空出来了，调用方可以继续（install 能落新包、`.tryN` 能重来、卸载能收尾）。
 * ⚠️ 实测边界（2026-09-26 本机探针，真机段见 tests/test-trash-fallback.mjs）——占用形态决定成败：
 *    · 目录里有**正在运行的 exe**（该文件句柄带 FILE_SHARE_DELETE）→ 删不掉，但**改名成功** ✅
 *    · 目录是活进程的 cwd → 改名 EBUSY（内核不允许改 cwd 的名字）
 *    · 目录内有以 share=None 打开的**文件句柄** → 改名 EPERM（父目录项被锁）
 *   后两种改名也失败时如实返回 `status:'failed'` + 明确原因；**任何分支都不再出现「请手动删除」**，
 *   因为后台清理（cleanupTrashDirs）会继续试、下一次安装前也会再试。
 * 返回：`{ status:'removed'|'trashed'|'failed', removed, trashed, ok, path, trashPath, reason,
 *          attempts, rounds, method, lockFailure }` —— `ok` 的含义是"**原路径已经让开**"。
 * deps（remover/removerOpts/rename/exists/now/random）只为单测注入，生产调用不传。 */
function disposeDir(dir, deps = {}) {
  const {
    remover = removeDirVerifiedWithRetry,
    removerOpts = {},
    rename = renameSync,
    exists = existsSync,
    now = Date.now,
    random = Math.random,
  } = deps
  const target = String(dir ?? '')
  const base = { path: target, trashPath: null, attempts: 0, rounds: 0, method: null, lockFailure: false }
  if (target === '') return { ...base, status: 'failed', removed: false, trashed: false, ok: false, reason: '没有给出目录路径' }
  if (!exists(target)) return { ...base, status: 'removed', removed: true, trashed: false, ok: true, reason: 'already-gone', method: 'already-gone' }
  let first = null
  try {
    first = remover(target, removerOpts)
  } catch (error) {
    first = { ok: false, attempts: 0, rounds: 0, error: error instanceof Error ? error.message : String(error) }
  }
  const attempts = first?.attempts ?? 0
  const rounds = first?.rounds ?? 0
  const reason = first?.error ?? '删除后目录仍存在（未抛出错误：Windows 删除挂起或占用）'
  if (first?.ok === true) {
    return { ...base, status: 'removed', removed: true, trashed: false, ok: true, reason: first.method ?? 'rmSync', attempts, rounds, method: first.method ?? 'rmSync' }
  }
  // ② 改名降级：同父目录（同卷）；候选名撞了就换一个（最多 3 次）
  // lockFailure 的判据除了 isLockFailure 的正则，还包括"**没报错但目录仍在**"这种静默失败 ——
  // removeDirVerifiedWithRetry 自己把这种形态注释为「Windows 删除挂起或占用」，真机实测也确实如此
  // （占用中 rmSync 不抛、目录原封不动）。判成占用，前端口径才与事实一致；判错的代价只是措辞。
  const lockFailure = isLockFailure(reason) || first?.error === null || first?.error === undefined
  let trashPath = null
  let renameError = null
  for (let round = 0; round < 3 && trashPath === null; round += 1) {
    const candidate = trashPathFor(target, { now, random })
    try {
      if (exists(candidate)) { renameError = new Error(`降级目标名已存在：${basename(candidate)}`); continue }
      rename(target, candidate)
      trashPath = candidate
    } catch (error) { renameError = error }
  }
  if (trashPath === null) {
    const detail = renameError instanceof Error ? renameError.message : String(renameError ?? '未知')
    return { ...base, status: 'failed', removed: false, trashed: false, ok: false, attempts, rounds, lockFailure, reason: `${lockFailure ? '目录被占用' : '删除未成功'}，改名降级也失败（${detail}）；原删除失败原因：${reason}` }
  }
  return { ...base, status: 'trashed', removed: false, trashed: true, ok: true, trashPath, reason, attempts, rounds, method: 'rename', lockFailure }
}

/** 面向前端的短句（纯函数，单测覆盖）：**不再出现「请手动删除」**——
 * 删不掉时我们自己做了 rename 降级 + 后台重试，用户不需要去命令行干活。 */
function disposeNote(result) {
  const status = result?.status
  if (status === 'removed') return '已删除'
  if (status === 'trashed') {
    const name = basename(String(result?.trashPath ?? '')) || `${TRASH_PREFIX}*`
    return `${result?.lockFailure === true ? '目录正被占用' : '删除未成功'}，已改名降级为 ${name}（${TRASH_PREFIX}*），稍后自动清理`
  }
  return `删除未成功，改名降级也没成（${result?.reason ?? '原因未知'}）；控制台会在后台自动重试清理`
}

/** 常见降级目录扫描根：系统 tmpdir + profile 的 node_modules（含一级作用域目录）+ 调用方补充的目录（如 repos 根）。 */
function trashScanRoots({ profileDir = '', extra = [] } = {}) {
  const roots = [tmpdir()]
  if (typeof profileDir === 'string' && profileDir !== '') roots.push(join(profileDir, 'node_modules'))
  for (const dir of Array.isArray(extra) ? extra : [extra]) if (typeof dir === 'string' && dir !== '') roots.push(dir)
  return roots
}

/** 扫出根目录下（深度 ≤ maxDepth）的 `.trash-*`，按名字升序（= 由旧到新，先清最老的）。
 * 任何一步读不到就跳过、绝不抛 —— 后台清理是尽力而为，不能让一个坏目录把主流程带崩。 */
function findTrashDirs(roots, { maxDepth = TRASH_SCAN_MAX_DEPTH, limit = 40, readdir = readdirSync, exists = existsSync } = {}) {
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > maxDepth) return
    let entries
    try { entries = readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (!entry.isDirectory()) continue
      if (TRASH_RE.test(entry.name)) { out.push(join(dir, entry.name)); continue }
      if (depth < maxDepth) walk(join(dir, entry.name), depth + 1)
    }
  }
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    const dir = String(root ?? '')
    if (dir === '') continue
    try { if (exists(dir)) walk(dir, 1) } catch {}
  }
  return out.sort()
}

/** 后台清理 `.trash-*`（2026-09-26 加法：尽力而为、绝不阻塞主流程、绝不抛）：
 * 扫 tmpdir / profile node_modules / repos 等根目录下的降级目录，能删就删，删不掉留着下次；
 * 上限：最多处理 limit 个（默认 20）、单个最多等 perItemMs（默认 1000ms，到点就不管它、继续下一个）；
 * 任何异常都吞掉只记日志。返回 `{ scanned, removed, kept, skipped, more, ms, dirs, error }`（如实，不假装成功）：
 * `scanned` 是本次**扫到**的数量（扫到 limit+1 就收手 → `more:true` 表示盘上还有更多）、
 * `skipped` = 扫到但没处理的数量。deps（remover/find/now/log）只为单测注入。 */
async function cleanupTrashDirs({
  roots = [tmpdir()],
  limit = TRASH_CLEAN_LIMIT,
  perItemMs = TRASH_CLEAN_ITEM_MS,
  maxDepth = TRASH_SCAN_MAX_DEPTH,
  remover = removeDirVerifiedAsync,
  find = findTrashDirs,
  now = Date.now,
  log = null,
} = {}) {
  const startedAt = now()
  const stats = { scanned: 0, removed: 0, kept: 0, skipped: 0, more: false, ms: 0, dirs: [], error: null }
  try {
    const found = find(roots, { maxDepth, limit: limit + 1 }) ?? []
    stats.scanned = found.length
    stats.skipped = Math.max(0, found.length - limit)
    stats.more = found.length > limit // 扫到 limit+1 就收手：盘上至少还有更多（如实标注，不假装扫全了）
    for (const dir of found.slice(0, limit)) {
      try {
        const timeout = new Promise((resolved) => {
          // 注意：这里**不能** unref —— 单个删不掉的降级目录会让事件循环无事可做，
          // unref 过的定时器不阻止退出，本函数就会"永远不 settle"（本测试抓到的真实缺陷）。
          setTimeout(() => resolved({ ok: false, method: null, error: `超过 ${perItemMs}ms 没删完（留到下次）` }), perItemMs)
        })
        // eslint-disable-next-line no-await-in-loop
        const r = await Promise.race([remover(dir, { attempts: 1, pollMs: Math.min(400, Math.max(0, perItemMs)), shellTimeoutMs: Math.max(4000, perItemMs * 4) }), timeout])
        if (r?.ok === true) { stats.removed += 1; stats.dirs.push({ path: dir, ok: true, method: r.method ?? null }) }
        else { stats.kept += 1; stats.dirs.push({ path: dir, ok: false, error: r?.error ?? null }) }
      } catch (error) {
        stats.kept += 1
        stats.dirs.push({ path: dir, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error)
  }
  stats.ms = now() - startedAt
  try {
    if (typeof log === 'function') log(`[trash] 扫描 ${stats.scanned} 个 ${TRASH_PREFIX}*，删除 ${stats.removed}、保留 ${stats.kept}、跳过 ${stats.skipped}，用时 ${stats.ms}ms`)
  } catch {}
  return stats
}

/** 启动钩子/安装前调用的**即发即忘**入口：绝不抛、绝不阻塞调用方（返回的 promise 自带兜底 catch）。 */
function startTrashCleanup(opts = {}) {
  try {
    return Promise.resolve(cleanupTrashDirs(opts)).catch((error) => ({ scanned: 0, removed: 0, kept: 0, skipped: 0, ms: 0, dirs: [], error: error instanceof Error ? error.message : String(error) }))
  } catch (error) {
    return Promise.resolve({ scanned: 0, removed: 0, kept: 0, skipped: 0, ms: 0, dirs: [], error: error instanceof Error ? error.message : String(error) })
  }
}

export { copyTree, queuedWrite, cleanupStalePackageDir, removeDirVerified, removeDirVerifiedAsync, removeDirVerifiedWithRetry, removeViaShellSync, sleepSync, clearReadonly, waitGone, removeViaShell, writeQueue, isLockFailure, trashPathFor, disposeDir, disposeNote, trashScanRoots, findTrashDirs, cleanupTrashDirs, startTrashCleanup, TRASH_PREFIX, TRASH_RE, TRASH_CLEAN_LIMIT, TRASH_CLEAN_ITEM_MS }