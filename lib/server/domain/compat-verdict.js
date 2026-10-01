// L1 · domain —— compat-verdict.js（适配门结论的**判据版本戳** + 过期结论的读取代发重算；0.5.34 加法）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言）
//
// ── 真机背景（2026-10-01，用户实测）────────────────────────────────────────────────
// `~/.dsh/plugin-console/compat-pending.json` 里 `dshmarket` 的记录仍是
//   `check:"fail"` + `checkNote:"源码仍引用 0.1.2 起已删除的 dsh-settings API（…）——实际不兼容…"`
// —— 那是 **0.5.33 收紧判据之前**的误报结论（真机复核：现在 0 命中）。面板照旧把它当事实展示
// （「实际不兼容，启用会让整个服务启动崩溃」+「待适配」永久钉住），**持续误导用户**。
//
// ── 本模块只做两件事（**不放宽任何判据**）──────────────────────────────────────────
//   ① 给结论打**判据版本戳**：记录里的 `scanVerdict.version` 标明"这条结论是哪一版判据算的"
//      （戳来自 settings-api-scan.js 的 `SCAN_CRITERIA_VERSION`，判据改一次就要改它）。
//   ② **读取代发**：读清单时若记录的戳落后于当前判据 → 用**当前判据只读重算**
//      · 结论变了 → 回写（`check` / `checkNote` / `scanVerdict`，含 previous + rescinded + 来源证据）
//      · 结论没变 → **零写盘**（幂等；同一条记录不会每次读都写盘）
//      · 包解析不到 → 不猜：如实标注"无法复核"（保留旧结论，绝不假装成当前判据的结论）
//   `fail` 永远不会因为"戳旧"就被改成 `pass` —— 只有**真的用当前判据重算**出非 fail 才算撤回；
//   真不兼容的（重算仍 fail）一个字都不动。
//
// 行数预算：独立模块，留在 600 行架构硬顶内。

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'
import { SCAN_CRITERIA_VERSION } from './settings-api-scan.js'

/**
 * 进程内重算备忘（纯性能，不影响判据）："结论未变 ⇒ 不写盘"意味着记录上的判据戳**一直是旧的**，
 * 于是每次 `GET /state`（面板每隔几秒轮询一次）都会对同一批包重跑源码扫描（单包上限 120 文件 / 400KB）。
 * 键含包路径 + 版本 + package.json 的 mtime：包一变（升级/改源码）就重算，包没变就复用。
 */
const VERDICT_MEMO = new Map()
const MEMO_LIMIT = 200

/** 判据版本戳（当前判据的版本；判据变了就跟着 settings-api-scan.js 一起变）。 */
const SCANNER_VERSION = SCAN_CRITERIA_VERSION

/** 适配门清单文件（原在 compat.js；0.5.34 搬到本模块，供"读取代发"一处收口）。 */
const compatPendingFile = () => join(dshHome(), 'plugin-console', 'compat-pending.json')

/**
 * 「这条禁用记录是我们自己写进去的」判据（纯函数）。
 * 只有这类记录才允许在**误报被撤回**时给用户一键解锁入口 —— 用户手写的禁用块不在此列。
 */
const SELF_INFLICTED_SOURCES = new Set([
  'preflight-disabled-before-upgrade', // 框架升级前的预扫（dshmarket 就是这条）
  'boot-quarantine',                   // 启动失败隔离
  'auto-preflight',                    // 指纹变化自动预检
])
function isSelfInflictedSource(source) {
  return typeof source === 'string' && SELF_INFLICTED_SOURCES.has(source)
}

/** 记录上的判据戳（缺失 = 旧时代结论：必须重算）。 */
function stampOf(record) {
  const s = record?.scanVerdict
  if (s === null || typeof s !== 'object') return { version: null, decision: null, reason: null, at: null, rescinded: false, evidence: null }
  return {
    version: typeof s.version === 'string' ? s.version : null,
    decision: typeof s.decision === 'string' ? s.decision : null,
    reason: typeof s.reason === 'string' ? s.reason : null,
    at: Number.isFinite(s.at) ? s.at : null,
    rescinded: s.rescinded === true,
    evidence: typeof s.evidence === 'string' ? s.evidence : null,
  }
}

/** 这条记录的结论是不是"旧判据算的"（纯函数）。 */
function isStaleVerdict(record, version = SCANNER_VERSION) {
  return stampOf(record).version !== version
}

/**
 * 纯判据：给一组记录算出「哪些结论过期、用当前判据重算后是什么」（IO 全由 `recompute` 注入）。
 * `recompute(record)` → `{ decision, reason }`；解析不到包时返回 `{ unresolved: '原因' }`。
 * 返回每条的 `{ rowId, status, decision, reason, storedDecision, storedNote, rescinded, evidence }`，
 * status ∈ fresh（戳已是最新，无需重算）/ updated（结论变了 → 调用方回写）/ unchanged（结论没变 → **零写盘**）
 *          / unresolved（复核不了 → 如实标注，保留旧结论）。
 */
