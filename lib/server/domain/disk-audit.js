// L1 · domain —— disk-audit.js（`<DSH_HOME>/plugin-console` 的**只读体检** + **用户确认后**的清理；0.5.84 加法）
// 分层分组：L1 · domain（不认识 cordis ctx；读盘/删除全部可注入）
//
// ── 为什么（用户 2026-10 第 7 项）────────────────────────────────────────────────
//   这个目录涨到 2.1 GB：`framework-backups/` 里躺着历次框架升级前的**整棵树**（含全平台 office kit）。
//   用户要的是「先看清楚谁占的，再决定删什么」——**绝不自动删**。
//
// ── 本模块的死规矩（每一条都有测试盯着；违背任何一条都比不清理更糟）───────────────
//   ① **只读体检**：`auditConsoleDir()` 只统计，绝不删、不写、不改任何东西。
//   ② **候选分级**：每一项标 `level`：
//        · 'safe'      —— 删掉不影响任何功能（日志、旧自删守护留下的计数残渣、`*.bak-*` 状态备份、
//                        本机测试残留 `persist-e2e-*`）；
//        · 'tradeoff'  —— 删掉**会失去某种回退能力**（旧版本的框架备份、profile 快照备份）——
//                        必须让人知道代价，仍然允许，但要说清楚；
//        · 'protected' —— **绝不**列为可删：当前回滚点指向的检查点、当前框架版本的备份、
//                        控制台自己的状态文件（compat-* / framework-state.json / install-jobs.json / sources…）。
//       ⚠️ 真机实测（2026-10）：最大的那 2.1 GB 正是 `framework-backups/0.2.0-rc.1` ——
//          而 `framework-rollback.json` 的 `checkpointDir` **就指向它**。所以"最大的那个"恰恰是**不能删**的：
//          删了等于把当前唯一的框架回滚点销毁。判据必须从回滚记录里读，不能按体积猜。
//   ③ **边界**：只允许删 `<root>` 之内、且经 `planCleanup()` 白名单放行的项；任何绝对路径/`..`一律拒。
//   ④ **必须显式确认**：`runCleanup({ confirm: true })` 才动;否则返回 plan（"将删什么、能省多少"）。
//   ⑤ **删完读回核实**：删不干净就如实回报（本仓 fsx.js 记过：Windows 上 rmSync 会静默落空）。
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 单次体检最多统计多少个文件（防止在异常目录上跑到天荒地老；超了如实标记 truncated）。 */
const MAX_FILES = 60000
/** 认为是"日志"的文件名。 */
const LOG_RE = /\.log$/iu
/** 状态备份（旧实现留下的 `.bak-<时间>`）：删了只失去"那时候的状态"。 */
const STATE_BAK_RE = /\.bak-\d/iu
/** 旧实现留下的自删守护计数（0.5.84 的代码已经不再创建它们）。 */
const GUARD_RESIDUE_RE = /^restart-guard-\d+\.count$/iu
/** 本机测试残留（含旧实现留下的 console-restart.log）。 */
const TEST_RESIDUE_RE = /^(?:persist-e2e-|console-restart\.log$)/iu
/** 需要**按子项**展开的目录：判据要细到"哪一份备份"，而不是整个目录一刀切。
 *  为什么必须展开（真机 2026-10 实测）：`framework-backups/` 里 2.1 GB 全在 0.2.0-rc.1 这一份，
 *  而回滚点正好指向它；其余 9 份加起来不到 2 MB。若按顶层整目录判，整块只能标"受保护"⇒
 *  用户永远清不掉那 9 份旧备份；展开成子项后，只有被回滚点引用的那份受保护，其余标 tradeoff。 */
const EXPAND_DIRS = new Set(['framework-backups', 'profile-sync-backups'])
/** 绝不能删的状态文件（名字精确匹配或前缀匹配）。 */
const PROTECTED_FILES = new Set([
  'framework-rollback.json', 'framework-state.json', 'install-jobs.json', 'compat-pending.json',
  'compat-gate.json', 'compat-mode.json', 'compat-ack.json', 'components.json', 'repo-land.json',
  'preset-sources.json', 'auto-preflight.json', 'env-fingerprint.json', 'fw-quarantine.json',
  'fw-quarantine-candidates.json', 'sources.json', 'ai-jobs.json', 'lock-autofix.json',
])
const PROTECTED_PREFIX = ['fw-upgrade-state.txt', 'link-self-sufficiency', 'source-specs', 'safe-boot', 'subdir-src']

