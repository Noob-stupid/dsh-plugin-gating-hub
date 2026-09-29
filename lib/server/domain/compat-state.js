// L1 · domain —— 门控常驻化的状态层：运行模式（托管 / 观察者）+ 环境指纹 + 回滚点读取
//
// 为什么需要它（2026-09-24 桌面端复盘）：门控此前**寄生在我们自己的升级流程**上 ——
// 「我们点升级」才跑兼容扫描、才产出隔离清单。一旦官方桌面端自带升级器，或官方只发桌面端
// 而不再单独更新框架，我们就失去了触发点。这里把触发源从「升级动作」换成「环境指纹变化」：
// 任何来源的框架变更（官方升级器 / 桌面端自带运行时 / 手动 pnpm / npx 缓存变化）都会被发现，
// 门控因此不再依赖我们是否执行了升级。
//
// 纯状态层：不做扫描、不装东西、不碰 ctx。扫描仍走 domain/compat.js 与 domain/format-scan.js。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'

/** 运行模式。managed = 托管（我们负责框架升级与回滚，既有行为）；observer = 观察者（只守门，不碰升级）。 */
const COMPAT_MODES = ['managed', 'observer']
// 默认**观察者**（用户 2026-09-24 定）：只守门、不接管框架升级；一旦用户走了本控制台的框架升级，服务端会自动切回托管
const DEFAULT_MODE = 'observer'

/**
 * 模式写入的**来源**（0.5.32 加法 D4；缺字段一律按 `manual` 兼容 —— 老记录等于"用户手动设定过"，永不自动改）：
 *   · `manual`               用户在本控制台手动拨过（`POST /compat-mode`）→ 之后**永不自动改**
 *   · `auto:console-upgrade` 走了本控制台的框架升级 → 自动切托管（可被桌面端启动拨回）
 *   · `auto:desktop-host`    检测到桌面端宿主形态 → 自动切观察者
 */
const MODE_SOURCES = ['manual', 'auto:console-upgrade', 'auto:desktop-host']
const DEFAULT_MODE_SOURCE = 'manual'

/** 自动切换的判定（纯函数）：**只在"上次不是用户手动设定"时才自动改**。 */
const AUTO_MODE_SOURCES = ['auto:console-upgrade', 'auto:desktop-host']

/**
 * 「桌面端宿主启动 → 自动拨回观察者」的判定（纯函数，加法 D4）。
 * 规则（三条，全部可离线断言）：
 *   ① 不是桌面端宿主 → 不动（`standalone` 实例的既有行为一字不改）；
 *   ② 当前已经是 observer → 不动（**零写盘**：连 source 都不刷新）；
 *   ③ 当前模式的来源是 `manual`（含缺字段的老记录）→ **不动**（用户手动优先，绝不抢用户意图）。
 * @returns {{ action: 'none'|'switch-to-observer', mode: string, from: string, reason: string|null, note: {zh,en}|null }}
 */
function planDesktopHostSwitch(modeRecord, { hosted = false } = {}) {
  const mode = typeof modeRecord?.mode === 'string' && COMPAT_MODES.includes(modeRecord.mode) ? modeRecord.mode : DEFAULT_MODE
  const source = typeof modeRecord?.source === 'string' && MODE_SOURCES.includes(modeRecord.source) ? modeRecord.source : DEFAULT_MODE_SOURCE
  if (hosted !== true) return { action: 'none', mode, from: source, reason: 'not-desktop-host', note: null }
  if (mode === 'observer') return { action: 'none', mode, from: source, reason: 'already-observer', note: null }
  if (!AUTO_MODE_SOURCES.includes(source)) return { action: 'none', mode, from: source, reason: 'user-set-manual', note: null }
  return {
    action: 'switch-to-observer',
    mode: 'observer',
    from: source,
    reason: 'desktop-host-detected',
    note: {
      zh: '检测到桌面端托管，已切观察者：不接管框架升级',
      en: 'Desktop host detected — switched to Observer: framework upgrades are not taken over',
    },
  }
}

const stateDir = () => join(dshHome(), 'plugin-console')
const modeFile = () => join(stateDir(), 'compat-mode.json')
const fingerprintFile = () => join(stateDir(), 'env-fingerprint.json')
const rollbackFile = () => join(stateDir(), 'framework-rollback.json')

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 读运行模式。**默认观察者** —— 纯加法：没有设置过的机器行为与之前完全一致。
 * `source` 缺字段（0.5.32 之前写下的记录）按 `manual` 兼容：视为用户手动设定过，绝不自动改。
 * @returns {{ mode: string, at: number|null, source: 'manual'|'auto:console-upgrade'|'auto:desktop-host', reason: string|null, fileSource: 'file'|'default' }}
 */
function readCompatMode() {
  const rec = readJson(modeFile())
  const mode = typeof rec?.mode === 'string' && COMPAT_MODES.includes(rec.mode) ? rec.mode : DEFAULT_MODE
  const source = typeof rec?.source === 'string' && MODE_SOURCES.includes(rec.source) ? rec.source : DEFAULT_MODE_SOURCE
  return { mode, at: typeof rec?.at === 'number' ? rec.at : null, source, reason: typeof rec?.reason === 'string' ? rec.reason : null, fileSource: rec === null ? 'default' : 'file' }
}

