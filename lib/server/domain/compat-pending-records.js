// L1 · domain —— compat-pending-records.js（「真待适配」判据的**唯一真源** + 记录删除的写盘纪律）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言）
//
// ── 真机背景（2026-10-28，用户实测）────────────────────────────────────────────────
// `~/.dsh/plugin-console/compat-pending.json` 自 2026-10-04 之后就没再被写过，里面 24 条记录：
//   · 20 条 `status:"adopted"`（已适配解锁 —— 历史，不是待办）；
//   · 3 条 `status:"pending"` 且 `moduleName: null`（web-ui-describe-image / web-ui-doctor /
//     web-ui-better-sidebar）—— **对应的补丁行早已不存在**，永远不可能被适配；
//   · 全部 `check:"unknown"`。
// 结果门控面板照旧把它们算成"待适配的行"，用户看到"有 N 行待适配"，其实**一行都没有**。
//
// 两处根因，本模块各治一处：
//   ① **计数口径错**：数的是 `pending` 数组长度，而不是"status=pending 且该行仍在补丁里"。
//      → `isActionablePending()` / `countPendingRecords()` 是唯一判据，路由与面板都只认它。
//   ② **记录从不清理**：adopted 与"行已消失"的记录永久留在文件里。
//      → `planForgetRecord()` / `planForgetStale()` + `applyPendingForget()` 提供删除（只删记录）。
//
// ── 三条硬边界（不许放宽）──────────────────────────────────────────────────────────
//   · 「行是否存在」只取**补丁解析的既有产物**（`readPatchState()` 的 disables / forced / inserts，
//     见 domain/patch.js）—— 这里不另写一套正则，避免两套判据分叉（本仓已为分叉付过代价）。
//   · 删除**只动 compat-pending.json**：不动插件、不动补丁、不动 bundles 清单。
//     「清理无效记录」只清 stale（status=pending 且行已不存在）；真 pending 与 adopted **保留**。
//   · 写盘：备份 → 原子写（临时文件 + rename）→ **读回核实** → 失败回滚；坏文件**拒绝覆盖**
//     （那是用户的文件，覆盖等于丢数据），读侧则降级为空结构并如实报原因。
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { compatPendingFile } from './compat-verdict.js'

/** 适配门记录里"待办"这一侧的状态字（其它一切状态都算历史）。 */
const PENDING_STATUS = 'pending'

/**
 * 当前补丁里**真实存在**的行 id 集合（唯一真源：`readPatchState()` 的解析结果）。
 * 三个来源都是"这一行在补丁里有位置"的等价证据：
 *   inserts —— 本控制台插入的启用行；disables / forced —— 针对该行的禁用/强制覆盖块。
 * @param {{disables?: string[], forced?: string[], inserts?: string[]}|null} patchState
 * @returns {Set<string>}
 */
function liveRowIdsFromPatch(patchState) {
  const out = new Set()
  if (patchState === null || typeof patchState !== 'object') return out
  for (const key of ['disables', 'forced', 'inserts']) {
    const list = Array.isArray(patchState[key]) ? patchState[key] : []
    for (const id of list) if (typeof id === 'string' && id !== '') out.add(id)
  }
  return out
}

const statusOf = (record) => (typeof record?.status === 'string' && record.status !== '' ? record.status : PENDING_STATUS)

/**
 * 「真待适配」判据（**纯函数、唯一真源**）：status 仍是 pending，**且**该行此刻还在补丁里。
 * 行已不存在 ⇒ 这条记录永远等不到"适配"（它的行都不在了），所以它不是待办。
 */
function isActionablePending(record, liveRowIds) {
  if (record === null || typeof record !== 'object') return false
  if (statusOf(record) !== PENDING_STATUS) return false
  if (typeof record.rowId !== 'string' || record.rowId === '') return false
  return liveRowIds instanceof Set && liveRowIds.has(record.rowId)
}

/**
 * 「失效记录」判据：记录写着待适配，但它的补丁行已经不在了（用户眼前那条"删不掉的待适配"）。
 * 注意：adopted 记录**不算** stale —— 那是历史，用户明确要求保留、只在历史区展示。
 */
function isStalePending(record, liveRowIds) {
  if (record === null || typeof record !== 'object') return false
  if (statusOf(record) !== PENDING_STATUS) return false
  if (typeof record.rowId !== 'string' || record.rowId === '') return false
  return !(liveRowIds instanceof Set) || !liveRowIds.has(record.rowId)
}

/**
 * 计数（面板/接口只认这三个数）：真待适配 / 已失效 / 历史已适配。
 * @returns {{ totalCount: number, actionableCount: number, staleCount: number, adoptedCount: number }}
 */