/** 递归量体积（字节 + 文件数）；只读，且带 MAX_FILES 上限。 */
function measure(dir, { readdir = readdirSync, stat = statSync, budget = { files: MAX_FILES } } = {}) {
  let bytes = 0
  let files = 0
  let truncated = false
  const walk = (current) => {
    let entries = []
    try {
      entries = readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (budget.files <= 0) { truncated = true; return }
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      budget.files -= 1
      files += 1
      try {
        bytes += stat(full).size
      } catch {}
    }
  }
  walk(dir)
  return { bytes, files, truncated }
}

/** 当前框架回滚记录（读不到返回 null）——**最大的那份备份往往就是它指向的**。 */
function readRollbackPointer({ root, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    const rec = JSON.parse(readFile(join(root, 'framework-rollback.json')))
    return {
      from: typeof rec?.from === 'string' ? rec.from : null,
      to: typeof rec?.to === 'string' ? rec.to : null,
      checkpointDir: typeof rec?.checkpointDir === 'string' ? rec.checkpointDir : null,
      cliBackupDir: typeof rec?.cliBackupDir === 'string' ? rec.cliBackupDir : null,
      at: typeof rec?.at === 'number' ? rec.at : null,
    }
  } catch {
    return null
  }
}

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 100) / 100

/**
 * **只读体检**：返回
 * `{ ok, root, totalBytes, totalFiles, truncated, rollback, entries:[{ id, name, kind, bytes, files, level, reason }], reclaimableBytes, safeBytes }`。
 * `entries` 按体积降序；`level` 见文件头 ②。任何一项都不删、不写。
 */
