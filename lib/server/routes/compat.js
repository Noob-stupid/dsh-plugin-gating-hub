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
// 0.5.32 加法（用户 2026-09-29 诉求「走别的更新通道改了框架后仍要自动守门 / 能挽救改完打不开」）：
//   · D1：指纹变化 → **自动跑一次只读预检**（不下载/不安装/不改补丁），落成「兼容清单 + 隔离计划 +
//         变更摘要」；同一指纹只自动跑一次（以指纹为 key 持久化），失败/超时如实记录且可重试，
//         **绝不阻塞状态查询**（超时降级为「未完成，可手动重跑」）；
//   · D2：每次确认服务正常（状态查询成功 + 指纹未变 + 补丁结构合法）落一份 last-known-good 快照到
//         `dshHome()/plugin-console/safe-boot/`（**不是** profile 目录），原子写 + sha256 + 保留 N 份；
//   · D4：检测到桌面端宿主形态时，把**非用户手动设定**的运行模式自动拨回观察者（用户手动优先）。
//
// declare-installed 存在的理由（2026-09-24 用户实测）：第三方插件管理器与 pnpm 都只认清单里的
// 依赖，手铺安装的包在它们眼里不存在（看不见 + 会被还原）。老规矩：先 plan 再 apply。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyEvidenceDisable } from '../domain/auto-disable.js'
import { DEFAULT_TIMEOUT_MS, autoPreflightView, runAutoPreflight } from '../domain/auto-preflight.js'
import { runAutoPreflightScan } from '../domain/auto-preflight-run.js'
import { NOTICE_MODES, detectCompat, readCompatAck, readCompatGate, writeCompatAck, writeCompatGate } from '../domain/compat.js'
import { compareFingerprint, computeFingerprint, planDesktopHostSwitch, readCompatMode, readFingerprint, readRollbackRecord, stampFingerprint, writeCompatMode } from '../domain/compat-state.js'
import { currentFrameworkVersion, detectHostShape } from '../domain/framework.js'
import { applyDependencyBackfill, planDependencyBackfill } from '../domain/manifest.js'
import { isProtectedModule } from '../domain/runtime.js'
import { listSnapshots, readSafeBootState, validatePatchYaml, writeSnapshot } from '../domain/safe-boot.js'
import { reconcileLockfile } from '../domain/selfupdate.js'
import { listEntries } from '../domain/runtime.js'
import { preferredRegistries } from '../domain/sources.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { baseDirOf, dshHome, findPatchPath, pluginRoot, profileDirOf, resolvePackageJson } from '../infra/paths.js'
import { preflightRoots } from './framework-preflight.js'

const PREFLIGHT_TIMEOUT_ENV = 'DSH_AUTO_PREFLIGHT_TIMEOUT_MS'
/** 自动预检的预算：到点降级成「未完成，可手动重跑」，状态查询照常返回（env 可调）。 */
function preflightTimeoutMs() {
  const raw = Number(process.env[PREFLIGHT_TIMEOUT_ENV])
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
}

function pluginVersionOf() {
  try { return JSON.parse(readFileSync(join(pluginRoot(), 'package.json'), 'utf8')).version ?? null } catch { return null }
}

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

/** 桌面端宿主形态（复用既有判据 `detectHostShape`；`rc.deps` 可注入替身，生产路径即真判据）。 */
function hostShapeOf(rc) {
  const detect = rc?.deps?.detectHostShape ?? detectHostShape
  try { return detect() } catch { return { hosted: false, kind: 'standalone', reasons: [] } }
}

/** D4 只在「启动 / 首次状态查询」判定一次（与用户要求的触发时机一致）；之后的状态查询不重复判定。
 *  `resetHostSwitchChecked()` 只给测试用：让"首次判定"这件事可被独立驱动（生产路径不调用它）。 */
let hostSwitchChecked = false
function resetHostSwitchChecked() { hostSwitchChecked = false }

