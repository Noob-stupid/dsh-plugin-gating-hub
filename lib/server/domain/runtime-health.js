// L1 · domain —— runtime-health.js（运行期卡顿防护：客户端空转上报 + 归因 + 事件循环采样；0.5.111 加法）
//
// 用户 2026-11-17 现场：桌面端后台一直刷
//   `client.js:3229 WebSocket connection to 'ws://127.0.0.1:9230/ingest' failed`
// 9230 是**官方** `@deepseek-ai/dsh-experimental-inspector` 的客户端 endpoint（默认端口），
// 服务端没监听时它就会无限重连 —— 官方插件一样能把页面主线程拖卡。
//
// 本模块只做三件事（**不杀进程、不碰别的插件代码、不写补丁**）：
//   ① 收客户端哨兵上报的“同一 URL 反复失败”事件，落一份**有上限**的 ring（50 条）；
//   ② 归因：优先用调用栈里的 `/plugins/<pkg>/`、`/node_modules/<pkg>/` 路径；
//      没有栈时只在**当前 profile 已装包**里只读搜 URL/端口（缓存，单文件 1MB 上限）；
//   ③ 事件循环采样：1s 心跳的漂移 > 50ms 记为一次卡顿（含我们自己的同步扫描），供面板显示。
//
// 硬边界（改代码时别越线）：
//   · 只记录、只归因；**是否熔断由客户端哨兵决定**，是否停用由用户点（既有 /toggle）。
//   · 归因扫描是只读的，不执行包内代码、不联网；扫不到就如实返回 null，不猜。
//   · 任何 IO 失败都不抛给调用方：返回 `{ok:false,error}` 或空视图。
//   · 上限：incidents 50 条、归因缓存 200 项、单文件 1MB、单包最多 40 个 js 文件。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'

/** 客户端哨兵的配置（跟着页面走；服务端只负责持久化与下发）。
 *  ⚠ `enabled` 只是**调试覆盖**：守护是否生效由「运行模式（观察者）」决定（客户端读 /compat-status.mode）；
 *  默认 false，避免 managed 模式被误显示成“守护生效”。 */
const DEFAULT_CONFIG = {
  enabled: false,
  windowMs: 30000,
  maxFails: 20,
  cooldownMs: 120000,
  suppressCloseMs: 15000,
}

const CONFIG_FILE = 'runtime-guard.json'
const STORE_FILE = 'runtime-health.json'
const MAX_INCIDENTS = 50
const MAX_SCAN_FILES = 40
const MAX_SCAN_BYTES = 1024 * 1024
const ATTRIBUTION_MEMO_LIMIT = 200

const stateDir = (home = undefined) => join(home ?? dshHome(), 'plugin-console')
const configFile = (home = undefined) => join(stateDir(home), CONFIG_FILE)
const storeFile = (home = undefined) => join(stateDir(home), STORE_FILE)

