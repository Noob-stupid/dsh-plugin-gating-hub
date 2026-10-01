// L1 · domain —— compat.js（框架兼容判定与适配门：设置 API 扫描 / 兼容门读写 / 待适配记录 / 隔离记录合并的前置部分 / 启动失败分析；分层 Step 6 从 lib/index.js 搬出，只搬移未改逻辑。注：detectCompat 等吃运行上下文的留到 Step 8）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言）

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, sep, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { currentFrameworkVersion } from './framework.js'
import { removeDisableBlock } from './patch.js'
import { listEntries } from './runtime.js'
import { fetchJsonUrl } from '../infra/http.js'
import { dshHome, findPatchPath, pluginRoot, profileDirOf, resolvePackageJson } from '../infra/paths.js'
import { semverRangeMatch, semverRangeMatchLoose } from '../infra/semver.js'
// 0.5.34 加法：适配门结论的**判据版本戳** + 过期结论的读取代发重算（见该模块头注释）。
import { SCANNER_VERSION, compatPendingFile, isSelfInflictedSource, planVerdictRefresh, refreshCompatPendingVerdicts, verdictView } from './compat-verdict.js'
// 0.5.33 改错：已删除 API 的源码扫描搬进独立 domain 模块（判据收紧为"真的从 dsh-settings 绑定进来"）。
// 这三个名字继续由本模块导出，对外契约不变。
import { REMOVED_SETTINGS_SYMBOLS, referencesRemovedSymbol, scanSettingsApiUsage } from './settings-api-scan.js'

/** Cordis Fiber 状态映射（与 dsh-host-plugin-inventory 一致）。 */
const FIBER_STATE = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 }

const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
}

/** 包是否由框架自带（解析到 profile 目录之外，如 npx/pnpm 缓存里的 @deepseek-ai/*）。
 *  v0.3.35：这类行随框架一起发布，禁用**不是**正确处置（正确处置是回滚框架），
 *  而且一旦判定有误就会把框架功能砍掉——所以升级预扫永不自动禁用它们。 */
function isFrameworkOwnedPackage(pkgDir, profileDir) {
  if (typeof pkgDir !== 'string' || pkgDir === '' || typeof profileDir !== 'string' || profileDir === '') return false
  const real = (p) => { try { return realpathSync(p) } catch { return p } }
  const dir = real(pkgDir).toLowerCase()
  let base = real(profileDir).toLowerCase()
  if (!base.endsWith(sep)) base += sep
  return !dir.startsWith(base)
}

/**
 * 插件-框架兼容校验（框架升级适配门）：
 * 1) 显式兼容声明（dsh.engines.framework / dsh.compat.framework / engines.dsh）：以声明为准；
 * 2) 扫描依赖/peerDeps 的 @deepseek-ai/*：任一范围明确不含框架版本 → fail；
 * 3) 【硬判据】提供 pkgDir 时扫描包源码：命中已删除的 dsh-settings API
 *    （settingsNamespace / installSettingsSection）→ 直接 fail（2026-09-04 教训：
 *    0.3.6 全家仍引用旧 API，静态声明/依赖检查判 pass 是假通过，loader 单行失败 = 服务崩溃）；
 * 4) 无声明且依赖全部满足 → unknown（新版变动不大；由调用方在「版本已变化」前提下放行）。
 * 返回 { decision: 'pass'|'fail'|'unknown', reason }。
 */