/** D4：桌面端宿主启动 → 非用户手动设定的模式自动拨回观察者（幂等；已是 observer 时零写盘）。 */
function maybeSwitchToObserver(rc, { force = false } = {}) {
  if (hostSwitchChecked && force !== true) return { switched: false, reason: 'already-checked', note: null }
  hostSwitchChecked = true
  try {
    const current = readCompatMode()
    const verdict = planDesktopHostSwitch(current, { hosted: hostShapeOf(rc).hosted === true })
    if (verdict.action !== 'switch-to-observer') return { switched: false, reason: verdict.reason, note: null }
    const written = writeCompatMode('observer', { source: 'auto:desktop-host', reason: verdict.note.zh })
    return { switched: written.ok === true && written.changed === true, reason: verdict.reason, note: verdict.note }
  } catch (error) {
    return { switched: false, reason: `判定失败：${error instanceof Error ? error.message : String(error)}`, note: null }
  }
}

/**
 * D1：指纹变化 → 后台跑一次只读预检（**不 await**：状态查询该返回什么还返回什么）。
 * 节流闸门在 `runAutoPreflight` 内部**同步**写下的 pending 占位 —— 同指纹的第二次查询会看到
 * pending/done，因此「同一指纹只自动跑一次」与「绝不阻塞」两件事同时成立。
 */
function scheduleAutoPreflight(rc, { current, previous, reasons, profileDir, patchPath }) {
  const scan = rc?.deps?.autoPreflightScan ?? runAutoPreflightScan
  let roots = []
  const entries = (() => { try { return listEntries(rc.ctx) } catch { return [] } })()
  try { roots = preflightRoots(rc.ctx, profileDir, { listEntries: () => entries, resolvePackageJson, pluginRoot }) } catch { roots = [] }
  const timeoutMs = preflightTimeoutMs()
  void runAutoPreflight({
    current,
    previous,
    timeoutMs,
    scan: ({ current: cur, previous: prev }) => scan({
      profileDir,
      patchPath,
      current: cur,
      previous: prev,
      presetRoots: [join(dshHome(), '.agent-presets')],
      roots,
      reasons,
      previousPackages: [],
      networkAllowed: false,
    }),
  }).then((result) => {
    // D5：预检**出结论之后**再看要不要自动禁用（有确证证据 + 开关开着 → 禁前快照 → 写盘 → 留记录）
    if (result?.ok === true && result.record !== null && result.record !== undefined) maybeAutoDisable({ rc, current, previous, reasons, patchPath, record: result.record })
  }).catch(() => {})
  return { scheduled: true, timeoutMs, roots: roots.length }
}

/**
 * D5 的接线：把 D1 预检结论里的**确证证据**交给自动禁用入口（`domain/auto-disable.js`）。
 * 开关（`compat-gate.json#autoDisableOnEvidence`，默认启用）关闭时只记录候选、不写盘。
 * 结果**只留在内存里给下一次状态查询用**（一次性提示；不新增任何常驻 UI/文件）。
 */
let lastAutoDisable = null
function maybeAutoDisable({ rc, current, previous, reasons, patchPath, record }) {
  try {
    const evidence = record.evidence ?? null
    const hasEvidence = Array.isArray(evidence?.rows) && evidence.rows.some((r) => r.code === 'package-unresolvable' || r.code === 'file-target-missing')
    const hasBoot = Array.isArray(evidence?.bootRows) && evidence.bootRows.length > 0
    if (!hasEvidence && !hasBoot) return null
    if (typeof patchPath !== 'string' || patchPath === '' || !existsSync(patchPath)) return null
    const gate = readCompatGate()
    const plan = rc?.deps?.autoDisableApply ?? applyEvidenceDisable
    const result = plan({
      patchPath,
      affected: Array.isArray(evidence?.rows) ? evidence.rows : [],
      bootRows: Array.isArray(evidence?.bootRows) ? evidence.bootRows : [],
      enabled: gate.autoDisableOnEvidence === true,
      uncertainty: evidence?.uncertainty ?? null,
      fingerprint: current,
      frameworkVersion: current?.frameworkVersion ?? null,
      reasons,
      isProtected: isProtectedModule,
    })
    lastAutoDisable = { at: Date.now(), snapshotId: result?.snapshot?.id ?? null, ...result }
    return result
  } catch (error) {
    lastAutoDisable = { at: Date.now(), ok: false, disabled: [], error: error instanceof Error ? error.message : String(error) }
    return null
  }
}

/** 一次性提示文案（中英双语短句；**不新增常驻 UI**：由客户端沿用既有的瞬时 note 通道显示）。
 *  ★ 开关是**读时判据**：关掉之后，之前那次"已自动禁用 N 行"的提示**不许再冒出来**
 *    （否则用户会以为刚又被禁了一次；实测就是这么发现的）。 */