const readJson = (file, readText) => {
  try {
    if (typeof readText === 'function') return JSON.parse(readText(file))
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 归一配置：非法项回落默认值，并逐项记下“哪里说不过去”（不静默改）。 */
function normalizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG }
  const problems = []
  if (raw === null || raw === undefined) return { config: out, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { config: out, problems: ['配置不是对象'] }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  else if (raw.enabled !== undefined) problems.push('enabled 不是布尔值')
  const num = (key, min, max) => {
    const value = Number(raw[key])
    if (!Number.isFinite(value)) {
      if (raw[key] !== undefined) problems.push(`${key} 不是数字`)
      return
    }
    out[key] = Math.min(max, Math.max(min, Math.round(value)))
  }
  num('windowMs', 1000, 300000)
  num('maxFails', 3, 10000)
  num('cooldownMs', 10000, 3600000)
  num('suppressCloseMs', 1000, 300000)
  return { config: out, problems }
}

/** 读配置（读不到/坏文件 → 默认值 + 如实原因；**绝不覆盖**用户文件）。 */
function readRuntimeGuardConfig({ home = undefined, readText = null } = {}) {
  const file = configFile(home)
  const raw = readJson(file, readText)
  if (raw === null) {
    const exists = (() => { try { return existsSync(file) } catch { return false } })()
    return { config: { ...DEFAULT_CONFIG }, problems: exists ? ['配置读不出来（按默认值）'] : [], file, exists }
  }
  const { config, problems } = normalizeConfig(raw)
  return { config, problems, file, exists: true }
}

/** 写配置（只接受白名单字段；读坏文件不覆盖 —— 与仓库其它状态文件同一纪律）。 */
function writeRuntimeGuardConfig(patch = {}, { home = undefined, readText = null } = {}) {
  const current = readRuntimeGuardConfig({ home, readText })
  const next = { ...current.config }
  if (patch !== null && typeof patch === 'object') {
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    for (const key of ['windowMs', 'maxFails', 'cooldownMs', 'suppressCloseMs']) {
      const value = Number(patch[key])
      if (Number.isFinite(value)) next[key] = Math.min(DEFAULT_CONFIG[key] * 100, Math.max(1, Math.round(value)))
    }
  }
  const normalized = normalizeConfig(next).config
  try {
    mkdirSync(dirname(configFile(home)), { recursive: true })
    writeFileSync(configFile(home), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    return { ok: true, config: normalized, file: configFile(home), error: null }
  } catch (error) {
    return { ok: false, config: current.config, file: configFile(home), error: String(error?.message ?? error) }
  }
}

/** 空 store（坏文件也降级成空，不抛）。 */
function emptyStore() {
  return { schema: 1, updatedAt: null, eventLoop: null, incidents: [] }
}

function readRuntimeHealthStore({ home = undefined, readText = null } = {}) {
  const raw = readJson(storeFile(home), readText)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore()
  return {
    schema: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    eventLoop: raw.eventLoop !== null && typeof raw.eventLoop === 'object' ? raw.eventLoop : null,
    incidents: Array.isArray(raw.incidents) ? raw.incidents.filter((x) => x !== null && typeof x === 'object') : [],
  }
}

function writeRuntimeHealthStore(store, { home = undefined } = {}) {
  try {
    mkdirSync(dirname(storeFile(home)), { recursive: true })
    writeFileSync(storeFile(home), `${JSON.stringify({ ...store, schema: 1 }, null, 2)}\n`, 'utf8')
    return { ok: true, file: storeFile(home), error: null }
  } catch (error) {
    return { ok: false, file: storeFile(home), error: String(error?.message ?? error) }
  }
}

// ── 事件循环采样 ────────────────────────────────────────────────────────────────
// 为什么用“1s 心跳漂移”而不是 monitorEventLoopDelay：零依赖、能直接抓到同步阻塞
// （本次实测 auto-preflight 同步扫描 5.47s，心跳会在下一次 tick 记到 ~5.4s 的漂移），
// 且 setInterval().unref() 不会拖住进程退出。
let loopState = { maxDriftMs: 0, lastDriftAt: null, stalls: 0, samples: 0, startedAt: null }
let loopTimer = null

function eventLoopSnapshot() {
  return { ...loopState, stalls: loopState.stalls }
}

/** 超过这个值的“漂移”不当作事件循环卡顿：多半是系统睡眠 / 时钟跳变（真机出现过 740s 的假峰值）。 */
const MAX_CREDIBLE_DRIFT_MS = 60000

/** 注入一次采样（纯函数，测试用）：返回新的 loopState。
 *  超过 60s 的跳变单独记 clockJumps，不污染 maxDriftMs / stalls（否则面板会显示十几分钟的假卡顿）。 */
function sampleEventLoop(state, driftMs, at = Date.now()) {
  const drift = Math.max(0, Math.round(Number(driftMs) || 0))
  const base = state !== null && typeof state === 'object' ? state : { maxDriftMs: 0, lastDriftAt: null, stalls: 0, samples: 0, startedAt: null }
  const next = { ...base, samples: (base.samples ?? 0) + 1 }
  if (drift > MAX_CREDIBLE_DRIFT_MS) {
    next.clockJumps = (base.clockJumps ?? 0) + 1
    next.lastClockJumpAt = at
    return next
  }
  if (drift > 50) {
    next.stalls = (base.stalls ?? 0) + 1
    next.lastDriftAt = at
    if (drift > (base.maxDriftMs ?? 0)) next.maxDriftMs = drift
  }
  return next
}

/** 启动采样（幂等；unref ⇒ 不阻塞退出）。测试里也可显式 start/stop。 */
function startEventLoopMonitor({ intervalMs = 1000, now = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (loopTimer !== null) return { started: false, reason: 'already-started', timer: loopTimer }
  const period = Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 200 ? Number(intervalMs) : 1000
  let last = now()
  loopState = { ...loopState, startedAt: loopState.startedAt ?? last }
  loopTimer = setIntervalFn(() => {
    const at = now()
    const drift = at - last - period
    last = at
    loopState = sampleEventLoop(loopState, drift, at)
  }, period)
  if (loopTimer !== null && typeof loopTimer.unref === 'function') loopTimer.unref()
  return { started: true, reason: null, timer: loopTimer }
}

function stopEventLoopMonitor({ clearIntervalFn = clearInterval } = {}) {
  if (loopTimer === null) return false
  try { clearIntervalFn(loopTimer) } catch {}
  loopTimer = null
  return true
}

// ── 归因 ────────────────────────────────────────────────────────────────────────
/** 从调用栈/脚本 URL 里认包名：`/plugins/@scope/pkg/…`、`/node_modules/pkg/lib/…`。 */
function attributeSourcePath(source) {
  const text = typeof source === 'string' ? source : ''
  if (text === '') return null
  const m = text.match(/(?:node_modules|plugins)[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)[\\/]/u)
  if (m === null) return null
  const owner = m[1].replace(/\\/gu, '/')
  if (owner === '' || owner.startsWith('.')) return null
  return { owner, confidence: 'source-path', evidence: text.slice(0, 300) }
}

const ATTRIBUTION_MEMO = new Map()

/** 收集一个包目录里值得搜的文件（client 优先、总量受限）。 */
function candidateFiles(pkgDir, readdir = readdirSync, statFile = statSync) {
  const out = []
  const push = (file) => {
    if (out.length >= MAX_SCAN_FILES) return
    if (out.includes(file)) return
    try { if (!statFile(file).isFile()) return } catch { return }
    out.push(file)
  }
  for (const rel of ['lib/client.js', 'client.js', 'lib/index.js', 'dist/client.js']) push(join(pkgDir, rel))
  const libDir = join(pkgDir, 'lib')
  try {
    for (const entry of readdir(libDir, { withFileTypes: true })) {
      if (out.length >= MAX_SCAN_FILES) break
      if (entry.isFile() && /\.(?:js|mjs|cjs)$/u.test(entry.name)) push(join(libDir, entry.name))
    }
  } catch {}
  return out
}

/** 在包目录里搜 needle（只读；超过 1MB 的文件跳过）。返回 `{file,line}` 或 null。 */
function findNeedle(pkgDir, needles, { readText = (p) => readFileSync(p, 'utf8'), readdir = readdirSync, statFile = statSync } = {}) {
  for (const file of candidateFiles(pkgDir, readdir, statFile)) {
    let text = ''
    try {
      if (statFile(file).size > MAX_SCAN_BYTES) continue
      text = readText(file)
    } catch { continue }
    for (const needle of needles) {
      const at = text.indexOf(needle)
      if (at < 0) continue
      const line = text.slice(0, at).split('\n').length
      return { file, line, needle }
    }
  }
  return null
}

/** 列出 profile 里已装的包目录（顶层 + 一层 scope；跳过点目录与 .bin）。 */
function installedPackageDirs(profileDir, { readdir = readdirSync } = {}) {
  const root = join(profileDir, 'node_modules')
  const out = []
  let entries = []
  try { entries = readdir(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      let scoped = []
      try { scoped = readdir(join(root, entry.name), { withFileTypes: true }) } catch { scoped = [] }
      for (const child of scoped) {
        if (child.isDirectory() && !child.name.startsWith('.')) out.push(join(root, entry.name, child.name))
      }
      continue
    }
    out.push(join(root, entry.name))
  }
  return out
}

/**
 * 归因一个 WebSocket URL：
 *   ① 先看调用栈里的包路径（最可信）；
 *   ② 没有栈 → 在已装包里只读搜 URL / `:port/path`（缓存按包 mtime）。
 * 返回 `{ owner, confidence, evidence }`；扫不到返回 `{ owner:null, ... }`（不猜）。
 */
function attributeUrl(url, { source = null, profileDir = null, deps = {} } = {}) {
  const fromSource = attributeSourcePath(source)
  if (fromSource !== null) return fromSource
  const text = String(url ?? '')
  if (text === '' || typeof profileDir !== 'string' || profileDir === '') return { owner: null, confidence: null, evidence: null }
  let parsed = null
  try { parsed = new URL(text) } catch { return { owner: null, confidence: null, evidence: null } }
  const port = parsed.port !== '' ? parsed.port : (parsed.protocol === 'wss:' ? '443' : '80')
  const path = parsed.pathname === '' ? '/' : parsed.pathname
  const needles = [text, `${parsed.host}${path}`, `:${port}${path}`, path.length > 1 ? path : null]
    .filter((x) => typeof x === 'string' && x.length >= 3)
  if (needles.length === 0) return { owner: null, confidence: null, evidence: null }
  const dirs = installedPackageDirs(profileDir, deps)
  for (const pkgDir of dirs) {
    let version = '?'
    let mtime = 0
    try {
      const pkg = JSON.parse((deps.readText ?? ((p) => readFileSync(p, 'utf8')))(join(pkgDir, 'package.json')))
      version = String(pkg.version ?? '?')
      mtime = (deps.statFile ?? statSync)(join(pkgDir, 'package.json')).mtimeMs
    } catch { continue }
    const key = `${text}|${pkgDir}|${version}|${mtime}`
    if (ATTRIBUTION_MEMO.has(key)) {
      const hit = ATTRIBUTION_MEMO.get(key)
      if (hit !== null) return hit
      continue
    }
    const found = findNeedle(pkgDir, needles, deps)
    const result = found === null ? null : {
      owner: (() => { try { return JSON.parse((deps.readText ?? ((p) => readFileSync(p, 'utf8')))(join(pkgDir, 'package.json'))).name ?? basename(pkgDir) } catch { return basename(pkgDir) } })(),
      confidence: 'source-scan',
      evidence: `${found.file}:${found.line}`,
    }
    if (ATTRIBUTION_MEMO.size >= ATTRIBUTION_MEMO_LIMIT) ATTRIBUTION_MEMO.clear()
    ATTRIBUTION_MEMO.set(key, result)
    if (result !== null) return result
  }
  return { owner: null, confidence: null, evidence: null }
}

// ── 事件收口 ────────────────────────────────────────────────────────────────────
const sanitizeText = (value, max = 500) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]/gu, ' ').trim().slice(0, max) : null)

