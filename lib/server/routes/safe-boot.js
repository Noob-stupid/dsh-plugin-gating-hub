// L2 · routes —— **安全启动材料**恢复入口（0.5.32 加法 D3-①；服务在跑时用这条）
//   POST /plugin-console/safe-boot   { action: 'list' | 'restore-last-good' | 'disable-suspects' | 'mark-good', ... }
//
// 为什么要有它（用户 2026-09-29 诉求：「能挽救改完打不开的局面」）：
//   走了别的更新通道（官方桌面端更新器 / 手动 pnpm / npx 缓存变化）把框架换坏之后，
//   用户需要**在服务还能应答的时候**有一条一键出路；服务起不来时则走 `scripts/safe-boot.mjs`
//   （同一个 domain 模块，同一套判据）。
//
// 白名单动作（**只认这四个字符串**，绝不接受任何命令串/路径）：
//   · list              列快照（不返回补丁正文）
//   · restore-last-good 把补丁恢复成快照（改前再备份一份当前状态 + 读回核实 + 严格 YAML 闸门）
//   · disable-suspects  **只**给点名的可疑行追加 `disabled: true`（不删任何行）；点名来源：
//                       请求里的 rowIds，或 D1 自动预检落下的隔离计划（`?usePlan=1` 默认）
//   · mark-good         把某份快照标记为「良好」（永不随保留策略删除）
//
// 一律返回**可复制的命令**与影响面摘要；不做任何未点名的改动。

import { readFileSync } from 'node:fs'
import { readStore } from '../domain/auto-preflight.js'
import { readCompatMode } from '../domain/compat-state.js'
import { CORE_PATCH_ROW_IDS } from '../domain/patch.js'
import { readSafeBootState, disableSuspects, listSnapshots, markSnapshotGood, restoreLastGood, snapshotView, validatePatchYaml } from '../domain/safe-boot.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { findPatchPath, pluginRoot } from '../infra/paths.js'

const ACTIONS = ['list', 'restore-last-good', 'disable-suspects', 'mark-good']
const PREFLIGHT_FILE_HINT = 'D1 自动预检的结论（同一份记录，面板与离线脚本共用）'

function patchPathOf(rc) {
  try { return findPatchPath(rc.ctx) } catch { return null }
}

function pluginVersionOf() {
  try { return JSON.parse(readFileSync(`${pluginRoot()}/package.json`, 'utf8')).version ?? null } catch { return null }
}

/** 最近一次「done」的自动预检记录（按当前指纹取；取不到就退回最新一条 done）。 */
function latestPlan() {
  try {
    const records = readStore().records
    return records.find((r) => r.state === 'done' && Array.isArray(r.suspects) && r.suspects.length > 0)
      ?? records.find((r) => r.state === 'done')
      ?? null
  } catch { return null }
}

/** 可复制命令（用户能直接粘到终端；服务起不来时就是这一条救回来）。 */
function commands({ id = null } = {}) {
  const script = 'node scripts/safe-boot.mjs'
  return {
    list: `${script} --list`,
    restore: id === null ? `${script} --restore-last-good` : `${script} --restore-last-good --id ${id}`,
    disable: `${script} --disable-suspects`,
    markGood: id === null ? `${script} --mark-good` : `${script} --mark-good --id ${id}`,
    note: { zh: '服务打不开时在插件目录下执行（无需服务在跑）', en: 'Run this in the plugin directory when the service cannot start (no running server needed)' },
  }
}