function auditConsoleDir({ root, deps = {} } = {}) {
  const base = typeof root === 'string' && root !== '' ? resolve(root) : null
  if (base === null) return { ok: false, error: '拿不到 plugin-console 目录', entries: [], totalBytes: 0, totalFiles: 0, truncated: false, rollback: null, reclaimableBytes: 0, safeBytes: 0 }
  if (!existsSync(base)) return { ok: true, root: base, totalBytes: 0, totalFiles: 0, truncated: false, rollback: null, entries: [], reclaimableBytes: 0, safeBytes: 0, note: '目录还不存在（没产生过备份/日志）' }
  const readdir = deps.readdir ?? readdirSync
  const stat = deps.stat ?? statSync
  const rollback = readRollbackPointer({ root: base, ...(deps.readFile === undefined ? {} : { readFile: deps.readFile }) })
  const budget = { files: MAX_FILES }
  let names = []
  try {
    names = readdir(base)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), entries: [], totalBytes: 0, totalFiles: 0, truncated: false, rollback, reclaimableBytes: 0, safeBytes: 0 }
  }
  const entries = []
  let totalBytes = 0
  let totalFiles = 0
  let truncated = false
  for (const name of names) {
    const full = join(base, name)
    let isDir = false
    let fileBytes = 0
    try {
      const st = stat(full)
      isDir = st.isDirectory()
      if (!isDir) fileBytes = st.size
    } catch {
      continue
    }
    if (isDir && EXPAND_DIRS.has(name)) {
      // 展开成子项（见 EXPAND_DIRS 的注释：判据要细到"哪一份备份"）
      let children = []
      try {
        children = readdir(full)
      } catch {
        children = []
      }
      for (const child of children) {
        const childFull = join(full, child)
        let childIsDir = false
        try {
          childIsDir = stat(childFull).isDirectory()
        } catch {
          continue
        }
        const m = childIsDir ? measure(childFull, { readdir, stat, budget }) : { bytes: stat(childFull).size, files: 1, truncated: false }
        if (m.truncated) truncated = true
        totalBytes += m.bytes
        totalFiles += m.files
        entries.push({ id: `${name}/${child}`, name: child, parent: name, full: childFull, isDir: childIsDir, bytes: m.bytes, files: m.files })
      }
      continue
    }
    let bytes = fileBytes
    let files = isDir ? 0 : 1
    if (isDir) {
      const m = measure(full, { readdir, stat, budget })
      bytes = m.bytes
      files = m.files
      if (m.truncated) truncated = true
    }
    totalBytes += bytes
    totalFiles += files
    entries.push({ id: name, name, parent: null, full, isDir, bytes, files })
  }
  // ── 分级（唯一判据；面板与清理都不许另判一套）──────────────────────────────────
  const inRollback = []
  for (const p of [rollback?.checkpointDir, rollback?.cliBackupDir]) {
    if (typeof p === 'string' && p !== '') inRollback.push(resolve(p))
  }
  const classify = (entry) => {
    const { name, full, isDir, parent } = entry
    // ① 回滚点指向的东西：绝不列为可删（真机实测：最大的 2.1 GB 就是这个）
    if (inRollback.some((p) => resolve(full) === p || resolve(full) === resolve(p, '..') || p.startsWith(resolve(full) + sep))) {
      return { level: 'protected', reason: '当前框架回滚点（framework-rollback.json）指向这里 —— 删掉就等于销毁唯一的回滚点' }
    }
    // ② 纯垃圾类（**先于**状态文件判据：`fw-upgrade-state.txt.bak-<时间>` 是那份状态的旧备份，
    //    删它不丢当前状态；而 `fw-upgrade-state.txt` 本身仍然受下面的前缀保护）
    if (!isDir && (LOG_RE.test(name) || GUARD_RESIDUE_RE.test(name) || STATE_BAK_RE.test(name) || TEST_RESIDUE_RE.test(name))) {
      return { level: 'safe', reason: LOG_RE.test(name) ? '日志：删了只是丢历史输出'
        : GUARD_RESIDUE_RE.test(name) ? '旧实现自删守护留下的计数残渣（现在的代码已不创建）'
          : STATE_BAK_RE.test(name) ? '旧状态文件的 .bak 备份（当前状态文件不在清理范围）'
            : '本机测试残留' }
    }
    if (isDir && TEST_RESIDUE_RE.test(name)) return { level: 'safe', reason: '本机测试残留' }
    // ③ 控制台状态：一律不许动
    if (PROTECTED_FILES.has(name) || PROTECTED_PREFIX.some((p) => name === p || name.startsWith(p))) {
      return { level: 'protected', reason: '控制台状态文件/受保护目录（删了会丢配置、记录或已安装子目录插件的源码）' }
    }
    // ④ 展开出来的子项（framework-backups/<版本> / profile-sync-backups/<快照>）
    if (parent === 'framework-backups') {
      return { level: 'tradeoff', reason: '某一版本框架升级前的整棵树备份：删掉会失去回滚到该版本的能力（当前回滚点引用的那一份不在此列）' }
    }
    if (parent === 'profile-sync-backups') {
      return { level: 'tradeoff', reason: '某一次 profile 快照备份：删掉会失去那一次的快照，不影响当前运行' }
    }
    if (isDir && (name === 'backups' || /^pre-upgrade-snapshot-/u.test(name))) {
      return { level: 'tradeoff', reason: '历史快照备份：删掉会失去那几次的快照，不影响当前运行' }
    }
    if (isDir && name === 'release-0.5.38') {
      return { level: 'tradeoff', reason: '旧版本的发布物副本：不影响当前运行' }
    }
    return { level: 'protected', reason: '未知/状态类条目：不在清理白名单里（宁可不删）' }
  }
  const graded = entries.map((entry) => {
    const g = classify(entry)
    return {
      id: entry.id,
      name: entry.name,
      parent: entry.parent ?? null,
      kind: entry.isDir ? 'dir' : 'file',
      mb: mb(entry.bytes),
      bytes: entry.bytes,
      files: entry.files,
      level: g.level,
      reason: g.reason,
    }
  }).sort((a, b) => b.bytes - a.bytes)
  const reclaimable = graded.filter((e) => e.level === 'safe' || e.level === 'tradeoff')
  const safe = graded.filter((e) => e.level === 'safe')
  return {
    ok: true,
    root: base,
    totalBytes,
    totalFiles,
    totalMb: mb(totalBytes),
    truncated,
    rollback,
    entries: graded,
    reclaimableBytes: reclaimable.reduce((sum, e) => sum + e.bytes, 0),
    reclaimableMb: mb(reclaimable.reduce((sum, e) => sum + e.bytes, 0)),
    safeBytes: safe.reduce((sum, e) => sum + e.bytes, 0),
    safeMb: mb(safe.reduce((sum, e) => sum + e.bytes, 0)),
  }
}

/**
 * 清理**计划**（纯函数，不删任何东西）：把用户点名的 id 过一遍白名单与边界。
 * @returns {{ ok, plan:[{id,bytes,level}], refused:[{id,reason}], freedBytes, note }}
 *   · 只接受 `audit.entries` 里出现过的 id；`protected` 一律拒绝并说明为什么；
 *   · 任何包含 `/` `\` `..` 的 id 直接拒绝（路径穿越）。
 */