function planVerdictRefresh(records, { version = SCANNER_VERSION, recompute } = {}) {
  const out = []
  for (const rec of (Array.isArray(records) ? records : [])) {
    if (rec === null || typeof rec !== 'object' || typeof rec.rowId !== 'string' || rec.rowId === '') continue
    const storedDecision = typeof rec.check === 'string' && rec.check !== '' ? rec.check : null
    const storedNote = typeof rec.checkNote === 'string' ? rec.checkNote : null
    const stamp = stampOf(rec)
    if (stamp.version === version) {
      out.push({ rowId: rec.rowId, status: 'fresh', decision: storedDecision, reason: stamp.reason ?? storedNote, storedDecision, storedNote, rescinded: stamp.rescinded, evidence: stamp.evidence, version })
      continue
    }
    // 没给重算器（或明确要求只读）→ 不猜：标成"过期、未复核"
    if (typeof recompute !== 'function') {
      out.push({ rowId: rec.rowId, status: 'stale', decision: storedDecision, reason: storedNote, storedDecision, storedNote, rescinded: false, evidence: null, version: null })
      continue
    }
    let next = null
    try {
      next = recompute(rec)
    } catch (error) {
      next = { unresolved: String(error?.message ?? error) }
    }
    if (next === null || next === undefined) next = { unresolved: '重算没有返回结论' }
    if (typeof next.unresolved === 'string' && next.unresolved !== '') {
      out.push({ rowId: rec.rowId, status: 'unresolved', decision: storedDecision, reason: storedNote, storedDecision, storedNote, rescinded: false, evidence: null, version: null, unresolved: next.unresolved })
      continue
    }
    const decision = typeof next.decision === 'string' && next.decision !== '' ? next.decision : 'unknown'
    const reason = typeof next.reason === 'string' ? next.reason : null
    out.push({
      rowId: rec.rowId,
      status: decision === storedDecision ? 'unchanged' : 'updated',
      decision,
      reason,
      storedDecision,
      storedNote,
      // 「旧判据判 fail，当前判据不再 fail」= 误报被撤回（这是唯一允许解除"待适配"的情形）
      rescinded: storedDecision === 'fail' && decision !== 'fail',
      evidence: isSelfInflictedSource(rec.source) ? String(rec.source) : null,
      version,
    })
  }
  return out
}

/**
 * 读取代发（IO 版）：把 `planVerdictRefresh` 的结论落到记录上，**结论变了才写盘**（写后读回核实）。
 * `deps`：`{ resolvePkg, readPkg, check, writeText, readText, now }` —— 全部可注入（离线测试）。
 * 返回 `{ version, entries, updated, unchanged, unresolved, fresh, wrote, writeError, file }`。
 */