function autoDisableNotice(entry = lastAutoDisable, { enabled = null } = {}) {
  const on = enabled === null ? readCompatGate().autoDisableOnEvidence === true : enabled === true
  if (entry === null || entry === undefined) return null
  if (on !== true && entry.code === 'auto-disabled') return null
  const added = Array.isArray(entry.disabled) ? entry.disabled : []
  const restore = 'node scripts/safe-boot.mjs --restore-last-good'
  if (added.length > 0) {
    return {
      at: entry.at ?? null,
      zh: `已自动禁用 ${added.length} 行（确证解析不到 / 上次把服务搞挂）：${added.join('、')}；如需恢复：${restore}`,
      en: `Auto-disabled ${added.length} row(s) (confirmed unresolvable / crashed the service last time): ${added.join(', ')}; to restore: ${restore}`,
      disabled: added, snapshotId: entry.snapshotId ?? null, restoreCommand: restore, kind: 'auto-disabled',
    }
  }
  if (entry.code === 'switch-off') {
    return {
      at: entry.at ?? null,
      zh: `检测到需禁用的行，但自动禁用开关已关闭：${(entry.candidates ?? []).join('、')}（保持原样，等你手动处理）`,
      en: `Rows need disabling, but the auto-disable switch is off: ${(entry.candidates ?? []).join(', ')} (left untouched)`,
      disabled: [], candidates: entry.candidates ?? [], restoreCommand: restore, kind: 'switch-off',
    }
  }
  return null
}

/**
 * D2：确认服务正常后落一份 last-known-good 快照。
 * 「确认正常」的判据（不吹牛）：状态查询跑到了这一步 **且** 指纹与基线一致（环境没变）
 * **且** 补丁通过结构校验（不是写坏的）。任一不满足就如实说明，不写快照。
 */
