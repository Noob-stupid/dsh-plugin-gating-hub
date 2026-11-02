// L2 · routes —— 门控的「按需检查」（0.5.100 加法）：`POST /plugin-console/compat-gate {action:'scan-current'}`
//
// 用户 2026-11-02 原话：「我们一般情况下都不预检吧」——compat-pending 只在升级前预扫与启动失败
// 隔离时写入，平时门控一条记录都没有，而"0 条"会被误读成"全部兼容"。这个动作让用户随时查一次：
// 对当前补丁里的行逐行跑适配判定，把**判为不适配**的结论记进 compat-pending（`source: 'manual-scan'`），
// 并回一份统计（检查了几行 / 通过 / 不适配 / 无法判定）。
//
// 三条硬边界（判据在 domain/compat-scan.js，写盘纪律在 domain/compat-pending-records.js）：
//   · 判据复用 `checkPluginFrameworkCompat`（与框架升级预扫同一条链），本文件不新写任何判据；
//   · **绝不禁用任何行、绝不碰补丁文件** —— 禁用是用户的动作（/toggle）；
//   · 写盘：备份 → 原子写 → 读回核实 → 失败回滚；坏文件 ⇒ 409 拒绝覆盖（保住用户数据）。
import { dirname } from 'node:path'
import { planCurrentScan, recordsFromScan } from '../domain/compat-scan.js'
import { applyPendingWrite, countPendingRecords, liveRowIdsFromPatch, planScanMerge, readPendingRecords } from '../domain/compat-pending-records.js'
import { currentFrameworkVersion } from '../domain/framework.js'
import { readPatchState } from '../domain/patch.js'
import { listEntries } from '../domain/runtime.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { findPatchPath } from '../infra/paths.js'

/** 读回核实的判据：本次写进去的每条 fail 记录都必须真的在盘上，且 check === 'fail'。 */
function verifyScanWrite(expected) {
  return (back) => {
    const rows = (Array.isArray(back?.pending) ? back.pending : []).filter((r) => r !== null && typeof r === 'object')
    const missing = expected.filter((id) => !rows.some((r) => r.rowId === id && r.check === 'fail'))
    if (missing.length > 0) return `这些记录没真正落盘：${missing.slice(0, 5).join('、')}`
    return null
  }
}

async function routeCompatScanCurrent(req, res, rc) {
  const at = Date.now()
  let profileDir = null
  let patchRowIds = new Set()
  try {
    const patchPath = findPatchPath(rc.ctx)
    profileDir = dirname(patchPath)
    patchRowIds = liveRowIdsFromPatch(await readPatchState(patchPath))
  } catch {
    sendError(res, 503, '读不到 profile 目录/补丁文件，无法确定要检查的行；本次扫描没有写任何东西', { ok: false, code: 'patch-unreadable' })
    return
  }
  let entries = []
  try { entries = listEntries(rc.ctx) } catch { entries = [] }
  let frameworkVersion = null
  try { frameworkVersion = currentFrameworkVersion(rc.ctx) } catch { frameworkVersion = null }
  const scan = planCurrentScan({ entries, profileDir, frameworkVersion })
  const records = recordsFromScan(scan, { at })
  const read = readPendingRecords()
  const merge = planScanMerge({
    read,
    records,
    frameworkVersion,
    lastScan: {
      at,
      frameworkVersion: scan.frameworkVersion,
      checked: scan.checked,
      pass: scan.pass,
      fail: scan.fail,
      unknown: scan.unknown,
      skipped: scan.skipped.length,
      source: 'manual-scan',
    },
  })
  const counts = (() => {
    try { return countPendingRecords(read.records, patchRowIds) } catch { return null }
  })()
  const base = {
    ok: true,
    action: 'scan-current',
    frameworkVersion: scan.frameworkVersion,
    // 扫描统计（面板只放一句短句；明细在 skipped/results 里）
    checked: scan.checked,
    pass: scan.pass,
    fail: scan.fail,
    unknown: scan.unknown,
    skipped: scan.skipped,
    results: scan.results,
    // 落盘情况
    recorded: records.length,
    added: merge.added ?? [],
    updated: merge.updated ?? [],
    changed: false,
    file: read.file,
    backup: null,
    verified: false,
    counts,
    error: scan.error,
    note: null,
  }
  if (merge.ok !== true) {
    // 坏文件：结论不写盘，但扫描统计照样如实回（用户至少知道"现在查出来是什么"）
    sendError(res, merge.status ?? 500, merge.error ?? '扫描结果写入失败', { ...base, error: merge.error ?? scan.error })
    return
  }
  if (merge.changed !== true) {
    sendJson(res, 200, {
      ...base,
      changed: false,
      note: scan.checked === 0
        ? '没有可检查的行（补丁里没有可判定的插件行），未写任何记录'
        : `检查 ${scan.checked} 行：通过 ${scan.pass} / 不适配 ${scan.fail} / 无法判定 ${scan.unknown}；记录没有变化（无需写盘）`,
    })
    return
  }
  const write = applyPendingWrite({ file: read.file, next: merge.next, verify: verifyScanWrite(records.map((r) => r.rowId)), tag: 'scan' })
  const payload = {
    ...base,
    ok: write.ok === true,
    changed: write.ok === true,
    backup: write.backup ?? null,
    verified: write.verified === true,
    error: write.error ?? scan.error,
    note: write.ok === true
      ? `检查 ${scan.checked} 行：通过 ${scan.pass} / 不适配 ${scan.fail} / 无法判定 ${scan.unknown}`
        + (records.length > 0 ? `；已记下 ${records.length} 条待适配结论（只记录，未禁用任何行）` : '；没有不适配的行，未新增记录')
      : null,
  }
  if (write.ok === true) sendJson(res, 200, payload)
  else sendError(res, write.status ?? 500, write.error ?? '扫描结果写入失败', payload)
}

export { routeCompatScanCurrent }
