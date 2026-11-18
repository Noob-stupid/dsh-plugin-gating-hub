// L2 · routes —— 运行期卡顿防护：客户端空转上报 / 配置 / 清空（0.5.111 加法）
//
// 只有 POST（客户端哨兵上报是写动作）；只读视图走 `/state` 与 `/compat-status` 的
// `runtimeHealth` 字段，不另开 GET（避免又一条要登记的白名单路由）。
//
// 三条硬边界：
//   · **只记录**：本路由永不写插件补丁、永不禁用插件；停用仍走既有 `/toggle`（用户点）；
//   · 归因只在当前 profile 已装包里只读搜索，不执行包内代码、不联网；
//   · 坏输入一律 400 并说明原因，不静默成功。
import { dirname } from 'node:path'
import { clearClientIncidents, readRuntimeGuardConfig, recordClientIncident, runtimeHealthView, writeRuntimeGuardConfig } from '../domain/runtime-health.js'
import { readCompatMode } from '../domain/compat-state.js'
import { findPatchPath } from '../infra/paths.js'
import { sendError, sendJson } from '../infra/httpd.js'

function profileDirOf(rc) {
  try { return dirname(findPatchPath(rc.ctx)) } catch { return null }
}

/** GET /plugin-console/runtime-guard —— 客户端哨兵启动时只读一次：当前运行模式 + 阈值配置。
 *  为什么单独开一条 GET：/compat-status 会算指纹、可能排自动预检，太重；这里只读两个小 JSON。 */
async function routeRuntimeGuardGet(req, res, rc) {
  const mode = readCompatMode()
  const { config, problems } = readRuntimeGuardConfig()
  sendJson(res, 200, {
    ok: true,
    mode: mode.mode,
    modeSource: mode.source,
    modeReason: mode.reason,
    // 仅作调试覆盖：是否生效由 mode（observer）决定，客户端不许反过来拿 enabled 覆盖 mode
    guard: config,
    configProblems: problems,
  })
}

async function routeRuntimeHealth(req, res, rc) {
  const body = rc.body !== null && typeof rc.body === 'object' ? rc.body : {}
  const action = typeof body.action === 'string' && body.action !== '' ? body.action : 'report'
  if (action === 'config') {
    const patch = {
      enabled: body.enabled,
      windowMs: body.windowMs,
      maxFails: body.maxFails,
      cooldownMs: body.cooldownMs,
      suppressCloseMs: body.suppressCloseMs,
    }
    const result = writeRuntimeGuardConfig(patch)
    if (result.ok !== true) { sendError(res, 500, `保存运行期防护配置失败：${result.error ?? '未知原因'}`); return }
    sendJson(res, 200, { ok: true, action: 'config', config: result.config, runtimeHealth: runtimeHealthView({ limit: 8 }) })
    return
  }
  if (action === 'clear') {
    const result = clearClientIncidents({ url: typeof body.url === 'string' ? body.url : null })
    if (result.ok !== true) { sendError(res, 500, `清空运行期记录失败：${result.error ?? '未知原因'}`); return }
    sendJson(res, 200, { ok: true, action: 'clear', removed: result.removed, runtimeHealth: runtimeHealthView({ limit: 8 }) })
    return
  }
  if (action !== 'report') { sendError(res, 400, `未知动作：${action}（可选：report / config / clear）`); return }
  if (typeof body.url !== 'string' || !/^wss?:\/\//iu.test(body.url.trim())) {
    sendError(res, 400, '缺少合法的 url（只接受 ws:// 或 wss://）')
    return
  }
  const result = recordClientIncident({
    url: body.url,
    source: body.source,
    count: body.count,
    windowMs: body.windowMs,
    kind: body.kind,
    at: body.at,
    owner: body.owner,
  }, { profileDir: profileDirOf(rc) })
  if (result.ok !== true && result.incident === null) {
    sendError(res, 400, result.error ?? '事件没有记录')
    return
  }
  sendJson(res, 200, {
    ok: result.ok === true,
    action: 'report',
    incident: result.incident === null ? null : {
      url: result.incident.url,
      owner: result.incident.owner ?? null,
      confidence: result.incident.confidence ?? null,
      evidence: result.incident.evidence ?? null,
      count: result.incident.count ?? null,
      trips: result.incident.trips ?? 1,
    },
    writeError: result.writeError ?? null,
    config: readRuntimeGuardConfig().config,
  })
}

export { routeRuntimeGuardGet, routeRuntimeHealth }