function maybeWriteSnapshot({ current, changed, patchPath }) {
  try {
    if (typeof patchPath !== 'string' || patchPath === '' || !existsSync(patchPath)) return { written: false, reason: 'no-patch-file' }
    const patchText = readFileSync(patchPath, 'utf8')
    if (changed === true) return { written: false, reason: 'environment-changed' }
    const check = validatePatchYaml(patchText)
    if (check.ok !== true) return { written: false, reason: 'patch-not-yaml-valid', problems: check.problems.slice(0, 3) }
    const result = writeSnapshot({
      patchPath,
      patchText,
      fingerprint: current,
      frameworkVersion: current?.frameworkVersion ?? null,
      reasons: [],
      kind: 'auto',
      pluginVersion: pluginVersionOf(),
      note: `自动快照（模式 ${readCompatMode().mode}，服务响应正常，环境未变）`,
    })
    if (result.ok !== true) return { written: false, reason: 'write-failed', error: result.error }
    return { written: result.written === true, reason: result.written === true ? null : (result.reason ?? 'unchanged'), snapshot: result.snapshot ?? null }
  } catch (error) {
    return { written: false, reason: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

async function routeCompatStatusGet(req, res, rc) {
  // D4：桌面端宿主启动 → 自动拨回观察者（只在启动/首次查询判定一次；用户手动拨过的机器一动不动）
  const auto = maybeSwitchToObserver(rc)
  const mode = readCompatMode()
  const current = currentFingerprint(rc)
  const previous = readFingerprint()
  const { changed, reasons, baselineAt } = compareFingerprint(current, previous)
  const patchPath = (() => { try { return findPatchPath(rc.ctx) } catch { return null } })()

  // D1：变了就自动跑一次只读预检（后台，不阻塞；同一指纹只跑一次）
  const autoRun = changed === true ? scheduleAutoPreflight(rc, { current, previous, reasons, profileDir: profileDirOf(rc.ctx), patchPath }) : null

  // D2：确认服务正常 → 落 last-known-good 快照（节流：指纹与补丁都没变时零写盘）
  const snapshot = maybeWriteSnapshot({ current, changed, patchPath })

  const autoPreflight = autoPreflightView({ changed, current })
  sendJson(res, 200, {
    ok: true,
    mode: mode.mode,
    modeSource: mode.fileSource,
    modeChangedAt: mode.at,
    modeReason: mode.reason ?? null,
    // D4 加法字段：本次是否自动拨回了观察者 + 一句短句（中英双语）；没自动改就是 null
    modeAuto: auto.switched === true ? { switched: true, note: auto.note, at: Date.now() } : null,
    frameworkVersion: current.frameworkVersion,
    fingerprint: { current, previous, changed, reasons, baselineAt },
    rollback: readRollbackRecord(),
    // D1 加法字段：自动预检的状态/结论（面板只放一句短句，长文进详情）
    autoPreflight: { ...autoPreflight, scheduled: autoRun !== null, scheduledAt: autoRun === null ? null : Date.now(), timeoutMs: autoRun?.timeoutMs ?? preflightTimeoutMs() },
    // D5 加法字段：自动禁用的开关状态 + **本次一次性提示**（客户端走既有瞬时 note 通道；
    // 服务端不新增任何常驻面板元素/按钮/文件）
    autoDisable: {
      onEvidence: readCompatGate().autoDisableOnEvidence === true,
      switch: { file: 'compat-gate.json', key: 'autoDisableOnEvidence', route: '/plugin-console/compat-ack', body: { autoDisableOnEvidence: false } },
      notice: autoDisableNotice(),
      restore: { route: { path: '/plugin-console/safe-boot', body: { action: 'restore-last-good' } }, command: 'node scripts/safe-boot.mjs --restore-last-good' },
      logHint: '记录落在 dshHome()/plugin-console/auto-disable.log（追加式 JSONL）',
    },
    // D2 加法字段：安全启动材料（last-known-good 快照 + 恢复入口提示）
    safeBoot: {
      snapshot: { written: snapshot.written === true, reason: snapshot.reason ?? null, id: snapshot.snapshot?.id ?? null, at: snapshot.snapshot?.at ?? null, sha256: snapshot.snapshot?.patchSha256 ?? null },
      snapshots: listSnapshots().slice(0, 5),
      lastGoodId: readSafeBootState().lastGoodId,
      command: { list: 'node scripts/safe-boot.mjs --list', restore: 'node scripts/safe-boot.mjs --restore-last-good', disable: 'node scripts/safe-boot.mjs --disable-suspects' },
      route: { action: 'restore-last-good | disable-suspects | list | mark-good', path: '/plugin-console/safe-boot' },
    },
  })
}

async function routeCompatMode(req, res, rc) {
  const wanted = rc.body?.mode
  // 用户手动拨动 → 来源记 `manual`（此后**永不自动改**：D4 的"不抢用户意图"就靠这一笔）
  const result = writeCompatMode(wanted, { source: 'manual', reason: '用户手动切换' })
  if (!result.ok) { sendError(res, 400, result.error); return }
  sendJson(res, 200, {
    ok: true,
    mode: result.mode,
    source: result.source,
    changed: result.changed === true,
    note: result.mode === 'observer' ? '观察者模式：只做预检与门控，不接管框架升级' : '托管模式：框架升级与回滚由本控制台负责',
  })
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
  // D5 加法：自动禁用（有确证证据时）的开关——同一把锁（compat-gate.json）里再记一个布尔。
  // 它与既有的 `autoDisable`（我们升级时）是两个独立开关；这里只动 `autoDisableOnEvidence`，
  // **不碰** 既有字段（一个字都不改旧语义）。
  if (typeof body.autoDisableOnEvidence === 'boolean') {
    const gate = writeCompatGate({ autoDisableOnEvidence: body.autoDisableOnEvidence })
    sendJson(res, 200, {
      ok: true,
      autoDisableOnEvidence: gate.autoDisableOnEvidence,
      autoDisable: gate.autoDisable,
      note: gate.autoDisableOnEvidence === true
        ? '指纹变化 / 启动失败记录给出确证证据时，会自动禁用被点名的行（禁前先存快照，可一条命令回滚）'
        : '已关闭自动禁用：只在面板/接口里报告点名行，改由你手动点「只禁可疑行」',
    })
    return
  }
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
export { hostShapeOf, maybeSwitchToObserver, maybeWriteSnapshot, preflightTimeoutMs, resetHostSwitchChecked, routeCompatAck, routeCompatMode, routeCompatStamp, routeCompatStatusGet, routeDeclareInstalled, scheduleAutoPreflight }