/**
 * 记录一次客户端空转事件（幂等合并：同 url+source 只保留一条，trips+1）。
 * 返回 `{ ok, incident, store, writeError }`；写盘失败也把 incident 返回（面板至少能显示本次）。
 */
function recordClientIncident(input = {}, { home = undefined, profileDir = null, deps = {} } = {}) {
  const kind = sanitizeText(input.kind, 40) ?? 'ws-fail'
  const isPolling = kind === 'polling-storm'
  // 渲染增长（DOM/JS heap）也是“只有 source、没有 URL”的一类事件。
  const sourceOnly = isPolling || kind === 'renderer-growth'
  const url = sanitizeText(input.url, 500)
  const source = sanitizeText(input.source, 800)
  if (sourceOnly) {
    if (source === null || source === '') {
      return { ok: false, error: `${kind} 事件缺少 source（无法归因）`, incident: null, store: readRuntimeHealthStore({ home }), writeError: null }
    }
  } else if (url === null || url === '' || !/^wss?:\/\//iu.test(url)) {
    return { ok: false, error: 'url 不是 ws:// 或 wss://', incident: null, store: readRuntimeHealthStore({ home }), writeError: null }
  }
  const count = Math.max(1, Math.min(100000, Math.round(Number(input.count) || 1)))
  const windowMs = Math.max(1000, Math.min(300000, Math.round(Number(input.windowMs) || DEFAULT_CONFIG.windowMs)))
  const at = Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now()
  const detail = input.detail !== null && typeof input.detail === 'object' && !Array.isArray(input.detail)
    ? (() => { try { return JSON.parse(JSON.stringify(input.detail)) } catch { return null } })()
    : null
  const store = readRuntimeHealthStore({ home })
  const attribution = input.owner === undefined || input.owner === null
    ? (sourceOnly
      ? (attributeSourcePath(source) ?? { owner: null, confidence: null, evidence: source })
      : attributeUrl(url, { source, profileDir, deps }))
    : { owner: sanitizeText(input.owner, 200), confidence: 'client', evidence: null }
  const existing = store.incidents.find((x) => (x.url ?? null) === (sourceOnly ? null : url)
    && (x.source ?? null) === source && (x.kind ?? 'ws-fail') === kind) ?? null
  let incident
  if (existing !== null) {
    existing.count = Math.max(Number(existing.count) || 0, count)
    existing.windowMs = windowMs
    existing.lastAt = at
    existing.trips = (Number(existing.trips) || 1) + 1
    if (detail !== null) existing.detail = detail
    if (existing.owner === null || existing.owner === undefined) {
      existing.owner = attribution.owner
      existing.confidence = attribution.confidence
      existing.evidence = attribution.evidence
    }
    incident = existing
  } else {
    incident = {
      id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      url: sourceOnly ? null : url,
      source,
      count,
      windowMs,
      trips: 1,
      firstAt: at,
      lastAt: at,
      owner: attribution.owner,
      confidence: attribution.confidence,
      evidence: attribution.evidence,
      detail,
    }
    store.incidents.push(incident)
  }
  incident.kind = kind
  store.incidents.sort((a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0))
  store.incidents = store.incidents.slice(0, MAX_INCIDENTS)
  store.updatedAt = new Date().toISOString()
  store.eventLoop = eventLoopSnapshot()
  const write = writeRuntimeHealthStore(store, { home })
  return { ok: write.ok, incident, store, writeError: write.error }
}