function checkPluginFrameworkCompat(pkg, frameworkVersion, pkgDir = null) {
  const declared = pkg?.dsh?.engines?.framework ?? pkg?.dsh?.compat?.framework ?? pkg?.engines?.dsh ?? null
  if (typeof declared === 'string' && declared !== '') {
    const ok = semverRangeMatchLoose(frameworkVersion, declared)
    if (!ok) return { decision: 'fail', reason: `声明兼容范围 ${declared} 不满足当前框架 ${frameworkVersion}` }
  }
  // 硬判据：实际源码扫描（比声明/依赖更接近真实兼容性）
  if (pkgDir !== null && typeof pkgDir === 'string' && semverRangeMatchLoose(frameworkVersion, '>=0.1.2')) {
    const broken = scanSettingsApiUsage(pkgDir)
    if (broken.length > 0) {
      return { decision: 'fail', reason: `源码仍引用 0.1.2 起已删除的 dsh-settings API（${broken.join('、')}）——实际不兼容，启用会让整个服务启动崩溃` }
    }
    if (typeof declared === 'string' && declared !== '') return { decision: 'pass', reason: `声明兼容范围 ${declared} 满足框架 ${frameworkVersion}，且源码无已删除 API 引用` }
    // 源码扫描干净 = 权威判据：依赖范围可能滞后旧版（"假拒绝"），不作为 fail。
    return { decision: 'unknown', reason: '源码扫描无已删除 API 引用（声明/依赖范围为参考，不作为不兼容判据）' }
  } else if (typeof declared === 'string' && declared !== '') {
    return { decision: 'pass', reason: `声明兼容范围 ${declared} 满足框架 ${frameworkVersion}` }
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.peerDependencies ?? {}), ...(pkg?.optionalDependencies ?? {}) }
  const hits = Object.entries(deps).filter(([name]) => /^@deepseek-ai\//u.test(name))
  const failing = hits.filter(([, range]) => typeof range === 'string' && range !== '' && !semverRangeMatch(frameworkVersion, range))
  if (failing.length > 0) {
    return { decision: 'fail', reason: `依赖声明不满足：${failing.map(([n, r]) => `${n}@${r}`).join('、')}（当前框架 ${frameworkVersion}）` }
  }
  if (hits.length === 0) return { decision: 'unknown', reason: '未声明对 @deepseek-ai/* 的依赖，无法从声明判定（版本已更新时放行）' }
  return { decision: 'unknown', reason: '依赖范围包含当前框架版本但未显式声明兼容（版本已更新时放行）' }
}

// 支持 0.1.x 系列（0.1.0 / 0.1.1 等）；0.2 / 1.0 等破坏性大版本才标记不支持
const SUPPORTED_WEB_APP_PATTERN = /^0\.1\.\d+/u

/**
 * 启用前冒烟检查（服务永不崩机制）：在独立子进程中动态 import 插件主模块，
 * 捕获 loader 会遇到的 import/resolution 错误（SyntaxError、缺失导出、模块缺失）。
 * 子进程失败不影响控制台；探测失败/超时按"不通过"处理（宁可拒绝，不冒险拖崩服务）。
 */
function probePluginImport(moduleName, profileDir) {
  return new Promise((resolve) => {
    const script = [
      'import { createRequire } from "node:module";',
      'import path from "node:path";',
      'try {',
      '  const req = createRequire(path.join(process.argv[1], "package.json"));',
      '  const mainPath = req.resolve(process.argv[2]);',
      '  const { pathToFileURL } = await import("node:url");',
      '  await import(pathToFileURL(mainPath).href);',
      '  console.log("PROBE_OK");',
      '} catch (e) { console.log("PROBE_ERR:" + String(e && e.message ? e.message : e).slice(0, 400)); process.exitCode = 1; }',
    ].join('\n')
    let child = null
    try {
      child = spawn(process.execPath, ['--input-type=module', '-e', script, profileDir, moduleName], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ ok: true, detail: 'probe 无法启动（放行）' })
      return
    }
    let out = ''
    let timer = null
    const finish = (ok, detail) => {
      if (timer !== null) clearTimeout(timer)
      resolve({ ok, detail })
    }
    timer = setTimeout(() => { try { child.kill() } catch {}; finish(false, '探测超时') }, 8000)
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('error', () => finish(true, 'probe 进程错误（放行）'))
    child.on('close', (code) => {
      if (out.includes('PROBE_OK')) finish(true, 'import OK')
      else finish(false, (out.match(/PROBE_ERR:([^\n]*)/u)?.[1] ?? out.slice(0, 300)).trim())
    })
  })
}

/** 适配门清单文件（0.5.34 起由 compat-verdict.js 定义，供"读取代发"一处收口）。 */
const COMPAT_PENDING_FILE = compatPendingFile

