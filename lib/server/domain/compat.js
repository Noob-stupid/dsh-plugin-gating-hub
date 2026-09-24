// L1 · domain —— compat.js（框架兼容判定与适配门：设置 API 扫描 / 兼容门读写 / 待适配记录 / 隔离记录合并的前置部分 / 启动失败分析；分层 Step 6 从 lib/index.js 搬出，只搬移未改逻辑。注：detectCompat 等吃运行上下文的留到 Step 8）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, readdirSync, mkdirSync, realpathSync } from 'node:fs'
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

/**
 * 扫描已安装包源码，检测对已删除的 dsh-settings API 的引用
 * （2026-09-04 教训：0.1.2-rc.1 起 settingsNamespace / installSettingsSection 已删除，
 * 静态声明检查判 pass 是假通过；真实兼容性只有模块 import 时见分晓，而 loader 单行失败
 * = 整个服务启动崩溃）。返回命中的符号列表，空数组 = 干净。
 */
const REMOVED_SETTINGS_SYMBOLS = ['settingsNamespace', 'installSettingsSection']

/** 源码是否**引用**了已删除符号——而不是「恰好包含同名前缀的其它标识符」或「自己定义的同名局部函数」。
 *  v0.3.35 修复（真机演练抓到的误伤）：原先用 `text.includes('settingsNamespace')` 子串匹配，
 *  而框架自带的 @deepseek-ai/dsh-api-settings-controller 里有个 `settingsNamespaceRequestSchema`，
 *  于是框架自己的 settings 控制器被判「引用已删除 API」→ 升级预扫会把它自动禁用（砍掉框架功能）。
 *  现在要求标识符边界，且排除「本地 const/let/var/function/class 定义且同行没有 dsh-settings 引用」。 */
function referencesRemovedSymbol(text, sym) {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${sym}(?![A-Za-z0-9_$])`, 'u')
  for (const line of text.split(/\r?\n/u)) {
    const m = re.exec(line)
    if (m === null) continue
    const before = line.slice(0, m.index)
    const localDefinition = /(?:^|[^\w$])(?:const|let|var|function|class|async\s+function)\s*$/u.test(before)
    if (localDefinition && !/dsh-settings/u.test(line)) continue
    return true
  }
  return false
}

function scanSettingsApiUsage(pkgDir) {
  const found = []
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/u.test(entry.name)) continue
      if (seen.has(full)) continue
      seen.add(full)
      if (seen.size > 120) return
      try {
        const text = readFileSync(full, 'utf8').slice(0, 400000)
        for (const sym of REMOVED_SETTINGS_SYMBOLS) {
          if (found.includes(sym)) continue
          if (referencesRemovedSymbol(text, sym)) found.push(sym)
        }
      } catch {}
    }
  }
  walk(pkgDir, 0)
  return found
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

const COMPAT_PENDING_FILE = () => join(dshHome(), 'plugin-console', 'compat-pending.json')

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

/** 读取框架升级适配门清单（compat-pending.json）；损坏/缺失返回 null。 */
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
 *  autoDetect  —— 打开控制台时是否自动检测「已适配」（关掉 = 不显示可解锁提示） */
const COMPAT_GATE_FILE = () => join(dshHome(), 'plugin-console', 'compat-gate.json')

const COMPAT_GATE_DEFAULTS = { autoDisable: true, autoDetect: true }

function readCompatGate() {
  try {
    const raw = JSON.parse(readFileSync(COMPAT_GATE_FILE(), 'utf8'))
    return {
      autoDisable: raw?.autoDisable !== false,
      autoDetect: raw?.autoDetect !== false,
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
  return result
}

/** 待适配行的「现在是否已适配」检测（只提示，不自动解锁——用户定案：我点才开）。
 * 返回 Map<rowId, {version, check, note}>：仅当版本已变化且源码扫描不再 fail 时才算可解锁。 */
function detectAdoptablePending(ports) {
  const out = new Map()
  const pending = readCompatPending()
  if (pending === null) return out
  const fwVer = typeof pending.frameworkVersion === 'string' ? pending.frameworkVersion : null
  if (fwVer === null) return out
  let profileDir = null
  try { profileDir = dirname(findPatchPath(ports)) } catch { return out }
  for (const p of (pending.pending ?? []).filter((x) => (x.status ?? 'pending') === 'pending')) {
    try {
      const pkgPath = resolvePackageJson(p.moduleName, profileDir)
      if (pkgPath === null) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const version = typeof pkg.version === 'string' ? pkg.version : null
      const changed = version !== null && version !== p.version
      const check = checkPluginFrameworkCompat(pkg, fwVer, dirname(pkgPath))
      if (changed && check.decision !== 'fail') {
        out.set(p.rowId, { version, check: check.decision, note: check.reason ?? null })
      }
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
 */
function gatingSummary(ports, compatPending, ctxEntries = null) {
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
  const row = (p) => {
    const meta = info.get(p.rowId) ?? null
    const entry = byRow.get(p.rowId) ?? null
    const moduleName = p.moduleName ?? meta?.moduleName ?? entry?.moduleName ?? null
    const name = moduleName ?? p.rowId ?? '（未知行）'
    return {
      rowId: p.rowId ?? null,
      name,
      shortName: typeof name === 'string' && name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name,
      moduleName,
      version: p.version ?? meta?.version ?? entry?.version ?? null,
      status: p.status ?? 'pending',
      check: p.check ?? null,
      note: p.checkNote ?? null,
      source: p.source ?? null,
      adoptedAt: p.adoptedAt ?? null,
      forcedAt: p.forcedAt ?? null,
      adoptedBy: p.adoptedBy ?? null,
      enabled: entry === null ? null : entry.enabled === true,
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
 */
async function maybeAutoAdaptCompat({ profileDir, packageName, syncedNames, patchPath, ports }) {
  const pending = readCompatPending()
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
  const pending = readCompatPending()
  const norm = String(source ?? '').trim()
  const isNpm = norm.startsWith('@') || !norm.includes('/')
  const installed = (() => {
    try {
      const pkgPath = resolvePackageJson(norm, profileDir)
      if (pkgPath === null) return null
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? null
    } catch { return null }
  })()
  const pendHits = (pending?.pending ?? []).filter((p) => (p.status ?? 'pending') === 'pending' && p.moduleName === norm)
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
export { gatingSummary, COMPAT_PENDING_FILE, COMPAT_GATE_FILE, COMPAT_GATE_DEFAULTS, REMOVED_SETTINGS_SYMBOLS, FIBER_STATE, FIBER_PHASE, SUPPORTED_WEB_APP_PATTERN, referencesRemovedSymbol, scanSettingsApiUsage, isFrameworkOwnedPackage, checkPluginFrameworkCompat, probePluginImport, readCompatPending, writeCompatPending, readCompatGate, writeCompatGate, frameworkCheckPromptText, CONSOLE_VERSION, detectCompat, detectAdoptablePending, rowIdModuleMap, frameworkCompatReportFor, maybeAutoAdaptCompat }
