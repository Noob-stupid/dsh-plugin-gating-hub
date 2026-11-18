// L2 · routes —— 会话预设契约体检（GET /plugin-console/preset-contract；0.5.111 加法）
// 只读：不改预设目录、不写 profile 补丁；24h 缓存，`?force=1` 强制重算。
import { dirname, join } from 'node:path'
import { runPresetContractCheck } from '../domain/preset-contract.js'
import { dshHome, findPatchPath } from '../infra/paths.js'
import { sendJson } from '../infra/httpd.js'

async function routePresetContractGet(req, res, rc) {
  const force = rc.url?.searchParams?.get('force') === '1'
  const patchPath = (() => { try { return findPatchPath(rc.ctx) } catch { return null } })()
  const profileDir = patchPath === null ? null : dirname(patchPath)
  const report = runPresetContractCheck({
    baseUrl: rc.ctx?.baseUrl ?? null,
    profileDir,
    presetsRoot: join(dshHome(), '.agent-presets'),
    patchPath,
    force,
  })
  sendJson(res, 200, { ok: report.ok === true, ...report })
}

export { routePresetContractGet }