/** 清空事件（可按 url 精确清）。 */
function clearClientIncidents({ url = null, home = undefined } = {}) {
  const store = readRuntimeHealthStore({ home })
  const before = store.incidents.length
  store.incidents = typeof url === 'string' && url !== '' ? store.incidents.filter((x) => x.url !== url) : []
  store.updatedAt = new Date().toISOString()
  const write = writeRuntimeHealthStore(store, { home })
  return { ok: write.ok, removed: before - store.incidents.length, error: write.error }
}

/** 面板/`/state` 用的视图：配置 + 事件循环 + 最近事件（最多 8 条）。 */
function runtimeHealthView({ home = undefined, limit = 8, startMonitor = true } = {}) {
  if (startMonitor === true) {
    try { startEventLoopMonitor() } catch {}
  }
  const { config, problems } = readRuntimeGuardConfig({ home })
  const store = readRuntimeHealthStore({ home })
  const incidents = store.incidents
    .slice()
    .sort((a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 8)))
    .map((x) => ({
      id: x.id ?? null,
      kind: x.kind ?? 'ws-fail',
      url: x.url ?? null,
      owner: x.owner ?? null,
      confidence: x.confidence ?? null,
      evidence: x.evidence ?? null,
      count: Number(x.count) || 0,
      trips: Number(x.trips) || 1,
      windowMs: Number(x.windowMs) || null,
      firstAt: x.firstAt ?? null,
      lastAt: x.lastAt ?? null,
      detail: x.detail ?? null,
    }))
  const trips = store.incidents.reduce((sum, x) => sum + (Number(x.trips) || 1), 0)
  return {
    enabled: config.enabled === true,
    config,
    configProblems: problems,
    eventLoop: eventLoopSnapshot(),
    incidents,
    counts: { urls: store.incidents.length, trips, lastAt: incidents.length > 0 ? incidents[0].lastAt : null },
    updatedAt: store.updatedAt,
  }
}

export {
  ATTRIBUTION_MEMO,
  DEFAULT_CONFIG,
  MAX_INCIDENTS,
  attributeSourcePath,
  attributeUrl,
  candidateFiles,
  clearClientIncidents,
  configFile,
  emptyStore,
  eventLoopSnapshot,
  findNeedle,
  installedPackageDirs,
  normalizeConfig,
  readRuntimeGuardConfig,
  readRuntimeHealthStore,
  recordClientIncident,
  runtimeHealthView,
  sampleEventLoop,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  storeFile,
  writeRuntimeGuardConfig,
  writeRuntimeHealthStore,
}