/**
 * 读取框架升级适配门清单（compat-pending.json）；损坏/缺失返回 `{ pending: null, ... }`。
 *
 * 0.5.34 加法（**读取代发**）：给 `baseDir`（当前 profile 目录）时，对**判据戳落后**的记录
 * 用当前判据只读重算：结论变了才回写（幂等：结论不变**零写盘**），解析不到包就如实标注"无法复核"。
 * 真不兼容的（重算仍 fail）一个字都不动 —— 这条只解决"过期结论仍当事实展示"，不放宽任何判据。
 * 返回 `{ pending, refresh, verdicts }`：`verdicts` = rowId → 结论视图（面板/门控摘要用）。
 */
function readCompatPendingWithVerdicts({ baseDir = null, deps = {} } = {}) {
  let raw = null
  try { raw = JSON.parse(readFileSync(COMPAT_PENDING_FILE(), 'utf8')) } catch { return { pending: null, refresh: null, verdicts: new Map() } }
  if (raw === null || typeof raw !== 'object') return { pending: null, refresh: null, verdicts: new Map() }
  let refresh = null
  if (baseDir !== null && baseDir !== undefined && Array.isArray(raw.pending) && raw.pending.length > 0) {
    try {
      refresh = refreshCompatPendingVerdicts({
        pending: raw,
        baseDir,
        deps: {
          resolvePkg: (name, base) => resolvePackageJson(name, base),
          readPkg: (p) => JSON.parse(readFileSync(p, 'utf8')),
          check: checkPluginFrameworkCompat,
          ...deps,
        },
      })
    } catch (error) {
      // 复核本身出问题也必须如实回报（不静默）：结论按记录原样展示，附上失败原因
      refresh = { version: SCANNER_VERSION, entries: [], updated: [], unchanged: [], unresolved: [], fresh: [], wrote: false, writeError: '读取代发重算失败：' + String(error?.message ?? error), file: COMPAT_PENDING_FILE() }
    }
  }
  const entries = Array.isArray(refresh?.entries) ? refresh.entries : planVerdictRefresh(raw.pending)
  const verdicts = new Map()
  for (const rec of raw.pending) {
    if (rec === null || typeof rec !== 'object' || typeof rec.rowId !== 'string') continue
    verdicts.set(rec.rowId, verdictView(rec, entries.find((e) => e.rowId === rec.rowId) ?? null))
  }
  return { pending: raw, refresh, verdicts }
}

/** 读取清单（原契约不变：只读、不做复核）。需要"读取代发"的路径用 readCompatPendingWithVerdicts。 */
function readCompatPending() {
  try { return JSON.parse(readFileSync(COMPAT_PENDING_FILE(), 'utf8')) } catch { return null }
}

function writeCompatPending(payload) {
  try {
    mkdirSync(dirname(COMPAT_PENDING_FILE()), { recursive: true })
    writeFileSync(COMPAT_PENDING_FILE(), JSON.stringify(payload, null, 2), 'utf8')
  } catch {}
}

/** 兼容门总开关（用户定案 2026-09-11）：用户可关掉自动行为，回到纯手动。
 *  autoDisable —— 升级前是否自动禁用判定不适配的行（关掉 = 只提示不动开关）
 *  autoDetect  —— 打开控制台时是否自动检测「已适配」（关掉 = 不显示可解锁提示）
 *  autoDisableOnEvidence —— 0.5.32 加法 D5：**指纹变化自动预检 / 启动失败记录**给出**确证证据**时
 *    是否自动写 `disabled: true`（默认启用 = 按用户意图；关掉 = 只报告 + 等用户点「只禁可疑行」）。
 *    它与 autoDisable 是两个独立开关：后者管"我们升级时"，前者管"别人升级 / 启动失败时"。 */
const COMPAT_GATE_FILE = () => join(dshHome(), 'plugin-console', 'compat-gate.json')

const COMPAT_GATE_DEFAULTS = { autoDisable: true, autoDetect: true, autoDisableOnEvidence: true, noticeMode: 'once-per-version' }