function countPendingRecords(records, liveRowIds) {
  const list = Array.isArray(records) ? records : []
  let actionableCount = 0
  let staleCount = 0
  let adoptedCount = 0
  for (const rec of list) {
    if (rec === null || typeof rec !== 'object') continue
    if (statusOf(rec) !== PENDING_STATUS) { adoptedCount += 1; continue }
    if (isActionablePending(rec, liveRowIds)) actionableCount += 1
    else staleCount += 1
  }
  return { totalCount: list.length, actionableCount, staleCount, adoptedCount }
}

/**
 * 给门控明细行补两个**只增不改**的字段（面板据此如实标注"该行已不存在"并给删除入口）：
 *   rowMissing —— 这一行的 rowId 已不在当前补丁里（null/空 rowId 也算 missing：无所指）
 *   actionable —— 与 `isActionablePending` 同一个判据（pending 且行还在）
 */
function annotateGateRows(rows, liveRowIds) {
  const list = Array.isArray(rows) ? rows : []
  return list.map((row) => {
    const hasRow = typeof row?.rowId === 'string' && row.rowId !== '' && liveRowIds instanceof Set && liveRowIds.has(row.rowId)
    return { ...row, rowMissing: !hasRow, actionable: isActionablePending(row, liveRowIds) }
  })
}

/**
 * 读记录文件（**只读**）。坏文件/空文件按"没有内容"处理，但**把原因如实带出来**：
 * 调用方（写动作）据此拒绝覆盖，界面据此如实显示"读不出来，所以没有可清理的记录"。
 * @returns {{ file: string, exists: boolean, corrupt: boolean, raw: object|null, records: object[], error: string|null }}
 */
function readPendingRecords(file = compatPendingFile()) {
  const empty = { file, exists: false, corrupt: false, raw: null, records: [], error: null }
  if (typeof file !== 'string' || file === '') return { ...empty, corrupt: true, error: '拿不到记录文件路径' }
  if (!existsSync(file)) return empty
  let text = null
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ...empty, exists: true, corrupt: true, error: `读取失败：${String(error?.message ?? error)}` }
  }
  // 空文件（含只有空白 / BOM 的）按**没有内容**处理：它不是坏文件 ⇒ 读侧降级为空结构，
  // 写侧照旧"没有可删的记录"（绝不为了删一条记录就把空文件改写成别的形状）。
  if (text.replace(/^\uFEFF/u, '').trim() === '') return { ...empty, exists: true, empty: true, raw: null, records: [] }
  let raw = null
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ...empty, exists: true, corrupt: true, error: `不是合法 JSON：${String(error?.message ?? error)}` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...empty, exists: true, corrupt: true, error: '内容不是 JSON 对象' }
  }
  const records = (Array.isArray(raw.pending) ? raw.pending : []).filter((r) => r !== null && typeof r === 'object')
  return { file, exists: true, corrupt: false, raw, records, error: null }
}

/** 写动作的公共前置校验：坏文件**拒绝覆盖**（保住用户数据），并给出可读原因。 */
function refuseIfUnsafe(read) {
  if (read.exists !== true) return { ok: false, status: 404, error: `${read.file} 不存在（没有可删的记录）` }
  if (read.corrupt === true) {
    return { ok: false, status: 409, error: `${read.file} 读不出来（${read.error ?? '格式非法'}）；为保住你的数据，本动作已停止（请先手工修好或删掉它）` }
  }
  return null
}

/**
 * 规划「删掉某一条记录」（**纯函数，不写盘**）。
 * 不存在的 rowId ⇒ 404 + 明确原因（绝不静默成功）。
 */
function planForgetRecord({ read, rowId } = {}) {
  const base = { ok: false, status: 400, error: null, file: read?.file ?? null, next: null, changed: false, removedRowIds: [], keptRowIds: [] }
  if (read === null || typeof read !== 'object') return { ...base, error: '内部错误：没有读到记录文件' }
  const refused = refuseIfUnsafe(read)
  if (refused !== null) return { ...base, ...refused }
  if (typeof rowId !== 'string' || rowId === '') return { ...base, error: '缺少 rowId（要删哪一条？）' }
  const index = read.records.findIndex((r) => r.rowId === rowId)
  if (index < 0) return { ...base, status: 404, error: `没有 rowId 为 ${rowId} 的记录（文件未改动）` }
  const kept = read.records.filter((_, i) => i !== index)
  return {
    ok: true,
    status: 200,
    error: null,
    file: read.file,
    next: { ...read.raw, pending: kept },
    changed: true,
    removedRowIds: [rowId],
    keptRowIds: kept.map((r) => r.rowId).filter((id) => typeof id === 'string'),
  }
}