/**
 * 写运行模式（只接受白名单值，避免拼错导致「模式静默失效」）。
 * **幂等零写盘**（0.5.32 加法 D4）：模式与来源都没变时一个字节都不写 —— 否则"桌面端每次启动都重写一份
 * 状态文件"，而用户看不出任何区别（也破坏"已是 observer 时零写盘"的断言）。
 * @returns {{ ok: boolean, mode: string, source: string, changed: boolean, error?: string }}
 */
function writeCompatMode(mode, meta = {}) {
  if (typeof mode !== 'string' || !COMPAT_MODES.includes(mode)) {
    const current = readCompatMode()
    return { ok: false, mode: current.mode, source: current.source, changed: false, error: `未知模式 ${String(mode)}（可选：${COMPAT_MODES.join(' / ')}）` }
  }
  const source = typeof meta.source === 'string' && MODE_SOURCES.includes(meta.source) ? meta.source : DEFAULT_MODE_SOURCE
  const reason = typeof meta.reason === 'string' ? meta.reason : null
  const current = readCompatMode()
  if (current.mode === mode && current.source === source && current.reason === reason && current.at !== null) {
    return { ok: true, mode, source, changed: false }
  }
  writeJson(modeFile(), { mode, at: Date.now(), source, reason })
  return { ok: true, mode, source, changed: true }
}

/**
 * 算一份环境指纹。字段刻意取「便宜且稳定」的信号：
 *   · frameworkVersion —— 框架自报版本（换版本必变）
 *   · pnpmEntities —— 框架树里 @deepseek-ai 实体数（半装/损坏/换包会变）
 *   · pnpmRoot —— 框架树根路径（换运行时/换安装位置会变：npx 缓存 ↔ 桌面端自带运行时）
 * @param {{ frameworkVersion?: string|null, pnpmRoot?: string|null }} input
 */
function computeFingerprint(input = {}) {
  const frameworkVersion = typeof input.frameworkVersion === 'string' && input.frameworkVersion !== '' ? input.frameworkVersion : null
  const pnpmRoot = typeof input.pnpmRoot === 'string' && input.pnpmRoot !== '' ? input.pnpmRoot : null
  let pnpmEntities = null
  if (pnpmRoot !== null) {
    try {
      pnpmEntities = readdirSync(join(pnpmRoot, '.pnpm'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('@deepseek-ai+')).length
    } catch {
      pnpmEntities = null
    }
  }
  return { frameworkVersion, pnpmEntities, pnpmRoot, at: Date.now() }
}

function readFingerprint() {
  const rec = readJson(fingerprintFile())
  return rec === null ? null : rec
}

/** 把当前指纹记为基线（启动时 / 用户确认变更后调用）。 */
function stampFingerprint(fp) {
  const rec = { ...fp, at: Date.now() }
  writeJson(fingerprintFile(), rec)
  return rec
}

/**
 * 比对新旧指纹 —— 这就是「环境变更事件」的判定：**谁改的都算**。
 * @returns {{ changed: boolean, reasons: string[], baselineAt: number|null }}
 */
function compareFingerprint(current, previous) {
  if (previous === null || previous === undefined) return { changed: false, reasons: [], baselineAt: null }
  const reasons = []
  if (previous.frameworkVersion !== current.frameworkVersion) {
    reasons.push(`框架版本 ${previous.frameworkVersion ?? '未知'} → ${current.frameworkVersion ?? '未知'}`)
  }
  if (previous.pnpmRoot !== current.pnpmRoot) reasons.push('框架运行时位置变化（换了安装根：npx 缓存 / 桌面端自带运行时 / 自定义）')
  if (previous.pnpmEntities !== current.pnpmEntities) reasons.push(`框架树包数 ${previous.pnpmEntities ?? '?'} → ${current.pnpmEntities ?? '?'}`)
  return { changed: reasons.length > 0, reasons, baselineAt: typeof previous.at === 'number' ? previous.at : null }
}

/** 回滚点：记录存在 **且** 其 checkpoint 目录仍在（记录在、目录没了 = 实际不可用，不能骗用户）。 */
function readRollbackRecord() {
  const rec = readJson(rollbackFile())
  if (rec === null) return { from: null, to: null, at: null, applicable: false, reason: '没有回滚记录' }
  const fwRoot = typeof rec.fwRoot === 'string' ? rec.fwRoot : null
  const checkpoint = fwRoot === null ? false : existsSync(join(stateDir(), 'framework-backups'))
  const applicable = fwRoot !== null && existsSync(fwRoot)
  return {
    from: rec.from ?? null,
    to: rec.to ?? null,
    at: typeof rec.at === 'number' ? rec.at : null,
    fwRoot,
    checkpoint,
    applicable,
    reason: applicable ? null : '框架树路径不存在（可能已被清理或换了安装根）',
  }
}

export { AUTO_MODE_SOURCES, COMPAT_MODES, DEFAULT_MODE, DEFAULT_MODE_SOURCE, MODE_SOURCES, compareFingerprint, computeFingerprint, planDesktopHostSwitch, readCompatMode, readFingerprint, readRollbackRecord, stampFingerprint, writeCompatMode }