function readCompatGate() {
  try {
    const raw = JSON.parse(readFileSync(COMPAT_GATE_FILE(), 'utf8'))
    return {
      autoDisable: raw?.autoDisable !== false,
      autoDetect: raw?.autoDetect !== false,
      autoDisableOnEvidence: raw?.autoDisableOnEvidence !== false,
      // 兼容提示的展示模式（2026-09-28 加法）：非法/缺失一律回落默认，**不影响 supported 判定**
      noticeMode: NOTICE_MODES.includes(raw?.noticeMode) ? raw.noticeMode : DEFAULT_NOTICE_MODE,
    }
  } catch { return { ...COMPAT_GATE_DEFAULTS } }
}

function writeCompatGate(patch) {
  const next = { ...readCompatGate(), ...patch }
  try {
    mkdirSync(dirname(COMPAT_GATE_FILE()), { recursive: true })
    writeFileSync(COMPAT_GATE_FILE(), JSON.stringify(next, null, 2), 'utf8')
  } catch {}
  return next
}

/** 兼容提示的展示模式（2026-09-28 加法）：
 *  · `always`           每次都提示
 *  · `once-per-version` 同一框架版本只提示一次（默认；用户点「我知道了」后不再出现，**版本一变重新提示**）
 *  · `off`              不提示（需显式设置）
 * ⚠ 它只影响**展示** —— `supported` 的判定与门控语义一个字都不变（披露不能被"关掉"成看不见的风险）。 */
const NOTICE_MODES = ['always', 'once-per-version', 'off']
const DEFAULT_NOTICE_MODE = 'once-per-version'

const COMPAT_ACK_FILE = () => join(dshHome(), 'plugin-console', 'compat-ack.json')

/** 读「已确认看过」的框架版本（按版本记：换版本自动重新提示）。 */
function readCompatAck() {
  try {
    const raw = JSON.parse(readFileSync(COMPAT_ACK_FILE(), 'utf8'))
    return {
      version: typeof raw?.version === 'string' && raw.version !== '' ? raw.version : null,
      at: Number.isFinite(raw?.at) ? raw.at : null,
    }
  } catch { return { version: null, at: null } }
}

/** 写 ack（整文件覆盖：只记最后一个确认过的版本，语义就是"这个版本我看过了"）。 */
function writeCompatAck(version) {
  const next = { version: String(version), at: Date.now() }
  try {
    mkdirSync(dirname(COMPAT_ACK_FILE()), { recursive: true })
    writeFileSync(COMPAT_ACK_FILE(), JSON.stringify(next, null, 2), 'utf8')
  } catch {}
  return next
}

/** 提示该不该显示（纯函数，离线可断言）。**绝不修改 supported**。 */
function resolveNoticeState({ supported, notice, webAppVersion, noticeMode, ackVersion } = {}) {
  if (notice === null || notice === undefined || notice === '') return { visible: false, reason: 'no-notice' }
  if (supported === true) return { visible: false, reason: 'supported' }
  const mode = NOTICE_MODES.includes(noticeMode) ? noticeMode : DEFAULT_NOTICE_MODE
  if (mode === 'off') return { visible: false, reason: 'mode-off' }
  if (mode === 'always') return { visible: true, reason: 'mode-always' }
  const acked = typeof ackVersion === 'string' && ackVersion !== ''
    && typeof webAppVersion === 'string' && webAppVersion !== ''
    && ackVersion === webAppVersion
  return acked ? { visible: false, reason: 'version-acked' } : { visible: true, reason: 'first-sight' }
}
/** 把框架适配检测结果格式化为给子代理的提示段。 */
function frameworkCheckPromptText(fc) {
  if (fc === null || fc === undefined) return '（不可用）'
  return [
    `- 当前框架版本：${fc.frameworkVersion ?? '未知'}`,
    `- ${fc.kind === 'npm' ? `npm 包 ${fc.packageName ?? '?'}` : '来源类型'}：registry 最新 ${fc.latest ?? '未知'}${fc.installedVersion ? `；本机已装 ${fc.installedVersion}` : ''}`,
    fc.pending && fc.pending.length > 0 ? `- ⚠ 已命中兼容门：${fc.pending.map((p) => p.rowId).join('、')} 处于强制禁用（版本 ${fc.pending[0]?.version ?? '?'}），升级后仅更新并通过校验才解锁` : null,
    fc.check ? `- 声明/依赖校验：${fc.check.decision === 'fail' ? '不兼容' : fc.check.decision === 'pass' ? '兼容' : '未知'}（${fc.check.reason}）` : null,
    '- 计划总结必须向用户说明上述适配结论；若校验为 fail，不要建议启用，应建议「更新到最新版后再启用」。',
  ].filter((s) => s !== null).join('\n')
}

