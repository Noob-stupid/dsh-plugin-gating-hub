// L1 · domain —— preset-contract.js（会话预设 ↔ 框架契约的每日只读体检；0.5.111 加法）
//
// 用户 2026-11-18 选 A：每天只读探一次，不自动改写预设。
// 做法：
//   · 用**已安装的官方包**当契约指纹（@deepseek-ai/dsh-agent-preset 的版本 + lib/index.js sha256）；
//   · 复用既有 preset-audit（声明行 ↔ 磁盘预设的跨源对账），只把结论汇总成面板一句话；
//   · 24h 内命中缓存；force=1 才重算；结果落 preset-contract.json。
//
// 硬边界：只读；不改 .agent-presets/**、不写 profile 补丁；包解析不到如实报 error，不猜。
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'
import { collectPresetAudit } from './preset-audit.js'
import { parsePatchRows } from './patch-composition-audit.js'

const DAY_MS = 24 * 60 * 60 * 1000
const CONTRACT_FILE = 'preset-contract.json'
const cacheFile = (home = undefined) => join(home ?? dshHome(), 'plugin-console', CONTRACT_FILE)

function readCache(home = undefined) {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(home), 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : null
  } catch { return null }
}

function sha256File(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null }
}

/** 官方预设包的契约指纹：版本 + 入口文件 sha（入口读不到就退回 package.json sha）。 */
function readContract({ baseUrl = null, profileDir = null } = {}) {
  try {
    const anchor = typeof baseUrl === 'string' && baseUrl !== '' ? baseUrl : join(profileDir ?? dshHome(), 'package.json')
    const require = createRequire(anchor)
    const pkgPath = require.resolve('@deepseek-ai/dsh-agent-preset/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const main = join(dirname(pkgPath), typeof pkg.main === 'string' && pkg.main !== '' ? pkg.main : 'lib/index.js')
    const sha = sha256File(main) ?? sha256File(pkgPath)
    return { ok: true, package: pkg.name ?? '@deepseek-ai/dsh-agent-preset', version: pkg.version ?? null, sha, main: existsSync(main) ? main : pkgPath, error: null }
  } catch (error) {
    return { ok: false, package: '@deepseek-ai/dsh-agent-preset', version: null, sha: null, main: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function summarizeAudit(audit) {
  if (audit === null || typeof audit !== 'object') return { ok: false, presetCount: 0, blockers: 0, stale: 0, missing: 0, orphan: 0, targetMissing: 0, error: '没有体检结论' }
  return {
    ok: audit.ok === true,
    presetCount: Number(audit.presetCount) || 0,
    blockers: Number(audit.blockers) || 0,
    stale: Array.isArray(audit.stale) ? audit.stale.length : 0,
    missing: Array.isArray(audit.missing) ? audit.missing.length : 0,
    orphan: Array.isArray(audit.orphan) ? audit.orphan.length : 0,
    targetMissing: Array.isArray(audit.targetMissing) ? audit.targetMissing.length : 0,
    error: audit.error ?? null,
  }
}

function declarationCount(patchPath) {
  try {
    const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
    return rows.filter((row) => row?.name === '@deepseek-ai/dsh-agent-preset').length
  } catch { return 0 }
}

/**
 * 跑一次契约体检（24h 缓存；force=true 强制重算）。
 * @returns {{ok:boolean,cached:boolean,checkedAt:number,nextDueAt:number,contract:object,declarations:number,audit:object,drift:object,error?:string}}
 */
function runPresetContractCheck({ baseUrl = null, profileDir = null, presetsRoot = null, patchPath = null, force = false, home = undefined, now = Date.now() } = {}) {
  const cached = readCache(home)
  if (force !== true && cached !== null && Number.isFinite(Number(cached.checkedAt)) && now - Number(cached.checkedAt) < DAY_MS) {
    return { ...cached, cached: true }
  }
  const contract = readContract({ baseUrl, profileDir })
  const audit = (() => {
    try {
      return summarizeAudit(collectPresetAudit({ presetsRoot: presetsRoot ?? join(home ?? dshHome(), '.agent-presets'), patchPath }))
    } catch (error) {
      return { ok: false, presetCount: 0, blockers: 0, stale: 0, missing: 0, orphan: 0, targetMissing: 0, error: error instanceof Error ? error.message : String(error) }
    }
  })()
  const declarations = typeof patchPath === 'string' && patchPath !== '' ? declarationCount(patchPath) : 0
  const previousSha = cached?.contract?.sha ?? null
  const drift = {
    contractChanged: previousSha !== null && contract.sha !== null && previousSha !== contract.sha,
    blockers: audit.blockers,
    declarations,
    hasDrift: audit.blockers > 0 || (previousSha !== null && contract.sha !== null && previousSha !== contract.sha),
  }
  const result = {
    ok: contract.ok === true && audit.error === null,
    cached: false,
    checkedAt: now,
    nextDueAt: now + DAY_MS,
    contract,
    declarations,
    audit,
    drift,
    error: contract.ok === true ? (audit.error ?? null) : (contract.error ?? '官方预设包解析不到'),
  }
  try {
    mkdirSync(dirname(cacheFile(home)), { recursive: true })
    writeFileSync(cacheFile(home), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  } catch {}
  return result
}

export { DAY_MS, cacheFile, declarationCount, readCache, readContract, runPresetContractCheck, summarizeAudit }
