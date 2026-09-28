// L2 · routes —— 门控常驻化（观察者/托管模式 · 环境指纹 · 回滚点）+ 官方互操作
//   GET  /plugin-console/compat-status      一次拿齐：模式 + 框架版本 + 指纹变化 + 回滚点可用性
//   POST /plugin-console/compat-mode        切换运行模式（managed / observer）
//   POST /plugin-console/compat-stamp       把当前指纹记为基线（用户确认「环境变更」后调用）
//   POST /plugin-console/declare-installed  补声明：把「已装但未声明」的插件写进 profile 依赖
//
// 与 /framework-preflight 的分工：预检负责「扫什么」，这里负责「什么时候扫、以什么模式守门」。
// 触发源不再是我们的升级按钮，而是环境指纹变化 —— 官方桌面端自带升级器 / 官方只发桌面端 /
// 手动 pnpm 操作，都会在这里被发现（见 domain/compat-state.js 头注释）。
//
// declare-installed 存在的理由（2026-09-24 用户实测）：第三方插件管理器与 pnpm 都只认清单里的
// 依赖，手铺安装的包在它们眼里不存在（看不见 + 会被还原）。老规矩：先 plan 再 apply。

import { dirname } from 'node:path'
import { compareFingerprint, computeFingerprint, readCompatMode, readFingerprint, readRollbackRecord, stampFingerprint, writeCompatMode } from '../domain/compat-state.js'
import { NOTICE_MODES, detectCompat, readCompatAck, readCompatGate, writeCompatAck, writeCompatGate } from '../domain/compat.js'
import { currentFrameworkVersion } from '../domain/framework.js'
import { applyDependencyBackfill, planDependencyBackfill } from '../domain/manifest.js'
import { preferredRegistries } from '../domain/sources.js'
import { reconcileLockfile } from '../domain/selfupdate.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { baseDirOf, profileDirOf, resolvePackageJson } from '../infra/paths.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 框架运行时根（含 .pnpm 的那层）：换了安装根（npx 缓存 ↔ 桌面端自带运行时）指纹必变。
 *  `@deepseek-ai/dsh` 既可能解析到 `<root>/node_modules/@deepseek-ai/dsh`（顶层投影），
 *  也可能落在 `<root>/.pnpm/@deepseek-ai+dsh@…/node_modules/…`（实体内部）—— 后者直接
 *  `dirname(dirname())` 会停在 `.pnpm` **内部**、数不到包数（门槛实测 `entities=null`）。
 *  所以向上逐级找「含 .pnpm 的那一层」为止。 */
function frameworkPnpmRoot(ports, profileDir) {
  try {
    const baseDir = baseDirOf(ports?.baseUrl ?? 'file:///')
    const pkgPath = resolvePackageJson('@deepseek-ai/dsh', baseDir, profileDir)
    if (pkgPath === null) return null
    const direct = dirname(dirname(pkgPath))
    let dir = direct
    for (let i = 0; i < 6; i += 1) {
      if (existsSync(join(dir, '.pnpm'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return direct
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
    modeReason: mode.reason ?? null,
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

/** 补声明：plan 只报「有几项要补」，apply 真写清单（逐条写、逐条回报）。 */
async function routeDeclareInstalled(req, res, rc) {
  const mode = rc.body?.mode === 'apply' ? 'apply' : 'plan'
  const profileDir = profileDirOf(rc.ctx)
  try {
    if (mode === 'apply') {
      // 2026-09-27：补声明同样按 registry 可解析性决定写回形态（非 registry 包写 link:），
      // 且必须传**用户配置的** registry 列表 —— 否则探测只用默认源，自定义源/备源形同虚设。
      const registries = preferredRegistries()
      const result = await applyDependencyBackfill(profileDir, { registries })
      // 关键：只写清单不写 lock → 之后任何 pnpm 操作都会因清单/lock 不一致失败（2026-09-24 CI 实测）
      let lockNote = null
      let suggestedAction = Array.isArray(result.suggestedActions) && result.suggestedActions.length > 0 ? result.suggestedActions[0] : null
      try {
        const lock = await reconcileLockfile({ profileDir, registries })
        if (lock.lockNote !== null) lockNote = lock.lockNote
        if (Array.isArray(lock.suggestedActions) && lock.suggestedActions.length > 0) suggestedAction = lock.suggestedActions[0]
      } catch (error) { lockNote = `lock 对账失败：${error instanceof Error ? error.message : String(error)}` }
      sendJson(res, 200, {
        ok: true,
        mode,
        declared: result.declared,
        skipped: result.skipped,
        lockNote,
        depNote: result.depNote ?? null,
        suggestedAction,
        note: result.declared.length === 0
          ? '没有需要补声明的插件'
          : `已补声明 ${result.declared.length} 项 —— 它们现在会出现在官方/第三方插件页的「已安装」里，也不会再被 pnpm 还原`,
      })
      return
    }
    const plan = await planDependencyBackfill(profileDir)
    sendJson(res, 200, { ok: true, mode, candidates: plan.candidates, skipped: plan.skipped, count: plan.candidates.length })
  } catch (error) {
    sendError(res, 500, `补声明失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 兼容提示：手动关闭 / 设定展示模式（2026-09-28 加法）。
 *
 *  背景（用户实测）：面板顶部那句「当前 DSH web 包版本 X 不在受支持的 0.1.x 系列内…」是**披露**，
 *  但它以前**关不掉** —— 纯 `<p>`、没有关闭入口、也没有持久化。用户诉求：可以手动关。
 *
 *  两种入参（互斥，按字段判断）：
 *    · `{ webAppVersion }` → 记住"这个版本我看过了"：同版本不再提示，**框架版本一变重新提示**
 *    · `{ mode }`         → 展示模式 `always` / `once-per-version`（默认）/ `off`
 *
 *  ⚠ 硬约束：**只影响展示，不改 `supported`** —— 门控判定与"该不该拦"一个字都不变，
 *    披露不能被关成"看不见的风险"。版本还会校验：只接受**当前探测到**的那一个，
 *    避免把 ack 记到别的版本上（否则升到新版本时会被误吞）。
 */
async function routeCompatAck(req, res, rc) {
  const body = rc.body ?? {}
  if (typeof body.mode === 'string') {
    const mode = body.mode.trim().toLowerCase()
    if (!NOTICE_MODES.includes(mode)) {
      sendError(res, 400, `未知的提示模式：${body.mode}（可选 ${NOTICE_MODES.join(' / ')}）`)
      return
    }
    const gate = writeCompatGate({ noticeMode: mode })
    sendJson(res, 200, { ok: true, noticeMode: gate.noticeMode, ack: readCompatAck() })
    return
  }
  const version = typeof body.webAppVersion === 'string' ? body.webAppVersion.trim() : ''
  if (version === '' || !/^\d+\.\d+\.\d+/u.test(version)) {
    sendError(res, 400, 'webAppVersion 缺失或格式不对（形如 0.2.0-rc.1）')
    return
  }
  let detected = null
  try { detected = (await detectCompat(rc?.ctx?.baseUrl ?? 'file:///')).webAppVersion } catch {}
  if (detected !== null && detected !== version) {
    sendError(res, 400, `版本不匹配：当前探测到 ${detected}，请求里是 ${version}（请刷新后重试）`)
    return
  }
  const ack = writeCompatAck(version)
  sendJson(res, 200, { ok: true, ack, noticeMode: readCompatGate().noticeMode })
}
export { routeCompatAck, routeCompatMode, routeCompatStamp, routeCompatStatusGet, routeDeclareInstalled }