/**
 * 兼容性探测：读取 profile 中 web-app / cli 的版本。
 * 官方破坏性升级（0.2、1.0 等）可能改动本插件依赖的补丁/加载器/插槽接口，
 * 因此面板披露版本并给出提示，而不是默默失效。
 */
const CONSOLE_VERSION = '0.1.0'

async function detectCompat(baseUrl) {
  const result = { consoleVersion: CONSOLE_VERSION, webAppVersion: null, dshVersion: null, supported: true, notice: null }
  try {
    const require = createRequire(baseUrl)
    try {
      const webAppPkg = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-web-app/package.json'), 'utf8'))
      result.webAppVersion = webAppPkg.version ?? null
    } catch {}
    try {
      const dshPkg = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
      result.dshVersion = dshPkg.version ?? null
    } catch {}
  } catch {}
  // 兜底：ports.baseUrl 不可用导致 require.resolve 失败时，从插件自身目录解析——
  // 曾导致 dshVersion 为空 → 客户端 current="" → 误判「升级到 latest(rc.7)」（方向相反）
  if (result.dshVersion === null) {
    try {
      const requireLocal = createRequire(join(pluginRoot(), 'package.json'))
      const dshPkg = JSON.parse(readFileSync(requireLocal.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
      result.dshVersion = dshPkg.version ?? null
    } catch {}
  }
  if (result.webAppVersion !== null && !SUPPORTED_WEB_APP_PATTERN.test(result.webAppVersion)) {
    result.supported = false
    result.notice = `当前 DSH web 包版本 ${result.webAppVersion} 不在受支持的 0.1.x 系列内，插件控制台的部分功能可能因官方破坏性更新而失效；请到 https://github.com/Noob-stupid/dsh-plugin-gating-hub 获取匹配的更新`
  }
  // 展示层（2026-09-28 加法）：`supported` 与 `notice` 保持原样，这里只额外给出"该不该显示 + 为什么"。
  try {
    const gate = readCompatGate()
    const ack = readCompatAck()
    const resolved = resolveNoticeState({
      supported: result.supported,
      notice: result.notice,
      webAppVersion: result.webAppVersion,
      noticeMode: gate.noticeMode,
      ackVersion: ack.version,
    })
    result.noticeMode = gate.noticeMode
    result.noticeVisible = resolved.visible
    result.noticeReason = resolved.reason
    result.noticeAckedAt = ack.version !== null && ack.version === result.webAppVersion ? ack.at : null
  } catch {
    result.noticeMode = DEFAULT_NOTICE_MODE
    result.noticeVisible = result.supported === false
    result.noticeReason = 'fallback'
    result.noticeAckedAt = null
  }
  return result
}

/** 待适配行的「现在是否已适配」检测（只提示，不自动解锁——用户定案：我点才开）。
 * 返回 Map<rowId, {version, check, note, basis}>：可解锁有两种**互不放松**的来路 ——
 *   ① `version-changed`：插件真的更新过（版本 ≠ 记录版本）且源码扫描不再 fail（原判据，不变）；
 *   ② `verdict-rescinded`（0.5.34 加法）：记录里的 `fail` 是**旧判据的误报**，当前判据重算后不再 fail。
 *      真不兼容（重算仍 fail）**一个都不放行**；②也不需要"版本变化"——否则用户会被永久钉在「待适配」。 */
function detectAdoptablePending(ports) {
  const out = new Map()
  let profileDir = null
  try { profileDir = dirname(findPatchPath(ports)) } catch { return out }
  const { pending, verdicts } = readCompatPendingWithVerdicts({ baseDir: profileDir })
  if (pending === null) return out
  const fwVer = typeof pending.frameworkVersion === 'string' ? pending.frameworkVersion : null
  if (fwVer === null) return out
  for (const p of (pending.pending ?? []).filter((x) => (x.status ?? 'pending') === 'pending')) {
    try {
      const pkgPath = resolvePackageJson(p.moduleName, profileDir)
      if (pkgPath === null) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const version = typeof pkg.version === 'string' ? pkg.version : null
      const changed = version !== null && version !== p.version
      const check = checkPluginFrameworkCompat(pkg, fwVer, dirname(pkgPath))
      if (check.decision === 'fail') continue
      const view = verdicts.get(p.rowId) ?? null
      const rescinded = view?.rescinded === true
      if (!changed && !rescinded) continue
      out.set(p.rowId, {
        version,
        check: check.decision,
        note: check.reason ?? null,
        basis: changed ? 'version-changed' : 'verdict-rescinded',
        previousVerdict: view?.storedDecision ?? null,
        evidence: view?.evidence ?? null,
      })
    } catch {}
  }
  return out
}

/**
 * 门控面板要的「明细清单」（2026-09-24 用户要求：门控面板应该能显示是哪些插件，有列表数据）。
 *
 * 此前面板只有两个总开关 + 一句「当前待适配：N 行」——看得到数量，看不到**是谁**：
 * compat-pending.json 里有 rowId / moduleName / version / checkNote / 来源 / 时间，
 * 但只下发了 pending 那半边，也没有把 rowId 补成可读模块名。
 *
 * pending —— 当前被拦下/待解锁的行（含原因、来源、是否已通过源码扫描可解锁）
 * adopted —— 曾经被拦、现已适配解锁的行（让用户能核对"到底动过哪些行"）
 *
 * 0.5.34 加法：每行多带 `verdict`（当前判据下的结论视图：`stale` / `rescinded` / `unresolved`）——
 * 旧判据的结论不许再被当成事实展示；**复核不了**（包解析不到）的行在 `note` 上如实标注。
 */
function gatingSummary(ports, compatPending, ctxEntries = null, verdicts = null) {
  const rec = compatPending ?? { frameworkVersion: null, upgradeFrom: null, pending: [] }
  const all = Array.isArray(rec.pending) ? rec.pending : []
  let info = new Map()
  try {
    info = rowIdModuleMap(ports)
  } catch {}
  const byRow = new Map()
  for (const e of Array.isArray(ctxEntries) ? ctxEntries : []) {
    if (typeof e?.rowId === 'string' && e.rowId !== '') byRow.set(e.rowId, e)
  }
  const byVerdict = verdicts instanceof Map ? verdicts : new Map()
  const row = (p) => {
    const meta = info.get(p.rowId) ?? null
    const entry = byRow.get(p.rowId) ?? null
    const moduleName = p.moduleName ?? meta?.moduleName ?? entry?.moduleName ?? null
    const name = moduleName ?? p.rowId ?? '（未知行）'
    const verdict = byVerdict.get(p.rowId) ?? verdictView(p)
    const note = p.checkNote ?? null
    return {
      rowId: p.rowId ?? null,
      name,
      shortName: typeof name === 'string' && name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name,
      moduleName,
      version: p.version ?? meta?.version ?? entry?.version ?? null,
      status: p.status ?? 'pending',
      check: p.check ?? null,
      // 复核不了的行：**如实标注**"旧判据结论、未复核"（不许继续当事实；也不猜新结论）
      note: verdict.unresolved === null || verdict.unresolved === undefined
        ? note
        : `${note ?? ''}（旧判据结论，未能复核：${verdict.unresolved}）`,
      source: p.source ?? null,
      adoptedAt: p.adoptedAt ?? null,
      forcedAt: p.forcedAt ?? null,
      adoptedBy: p.adoptedBy ?? null,
      enabled: entry === null ? null : entry.enabled === true,
      verdict,
    }
  }
  const isPending = (p) => (p.status ?? 'pending') === 'pending'
  const pendingRows = all.filter(isPending).map(row)
  const adoptedRows = all.filter((p) => !isPending(p)).map(row)
  let adoptable = new Map()
  try {
    adoptable = detectAdoptablePending(ports)
  } catch {}
  for (const r of pendingRows) r.adoptable = adoptable.get(r.rowId) ?? null
  return {
    version: rec.frameworkVersion ?? null,
    upgradeFrom: rec.upgradeFrom ?? null,
    quarantineAt: rec.quarantineAt ?? null,
    quarantineLines: Array.isArray(rec.quarantineLines) ? rec.quarantineLines.slice(0, 5) : [],
    pendingCount: pendingRows.length,
    adoptedCount: adoptedRows.length,
    pending: pendingRows,
    adopted: adoptedRows,
  }
}

/** 当前 loader 树里的 rowId → { moduleName, version, enabled }（补 moduleName、对账用）。 */
function rowIdModuleMap(ports) {
  const out = new Map()
  let entries = []
  try { entries = listEntries(ports) } catch { return out }
  const profileDir = profileDirOf(ports)
  for (const entry of entries) {
    if (typeof entry.rowId !== 'string' || entry.rowId === '') continue
    let version = null
    try {
      const pkgPath = profileDir === null ? null : resolvePackageJson(entry.moduleName, profileDir)
      if (pkgPath !== null) version = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? null
    } catch {}
    out.set(entry.rowId, { moduleName: entry.moduleName ?? null, version, enabled: entry.enabled === true })
  }
  return out
}

/**
 * 框架升级适配门：安装/更新完成后自动校验兼容性，
 * 通过（版本已变化 + 未在声明/依赖层面明确不兼容）则移除补丁禁用块并解锁启用。
 * 0.5.34：走**读取代发**（`profileDir` 已知）—— 顺手把过期判据的结论复核/回写，避免旧误报继续挂在这里。
 */
async function maybeAutoAdaptCompat({ profileDir, packageName, syncedNames, patchPath, ports }) {
  const { pending } = readCompatPendingWithVerdicts({ baseDir: profileDir })
  if (!pending || !Array.isArray(pending.pending)) return { ran: false }
  const interested = new Set([packageName, ...(syncedNames ?? [])].filter((n) => n !== null))
  const targets = pending.pending.filter((p) => (p.status ?? 'pending') === 'pending' && interested.has(p.moduleName))
  if (targets.length === 0) return { ran: false }
  const fwVer = typeof pending.frameworkVersion === 'string' ? pending.frameworkVersion : '?'
  const adopted = []
  const kept = []
  for (const p of targets) {
    let pkg = null
    let pkgDir = null
    try {
      const pkgPath = resolvePackageJson(p.moduleName, profileDir)
      if (pkgPath !== null) {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        pkgDir = dirname(pkgPath)
      }
    } catch {}
    const version = typeof pkg?.version === 'string' ? pkg.version : null
    const changed = version !== null && version !== p.version
    const check = pkg !== null ? checkPluginFrameworkCompat(pkg, fwVer, pkgDir) : { decision: 'unknown', reason: '无法读取包信息' }
    if (changed && check.decision !== 'fail') {
      try { await removeDisableBlock(patchPath, p.rowId) } catch {}
      p.status = 'adopted'
      p.adoptedAt = Date.now()
      p.adoptedVersion = version
      p.adoptedFramework = fwVer
      p.check = check.decision
      p.checkNote = check.reason ?? null
      adopted.push({ rowId: p.rowId, moduleName: p.moduleName, version, check: check.decision })
    } else {
      kept.push({ rowId: p.rowId, moduleName: p.moduleName, reason: !changed ? '版本未变化（无更新可适配）' : (check.reason ?? '兼容校验未通过') })
    }
  }
  if (adopted.length > 0 || kept.length > 0) writeCompatPending(pending)
  const note = adopted.length > 0
    ? `兼容适配：已解锁 ${adopted.length} 行（${adopted.map((a) => a.rowId).join('、')}）`
      + (kept.length > 0 ? `；仍待适配 ${kept.length} 行（${kept.map((k) => `${k.rowId} ${k.reason}`).join('、')}）` : '')
    : `兼容适配：暂未解锁（${kept.map((k) => `${k.rowId} ${k.reason}`).join('、')}）`
  return { ran: true, adopted, kept, note }
}

/** AI 赋能框架适配预检：查 registry 最新版声明 + 兼容门清单，给出权威说明。 */
async function frameworkCompatReportFor(source, ports, profileDir) {
  const fwVer = currentFrameworkVersion(ports)
  const { pending, verdicts } = readCompatPendingWithVerdicts({ baseDir: profileDir })
  const norm = String(source ?? '').trim()
  const isNpm = norm.startsWith('@') || !norm.includes('/')
  const installed = (() => {
    try {
      const pkgPath = resolvePackageJson(norm, profileDir)
      if (pkgPath === null) return null
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? null
    } catch { return null }
  })()
  // 命中行带上当前判据的结论视图（`fail` 仍然是 fail；过期/复核不了会如实标注）
  const pendHits = (pending?.pending ?? [])
    .filter((p) => (p.status ?? 'pending') === 'pending' && p.moduleName === norm)
    .map((p) => ({ ...p, verdict: verdicts.get(p.rowId) ?? verdictView(p) }))
  if (!isNpm) {
    return {
      kind: 'repo', frameworkVersion: fwVer, packageName: null, latest: null, check: null,
      pending: pendHits, installedVersion: null,
      summary: pendHits.length > 0
        ? `该来源命中兼容门清单（${pending.frameworkVersion}），GitHub 仓库无法在线预检——更新/部署完成后会由控制台自动校验解锁`
        : `GitHub 仓库来源无法预检 npm 声明，部署后以实际运行为准（框架当前 ${fwVer ?? '未知'}）`,
    }
  }
  const name = norm.startsWith('@')
    ? '@' + norm.slice(1).split('@')[0]
    : norm.split('@')[0]
  let latest = null
  let versionMeta = null
  try {
    const data = await fetchJsonUrl(`https://registry.npmmirror.com/${name.replace('/', '%2f')}`)
    latest = data?.['dist-tags']?.latest ?? data?.['dist-tags']?.next ?? null
    if (latest !== null) versionMeta = data?.versions?.[latest] ?? null
  } catch (error) {
    return {
      kind: 'npm', frameworkVersion: fwVer, packageName: name, latest: null, check: null,
      pending: pendHits, installedVersion: installed,
      summary: `registry 预检失败（${error instanceof Error ? error.message : String(error)}）；本机已装 ${installed ?? '?'}${pendHits.length > 0 ? '，处于兼容门禁用中' : ''}`,
    }
  }
  const check = versionMeta !== null ? checkPluginFrameworkCompat(versionMeta, fwVer) : null
  const parts = []
  if (pendHits.length > 0) parts.push(`已在兼容门清单（${pending.upgradeFrom ?? '?'} → ${pending.frameworkVersion}）中强制禁用，当前已装 ${installed ?? pendHits[0]?.version ?? '?'}`)
  if (latest !== null) {
    if (check?.decision === 'fail') parts.push(`最新版 ${latest} 不满足框架 ${fwVer}（${check.reason}）——请勿启用，等待适配版本`)
    else if (check?.decision === 'pass') parts.push(`最新版 ${latest} 声明兼容框架 ${fwVer}，可放心启用`)
    else parts.push(`最新版 ${latest} 未声明框架兼容（${check?.reason ?? '无声明'}），建议更新后启用并观察`)
  }
  return {
    kind: 'npm', frameworkVersion: fwVer, packageName: name, latest, check, pending: pendHits, installedVersion: installed,
    summary: parts.length > 0 ? parts.join('；') : `框架 ${fwVer}，无待适配记录`,
  }
}
export { gatingSummary, COMPAT_PENDING_FILE, COMPAT_GATE_FILE, COMPAT_ACK_FILE, COMPAT_GATE_DEFAULTS, NOTICE_MODES, DEFAULT_NOTICE_MODE, REMOVED_SETTINGS_SYMBOLS, FIBER_STATE, FIBER_PHASE, SUPPORTED_WEB_APP_PATTERN, referencesRemovedSymbol, scanSettingsApiUsage, isFrameworkOwnedPackage, checkPluginFrameworkCompat, probePluginImport, readCompatPending, readCompatPendingWithVerdicts, writeCompatPending, verdictView, SCANNER_VERSION, readCompatGate, writeCompatGate, readCompatAck, writeCompatAck, resolveNoticeState, frameworkCheckPromptText, CONSOLE_VERSION, detectCompat, detectAdoptablePending, rowIdModuleMap, frameworkCompatReportFor, maybeAutoAdaptCompat }