/**
 * 规划「清掉所有失效记录」（**纯函数，不写盘**）：只删 status=pending 且行已不存在的；
 * 真 pending 与 adopted 一条都不动。没有可清的 ⇒ `changed:false`（**零写盘**，不是错误）。
 */
function planForgetStale({ read, liveRowIds } = {}) {
  const base = { ok: false, status: 400, error: null, file: read?.file ?? null, next: null, changed: false, removedRowIds: [], keptRowIds: [], staleCount: 0 }
  if (read === null || typeof read !== 'object') return { ...base, error: '内部错误：没有读到记录文件' }
  const refused = refuseIfUnsafe(read)
  if (refused !== null) return { ...base, ...refused }
  const stale = read.records.filter((r) => isStalePending(r, liveRowIds))
  if (stale.length === 0) {
    return { ...base, ok: true, status: 200, changed: false, keptRowIds: read.records.map((r) => r.rowId).filter((id) => typeof id === 'string'), staleCount: 0 }
  }
  const staleIds = new Set(stale.map((r) => r.rowId))
  const kept = read.records.filter((r) => !staleIds.has(r.rowId))
  return {
    ok: true,
    status: 200,
    error: null,
    file: read.file,
    next: { ...read.raw, pending: kept },
    changed: true,
    removedRowIds: [...staleIds],
    keptRowIds: kept.map((r) => r.rowId).filter((id) => typeof id === 'string'),
    staleCount: stale.length,
  }
}

/**
 * 执行写入：备份 → 原子写（临时文件 + rename）→ **读回核实** → 任何一步不过就回滚并如实报错。
 * `deps` 全是注入缝（写失败 / 读回不符的单测靠它，生产路径不传 ⇒ 真实 fs）。
 * @returns 计划的字段 + `{ backup, verified, rolledBack }`
 */
function applyPendingForget(plan, deps = {}) {
  if (plan === null || typeof plan !== 'object' || plan.ok !== true || plan.changed !== true) return plan
  const io = {
    copy: deps.copyFileSync ?? copyFileSync,
    write: deps.writeFileSync ?? writeFileSync,
    rename: deps.renameSync ?? renameSync,
    remove: deps.unlinkSync ?? unlinkSync,
    exists: deps.existsSync ?? existsSync,
    read: deps.readFileSync ?? readFileSync,
  }
  const { file, next } = plan
  const stamp = Date.now()
  const backup = `${file}.bak-forget-${stamp}`
  const tmp = `${file}.tmp-forget-${stamp}`
  const rollback = (extra) => {
    try { if (io.exists(backup)) io.copy(backup, file) } catch {}
    try { if (io.exists(tmp)) io.remove(tmp) } catch {}
    return { ...plan, ...extra, backup, verified: false, rolledBack: io.exists(backup) }
  }
  try {
    if (io.exists(file)) io.copy(file, backup)
    io.write(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    io.rename(tmp, file)
  } catch (error) {
    return rollback({ ok: false, status: 500, error: `写入 ${file} 失败：${String(error?.message ?? error)}（已回滚，文件保持原样）` })
  }
  // 读回核实：删掉的那条必须真的不在、保留的每一条必须还在 —— "写了但没生效"是最坏的一种假绿
  let back = null
  try {
    back = JSON.parse(io.read(file, 'utf8'))
  } catch (error) {
    return rollback({ ok: false, status: 500, error: `写入后读回失败：${String(error?.message ?? error)}（已回滚）` })
  }
  const rows = (Array.isArray(back?.pending) ? back.pending : []).filter((r) => r !== null && typeof r === 'object')
  const stillThere = plan.removedRowIds.filter((id) => rows.some((r) => r.rowId === id))
  const lost = plan.keptRowIds.filter((id) => !rows.some((r) => r.rowId === id))
  if (stillThere.length > 0 || lost.length > 0) {
    const why = stillThere.length > 0 ? `要删的记录仍在（${stillThere.join('、')}）` : `保留的记录丢了（${lost.slice(0, 5).join('、')}）`
    return rollback({ ok: false, status: 500, error: `写入后读回内容与期望不一致（${why}），已回滚` })
  }
  return { ...plan, backup, verified: true, rolledBack: false }
}

export {
  PENDING_STATUS,
  liveRowIdsFromPatch,
  isActionablePending,
  isStalePending,
  countPendingRecords,
  annotateGateRows,
  readPendingRecords,
  planForgetRecord,
  planForgetStale,
  applyPendingForget,
}
