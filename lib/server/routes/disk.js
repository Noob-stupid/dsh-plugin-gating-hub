// L2 · routes —— `<DSH_HOME>/plugin-console` 的**磁盘体检 / 清理**（0.5.84 加法，用户第 7 项）
//   GET  /plugin-console/disk-audit    只读体检：谁占了多少、哪些可以清、哪些绝不能动
//   POST /plugin-console/disk-cleanup  **必须显式确认**（confirm:true）才删；未确认只回计划
//
// 用户原话（大意）：这个目录已经 2.1 GB（framework-backups 含全平台 libreoffice），
// 要一个"只读体检 + 显式确认后清理"的能力，**绝不自动删除**。
//
// 安全语义（写死，判据全在 domain/disk-audit.js）：
//   · audit 只统计，不删不写；
//   · cleanup 只认体检结果里出现过的条目名（拒绝路径穿越），且 protected（当前回滚点 /
//     控制台状态文件 / 未知条目）一律拒绝并说明原因；
//   · 删完**读回核实**，没删干净如实回报（Windows 上 rmSync 会静默落空，本仓 fsx.js 记过）。
//
// 真机实测（2026-10）：最大的那 2.1 GB 是 `framework-backups/0.2.0-rc.1`，而它**正是**
// `framework-rollback.json` 的 checkpointDir ⇒ 判据从回滚记录里读，绝不按体积猜"大的就可以删"。

import { auditConsoleDir, runCleanup } from '../domain/disk-audit.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome } from '../infra/paths.js'
import { join } from 'node:path'

/** 体检/清理的唯一根目录（绝不接受调用方传路径 —— 那等于开了一个任意路径删除的口子）。 */
function consoleDir() {
  return join(dshHome(), 'plugin-console')
}

async function routeDiskAudit(req, res, rc) {
  const audit = auditConsoleDir({ root: consoleDir(), deps: rc.deps?.diskAuditDeps ?? {} })
  if (audit.ok !== true) {
    sendError(res, 500, `磁盘体检失败：${audit.error ?? '未知原因'}`, { ok: false, entries: [] })
    return
  }
  sendJson(res, 200, audit)
}

async function routeDiskCleanup(req, res, rc) {
  const body = rc.body ?? {}
  const ids = Array.isArray(body.ids) ? body.ids : (typeof body.ids === 'string' ? [body.ids] : [])
  const root = consoleDir()
  // 每次都**重新体检**（不信任客户端回传的体积/分级 —— 那等于让调用方决定删什么）
  const audit = auditConsoleDir({ root, deps: rc.deps?.diskAuditDeps ?? {} })
  if (audit.ok !== true) {
    sendError(res, 500, `磁盘体检失败：${audit.error ?? '未知原因'}`, { ok: false })
    return
  }
  const result = runCleanup({ root, audit, ids, confirm: body.confirm === true, deps: rc.deps?.diskCleanupDeps ?? {} })
  if (result.needsConfirm === true) {
    // 未确认：200 + 计划（不是错误 —— 面板要用这份计划渲染「确认清理」按钮与体积）
    sendJson(res, 200, { ok: true, needsConfirm: true, applied: false, plan: result.plan, note: result.note })
    return
  }
  if (result.plan?.refused?.length > 0 && result.removed?.length === 0) {
    sendError(res, 400, `没有可以清理的条目：${result.plan.refused.map((r) => `${r.id}（${r.reason}）`).join('；')}`, { ok: false, applied: false, refused: result.plan.refused })
    return
  }
  sendJson(res, 200, result)
}

export { routeDiskAudit, routeDiskCleanup }