async function routeSafeBoot(req, res, rc) {
  const body = rc.body ?? {}
  const action = typeof body.action === 'string' ? body.action.trim() : ''
  const patchPath = patchPathOf(rc)
  if (!ACTIONS.includes(action)) {
    sendError(res, 400, `未知动作 ${action === '' ? '(空)' : action}（可选：${ACTIONS.join(' / ')}）—— 本接口只认白名单动作，不接受命令串`)
    return
  }
  const state = readSafeBootState()
  if (action === 'list') {
    const plan = latestPlan()
    sendJson(res, 200, {
      ok: true,
      action,
      patchPath,
      patch: patchPath === null ? null : { exists: true, check: (() => { try { return validatePatchYaml(readFileSync(patchPath, 'utf8')) } catch { return null } })() },
      snapshots: listSnapshots(),
      lastGoodId: state.lastGoodId,
      lastAutoId: state.lastAutoId,
      mode: readCompatMode().mode,
      lastPlan: plan === null ? null : { at: plan.at, key: plan.key, state: plan.state, suspects: (plan.suspects ?? []).map((s) => s.rowId), affectedCount: (plan.affected ?? []).length, note: PREFLIGHT_FILE_HINT },
      commands: commands(),
      pluginVersion: pluginVersionOf(),
    })
    return
  }
  if (action === 'mark-good') {
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : null
    const result = markSnapshotGood({ id })
    if (result.ok !== true) { sendError(res, 404, result.error); return }
    sendJson(res, 200, { ok: true, action, snapshot: result.snapshot, note: result.note, commands: commands({ id: result.snapshot?.id ?? null }) })
    return
  }
  if (action === 'restore-last-good') {
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : null
    const result = restoreLastGood({ patchPath, id })
    if (result.ok !== true) { sendError(res, 409, result.error, { code: result.code, snapshot: result.snapshot ?? null, commands: commands({ id }) }); return }
    sendJson(res, 200, {
      ok: true, action, ...result,
      impact: {
        patchPath: result.patchPath,
        changed: result.changed === true,
        backupPath: result.backupPath ?? null,
        sha256: result.sha256 ?? null,
        snapshotId: result.snapshot?.id ?? null,
        snapshotAt: result.snapshot?.at ?? null,
        enabledCount: result.snapshot?.enabledCount ?? null,
        disabledCount: result.snapshot?.disabledCount ?? null,
      },
      commands: commands({ id: result.snapshot?.id ?? null }),
      next: { zh: '重启服务让补丁生效（观察者模式下本控制台不代你重启）', en: 'Restart the service for the patch to take effect (Observer mode does not restart it for you)' },
    })
    return
  }
  // disable-suspects
  const plan = latestPlan()
  const explicit = Array.isArray(body.rowIds) ? body.rowIds.filter((x) => typeof x === 'string') : null
  const usePlan = body.usePlan !== false
  const rowIds = explicit !== null && explicit.length > 0 ? explicit : (usePlan && plan !== null ? (plan.suspects ?? []).map((s) => s.rowId) : [])
  if (rowIds.length === 0) {
    sendJson(res, 200, {
      ok: true, action, changed: false, added: [], skipped: [], backupPath: null,
      reason: 'no-suspects',
      note: { zh: '没有点名的可疑行（自动预检尚未跑出结论，或它没点名任何行）—— 需要的话请在 rowIds 里显式给出', en: 'No named suspect rows (auto-preflight has no conclusion yet, or named none) — pass rowIds explicitly if needed' },
      coreRowIds: [...CORE_PATCH_ROW_IDS].slice(0, 8),
      commands: commands(),
    })
    return
  }
  const result = disableSuspects({ patchPath, rowIds })
  if (result.ok !== true) { sendError(res, 409, result.error, { code: result.code, problems: result.problems ?? null, commands: commands() }); return }
  sendJson(res, 200, {
    ok: true, action, ...result,
    source: explicit !== null && explicit.length > 0 ? 'request' : 'auto-preflight-plan',
    planAt: plan?.at ?? null,
    impact: { requested: rowIds.length, added: result.added ?? [], skipped: result.skipped ?? [], backupPath: result.backupPath ?? null, prefixUnchanged: result.prefixSame === true },
    commands: commands(),
  })
}

export { ACTIONS, commands, latestPlan, routeSafeBoot }
