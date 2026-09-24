// L2 · routes —— 门控常驻化（观察者/托管模式 · 环境指纹 · 回滚点）
//   GET  /plugin-console/compat-status   一次拿齐：模式 + 框架版本 + 指纹变化 + 回滚点可用性
//   POST /plugin-console/compat-mode     切换运行模式（managed / observer）
//   POST /plugin-console/compat-stamp    把当前指纹记为基线（用户确认「环境变更」后调用）
//
// 与 /framework-preflight 的分工：预检负责「扫什么」，这里负责「什么时候扫、以什么模式守门」。
// 触发源不再是我们的升级按钮，而是环境指纹变化 —— 官方桌面端自带升级器 / 官方只发桌面端 /
// 手动 pnpm 操作，都会在这里被发现（见 domain/compat-state.js 头注释）。

import { dirname } from 'node:path'
import { compareFingerprint, computeFingerprint, readCompatMode, readFingerprint, readRollbackRecord, stampFingerprint, writeCompatMode } from '../domain/compat-state.js'
import { currentFrameworkVersion } from '../domain/framework.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { baseDirOf, profileDirOf, resolvePackageJson } from '../infra/paths.js'

/** 框架运行时根（含 .pnpm 的那层）：换了安装根（npx 缓存 ↔ 桌面端自带运行时）指纹必变。 */
function frameworkPnpmRoot(ports, profileDir) {
  try {
    const baseDir = baseDirOf(ports?.baseUrl ?? 'file:///')
    const pkgPath = resolvePackageJson('@deepseek-ai/dsh', baseDir, profileDir)
    if (pkgPath === null) return null
    return dirname(dirname(pkgPath))
  } catch {
    return null
  }
}

function currentVersion(rc) {
  try { return currentFrameworkVersion(rc.ctx) } catch { return null }
}

/** 当前环境指纹（每次调用都现场算，不做缓存 —— 缓存会让「变更」永远滞后一拍）。 */
function currentFingerprint(rc) {
  const profileDir = profileDirOf(rc.ctx)
  return computeFingerprint({
    frameworkVersion: currentVersion(rc),
    pnpmRoot: frameworkPnpmRoot(rc.ctx, profileDir),
  })
}

async function routeCompatStatusGet(req, res, rc) {
  const mode = readCompatMode()
  const current = currentFingerprint(rc)
  const previous = readFingerprint()
  const { changed, reasons, baselineAt } = compareFingerprint(current, previous)
  sendJson(res, 200, {
    ok: true,
    mode: mode.mode,
    modeSource: mode.source,
    modeChangedAt: mode.at,
    frameworkVersion: current.frameworkVersion,
    fingerprint: { current, previous, changed, reasons, baselineAt },
    rollback: readRollbackRecord(),
  })
}

async function routeCompatMode(req, res, rc) {
  const wanted = rc.body?.mode
  const result = writeCompatMode(wanted)
  if (!result.ok) { sendError(res, 400, result.error); return }
  sendJson(res, 200, { ok: true, mode: result.mode, note: result.mode === 'observer' ? '观察者模式：只做预检与门控，不接管框架升级' : '托管模式：框架升级与回滚由本控制台负责' })
}

async function routeCompatStamp(req, res, rc) {
  const stamped = stampFingerprint(currentFingerprint(rc))
  sendJson(res, 200, { ok: true, fingerprint: stamped })
}

export { routeCompatMode, routeCompatStamp, routeCompatStatusGet }
