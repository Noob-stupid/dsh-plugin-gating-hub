// L2 · routes —— 预设声明行体检（GET /plugin-console/preset-audit；0.5.30 加法）
//
// 真机背景：框架 0.1.7-rc.1 起预设靠 profile 补丁里的**声明行**发现；预设目录自身后来被改成 v10，
// 而补丁里的行还指向 v1 → 老会话 resume 到错的模块（而且没有任何地方会报）。本路由**只读**出报告：
// 陈旧（stale）/ 缺失（missing）/ 悬空（orphan）/ 目标不存在（targetMissing）。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { collectPresetAudit } from '../domain/preset-audit.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome, findPatchPath } from '../infra/paths.js'

async function routePresetAuditGet(req, res, rc) {
  let patchPath = null
  try { patchPath = findPatchPath(rc.ctx) } catch {}
  if (patchPath === null || !existsSync(patchPath)) {
    sendError(res, 404, '找不到 profile 补丁文件（cordis.patch.yml）—— 无法体检')
    return
  }
  const presetsRoot = join(dshHome(), '.agent-presets')
  const report = collectPresetAudit({ presetsRoot, patchPath })
  sendJson(res, 200, { ok: true, patchPath, presetsRoot, ...report })
}

export { routePresetAuditGet }