function refreshCompatPendingVerdicts({ pending, baseDir, file = null, deps = {} } = {}) {
  const {
    resolvePkg, readPkg, check, now = () => Date.now(), stat = statSync,
    readText = (p) => readFileSync(p, 'utf8'), writeText = (p, data) => writeFileSync(p, data, 'utf8'),
    memo = VERDICT_MEMO,
  } = deps
  const target = file ?? compatPendingFile()
  const records = Array.isArray(pending?.pending) ? pending.pending : []
  const fwVer = typeof pending?.frameworkVersion === 'string' ? pending.frameworkVersion : null
  const recompute = (rec) => {
    if (typeof rec.moduleName !== 'string' || rec.moduleName === '') return { unresolved: '记录里没有 moduleName（无法定位已装包）' }
    if (typeof resolvePkg !== 'function' || typeof readPkg !== 'function' || typeof check !== 'function') return { unresolved: '读取代发缺少解析器（内部接线问题）' }
    let pkgPath = null
    try { pkgPath = resolvePkg(rec.moduleName, baseDir) } catch (error) { return { unresolved: '解析包失败：' + String(error?.message ?? error) } }
    if (pkgPath === null || pkgPath === undefined) return { unresolved: `本机解析不到 ${rec.moduleName}` }
    let pkg = null
    try { pkg = readPkg(pkgPath) } catch (error) { return { unresolved: '读取包信息失败：' + String(error?.message ?? error) } }
    if (pkg === null || pkg === undefined) return { unresolved: '读取包信息失败' }
    const mtimeMs = (() => { try { return stat(pkgPath).mtimeMs } catch { return 0 } })()
    const key = `${rec.rowId}|${pkgPath}|${pkg.version ?? ''}|${mtimeMs}|${SCANNER_VERSION}`
    if (memo instanceof Map && memo.has(key)) return memo.get(key)
    const verdict = check(pkg, fwVer ?? '?', dirname(pkgPath))
    const out = { decision: verdict?.decision ?? 'unknown', reason: verdict?.reason ?? null }
    if (memo instanceof Map) {
      if (memo.size >= MEMO_LIMIT) memo.clear()
      memo.set(key, out)
    }
    return out
  }
  const entries = planVerdictRefresh(records, { recompute })
  const byRow = new Map(entries.map((e) => [e.rowId, e]))
  const updated = []
  const at = now()
  for (const rec of records) {
    const e = byRow.get(rec?.rowId)
    if (e === undefined || e.status !== 'updated') continue
    const previous = { decision: e.storedDecision, note: e.storedNote }
    rec.check = e.decision
    rec.checkNote = e.reason
    rec.scanVerdict = { version: SCANNER_VERSION, decision: e.decision, reason: e.reason, at, previous, rescinded: e.rescinded, evidence: e.evidence }
    rec.verdictUpdatedAt = at
    updated.push({ rowId: e.rowId, from: e.storedDecision, to: e.decision, rescinded: e.rescinded, evidence: e.evidence })
  }
  const result = {
    version: SCANNER_VERSION,
    file: target,
    entries,
    updated,
    unchanged: entries.filter((e) => e.status === 'unchanged').map((e) => e.rowId),
    unresolved: entries.filter((e) => e.status === 'unresolved').map((e) => ({ rowId: e.rowId, reason: e.unresolved })),
    fresh: entries.filter((e) => e.status === 'fresh').map((e) => e.rowId),
    wrote: false,
    writeError: null,
  }
  if (updated.length === 0) return result // ② 结论未变（或无可重算）→ **零写盘**
  const payload = { ...pending, pending: records, updatedAt: new Date(at).toISOString() }
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeText(target, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    result.writeError = '回写适配门清单失败：' + String(error?.message ?? error)
    return result
  }
  // 读回核实：只有真的落盘且内容一致才算写成功（绝不谎报"已更正"）
  try {
    const back = JSON.parse(readText(target))
    const rec = (back?.pending ?? []).find((p) => p.rowId === updated[0].rowId)
    const ok = rec !== undefined && rec.check === updated[0].to && stampOf(rec).version === SCANNER_VERSION
    if (!ok) result.writeError = '回写后读回内容与期望不一致（结论没真正落盘）'
  } catch (error) {
    result.writeError = '回写后读回失败：' + String(error?.message ?? error)
  }
  result.wrote = result.writeError === null
  return result
}

/**
 * 一条记录对外的"结论视图"（面板/门控摘要用）：当前判据下的结论 + 是否过期 + 是否已撤回。
 * `entry` = `refreshCompatPendingVerdicts()` 的 `entries` 里对应那条（可省 → 只看记录上的判据戳）。
 */
function verdictView(record, entry = null) {
  const stamp = stampOf(record)
  const status = entry?.status ?? (stamp.version === SCANNER_VERSION ? 'fresh' : 'stale')
  const evidence = entry?.evidence ?? stamp.evidence ?? (isSelfInflictedSource(record?.source) ? String(record.source) : null)
  if (status === 'updated') {
    return { decision: entry.decision, reason: entry.reason, version: entry.version, stale: false, rescinded: entry.rescinded === true, evidence, unresolved: null, status, previous: { decision: entry.storedDecision, note: entry.storedNote } }
  }
  if (status === 'fresh') {
    return { decision: stamp.decision ?? (typeof record?.check === 'string' ? record.check : null), reason: stamp.reason ?? (typeof record?.checkNote === 'string' ? record.checkNote : null), version: stamp.version, stale: false, rescinded: stamp.rescinded, evidence, unresolved: null, status }
  }
  if (status === 'unchanged') {
    // 结论与旧判据一致（已用当前判据复核过，但**不写盘**）：结论可信，判据戳仍是旧的
    return { decision: entry.decision, reason: entry.reason, version: entry.version, stale: true, rescinded: false, evidence, unresolved: null, status }
  }
  if (status === 'unresolved') {
    return { decision: entry.decision, reason: entry.reason, version: null, stale: true, rescinded: false, evidence: null, unresolved: entry.unresolved, status }
  }
  // 'stale'：本轮没有重算（没给基准/只读）→ 如实标"旧判据、未复核"
  return { decision: stamp.decision ?? (typeof record?.check === 'string' ? record.check : null), reason: stamp.reason ?? (typeof record?.checkNote === 'string' ? record.checkNote : null), version: stamp.version, stale: true, rescinded: stamp.rescinded, evidence, unresolved: null, status: 'stale' }
}

export {
  SCANNER_VERSION,
  SELF_INFLICTED_SOURCES,
  compatPendingFile,
  isSelfInflictedSource,
  isStaleVerdict,
  planVerdictRefresh,
  refreshCompatPendingVerdicts,
  stampOf,
  verdictView,
}
