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
const DEFAULT_MODE = 'managed'

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
 * 读运行模式。**默认托管** —— 纯加法：没有设置过的机器行为与之前完全一致。
 * @returns {{ mode: string, at: number|null, source: 'file'|'default' }}
 */
function readCompatMode() {
  const rec = readJson(modeFile())
  const mode = typeof rec?.mode === 'string' && COMPAT_MODES.includes(rec.mode) ? rec.mode : DEFAULT_MODE
  return { mode, at: typeof rec?.at === 'number' ? rec.at : null, source: rec === null ? 'default' : 'file' }
}

/**
 * 写运行模式（只接受白名单值，避免拼错导致「模式静默失效」）。
 * @returns {{ ok: boolean, mode: string, error?: string }}
 */
function writeCompatMode(mode) {
  if (typeof mode !== 'string' || !COMPAT_MODES.includes(mode)) {
    return { ok: false, mode: readCompatMode().mode, error: `未知模式 ${String(mode)}（可选：${COMPAT_MODES.join(' / ')}）` }
  }
  writeJson(modeFile(), { mode, at: Date.now() })
  return { ok: true, mode }
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

export { COMPAT_MODES, DEFAULT_MODE, compareFingerprint, computeFingerprint, readCompatMode, readFingerprint, readRollbackRecord, stampFingerprint, writeCompatMode }