function planCleanup({ audit, ids } = {}) {
  const list = Array.isArray(ids) ? ids : (typeof ids === 'string' && ids !== '' ? [ids] : [])
  const byName = new Map((Array.isArray(audit?.entries) ? audit.entries : []).map((e) => [e.id, e]))
  const plan = []
  const refused = []
  for (const raw of list) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id === '') continue
    // 允许 `name` 或 `父目录/子项`（只展开一层：framework-backups/<版本>、profile-sync-backups/<快照>）；
    // 任何 `..`、绝对路径、多级路径一律拒 —— 删东西的口子越小越好。
    if (id === '..' || id === '.' || id.startsWith('/') || /^[A-Za-z]:/u.test(id) || (id.match(/\//gu) ?? []).length > 1 || /\\/u.test(id) || id.includes('..')) {
      refused.push({ id, reason: '不是本目录下的条目名（拒绝路径穿越）' })
      continue
    }
    const entry = byName.get(id)
    if (entry === undefined) { refused.push({ id, reason: '体检结果里没有这一项（请先做一次体检）' }); continue }
    if (entry.level === 'protected') { refused.push({ id, reason: entry.reason }); continue }
    plan.push({ id, bytes: entry.bytes, mb: entry.mb, level: entry.level, reason: entry.reason })
  }
  return {
    ok: refused.length === 0 && plan.length > 0,
    plan,
    refused,
    freedBytes: plan.reduce((sum, p) => sum + p.bytes, 0),
    freedMb: mb(plan.reduce((sum, p) => sum + p.bytes, 0)),
    note: plan.length === 0 ? (refused.length === 0 ? '没有指定要清理的条目' : '所有指定条目都被拒绝了') : null,
  }
}

/**
 * **真的删**（只有在 `confirm === true` 时才会动）：删前再过一次 planCleanup，删后读回核实。
 * @returns {{ ok, applied:boolean, removed:[], failed:[{id,reason}], needsConfirm:boolean, freedBytes, freedMb, plan }}
 */
function runCleanup({ root, audit, ids, confirm = false, deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const remove = deps.remove ?? ((p) => rmSync(p, { recursive: true, force: false }))
  const planResult = planCleanup({ audit, ids })
  const base = typeof root === 'string' && root !== '' ? resolve(root) : (typeof audit?.root === 'string' ? resolve(audit.root) : null)
  if (base === null) return { ok: false, applied: false, needsConfirm: false, removed: [], failed: [], freedBytes: 0, freedMb: 0, plan: planResult, error: '拿不到 plugin-console 目录' }
  if (confirm !== true) {
    // 没确认 ⇒ 只回计划（面板据此渲染"确认清理"按钮），**一个文件都不动**
    return { ok: false, applied: false, needsConfirm: true, removed: [], failed: [], freedBytes: 0, freedMb: 0, plan: planResult, note: '需要显式确认（confirm:true）才会删除；未确认前后一个字都没动' }
  }
  const removed = []
  const failed = []
  let freed = 0
  for (const item of planResult.plan) {
    const target = resolve(base, item.id)
    // 边界：目标必须在 root 之内（resolve 过，`..` 已经被 planCleanup 挡掉，这里是第二道）
    if (!target.startsWith(resolve(base) + sep)) {
      failed.push({ id: item.id, reason: '目标不在 plugin-console 目录内（拒绝删除）' })
      continue
    }
    try {
      remove(target)
    } catch (error) {
      failed.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    // 读回核实：Windows 上 rmSync 可能静默落空（infra/fsx.js 记过这类事）
    if (exists(target)) {
      failed.push({ id: item.id, reason: '删除后目录仍在（静默落空）' })
      continue
    }
    removed.push({ id: item.id, bytes: item.bytes, mb: item.mb })
    freed += item.bytes
  }
  return {
    ok: failed.length === 0 && removed.length > 0,
    applied: true,
    needsConfirm: false,
    removed,
    failed,
    freedBytes: freed,
    freedMb: mb(freed),
    plan: planResult,
    note: failed.length === 0
      ? `已清理 ${removed.length} 项，释放约 ${mb(freed)} MB`
      : `清理了 ${removed.length} 项（约 ${mb(freed)} MB），但有 ${failed.length} 项没清干净（原因见 failed）`,
  }
}

export {
  GUARD_RESIDUE_RE, LOG_RE, MAX_FILES, PROTECTED_FILES, PROTECTED_PREFIX, STATE_BAK_RE, TEST_RESIDUE_RE,
  auditConsoleDir, measure, planCleanup, readRollbackPointer, runCleanup,
}
