/**
 * @deepseek-ai/dsh-plugin-console — 插件控制台宿主端。
 *
 * 提供环回 HTTP 路由（前缀 /plugin-console）：
 *   GET  /plugin-console/state    当前插件清单 + 用户补丁层状态
 *   POST /plugin-console/toggle   一键启用/停用插件（写 cordis.patch.yml，HMR 生效）
 *   POST /plugin-console/search   GitHub 仓库搜索（dsh-plugin 相关）
 *   POST /plugin-console/repo     读取仓库的 package.json，判断是否可安装
 *   POST /plugin-console/install  安装 npm 包（或 git 仓库）并追加启用条目
 *
 * 插件开关的机制：用户补丁层 cordis.patch.yml 是逐键覆盖（id-targeted patch），
 * 追加 `- id: X` + `disabled: true` 即可停用任意行（含 bundle 行与用户 insert 行），
 * 移除该块即恢复；HMR 监视器会自动重组合，无需重启。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync, existsSync, statSync, rmSync, readdirSync, mkdirSync, copyFileSync, realpathSync, chmodSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, basename, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { request as httpsRequest } from 'node:https'

const execFileAsync = promisify(execFile)

/** Cordis 插件元信息。 */
export const name = '@noob-stupid/dsh-plugin-console'
export const inject = ['webServer', 'loader']

const ROUTE_PREFIX = '/plugin-console'
const GITHUB_API = 'https://api.github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const GITHUB_UA = 'dsh-plugin-console/0.1 (local dsh web instance)'
/** Gitee OAuth 端点（第三方应用需在 gitee.com → 数据管理 → 第三方应用 创建）。 */
const GITEE_AUTH_URL = 'https://gitee.com/oauth/authorize'
const GITEE_TOKEN_URL = 'https://gitee.com/oauth/token'
/** Gitee OAuth state 一次性凭证（防止登录 CSRF / token 替换）。 */
const GITEE_OAUTH_STATES = new Map()
function createGiteeOAuthState() {
  const state = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const now = Date.now()
  // 只保留最近 10 分钟内的 state
  for (const [key, at] of GITEE_OAUTH_STATES) {
    if (now - at > 10 * 60 * 1000) GITEE_OAUTH_STATES.delete(key)
  }
  GITEE_OAUTH_STATES.set(state, now)
  return state
}
function consumeGiteeOAuthState(state) {
  if (typeof state !== 'string' || state === '') return false
  const at = GITEE_OAUTH_STATES.get(state)
  if (at === undefined) return false
  GITEE_OAUTH_STATES.delete(state)
  return Date.now() - at <= 10 * 60 * 1000
}

const DEFAULT_SEARCH = 'dsh-plugin'
/** 技能市场收录的 topic（/search skills 分支三 topic 并行合并）。 */
const SKILL_TOPICS = ['agent-skills', 'claude-skills', 'dsh-skill']

/**
 * 宿主基础设施行：停用会连带破坏 HMR/传输/存储/设置链（例如停用 timer
 * 会让补丁热加载整体失效，停用 webserver 会让页面失联）。这些行禁止开关。
 */
const PROTECTED_MODULE_PATTERNS = [
  /^cordis:/u,
  /^@deepseek-ai\/cordis-plugin-/u,
  /^@deepseek-ai\/dsh-host-/u,
  /^@deepseek-ai\/dsh-client-modules$/u,
  /^@deepseek-ai\/dsh-client-connection$/u,
  /^@deepseek-ai\/dsh-client-hmr$/u,
  /^@deepseek-ai\/dsh-client-runtime$/u,
  /^@deepseek-ai\/dsh-client-locale$/u,
  /^@deepseek-ai\/dsh-client-ui-attachment$/u,
  /^@deepseek-ai\/dsh-client-web/u,
  /^@deepseek-ai\/dsh-web-frontend$/u,
  /^@deepseek-ai\/dsh-web-app$/u,
  /^@deepseek-ai\/dsh-settings/u,
  /^@deepseek-ai\/dsh-credentials/u,
  /^@deepseek-ai\/dsh-session/u,
  /^@deepseek-ai\/dsh-storage/u,
  /^@deepseek-ai\/dsh-attachment/u,
  /^@deepseek-ai\/dsh-typert/u,
  /^@deepseek-ai\/dsh-api-remotes$/u,
  /^@deepseek-ai\/dsh-tools$/u,
  /^@deepseek-ai\/dsh-system-prompt$/u,
  /^@deepseek-ai\/dsh-agent/u,
  /^@deepseek-ai\/dsh-llm/u,
  /^@deepseek-ai\/dsh-persona$/u,
  /^@deepseek-ai\/dsh-scope$/u,
  /^@deepseek-ai\/dsh-launch-environment$/u,
  /^@deepseek-ai\/dsh-shell$/u,
  /^@deepseek-ai\/dsh-subprocess/u,
  /^@deepseek-ai\/dsh-fs/u,
  /^@deepseek-ai\/dsh-sandbox/u,
  /^@deepseek-ai\/dsh-jobs/u,
  /^@deepseek-ai\/dsh-skill/u,
  /^@deepseek-ai\/dsh-goal/u,
  /^@deepseek-ai\/dsh-workflow/u,
  /^@deepseek-ai\/dsh-subagent/u,
  /^@deepseek-ai\/dsh-web$/u,
  /^@deepseek-ai\/dsh-workspace/u,
  /^@deepseek-ai\/dsh-user-approval$/u,
  /^@deepseek-ai\/dsh-user-questions$/u,
  /^@deepseek-ai\/dsh-commands$/u,
  /^@deepseek-ai\/dsh-hook/u,
  /^@deepseek-ai\/dsh-spill/u,
  /^@deepseek-ai\/dsh-guard/u,
  /^@deepseek-ai\/dsh-tool-call-timeout-policy$/u,
  /^@deepseek-ai\/dsh-repeat-tool-reminder$/u,
]

function isProtectedModule(moduleName) {
  return typeof moduleName === 'string' && PROTECTED_MODULE_PATTERNS.some((pattern) => pattern.test(moduleName))
}

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

/** bundle 包判定：声明 dsh.bundle 的包一律按官方 `dsh plugin add` 行为追加为
 * profile bundle 层（其 cordis.patch.yml 的插入行在下次启动时组合进树）。
 * 无论有没有 JS 入口都走 bundle 层——皮肤包（无入口）与 web-ui-settings
 * （有入口）都是这样安装的，当作插件条目 insert 会漏掉它们的 bundle 补丁。 */
async function detectBundleOnly(profileDir, packageName) {
  try {
    const pkgPath = resolvePackageJson(packageName, profileDir)
    if (pkgPath === null) throw new Error('not found')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    return typeof pkg.dsh?.bundle?.patch === 'string'
  } catch {
    return false
  }
}

/** 把包追加进 profile 的 dsh.profile.bundles 层（与官方 dsh plugin add 的 reconcile 一致）。 */
async function addBundleToManifest(profileDir, packageName) {
  return queuedWrite(async () => {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (!bundles.includes(packageName)) {
      bundles.push(packageName)
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }
  })
}

/** 官方 profile 模板自带的 bundle（其余 bundle 视为用户额外添加）。 */
const DEFAULT_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 包名归一：支持子路径导出形式（@linxin666/dsh-web-all/settings → @linxin666/dsh-web-all）。 */
function packageNameOf(moduleName) {
  if (typeof moduleName !== 'string') return moduleName
  const m = moduleName.match(/^(@[^/]+\/[^/]+)(?:\/.*)?$/u)
  return m ? m[1] : moduleName
}

/** 把 file:// URL（如 ctx.baseUrl）转成目录路径（resolve 用）。 */
function baseDirOf(baseUrl) {
  try {
    if (typeof baseUrl === 'string' && baseUrl.startsWith('file:')) return dirname(fileURLToPath(baseUrl))
  } catch {}
  return typeof baseUrl === 'string' && baseUrl !== '' ? baseUrl : '.'
}

/**
 * 解析包 package.json 的绝对路径（exports 限制包 fallback）：
 * require.resolve('pkg/package.json') 对声明了 exports 且不含 './package.json' 的包会抛错
 * （2026-09-04 教训：@openviking/dsh-memory-plugin 因此被 heal 误判模块缺失并自动禁用）——
 * fallback 直接查 node_modules 物理路径。
 */
function resolvePackageJson(pkgName, baseDir, fallbackBase) {
  const name = packageNameOf(pkgName)
  try {
    return createRequire(join(baseDir, 'package.json')).resolve(`${name}/package.json`)
  } catch {}
  const parts = String(name).split('/')
  const candidate = join(baseDir, 'node_modules', ...parts, 'package.json')
  if (existsSync(candidate)) return candidate
  // issue #15：npm 全局安装 dsh 时 ctx.baseUrl 落在框架安装树（而非 profile node_modules），
  // 官方 @deepseek-ai/* 恰好可见、第三方插件全部解析失败 → 详情/版本/仓库全空。
  // 回退到 profile 目录（fallbackBase）再试一次。
  if (typeof fallbackBase === 'string' && fallbackBase !== '' && fallbackBase !== baseDir) {
    try {
      return createRequire(join(fallbackBase, 'package.json')).resolve(`${name}/package.json`)
    } catch {}
    const candidate2 = join(fallbackBase, 'node_modules', ...parts, 'package.json')
    if (existsSync(candidate2)) return candidate2
  }
  return null
}

/** 已加载插件的包元信息缓存（安装日期/版本/仓库），60 秒 TTL。 */
const pkgMetaCache = new Map()
const PKG_META_TTL = 60000
function entryPkgMeta(moduleName, baseUrl, profileDir) {
  if (typeof moduleName !== 'string' || moduleName.startsWith('cordis:')) return null
  const hit = pkgMetaCache.get(moduleName)
  if (hit !== undefined && Date.now() - hit.at < PKG_META_TTL) return hit
  const meta = { at: Date.now(), installDate: null, version: null, repository: null }
  try {
    const pkgPath = resolvePackageJson(moduleName, baseDirOf(baseUrl), profileDir ?? null)
    if (pkgPath === null) throw new Error('not found')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    // 安装日期：优先 curl 通道写入的 .dsh-installed-at 标记（真实安装时刻）；
    // 否则用 package.json 的 mtime，但 npm tarball 会把文件时间固定为 1985-10-26
    // （可复现构建），此时回退到目录创建时间（birthtime，解压时刻，Windows 上可靠）。
    try {
      const marker = join(dirname(pkgPath), '.dsh-installed-at')
      if (existsSync(marker)) {
        const ts = Number(readFileSync(marker, 'utf8').trim())
        if (Number.isFinite(ts) && ts > 0) {
          const d = new Date(ts)
          meta.installDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
      }
      if (meta.installDate === null) {
        const st = statSync(pkgPath)
        const yearOk = (t) => t >= 946684800000 // 2000-01-01：早于它都是打包器固定时间戳等伪日期
        const candidates = [st.mtimeMs, st.birthtimeMs ?? NaN].filter((t) => Number.isFinite(t) && yearOk(t))
        if (candidates.length > 0) {
          const d = new Date(Math.min(...candidates))
          meta.installDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
      }
    } catch {}
    meta.version = typeof pkg.version === 'string' ? pkg.version : null
    const rawRepo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? null)
    if (typeof rawRepo === 'string') meta.repository = rawRepo.replace(/^git\+/u, '').replace(/\.git$/u, '').toLowerCase()
  } catch {}
  pkgMetaCache.set(moduleName, meta)
  return meta
}

/** 最小 semver：解析（含 prerelease/build）。 */
function parseSemverText(v) {
  const m = String(v ?? '').trim().replace(/^v/u, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
}
function compareSemverText(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const pa = a.pre.split('.')
  const pb = b.pre.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const xa = pa[i]
    const xb = pb[i]
    if (xa === undefined) return -1
    if (xb === undefined) return 1
    const na = /^\d+$/u.test(xa)
    const nb = /^\d+$/u.test(xb)
    if (na && nb) { const d = Number(xa) - Number(xb); if (d !== 0) return d; continue }
    if (na) return -1
    if (nb) return 1
    const d = xa < xb ? -1 : xa > xb ? 1 : 0
    if (d !== 0) return d
  }
  return 0
}
/** 单段范围匹配（^ ~ >= <= > < = 精确；返回 true = 满足）。 */
function semverCompareOne(v, raw) {
  const rText = String(raw).trim()
  const m = rText.match(/^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/u)
  if (!m) return true
  const op = m[1] ?? ''
  const base = { major: Number(m[2]), minor: m[3] === undefined ? 0 : Number(m[3]), patch: m[4] === undefined ? 0 : Number(m[4]), pre: m[5] ?? null }
  const hasMinor = m[3] !== undefined
  const hasPatch = m[4] !== undefined
  // npm 语义：prerelease 版本只与同 [major,minor,patch] 且范围带 prerelease 的声明匹配
  const preAllowed = v.pre === null || (v.major === base.major && v.minor === base.minor && v.patch === base.patch && base.pre !== null)
  switch (op) {
    case '':
    case '=':
      return preAllowed && compareSemverText(v, base) === 0
    case '<':
      return preAllowed && compareSemverText(v, base) < 0
    case '<=':
      return preAllowed && compareSemverText(v, base) <= 0
    case '>':
      return preAllowed && compareSemverText(v, base) > 0
    case '>=':
      return preAllowed && compareSemverText(v, base) >= 0
    case '~': {
      if (!preAllowed) return false
      if (!hasMinor) return v.major === base.major
      if (!hasPatch) return v.major === base.major && v.minor === base.minor
      return compareSemverText(v, base) >= 0 && !(v.major === base.major && v.minor > base.minor) && v.major === base.major
    }
    case '^': {
      if (!preAllowed) return false
      const upper = base.major === 0
        ? (base.minor === 0 ? { major: 0, minor: 0, patch: base.patch + 1, pre: null } : { major: 0, minor: base.minor + 1, patch: 0, pre: null })
        : { major: base.major + 1, minor: 0, patch: 0, pre: null }
      return compareSemverText(v, base) >= 0 && compareSemverText(v, upper) < 0
    }
    default:
      return true
  }
}
/** 范围匹配：支持多个段以逗号/空白分隔（AND）与 `||`（OR）。 */
function semverRangeMatch(versionText, rangeText) {
  const v = parseSemverText(versionText)
  if (!v) return false
  const alternatives = String(rangeText ?? '').split(/\s*\|\|\s*/u).filter(Boolean)
  if (alternatives.length === 0) return false
  return alternatives.some((alt) => {
    const parts = alt.split(/\s*[,\s]\s*/u).filter(Boolean)
    return parts.length > 0 && parts.every((part) => semverCompareOne(v, part))
  })
}
/**
 * 宽松声明匹配（仅用于插件「显式声明兼容范围」）：prerelease 版本按同线发布版判定——
 * 作者声明 `>=0.1.2` 即代表支持 0.1.2 线，框架运行在 0.1.2-rc.1 应判定兼容。
 */
function semverRangeMatchLoose(versionText, rangeText) {
  if (semverRangeMatch(versionText, rangeText)) return true
  const v = parseSemverText(versionText)
  if (v === null || v.pre === null) return false
  return semverRangeMatch(`${v.major}.${v.minor}.${v.patch}`, rangeText)
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

/** 读取用户额外 bundle（非官方模板）的补丁插入行 id 与包名，用于"额外插件"判定。 */
async function readExtraBundleRows(profileDir) {
  const rows = new Set()
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    for (const pkg of bundles) {
      if (DEFAULT_BUNDLES.includes(pkg)) continue
      try {
        const pk = resolvePackageJson(pkg, profileDir)
        const dir = dirname(pk ?? join(profileDir, 'node_modules', ...String(pkg).split('/'), 'package.json'))
        const text = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
        const lines = text.split(/\r?\n/u)
        let inInsert = false
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (/^- insert:\s*$/u.test(line)) {
            inInsert = true
            continue
          }
          if (/^- /u.test(line)) inInsert = false
          if (!inInsert) continue
          const idMatch = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
          if (!idMatch) continue
          rows.add(idMatch[1])
          const nameMatch = (lines[index + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
          if (nameMatch) rows.add(nameMatch[1])
        }
      } catch {}
    }
  } catch {}
  return rows
}

/** 从加载器读取 webserver 监听端口（默认 3080）。 */
function webPort(ctx) {
  // 优先取运行时真实监听端口（自定义 --port / 系统分配端口也能正确校验 Host）
  try {
    const ws = ctx.webServer
    if (ws && typeof ws.port === 'number' && ws.port > 0) return ws.port
  } catch {}
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.name === '@deepseek-ai/dsh-host-webserver') {
      const port = entry.options?.config?.port
      if (typeof port === 'number' && port > 0) return port
    }
  }
  return 3080
}

/** 简单 https POST 表单（Gitee token 交换用），返回 {status, body}。 */
function postJsonUrl(url, formBody) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formBody).toString()
    const req = httpsRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': GITHUB_UA,
        accept: 'application/json',
      },
      timeout: 20000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          resolve({ status: res.statusCode ?? 0, body: null })
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** 解析 dsh CLI 的 bin.js 绝对路径（守护拉起用）。 */
function resolveDshBin() {
  try {
    const requireLocal = createRequire(join(dirname(fileURLToPath(import.meta.url)), 'package.json'))
    return join(dirname(requireLocal.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  } catch {
    return null
  }
}

/** 读取用户额外 bundle 的插入行归属表：行 id / 包名 → 所属 bundle 包名。 */
async function readExtraBundleOwners(profileDir) {
  const owners = new Map()
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    for (const pkg of bundles) {
      if (DEFAULT_BUNDLES.includes(pkg)) continue
      try {
        const pk = resolvePackageJson(pkg, profileDir)
        const dir = dirname(pk ?? join(profileDir, 'node_modules', ...String(pkg).split('/'), 'package.json'))
        const text = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
        const lines = text.split(/\r?\n/u)
        let inInsert = false
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (/^- insert:\s*$/u.test(line)) {
            inInsert = true
            continue
          }
          if (/^- /u.test(line)) inInsert = false
          if (!inInsert) continue
          const idMatch = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
          if (!idMatch) continue
          owners.set(idMatch[1], pkg)
          const nameMatch = (lines[index + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
          if (nameMatch) owners.set(nameMatch[1], pkg)
        }
      } catch {}
    }
  } catch {}
  return owners
}

/** 从补丁文件移除某行的 insert 块与 disabled/forced 覆盖块。 */
async function removeInsertRow(patchPath, rowId) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    const blockRe = new RegExp(`^- insert:\\s*\\r?\\n {4}- id: ${escapeRegExp(rowId)}\\s*\\r?\\n( {6}name: [^\\r\\n]*\\r?\\n)?`, 'mu')
    let next = text.replace(blockRe, '')
    const overrideRe = new RegExp(`^- id: ${escapeRegExp(rowId)}\\s*\\r?\\n {2}disabled: (true|false)\\s*\\r?\\n`, 'mu')
    next = next.replace(overrideRe, '')
    if (next !== text) await writeFile(patchPath, sanitizePatchText(next), 'utf8')
  })
}

/** 从 profile manifest 移除一个 bundle。 */
async function removeBundleFromManifest(profileDir, bundlePkg) {
  return queuedWrite(async () => {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const next = bundles.filter((name) => name !== bundlePkg)
    if (next.length !== bundles.length) {
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: next } }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }
  })
}

/** 用 corepack pnpm 移除包（与安装同一管理器与凭据抑制环境）。
 * 注意：pnpm remove 不支持 --registry 选项，去掉避免静默失败。 */
export async function pnpmRemove(profileDir, packageName) {
  const args = ['remove', packageName]
  const opts = {
    cwd: profileDir,
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, COREPACK_NPM_REGISTRY: 'https://registry.npmmirror.com', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  }
  // 跨平台定位 corepack/pnpm（Linux 的 corepack 不在 <node bin>/node_modules 下，2026-09-20 事故）
  await runPnpmWithFallback(args, { execOpts: opts })
}

/** 清理陈旧包目录与 pnpm _tmp_ 残留（Windows 原子替换 EPERM 的根因），返回清理数量。 */
function cleanupStalePackageDir(profileDir, packageName) {
  const segments = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  const dir = join(profileDir, 'node_modules', ...segments)
  const base = basename(dir)
  const parent = dirname(dir)
  let removed = 0
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
    }
  } catch {}
  try {
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(`${base}_tmp_`)) {
        try {
          rmSync(join(parent, entry), { recursive: true, force: true })
          removed += 1
        } catch {}
      }
    }
  } catch {}
  return removed
}

/** 软件源配置文件（registry 列表，安装链按主→备依次尝试）。 */
const SOURCES_FILE = join(dshHome(), 'plugin-console-sources.json')
/** 敏感凭据单独落盘（避免与可分享配置混存）：自定义搜索源 headers + Gitee secret/token。 */
const SOURCES_SECRETS_FILE = join(dshHome(), 'plugin-console-sources.secrets.json')
export const DEFAULT_SOURCES = {
  registries: [
    { id: 'npmmirror', name: 'npmmirror（国内镜像）', url: 'https://registry.npmmirror.com', primary: true },
    { id: 'npmjs', name: 'npmjs（官方源）', url: 'https://registry.npmjs.org', primary: false },
  ],
  searchSources: [
    { id: 'github', name: 'GitHub', type: 'builtin' },
    { id: 'gitee', name: 'Gitee', type: 'builtin' },
  ],
  // 市场静态索引源（按主→备依次尝试；内网可整体替换为自建镜像，实现完全离线的市场浏览）
  // 2026-09-20 扩容 2 → 5：只有 jsDelivr + ghproxy 两个源时，两者同时不可达就会让整个市场退化成
  // 「只能搜 GitHub 实时结果」——收录清单（含 ★7800 全家桶）与本地索引模糊匹配一起失效
  // （另一位用户实测报「市场索引加载失败：网络不可达（2 个索引源全部失败）：GitHub 请求超时」）。
  // jsDelivr 官方多入口互为主备：cdn（主）/ gcore / fastly；再加 ghproxy 与 raw 直连兜底。
  indexSources: [
    { id: 'jsdelivr', name: 'jsDelivr CDN', url: 'https://cdn.jsdelivr.net/gh/Noob-stupid/dsh-plugin-hub@main/marketplace/index.json', primary: true },
    { id: 'jsdelivr-gcore', name: 'jsDelivr (gcore)', url: 'https://gcore.jsdelivr.net/gh/Noob-stupid/dsh-plugin-hub@main/marketplace/index.json', primary: false },
    { id: 'jsdelivr-fastly', name: 'jsDelivr (fastly)', url: 'https://fastly.jsdelivr.net/gh/Noob-stupid/dsh-plugin-hub@main/marketplace/index.json', primary: false },
    { id: 'ghproxy', name: 'ghproxy 镜像', url: 'https://ghproxy.net/https://raw.githubusercontent.com/Noob-stupid/dsh-plugin-hub/main/marketplace/index.json', primary: false },
    { id: 'raw', name: 'GitHub raw 直连', url: 'https://raw.githubusercontent.com/Noob-stupid/dsh-plugin-hub/main/marketplace/index.json', primary: false },
  ],
  // Git 克隆源（{owner}/{repo} 占位符；按主→备依次尝试）。
  // 可替换为 Gitee / GitLab / 自建 Gitea / 任意镜像代理，实现「换一个网站下载仓库内容」。
  gitSources: [
    { id: 'ghproxy-git', name: 'ghproxy 镜像', urlTemplate: 'https://ghproxy.net/https://github.com/{owner}/{repo}.git', primary: true },
    { id: 'github-git', name: 'GitHub 直连', urlTemplate: 'https://github.com/{owner}/{repo}.git', primary: false },
  ],
  // 索引合并模式：true = 所有索引源结果合并去重（公共索引 + 内网私有索引同时可见）；
  // false = 主→备只用一个（内网优先，更快）
  indexMerge: false,
  gitee: { clientId: '', clientSecret: '', token: '', login: '' },
}
/** 市场索引落盘缓存（网络不可达时降级展示上次成功结果，避免内网/断网下市场空白）。 */
const MARKET_INDEX_CACHE_FILE = join(dshHome(), 'plugin-console-market-index-cache.json')

/** 源地址校验（模块顶层，readSources 与 sources 路由共用）：https 任意；http 仅限私网/本机地址（内网 npm registry、内网搜索服务常用 http）。 */
function isAllowedSourceUrl(url) {
  if (/^https:\/\/\S+$/u.test(url)) return true
  if (!/^http:\/\/\S+$/u.test(url)) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true
    if (/^127\.\d+\.\d+\.\d+$/u.test(host)) return true
    if (/^10\.\d+\.\d+\.\d+$/u.test(host)) return true
    if (/^192\.168\.\d+\.\d+$/u.test(host)) return true
    if (/^169\.254\.\d+\.\d+$/u.test(host)) return true
    const m = host.match(/^172\.(\d+)\.\d+\.\d+$/u)
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
    if (/^[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7}$/iu.test(host)) return true
    return false
  } catch {
    return false
  }
}

/** Git 源地址校验：在通用校验之上额外允许 file:// 本地裸仓库（完全离线/内网共享盘场景）。 */
function isAllowedGitSourceUrl(url) {
  if (/^file:\/\/\/\S+$/u.test(url)) return true
  return isAllowedSourceUrl(url)
}

/** 读取 Gitee OAuth 配置（clientId/clientSecret/token/login）。 */
function readGiteeConfig(data) {
  const gitee = data && typeof data === 'object' && data.gitee && typeof data.gitee === 'object' ? data.gitee : {}
  return {
    clientId: typeof gitee.clientId === 'string' ? gitee.clientId : '',
    clientSecret: typeof gitee.clientSecret === 'string' ? gitee.clientSecret : '',
    token: typeof gitee.token === 'string' ? gitee.token : '',
    login: typeof gitee.login === 'string' ? gitee.login : '',
  }
}

/** 读取软件源配置（损坏/缺失时回退默认）。 */
function readSources() {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_SOURCES))
  try {
    const data = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'))
    const secrets = readSourceSecrets()
    const registries = (Array.isArray(data.registries) ? data.registries : [])
      .filter((r) => r && typeof r.url === 'string' && isAllowedSourceUrl(r.url))
      .map((r) => ({
        id: String(r.id ?? '').slice(0, 40) || `src-${Math.random().toString(36).slice(2, 8)}`,
        name: String(r.name ?? r.url).slice(0, 60) || r.url,
        url: r.url,
        primary: r.primary === true,
      }))
    const searchSources = (Array.isArray(data.searchSources) ? data.searchSources : [])
      .map((s) => {
        if (s && (s.id === 'github' || s.id === 'gitee')) {
          return { id: String(s.id), name: String(s.name ?? s.id), type: 'builtin' }
        }
        if (s && typeof s.url === 'string' && s.url.includes('{q}')) {
          let headers = {}
          const secretHeaders = secrets.headers?.[s.id]
          if (secretHeaders && typeof secretHeaders === 'object') {
            headers = { ...secretHeaders }
          } else if (Array.isArray(s.headers)) {
            for (const h of s.headers) {
              if (h && typeof h.name === 'string' && h.name !== '' && typeof h.value === 'string') {
                headers[h.name] = h.value
              }
            }
          } else if (s.headers && typeof s.headers === 'object') {
            headers = { ...s.headers }
          }
          return {
            id: String(s.id ?? `search-${Math.random().toString(36).slice(2, 8)}`).slice(0, 40),
            name: String(s.name ?? s.url).slice(0, 60),
            type: 'custom',
            url: s.url,
            headers,
          }
        }
        return null
      })
      .filter((s) => s !== null)
    const giteeBase = readGiteeConfig(data)
    // 索引源：老配置无该字段时用默认；URL 必须是合法 https 或本机/私网 http
    const indexSources = (Array.isArray(data.indexSources) ? data.indexSources : [])
      .filter((s) => s && typeof s.url === 'string' && isAllowedSourceUrl(s.url))
      .map((s) => ({
        id: String(s.id ?? '').slice(0, 40) || `idx-${Math.random().toString(36).slice(2, 8)}`,
        name: String(s.name ?? s.url).slice(0, 60) || s.url,
        url: s.url,
        primary: s.primary === true,
      }))
    const indexFinal = indexSources.length > 0
      ? (() => {
        if (!indexSources.some((s) => s.primary)) indexSources[0].primary = true
        return indexSources
      })()
      : defaults.indexSources
    // Git 克隆源：模板必须同时含 {owner} 与 {repo}；老配置无该字段时用默认
    const gitSources = (Array.isArray(data.gitSources) ? data.gitSources : [])
      .filter((s) => s && typeof s.urlTemplate === 'string' && s.urlTemplate.includes('{owner}') && s.urlTemplate.includes('{repo}') && isAllowedGitSourceUrl(s.urlTemplate))
      .map((s) => ({
        id: String(s.id ?? '').slice(0, 40) || `git-${Math.random().toString(36).slice(2, 8)}`,
        name: String(s.name ?? s.urlTemplate).slice(0, 60) || s.urlTemplate,
        urlTemplate: s.urlTemplate,
        primary: s.primary === true,
      }))
    const gitFinal = gitSources.length > 0
      ? (() => {
        if (!gitSources.some((s) => s.primary)) gitSources[0].primary = true
        return gitSources
      })()
      : defaults.gitSources
    const gitee = {
      ...giteeBase,
      clientSecret: secrets.gitee?.clientSecret ?? giteeBase.clientSecret,
      token: secrets.gitee?.token ?? giteeBase.token,
    }
    if (registries.length > 0) {
      if (!registries.some((r) => r.primary)) registries[0].primary = true
      return { registries, searchSources, indexSources: indexFinal, gitSources: gitFinal, indexMerge: data.indexMerge === true, gitee }
    }
  } catch {}
  return defaults
}

function readSourceSecrets() {
  try {
    const data = JSON.parse(readFileSync(SOURCES_SECRETS_FILE, 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

async function writeSourceSecrets(secrets) {
  const gitee = secrets.gitee ?? {}
  const headers = secrets.headers ?? {}
  const hasGitee = typeof gitee.clientSecret === 'string' && gitee.clientSecret !== '' || typeof gitee.token === 'string' && gitee.token !== ''
  const hasHeaders = Object.keys(headers).some((id) => { const h = headers[id]; return h && typeof h === 'object' && Object.keys(h).length > 0 })
  if (!hasGitee && !hasHeaders) {
    try { rmSync(SOURCES_SECRETS_FILE, { force: true }) } catch {}
    return
  }
  await writeFile(SOURCES_SECRETS_FILE, JSON.stringify({ gitee, headers }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}
async function writeSources(sources) {
  const secrets = { gitee: {}, headers: {} }
  const cleanSearch = (sources.searchSources ?? []).map((s) => {
    if (!s) return s
    if (s.headers && typeof s.headers === 'object' && Object.keys(s.headers).length > 0) {
      secrets.headers[s.id] = { ...s.headers }
      const { headers, ...rest } = s
      return rest
    }
    return s
  })
  const gitee = readGiteeConfig(sources)
  if (typeof gitee.clientSecret === 'string' && gitee.clientSecret !== '') secrets.gitee.clientSecret = gitee.clientSecret
  if (typeof gitee.token === 'string' && gitee.token !== '') secrets.gitee.token = gitee.token
  const cleanGitee = { ...(sources.gitee ?? {}), clientSecret: undefined, token: undefined }
  const main = { ...sources, searchSources: cleanSearch, gitee: cleanGitee }
  await writeFile(SOURCES_FILE, JSON.stringify(main, null, 2) + '\n', 'utf8')
  await writeSourceSecrets(secrets)
}

/**
 * 凭据脱敏（安全审查发现）：/sources 响应不得携带明文密钥——
 * - Gitee clientSecret / token：绝不回传（clientId 打码保留前 8 位供识别）
 * - 自定义搜索源的 headers（可能含 Authorization: Bearer xxx）：value 打码
 * 前端需要"已配置"状态时用 giteeStatusView 的布尔字段。
 */
function maskSources(sources) {
  const gitee = readGiteeConfig(sources)
  const maskedGitee = {
    clientId: gitee.clientId === '' ? '' : `${gitee.clientId.slice(0, 8)}…`,
    clientConfigured: gitee.clientId !== '',
    hasToken: gitee.token !== '',
    login: gitee.login,
  }
  return {
    registries: sources.registries,
    indexSources: sources.indexSources ?? DEFAULT_SOURCES.indexSources,
    indexMerge: sources.indexMerge === true,
    gitSources: sources.gitSources ?? DEFAULT_SOURCES.gitSources,
    searchSources: (sources.searchSources ?? []).map((s) => {
      if (s && typeof s.headers === 'object' && Object.keys(s.headers).length > 0) {
        const masked = {}
        for (const [k, v] of Object.entries(s.headers)) {
          masked[k] = typeof v === 'string' && v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : (v === '' ? '' : '••••')
        }
        return { ...s, headers: masked }
      }
      return s
    }),
    gitee: maskedGitee,
  }
}

/** Gitee 配置状态视图（布尔 + login，无任何凭据）。 */
function giteeStatusView(sources) {
  const gitee = readGiteeConfig(sources)
  return { clientConfigured: gitee.clientId !== '', hasToken: gitee.token !== '', login: gitee.login }
}

/** 按主→备顺序返回 registry URL 列表。 */
function orderedRegistries(sources) {
  const list = [...sources.registries]
  return [...list.filter((r) => r.primary), ...list.filter((r) => !r.primary)].map((r) => r.url)
}

/** 串行化补丁文件写入，避免并发 toggle 的读改写竞争。 */
let writeQueue = Promise.resolve()
function queuedWrite(fn) {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

/** 解析 DSH 框架版本号为可比较对象；正式版（无预发布段）视为 rc.∞。 */
function parseFrameworkVersion(value) {
  const m = String(value ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(?:[a-z]+\.)?(\d+))?$/iu)
  if (!m) return -1
  const [, maj, min, pat, rc] = m
  return {
    maj: Number.parseInt(maj, 10),
    min: Number.parseInt(min, 10),
    pat: Number.parseInt(pat, 10),
    rc: rc === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(rc, 10),
  }
}

/** 判断 candidate 是否比 current 更新（候选与当前必须是合法版本号，否则视为不可比）。 */
function isFrameworkVersionNewer(candidate, current) {
  const a = parseFrameworkVersion(candidate)
  const b = parseFrameworkVersion(current)
  if (a === -1 || b === -1) return false
  if (a.maj !== b.maj) return a.maj > b.maj
  if (a.min !== b.min) return a.min > b.min
  if (a.pat !== b.pat) return a.pat > b.pat
  return a.rc > b.rc
}

/** 默认 profile 用户补丁层路径（无 include 条目可推导时的兜底）。 */
function defaultPatchPath() {
  const home = dshHome()
  return join(home, 'profiles', 'web', 'cordis.patch.yml')
}

/** DSH 数据根目录（与 dsh-github-login 工具共享令牌文件位置）。 */
function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * 读取 dsh-github-login（独立登录工具）写入的 GitHub 令牌文件。
 * 只对外暴露登录状态（login），绝不下发令牌本身。
 */
function readGithubAuth() {
  try {
    const data = JSON.parse(readFileSync(join(dshHome(), 'github-auth.json'), 'utf8'))
    if (data && typeof data.token === 'string' && data.token) {
      return { loggedIn: true, login: typeof data.login === 'string' && data.login && data.login !== 'unknown' ? data.login : null, token: data.token }
    }
  } catch {}
  return { loggedIn: false, login: null, token: null }
}

/**
 * 兼容性探测：读取 profile 中 web-app / cli 的版本。
 * 官方破坏性升级（0.2、1.0 等）可能改动本插件依赖的补丁/加载器/插槽接口，
 * 因此面板披露版本并给出提示，而不是默默失效。
 */
const CONSOLE_VERSION = '0.1.0'
// 支持 0.1.x 系列（0.1.0 / 0.1.1 等）；0.2 / 1.0 等破坏性大版本才标记不支持
const SUPPORTED_WEB_APP_PATTERN = /^0\.1\.\d+/u

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
  // 兜底：ctx.baseUrl 不可用导致 require.resolve 失败时，从插件自身目录解析——
  // 曾导致 dshVersion 为空 → 客户端 current="" → 误判「升级到 latest(rc.7)」（方向相反）
  if (result.dshVersion === null) {
    try {
      const requireLocal = createRequire(join(dirname(fileURLToPath(import.meta.url)), 'package.json'))
      const dshPkg = JSON.parse(readFileSync(requireLocal.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
      result.dshVersion = dshPkg.version ?? null
    } catch {}
  }
  if (result.webAppVersion !== null && !SUPPORTED_WEB_APP_PATTERN.test(result.webAppVersion)) {
    result.supported = false
    result.notice = `当前 DSH web 包版本 ${result.webAppVersion} 不在受支持的 0.1.x 系列内，插件控制台的部分功能可能因官方破坏性更新而失效；请到 https://github.com/Noob-stupid/dsh-plugin-hub 获取匹配的更新`
  }
  return result
}

const FRAMEWORK_STATE_FILE = () => join(dshHome(), 'plugin-console', 'framework-state.json')
const FRAMEWORK_BACKUP_ROOT = () => join(dshHome(), 'plugin-console', 'framework-backups')
const COMPAT_PENDING_FILE = () => join(dshHome(), 'plugin-console', 'compat-pending.json')

/** 框架核心行：误禁用会导致启动失败（2026-09-04 session-persistence-jsonl 事故：6 行 pending、
 * 启动断言失败）。任何补丁写入（适配门/脚本/工具）都禁止禁用这些行；自愈机制自动恢复误禁。 */
const CORE_PATCH_ROW_IDS = new Set([
  'session-persistence-jsonl', 'webserver', 'timer', 'hmr', 'session', 'session-checkpoint-policy',
  'message-feedback', 'workspace', 'storage', 'storage-json', 'storage-domain', 'api-gateway',
  'api-session-controller', 'api-workspace-controller', 'credentials', 'settings', 'attachment-local',
  'subprocess', 'sandbox', 'sandbox-policy', 'shell-env', 'agent', 'agent-loop', 'llm', 'web-runtime', 'web-startup',
])

let patchHealAt = null
let patchHealReport = null

/** 解析用户补丁中 insert 块的 id → moduleName（name 字段）。 */
function parseInsertNames(text) {
  const map = new Map()
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  let curId = null
  for (const line of lines) {
    if (/^- insert:\s*$/u.test(line)) { inInsert = true; curId = null; continue }
    if (inInsert && /^- /u.test(line)) inInsert = false
    if (inInsert) {
      const idMatch = line.match(/^\s+- id: ([A-Za-z0-9_.-]+)/u)
      if (idMatch) { curId = idMatch[1]; continue }
      if (curId !== null) {
        const nameMatch = line.match(/^\s+name: ['"]([^'"]+)['"]/u)
        if (nameMatch) { map.set(curId, nameMatch[1]); curId = null }
      }
    }
  }
  return map
}

/**
 * 补丁安全自愈（服务永不崩机制）：
 * ① 核心行被误禁用 → 自动移除禁用块恢复；
 * ② 启用态用户 insert 行的模块缺失（如引用未安装包的行）→ 自动禁用（loader 对缺失模块会致命崩溃）。
 * return { healed:[], autoDisabled:[], healedAt } —— healedAt=0 表示本次无修改。
 */
async function healPatchSafety(patchPath) {
  const profileDir = dirname(patchPath)
  const { text } = await readPatchState(patchPath)
  let next = text
  const healed = []
  const autoDisabled = []
  for (const id of CORE_PATCH_ROW_IDS) {
    const re = new RegExp(`^- id: ${escapeRegExp(id)}\\s*\\r?\\n {2}disabled: true\\s*\\r?\\n`, 'mu')
    if (re.test(next)) {
      next = next.replace(re, '')
      healed.push(id)
    }
  }
  if (healed.length === 0) {
    const insertNames = parseInsertNames(next)
    let require = null
    for (const [id, moduleName] of insertNames) {
      if (!moduleName || moduleName.startsWith('cordis:')) continue
      let ok = true
      try { ok = resolvePackageJson(moduleName, profileDir) !== null } catch { ok = false }
      if (!ok && !new RegExp(`^- id: ${escapeRegExp(id)}\\s*\\r?\\n {2}disabled: true\\s*\\r?\\n`, 'mu').test(next)) {
        next = `${next.trimEnd()}\n- id: ${id}\n  disabled: true\n`
        autoDisabled.push(id)
      }
    }
  }
  if (next !== text) {
    await writeFile(patchPath, sanitizePatchText(next), 'utf8')
  }
  return { healed, autoDisabled, healedAt: next !== text ? Date.now() : 0 }
}

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

/** 待适配行的「现在是否已适配」检测（只提示，不自动解锁——用户定案：我点才开）。
 * 返回 Map<rowId, {version, check, note}>：仅当版本已变化且源码扫描不再 fail 时才算可解锁。 */
function detectAdoptablePending(ctx) {
  const out = new Map()
  const pending = readCompatPending()
  if (pending === null) return out
  const fwVer = typeof pending.frameworkVersion === 'string' ? pending.frameworkVersion : null
  if (fwVer === null) return out
  let profileDir = null
  try { profileDir = dirname(findPatchPath(ctx)) } catch { return out }
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

/** 把升级脚本留下的「启动失败隔离」记录并入适配门清单（只处理一次：处理后改名 .applied）。
 *  作用：服务被隔离救回来之后，用户能在面板上看到「谁被自动关了、为什么」，并可逐个解锁。 */
/** 读取升级脚本写下的隔离记录（含 BOM 兼容）。
 *  ★ 2026-09-11 事故根因：升级脚本用 PowerShell `Set-Content -Encoding UTF8` 写这个文件，
 *  PS5.1 会**带 UTF-8 BOM**；而合并逻辑先"复制 + 删除"再判断 JSON.parse 结果 → BOM 让 parse
 *  必失败 → 记录被销毁、却从未并进适配门清单 → 界面上那 20 行只剩一个**没有解释的【停用】**。
 *  这里统一剥 BOM 再解析；解析失败返回 null（调用方会保留文件、留错误日志，绝不销毁证据）。 */
function readQuarantineRecord() {
  const file = join(dshHome(), 'plugin-console', 'fw-quarantine.json')
  if (!existsSync(file)) return null
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return null }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  try {
    const rec = JSON.parse(raw)
    return rec !== null && typeof rec === 'object' ? rec : null
  } catch { return null }
}

/** 合并隔离记录失败时留痕（v0.3.44）：静默 catch 让 2026-09-11 那次 20 行隔离记录凭空消失，
 *  界面只剩一个没有解释的【停用】，而且事后完全查不到原因。错误落到 fw-merge-error.log。 */
function logQuarantineMergeError(error) {
  try {
    const file = join(dshHome(), 'plugin-console', 'fw-merge-error.log')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${new Date().toISOString()} ${error?.stack ?? String(error)}\n`, { flag: 'a' })
  } catch {}
}

/** 把升级脚本留下的「启动失败隔离」记录并入适配门清单。
 *  顺序很关键（v0.3.44）：**先写清单并校验成功，再归档移除记录**。反过来的话，
 *  任何解析/写入意外都会"记录没了、清单也没进"，用户只看到一个没有理由的【停用】。
 *  导出仅供测试直接驱动（避免测试为了跑它而 apply 整个插件）。 */
export function mergeQuarantineRecord(ctx) {
  const file = join(dshHome(), 'plugin-console', 'fw-quarantine.json')
  if (!existsSync(file)) return null
  const rec = readQuarantineRecord()
  if (rec === null) {
    logQuarantineMergeError(new Error('隔离记录无法解析（已按 BOM 兼容处理仍失败），保留文件待下次启动重试'))
    return null
  }
  const rows = (Array.isArray(rec.rows) ? rec.rows : []).filter((rowId) => typeof rowId === 'string' && rowId !== '')
  const pending = readCompatPending() ?? { frameworkVersion: null, upgradeFrom: null, pending: [] }
  if (!Array.isArray(pending.pending)) pending.pending = []
  const lines = Array.isArray(rec.lines) ? rec.lines : []
  // 隔离记录里只有 rowId（脚本写的），但清单里其它地方都按 moduleName 认身份：
  // 「全家桶一键启用已适配」按 moduleName 前缀匹配、`检测到已适配 vX` 也要 moduleName 才能算。
  // 所以这里按当前 loader 反查补上（v0.3.45：补不上就会永远匹配不到 —— 用户实测「点了说没有待适配行」）。
  const info = ctx === undefined || ctx === null ? new Map() : rowIdModuleMap(ctx)
  for (const rowId of rows) {
    const meta = info.get(rowId) ?? null
    const record = {
      rowId,
      moduleName: meta?.moduleName ?? null,
      version: meta?.version ?? null,
      status: 'pending',
      check: 'unknown',
      checkNote: `启动失败隔离（${rec.mode ?? 'targeted'}）：${lines[0] ?? '启动日志命中，服务曾被它拖垮'}`,
      forcedAt: Date.now(),
      source: 'boot-quarantine',
    }
    const at = pending.pending.findIndex((p) => p.rowId === rowId)
    if (at >= 0) pending.pending[at] = { ...pending.pending[at], ...record }
    else pending.pending.push(record)
    // 该行现在就是启用的（比如用户在隔离之后已经手动启用过）→ 直接记成已适配，别留一个假 pending
    if (meta?.enabled === true) markPendingAdopted(pending, rowId, 'row-enabled', meta)
  }
  // 预设隔离单独记录（它不是插件行，没有「启用」语义；解锁 = 把 .broken 文件改回来）
  if (Array.isArray(rec.presets) && rec.presets.length > 0) {
    pending.presetsQuarantined = rec.presets.map((name) => ({ name, at: rec.at ?? null, note: 'agent.cordis.yml 已改名 .broken（启动失败隔离），确认修好后改回文件名即可恢复' }))
  }
  pending.quarantineAt = rec.at ?? null
  pending.quarantineLines = lines.slice(0, 5)
  writeCompatPending(pending)
  // 写后校验：清单里必须真的能看到这些行，才允许销毁原始记录
  const back = readCompatPending()
  const missing = rows.filter((rowId) => !(back?.pending ?? []).some((p) => p.rowId === rowId))
  if (back === null || missing.length > 0) {
    logQuarantineMergeError(new Error(`隔离记录写入清单后校验失败（缺失 ${missing.length}/${rows.length} 行），保留记录待下次启动重试`))
    return rec
  }
  try {
    copyFileSync(file, `${file}.applied-${Date.now()}`)
    rmSync(file, { force: true })
  } catch {}
  return rec
}

/** 当前 loader 树里的 rowId → { moduleName, version, enabled }（补 moduleName、对账用）。 */
export function rowIdModuleMap(ctx) {
  const out = new Map()
  let entries = []
  try { entries = listEntries(ctx) } catch { return out }
  const profileDir = profileDirOf(ctx)
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

/** 把某行的待适配记录标记为「已适配」（保留历史判定痕迹：check / checkNote / riskyApprovedAt）。
 *  语义（用户定案 2026-09-11）：**启用即视为已适配**，但要留下"曾被判定/隔离"的痕迹供事后查。 */
function markPendingAdopted(pending, rowId, by, meta) {
  const rec = (pending?.pending ?? []).find((p) => p.rowId === rowId)
  if (rec === undefined) return false
  rec.status = 'adopted'
  rec.adoptedAt = Date.now()
  rec.adoptedBy = by
  if (meta !== null && meta !== undefined) {
    if (typeof meta.moduleName === 'string' && meta.moduleName !== '') rec.moduleName = meta.moduleName
    if (typeof meta.version === 'string' && meta.version !== '') rec.version = meta.version
  }
  return true
}

/** 启动时让清单与现实对账（v0.3.45）：
 *   ① 老记录缺 moduleName → 按当前 loader 补上（否则「全家桶一键启用已适配」永远匹配不到）；
 *   ② 记录还是 pending、但这一行**当前已经启用**（用户手动启用过 / 补丁被清过）→ 转 adopted。
 *  不这么做就会出现用户实测的那种矛盾：**已启用的行，重启后仍挂着【待适配】**。
 *  返回 { backfilled, adopted } 供日志/测试核对；无变化则不写盘。 */
export function reconcileCompatPending(ctx) {
  const pending = readCompatPending()
  if (pending === null || !Array.isArray(pending.pending)) return { backfilled: 0, adopted: 0 }
  const info = rowIdModuleMap(ctx)
  let backfilled = 0
  let adopted = 0
  for (const rec of pending.pending) {
    if ((rec.status ?? 'pending') !== 'pending') continue
    const meta = info.get(rec.rowId) ?? null
    if (meta !== null) {
      if ((rec.moduleName === null || rec.moduleName === undefined || rec.moduleName === '') && typeof meta.moduleName === 'string' && meta.moduleName !== '') {
        rec.moduleName = meta.moduleName
        if (meta.version !== null && meta.version !== undefined) rec.version = meta.version
        backfilled += 1
      }
      if (meta.enabled === true) {
        if (markPendingAdopted(pending, rec.rowId, 'row-enabled', meta)) adopted += 1
      }
    }
  }
  if (backfilled > 0 || adopted > 0) {
    pending.updatedAt = new Date().toISOString()
    writeCompatPending(pending)
  }
  return { backfilled, adopted }
}

/** 定位 @deepseek-ai/dsh-app-boot（与 @deepseek-ai/dsh 同级）。 */
function locateAppBootFile(baseUrl) {
  try {
    const require = createRequire(baseUrl)
    const dshPkg = require.resolve('@deepseek-ai/dsh/package.json')
    const candidate = join(dirname(dshPkg), 'dsh-app-boot', 'lib', 'index.js')
    if (existsSync(candidate)) return candidate
  } catch {}
  const cacheRoots = [
    process.env.NODE_CACHE || '',
    'D:\\node_cache\\_npx',
    join(homedir(), '.npm', '_npx'),
    join(process.env.LOCALAPPDATA || '', 'node_cache', '_npx'),
  ].filter(Boolean)
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 内联框架补丁（dsh-app-boot parsePatchList 容错，issue #5）——DSH 升级后框架文件被覆盖，需重打。 */
function applyFrameworkTolerancePatchOnce(baseUrl) {
  const target = locateAppBootFile(baseUrl)
  if (!target) return { applied: false, reason: 'dsh-app-boot 未找到' }
  let source = ''
  try { source = readFileSync(target, 'utf8') } catch (error) { return { applied: false, reason: `读取失败：${error.message}` } }
  if (source.includes('tryDropEmptyArrayPlaceholder')) return { applied: false, reason: '已打过补丁' }
  if (!source.includes('function parsePatchList')) return { applied: false, reason: 'parsePatchList 不存在（框架版本可能已变更）' }
  const OLD = 'function parsePatchList(binName, file, content, label) {\n\tlet parsed;\n\ttry {\n\t\tparsed = yaml.load(content, { schema: userPatchesSchema });\n\t} catch (error) {\n\t\tthrow new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);\n\t}'
  const NEW = 'function parsePatchList(binName, file, content, label) {\n\tlet parsed;\n\ttry {\n\t\tparsed = yaml.load(content, { schema: userPatchesSchema });\n\t} catch (error) {\n\t\tconst retried = tryDropEmptyArrayPlaceholder(content);\n\t\tif (retried !== null) {\n\t\t\ttry {\n\t\t\t\tparsed = yaml.load(retried, { schema: userPatchesSchema });\n\t\t\t} catch {\n\t\t\t\tthrow new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);\n\t\t\t}\n\t\t} else {\n\t\t\tthrow new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);\n\t\t}\n\t}'
  const HELPER = '\n/**\n * 容错辅助（issue #5）：若文件含顶格空数组占位行（`[]` / `[ ]`，可带行尾注释），视为 no-op 移除。\n */\nfunction tryDropEmptyArrayPlaceholder(content) {\n\tconst lines = String(content).split("\\n");\n\tconst kept = [];\n\tlet dropped = false;\n\tfor (const line of lines) {\n\t\tif (/^\\[\\s*\\]\\s*(?:#.*)?$/u.test(line)) {\n\t\t\tdropped = true;\n\t\t\tcontinue;\n\t\t}\n\t\tkept.push(line);\n\t}\n\tif (!dropped) return null;\n\treturn kept.join("\\n");\n}\n'
  try {
    copyFileSync(target, `${target}.bak-issue5`)
    const next = source.replace(OLD, NEW) + HELPER
    writeFileSync(target, next, 'utf8')
    return { applied: true, target }
  } catch (error) {
    return { applied: false, reason: `应用失败：${error.message}` }
  }
}

/** 备份当前 profile 配置快照（按版本目录；框架升级后旧版本目录即升级前配置）。 */
function backupProfileSnapshot(profileDir, version, ctx) {
  const dir = join(FRAMEWORK_BACKUP_ROOT(), version)
  mkdirSync(dir, { recursive: true })
  try { copyFileSync(join(profileDir, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml')) } catch {}
  try { copyFileSync(join(profileDir, 'package.json'), join(dir, 'profile-package.json')) } catch {}
  try {
    const plugins = listEntries(ctx).map((e) => {
      const meta = entryPkgMeta(e.moduleName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
      return { rowId: e.rowId, moduleName: e.moduleName, enabled: e.enabled, version: meta?.version ?? null, installDate: meta?.installDate ?? null }
    })
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify(plugins, null, 2), 'utf8')
  } catch {}
  return dir
}

/** 框架升级检测与适配：记录版本 → 每次启动备份配置快照 → 升级/首次时重打框架补丁。 */
function detectFrameworkUpgrade(ctx) {
  let current = null
  try {
    const require = createRequire(ctx.baseUrl ?? 'file:///')
    const dshPkg = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
    current = dshPkg.version ?? null
  } catch {}
  const statePath = FRAMEWORK_STATE_FILE()
  let prev = null
  try { prev = JSON.parse(readFileSync(statePath, 'utf8')) } catch {}
  const upgraded = prev !== null && prev.lastVersion !== null && current !== null && prev.lastVersion !== current
  const result = { version: current, upgraded, from: prev?.lastVersion ?? null, backupDir: null, patchApplied: false, patchNote: null }
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    const profileDir = dirname(findPatchPath(ctx))
    if (current !== null) result.backupDir = backupProfileSnapshot(profileDir, current, ctx)
    const patch = applyFrameworkTolerancePatchOnce(ctx.baseUrl ?? 'file:///')
    result.patchApplied = patch.applied
    result.patchNote = patch.reason ?? null
    writeFileSync(statePath, JSON.stringify({ lastVersion: current, backupAt: Date.now() }), 'utf8')
  } catch {}
  return result
}

/** 从 loader 树推导 profile 的 cordis.patch.yml 绝对路径。 */
function findPatchPath(ctx) {
  for (const entry of ctx.loader.entries()) {
    const cfg = entry.options?.config
    if (entry.options?.name !== 'cordis:include' || cfg == null || typeof cfg.path !== 'string') continue
    if (!cfg.path.includes('cordis.yml')) continue
    const configPath = fileURLToPath(new URL(cfg.path))
    return configPath.replace(/cordis\.yml$/u, 'cordis.patch.yml')
  }
  return defaultPatchPath()
}

/** profile 根目录（resolvePackageJson 的 fallbackBase 用；失败返回 null）。 */
function profileDirOf(ctx) {
  try {
    return dirname(findPatchPath(ctx))
  } catch {
    return null
  }
}

/** 框架版本检查缓存（功能包 → 框架 面板用；5 分钟 TTL，避免每次打开面板都打 registry）。 */
let fwCheckCache = null

/** 清理残留的框架升级/回滚/重启计划任务（脚本被强杀时它来不及自删）。
 *  v0.3.43：把「重启」与「重启守护」任务也纳入——2026-09-11 现场残留了 5 个 Ready 僵尸任务
 *  （DSH-Restart-13804 / -31688 / -3744 / RestartV2 / RestartV3），正是"重启后没人拉起"的证据。
 *  只在服务已经起来了的时候清理是安全的：服务在跑 ⇒ 守护任务无事可做（它自己也会立刻收工）。 */
function cleanupStaleFwTasks() {
  try {
    execFile('schtasks', ['/query', '/fo', 'CSV', '/nh'], { windowsHide: true, timeout: 20000 }, (error, stdout) => {
      if (error) return
      const names = String(stdout).split(/\r?\n/u)
        .map((line) => (line.match(/^"([^"]*)"/u)?.[1] ?? '').trim())
        .filter((name) => /^\\?DSH-(?:FW-(?:Upgrade|Rollback)|Restart(?:V\d+)?|RestartGuard)-\d+$/u.test(name))
      for (const name of names) {
        execFile('schtasks', ['/delete', '/f', '/tn', name], { windowsHide: true, timeout: 20000 }, () => {})
      }
    })
  } catch {}
}

/** 读取补丁文件并扫描：停用块与 insert 行的 id。 */
async function readPatchState(patchPath) {
  let text = ''
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const disables = []
  const forced = []
  const inserts = []
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^- insert:\s*$/u.test(line)) {
      inInsert = true
      continue
    }
    if (/^- /u.test(line)) inInsert = false
    if (inInsert) {
      const insertRow = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)/u)
      if (insertRow) inserts.push(insertRow[1])
      continue
    }
    const disableRow = line.match(/^- id: ([A-Za-z0-9_.-]+)\s*$/u)
    if (!disableRow) continue
    const next = lines[index + 1] ?? ''
    if (/^ {2}disabled: true\s*$/u.test(next)) disables.push(disableRow[1])
    else if (/^ {2}disabled: false\s*$/u.test(next)) forced.push(disableRow[1])
  }
  return { disables, forced, inserts, text }
}

/** include 前缀（加载器条目 id 形如 include:schedule，补丁行 id 为 schedule）。 */
function includePrefix(ctx) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.name === 'cordis:include') return `${entry.id}:`
  }
  return ''
}

/** 接受加载器条目 id 或行 id，返回补丁行 id。 */
function rowIdOf(ctx, entryId) {
  const prefix = includePrefix(ctx)
  if (prefix.length > 0 && entryId.startsWith(prefix)) return entryId.slice(prefix.length)
  return entryId
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 提取 README 的标题与开篇段落摘要（首个二级标题之前的正文）。 */
function summarizeReadme(text) {
  const lines = text.split(/\r?\n/u)
  let title = ''
  const intro = []
  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/u)
    if (heading) {
      if (title === '') {
        title = heading[2].trim()
        continue
      }
      break
    }
    if (title === '' && /^[-=]{3,}$/u.test(line.trim()) && line.trim() !== '') continue
    if (title === '') continue
    const cleaned = line
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/[`*_~]/gu, '')
      .trim()
    if (cleaned) intro.push(cleaned)
    if (intro.join(' ').length > 700) break
  }
  return { title, summary: intro.join(' ').trim().slice(0, 900) }
}

/** 读取一个已加载插件的 package.json 元信息与 README 摘要。 */
async function readPluginDetails(moduleName, baseUrl, profileDir) {
  if (typeof moduleName !== 'string' || moduleName.startsWith('cordis:')) return { meta: null, readme: null }
  try {
    const pkgPath = resolvePackageJson(moduleName, baseDirOf(baseUrl), profileDir ?? null)
    if (pkgPath === null) throw new Error('not found')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const meta = {
      name: moduleName,
      version: pkg.version ?? null,
      description: pkg.description ?? null,
      homepage: pkg.homepage ?? null,
      repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? null),
    }
    let readme = null
    for (const candidate of ['README.zh.md', 'README.md']) {
      try {
        const text = await readFile(join(dirname(pkgPath), candidate), 'utf8')
        readme = summarizeReadme(text)
        break
      } catch {}
    }
    return { meta, readme }
  } catch {
    return { meta: null, readme: null }
  }
}

function disableBlock(id) {
  return `- id: ${id}\n  disabled: true\n`
}

/**
 * 清理补丁文件中的顶层空数组占位符（issue #7 事故教训）：
 * DSH profile 模板的 cordis.patch.yml 以注释 + 顶层 `[]` 占位符初始化（如 `# ...\n[]`）。
 * 直接追加条目会生成 `[]` 后又跟 `- id: xxx` 的非法 YAML（同文档流里数组结束符 + 后续项），
 * 导致 dsh 启动解析崩溃。写入前必须移除顶层独立的 `[]` / `[ ]` 占位行。
 * 仅处理"整行就是空数组"的占位符；合法内容（如 `- insert:` 列表）不受影响。
 */
function sanitizePatchText(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*\[\s*\]\s*$/u.test(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\s+$/u, '') + '\n'
}

/** 停用：追加 disabled:true 块（已存在则不动）。 */
async function disableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, text } = await readPatchState(patchPath)
    if (disables.includes(id)) return { changed: false }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    await writeFile(patchPath, `${next}${disableBlock(id)}`, 'utf8')
    return { changed: true }
  })
}

/** 启用：移除 disabled:true 块；若仍被 bundle 停用则追加 disabled:false 覆盖。 */
async function enableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, forced, text } = await readPatchState(patchPath)
    const blockRe = new RegExp(`^- id: ${escapeRegExp(id)}\\r?\\n  disabled: true\\r?\\n`, 'mu')
    if (blockRe.test(text)) {
      await writeFile(patchPath, sanitizePatchText(text.replace(blockRe, '')), 'utf8')
      return { changed: true }
    }
    if (forced.includes(id)) return { changed: false }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    await writeFile(patchPath, `${next}- id: ${id}\n  disabled: false\n`, 'utf8')
    return { changed: true }
  })
}

/** 追加一条 insert 启用行（插件包需已安装到 profile）。 */
async function appendInsert(patchPath, entryId, packageName) {
  return queuedWrite(async () => {
    const { inserts, text } = await readPatchState(patchPath)
    if (inserts.includes(entryId)) return { changed: false }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    const block = `- insert:\n    - id: ${entryId}\n      name: '${packageName}'\n`
    await writeFile(patchPath, `${next}${block}`, 'utf8')
    return { changed: true }
  })
}

/** 包名 → 稳定的 entryId（去 scope、非字母数字转 -、查重加后缀）。 */
function deriveEntryId(packageName, taken) {
  const base = packageName
    .replace(/^@/u, '')
    .replace(/\//gu, '-')
    .replace(/[^A-Za-z0-9_-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 40) || 'plugin'
  if (!taken.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('无法为插件生成唯一的条目 id')
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 写请求跨站防护：浏览器同源策略不阻止跨站发送，必须校验 Origin / Sec-Fetch-Site。
 * 非浏览器客户端（无 Origin/Sec-Fetch-Site 头）仍允许，避免 curl/脚本/测试被误伤。 */
function isAllowedWriteOrigin(req, port) {
  const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : null
  const site = typeof req.headers?.['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : null
  if (origin !== null && origin !== '' && !ALLOWED_LOCAL_ORIGINS(port).has(origin)) return false
  if (site !== null && site !== 'same-origin' && site !== 'none') return false
  return true
}

function ALLOWED_LOCAL_ORIGINS(port) {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ])
}


function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendError(res, status, message, details) {
  sendJson(res, status, { ok: false, error: message, ...(details === undefined ? {} : { details }) })
}

async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 单次 https 请求；卡死的连接会在超时后被销毁。 */
function githubRequestOnce(url, { signal, accept, token, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: 'GET',
      headers: {
        'user-agent': GITHUB_UA,
        accept: accept ?? 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, resolve)
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error('GitHub 请求超时')))
    if (signal !== undefined) {
      if (signal.aborted) {
        req.destroy(new Error('请求已取消'))
        return
      }
      signal.addEventListener('abort', () => req.destroy(new Error('请求已取消')), { once: true })
    }
  })
}

/** api.github.com 的镜像竞速前缀（主通道黑洞期可用的兜底）。 */
const API_MIRROR_PREFIXES = [
  'https://ghproxy.net/https://api.github.com',
  'https://ghfast.top/https://api.github.com',
]

/** raw.githubusercontent.com 的镜像竞速前缀（与浏览器端四通道一致）。
 * 2026-09-19 移除 mirror.ghproxy.com：该域名早已失效（实测连接超时；失效域名被停放页接管时
 * 会回 2xx HTML —— 正是"普通插件被误判成 submodule 套装"的假阳性来源之一）。 */
const RAW_MIRROR_PREFIXES = [
  'https://ghproxy.net/https://raw.githubusercontent.com',
  'https://ghfast.top/https://raw.githubusercontent.com',
]

/** 并行竞速：任一分支拿到 2xx 即胜出；非 2xx 与错误都视为失败，全部失败则拒绝。 */
function raceFirst2xx(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length
    let done = false
    for (const promise of promises) {
      promise.then(
        (res) => {
          if (done) return
          const ok = res.statusCode === undefined || (res.statusCode >= 200 && res.statusCode < 300)
          if (ok) {
            done = true
            resolve(res)
            return
          }
          if (--pending === 0) reject(new Error(`HTTP ${res.statusCode}`))
        },
        () => {
          if (done) return
          if (--pending === 0) reject(new Error('GitHub 请求失败'))
        },
      )
    }
  })
}

/**
 * GitHub 公开元数据请求。用 node:https 而非全局 fetch，并跳过证书校验：
 * 国内网络环境的中间设备会注入不可信证书，全局 fetch 因此直接失败；
 * 本插件只经此通道拉取公开的仓库/包元数据，npm 安装本身仍走 registry 的
 * 完整 TLS 校验，所以这里放宽校验不会让安装环节失去 TLS 保护。
 *
 * 原逻辑保持不动：官方通道两次尝试（每次 20 秒，间隔 1.5 秒）。
 * 在此基础上新增并行分支：镜像（api/raw 各自前缀）同时竞速，15 秒封顶，
 * 任一分支先拿到 2xx 即胜出；全部失败时回退官方通道的最终错误。
 */
async function githubRequest(url, options) {
  const isApi = url.startsWith(GITHUB_API)
  const isRaw = url.startsWith(GITHUB_RAW)
  // ── 原逻辑：官方通道两次尝试 ──
  const official = (async () => {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500))
      try {
        return await githubRequestOnce(url, options)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('GitHub 请求失败')
  })()
  // ── 新增并行分支：镜像竞速（15 秒封顶；非 2xx 视为失败）──
  const prefixes = isApi ? API_MIRROR_PREFIXES : isRaw ? RAW_MIRROR_PREFIXES : []
  const mirrors = prefixes.map((prefix) => (async () => {
    const res = await githubRequestOnce(`${prefix}${url.slice(isApi ? GITHUB_API.length : GITHUB_RAW.length)}`, { ...options, timeout: 15000 })
    if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) throw new Error(`HTTP ${res.statusCode}`)
    return res
  })())
  try {
    return await raceFirst2xx([official, ...mirrors])
  } catch {
    // 全灭：回退官方通道的最终错误（保留原始报错语义）
    try {
      return await official
    } catch (error) {
      throw error
    }
  }
}

function collectBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', reject)
  })
}

/** gh CLI 通道：api.github.com 黑洞期（node:https 全部超时）时的最后兜底。
 * 服务进程 PATH 可能不含 gh（桌面壳环境）：依次尝试 gh、常见安装路径。 */
const GH_BIN_CANDIDATES = [
  'gh',
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
  join(homedir(), 'scoop', 'shims', 'gh.exe'),
]

/** gh CLI 通道。传 token 时用 GH_TOKEN/GITHUB_TOKEN 环境变量**覆盖 gh 的 keyring 凭据** ——
 * 这是"校验某个 token 是否有效"时唯一安全的用法：否则 gh 会拿本机已登录的身份作答，
 * 一个填错的 token 也会"验证成功"（详见 /github-login 路由里的说明）。 */
function githubViaGh(apiPath, token = null) {
  // 环境变量而不是命令行参数：token 不能出现在进程命令行（同机其他进程可见）
  const env = token === null ? undefined : { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token }
  return new Promise((resolve, reject) => {
    const attempt = (index) => {
      if (index >= GH_BIN_CANDIDATES.length) {
        reject(new Error('gh api 兜底失败：未找到 gh CLI'))
        return
      }
      execFile(GH_BIN_CANDIDATES[index], ['api', apiPath, '--jq', '.'], { windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024, ...(env === undefined ? {} : { env }) }, (error, stdout) => {
        if (error) {
          // ENOENT = 该路径不存在，继续下一个候选；其他错误（网络/认证）直接失败
          if (error.code === 'ENOENT') {
            attempt(index + 1)
            return
          }
          reject(new Error(`gh api 兜底失败：${error.message}`))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error('gh api 兜底返回的不是合法 JSON'))
        }
      })
    }
    attempt(0)
  })
}

async function githubJson(url, signal, token = null) {
  const apiPath = url.startsWith(GITHUB_API) ? url.slice(GITHUB_API.length) : null
  // https 主通道（官方重试+镜像并行）与 gh CLI **并行竞速**：黑洞期 gh 秒回，不再等 https 超时
  if (apiPath !== null) {
    const https = (async () => {
      const res = await githubRequest(url, { signal, token })
      const status = res.statusCode ?? 0
      if (status === 403 && Number(res.headers['x-ratelimit-remaining'] ?? '1') === 0) {
        throw new Error('GitHub 接口限流已用尽，请稍后再试')
      }
      const body = await collectBody(res)
      if (status < 200 || status >= 300) throw new Error(`GitHub 请求失败 (HTTP ${status})`)
      return JSON.parse(body)
    })()
    try {
      return await raceFirst2xx([https, githubViaGh(apiPath)])
    } catch (error) {
      try { return await https } catch (httpsError) { throw httpsError }
    }
  }
  const res = await githubRequest(url, { signal, token })
  const status = res.statusCode ?? 0
  if (status === 403 && Number(res.headers['x-ratelimit-remaining'] ?? '1') === 0) {
    throw new Error('GitHub 接口限流已用尽，请稍后再试')
  }
  const body = await collectBody(res)
  if (status < 200 || status >= 300) throw new Error(`GitHub 请求失败 (HTTP ${status})`)
  return JSON.parse(body)
}

async function githubText(url, signal, token = null) {
  const res = await githubRequest(url, { signal, accept: 'application/json', token })
  const status = res.statusCode ?? 0
  const body = await collectBody(res)
  if (status < 200 || status >= 300) return null
  return body
}

/**
 * 用**给定 token 专属**的通道取当前用户（GitHub 登录名校验用）。
 *
 * 为什么不能直接用 githubJson：它内部会与 gh CLI 通道并行竞速（raceFirst2xx），而 gh 默认用
 * 本机 keyring 里已有的凭据、完全忽略我们传入的 token —— 本机装着已登录的 gh 时，一个填错的
 * token 也会因 gh 通道 2xx 而"验证成功"（2026-09-20 实测：本机 gh 登录 Noob-stupid，ghp_aaa…
 * 拿到的是 Noob-stupid），于是错误 token 被写进 github-auth.json，顶掉用户真实登录态。
 *
 * 两条通道都只认用户给的这个 token（gh 走 GH_TOKEN 环境变量覆盖 keyring 凭据）：
 *   · https（官方 + 镜像）：通用主通道，无子进程
 *   · gh：node:https 被中间设备劫持时（本机实测 "unable to verify the first certificate"）
 *         的唯一可用通道 —— 少了它，本机贴对 token 也会被判成"令牌无效"
 * 两条通道认证的是同一个 token，所以谁先成功都等价；一旦某条给出 401/403（令牌本身不对），
 * 立刻采信，不等另一条慢超时。
 */
async function githubJsonUserWithToken(token) {
  const viaHttps = (async () => {
    const res = await githubRequest(`${GITHUB_API}/user`, { token })
    const status = res.statusCode ?? 0
    const body = await collectBody(res)
    // 与 githubJson 同一套错误语义：限流单独说明，其余只报 HTTP 状态（都不含 token）
    if (status === 403 && Number(res.headers['x-ratelimit-remaining'] ?? '1') === 0) {
      throw new Error('GitHub 接口限流已用尽，请稍后再试')
    }
    if (status < 200 || status >= 300) throw new Error(`GitHub 请求失败 (HTTP ${status})`)
    return JSON.parse(body)
  })()
  const attempts = [viaHttps, githubViaGh('/user', token)]
  return await new Promise((resolve, reject) => {
    let pending = attempts.length
    let firstError = null
    for (const attempt of attempts) {
      attempt.then(resolve, (error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (/HTTP (?:401|403)/u.test(message)) {
          reject(error)
          return
        }
        if (firstError === null) firstError = error
        pending -= 1
        if (pending === 0) reject(firstError)
      })
    }
  })
}

/** 用 curl 子进程请求 JSON（绕过本机中间设备对 node:https TLS 指纹的拦截；curl 走系统网络栈）。 */
async function curlJson(url, timeout = 15000, headers = {}, { ipv4 = false } = {}) {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const args = ['-s', '-m', String(Math.max(5, Math.ceil(timeout / 1000))), '-H', 'accept: application/json', '-w', '\n__HTTP__%{http_code}']
  // ipv4：只给 GitHub 域名用——「解析出 IPv6 但没有 IPv6 路由」的环境里 curl 默认要先空等 ~5.2s 才回退
  // IPv4（2026-09-20 另一位用户实测：默认 5473ms vs `-4` 的 461ms）；双栈正常的环境无副作用。
  if (ipv4) args.push('-4')
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`)
  args.push(url)
  const { stdout } = await execFileAsync(bin, args, { timeout: timeout + 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  const m = String(stdout).match(/\n__HTTP__(\d+)\s*$/u)
  const code = m ? Number(m[1]) : 0
  const body = m ? String(stdout).slice(0, m.index) : String(stdout)
  if (code !== 0 && (code < 200 || code >= 300)) throw new Error(`请求失败 (HTTP ${code})`)
  return JSON.parse(body)
}

/** 用 curl 拉取文本（raw 文件用：本机 curl 直连 raw.githubusercontent.com 秒回，绕开 node:https 黑洞）。
 * 导出供 test-suite-detect.mjs 断言传输层口径（200 空 body → 空串，404 → 抛 HTTP 404）。 */
export async function curlText(url, timeout = 10000, { ipv4 = false } = {}) {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const args = ['-s', '-m', String(Math.max(3, Math.ceil(timeout / 1000))), '-H', 'accept: text/plain', '-w', '\n__HTTP__%{http_code}']
  // 见 curlJson 注释：GitHub 域名走 IPv4 快通道（IPv6 无路由的环境下默认要白等 ~5.2s）
  if (ipv4) args.push('-4')
  args.push(url)
  const { stdout } = await execFileAsync(
    bin,
    args,
    { timeout: timeout + 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  )
  const m = String(stdout).match(/\n__HTTP__(\d+)\s*$/u)
  const code = m ? Number(m[1]) : 0
  const body = m ? String(stdout).slice(0, m.index) : String(stdout)
  if (code !== 0 && (code < 200 || code >= 300)) throw new Error(`HTTP ${code}`)
  return body
}

/** 任意 https JSON 接口（Gitee/自定义源用）：curl 优先、node:https 兜底；4xx/5xx 确定性失败直接抛出。 */
async function fetchJsonUrl(url, timeout = 15000, headers = {}) {
  let lastError
  const isHttps = /^https:\/\//u.test(url)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      return await curlJson(url, timeout, headers)
    } catch (error) {
      // HTTP 状态错误（4xx/5xx）是确定性失败：直接抛出，不重试、不走 node 兜底
      if (error instanceof Error && /^请求失败 \(HTTP \d+\)$/u.test(error.message)) throw error
      lastError = error
    }
    // node:https 兜底仅对 https 有效：私网 http 镜像只走 curl 通道，
    // 否则会抛出 "Protocol http: not supported" 掩盖 curl 的真实连接错误
    if (!isHttps) continue
    try {
      const res = await githubRequest(url, { headers })
      const status = res.statusCode ?? 0
      const body = await collectBody(res)
      if (status < 200 || status >= 300) throw new Error(`请求失败 (HTTP ${status})`)
      return JSON.parse(body)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('请求失败')
}

/** 平台搜索返回归一化（数组或 {items} 均可；兼容 GitHub/Gitee/自定义源字段）。 */
function normalizePlatformItems(data, fallbackBranch = 'main') {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : [])
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      fullName: String(item.full_name ?? item.path_with_namespace ?? item.name ?? '').trim(),
      description: item.description ?? '',
      htmlUrl: item.html_url ?? item.web_url ?? '',
      stars: item.stargazers_count ?? item.star_count ?? 0,
      updatedAt: item.updated_at ?? item.last_activity_at ?? '',
      defaultBranch: item.default_branch ?? fallbackBranch,
      topics: Array.isArray(item.topics) ? item.topics : [],
    }))
    .filter((item) => item.fullName !== '')
}

/** 探测仓库是否为技能仓库：根目录或第一层子目录存在 SKILL.md。
 * 返回 { hasSkill, skillDir }（skillDir 为相对仓库根的目录，'' 表示根）。
 * raw 双通道竞速，3 秒封顶，失败静默。 */
async function detectSkillRepo(repo, branch = 'main') {
  const branchEnc = encodeURIComponent(branch)
  try {
    const root = await Promise.any([
      curlText(`${GITHUB_RAW}/${repo}/${branchEnc}/SKILL.md`, 3000),
      curlText(`https://ghproxy.net/${GITHUB_RAW}/${repo}/${branchEnc}/SKILL.md`, 3000),
      curlText(`https://cdn.jsdelivr.net/gh/${repo}@${branchEnc}/SKILL.md`, 3000),
    ]).catch(() => null)
    if (root !== null) return { hasSkill: true, skillDir: '' }
    // 根没有时再查一层子目录（常用布局：skills/<name>/SKILL.md、<name>/SKILL.md）
    const tree = await curlJson(`https://api.github.com/repos/${repo}/git/trees/${branchEnc}?recursive=1`, 5000).catch(() => null)
    const skillPaths = (tree?.tree ?? [])
      .filter((n) => n.type === 'blob' && /(?:^|\/)SKILL\.md$/u.test(n.path))
      .map((n) => n.path)
    if (skillPaths.length > 0) {
      const dir = skillPaths[0].slice(0, -'SKILL.md'.length).replace(/\/$/u, '')
      return { hasSkill: true, skillDir: dir }
    }
  } catch {}
  return { hasSkill: false, skillDir: null }
}

/** 提取 SKILL.md frontmatter 摘要（name / description / whenToUse，与客户端 summarizeSkillFrontmatter 同规则）。 */
function summarizeSkillFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const fmEnd = text.indexOf('\n---', 3)
  if (fmEnd === -1) return null
  const fm = text.slice(3, fmEnd)
  const pick = (key) => {
    const re = new RegExp(`^${key}:\\s*(.*)$`, 'mu')
    const m = fm.match(re)
    if (!m) return ''
    const first = m[1].trim()
    if (first.startsWith('|')) {
      const rest = fm.slice(m.index + m[0].length)
      const lines = []
      for (const line of rest.split('\n')) {
        if (/^[a-zA-Z][\w-]*\s*:/u.test(line)) break
        const v = line.trim()
        if (v) lines.push(v)
        if (lines.join(' ').length > 240) break
      }
      return lines.join(' ').slice(0, 500)
    }
    return first.slice(0, 200)
  }
  const name = pick('name')
  const description = pick('description')
  const whenToUse = pick('whenToUse')
  if (!name && !description && !whenToUse) return null
  return { name, description, whenToUse }
}

/** 读取仓库 SKILL.md 的 frontmatter 摘要（raw 双通道，失败静默返回 null）。 */
async function fetchSkillMeta(repo, branch, skillDir) {
  try {
    const path = skillDir ? `${skillDir}/SKILL.md` : 'SKILL.md'
    const body = await rawTextWithFallback(repo, branch, path)
    if (body === null) return null
    return summarizeSkillFrontmatter(body)
  } catch {
    return null
  }
}

/** 批量识别搜索结果类型（官方 bundle / 聚合仓库 / 普通项目 / 技能仓库）。
 * 全部条目并发 + raw 主站与镜像双通道竞速，单条 4 秒封顶。
 * 聚合仓库（根包 private+workspaces）额外检查子包是否有 dsh.bundle 清单：
 * 任一子包可 `dsh plugin add` 直装 → aggregateInstallable = true（★ 筛选会包含它）。 */
const ENRICH_CACHE_FILE = () => join(dshHome(), 'plugin-console', 'enrich-cache.json')
const ENRICH_CACHE_TTL = 24 * 60 * 60 * 1000

function readEnrichCache() {
  try {
    const j = JSON.parse(readFileSync(ENRICH_CACHE_FILE(), 'utf8'))
    return j !== null && typeof j === 'object' ? j : {}
  } catch { return {} }
}
function writeEnrichCache(cache) {
  try {
    mkdirSync(dirname(ENRICH_CACHE_FILE()), { recursive: true })
    const entries = Object.entries(cache).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, 2000)
    writeFileSync(ENRICH_CACHE_FILE(), JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8')
  } catch {}
}

/** 单项识别：官方通道 / 聚合仓库 / 技能 / 套装（失败返回 official=null）。 */
async function enrichItemOne(item) {
  let official = /^deepseek-ai\//u.test(item.fullName ?? '') ? true : null
  let aggregate = false
  let aggregateInstallable = false
  let hasSkill = false
  let hasSuite = false
  try {
    const branch = item.defaultBranch ?? 'main'
    const base = `https://raw.githubusercontent.com/${item.fullName}/${encodeURIComponent(branch)}/package.json`
    const [pkgResult, skillResult, suiteResult] = await Promise.allSettled([
      Promise.any([
        curlText(base, 4000),
        curlText(`https://ghproxy.net/${base}`, 4000),
      ]),
      detectSkillRepo(item.fullName, branch),
      rawTextWithFallback(item.fullName, branch, '.gitmodules'),
    ])
    // 套装判定必须过内容校验：代理/CDN 对不存在的 .gitmodules 也可能回 2xx 空 body，
    // 只判"探测非 null"会把普通插件标成套装置仓库（2026-09-19 事故）。
    if (suiteResult.status === 'fulfilled' && looksLikeGitmodules(suiteResult.value)) {
      hasSuite = true
    }
    if (pkgResult.status === 'fulfilled') {
      const pkg = JSON.parse(pkgResult.value)
      if (typeof pkg.dsh?.bundle?.patch === 'string') {
        official = true
      } else {
        // 成功读到 package.json 且没有 dsh.bundle.patch → 确定「非官方」。
        // 必须落成 false（而不是留 null），否则缓存条件 official !== null 永不成立，
        // 每个非官方插件每次打开都重新请求 → /enrich 缓存命中也要十几秒。
        official = false
        if (pkg.private === true && (Array.isArray(pkg.workspaces) || /(^|-)dsh[-/]/u.test(String(pkg.name ?? '')))) {
          aggregate = true
          try {
            const tree = await curlJson(`https://api.github.com/repos/${item.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`, 6000)
            const pkgPaths = (tree.tree ?? [])
              .filter((n) => n.type === 'blob' && /^packages\/[^/]+\/package\.json$/u.test(n.path))
              .map((n) => n.path)
              .slice(0, 12)
            if (pkgPaths.length > 0) {
              const subs = await Promise.all(pkgPaths.map((p) => curlText(`https://raw.githubusercontent.com/${item.fullName}/${encodeURIComponent(branch)}/${p}`, 4000)
                .then((t) => { try { return JSON.parse(t) } catch { return null } })
                .catch(() => null)))
              if (subs.some((sp) => sp && typeof sp.dsh?.bundle?.patch === 'string')) {
                aggregateInstallable = true
              }
            }
          } catch {}
        }
      }
    }
    if (skillResult.status === 'fulfilled' && skillResult.value?.hasSkill === true) {
      hasSkill = true
    }
  } catch {}
  return { ...item, official, aggregate, aggregateInstallable, hasSkill, hasSuite }
}

/**
 * 批量识别（★ 筛选数据源）：并发限流 + 24h 结果缓存。
 * 网络黑洞期（raw.githubusercontent 大部分拉取失败）自动回退缓存中的上次判定，
 * 保证「只看官方」不因瞬时网络而坍缩成 0/1 条。
 */
async function enrichItems(items) {
  const cache = readEnrichCache()
  const out = new Array(items.length)
  let next = 0
  let cacheDirty = false
  async function worker() {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) return
      const item = items[i]
      const key = `${item.fullName}@${item.defaultBranch ?? 'main'}`
      const cached = cache[key]
      try {
        // official 已判定（true/false）→ 24h 缓存；判定失败（null）→ 1h 短缓存，减少无谓重试
        if (cached !== undefined && typeof cached?.at === 'number' && cached.data) {
          const ttl = cached.data.official === null ? 60 * 60 * 1000 : ENRICH_CACHE_TTL
          if (Date.now() - cached.at < ttl) {
            out[i] = { ...item, ...cached.data }
            continue
          }
        }
        let result = await enrichItemOne(item)
        // 本次失败 → 回退缓存（哪怕已过期），避免「看天吃饭」
        if ((result.official === null && !/^deepseek-ai\//u.test(item.fullName ?? '')) && cached?.data) {
          result = { ...item, ...cached.data }
        } else {
          cache[key] = { at: Date.now(), data: { official: result.official, aggregate: result.aggregate, aggregateInstallable: result.aggregateInstallable, hasSkill: result.hasSkill, hasSuite: result.hasSuite } }
          cacheDirty = true
        }
        out[i] = result
      } catch {
        // 抛错的条目也必须写缓存（null 结果 + 1h 短 TTL），否则每次打开都重试同一批，
        // /enrich 即使「命中缓存」也要等十几秒。
        if (cached?.data) {
          out[i] = { ...item, ...cached.data }
        } else {
          const miss = { official: null, aggregate: false, aggregateInstallable: false, hasSkill: false, hasSuite: false }
          cache[key] = { at: Date.now(), data: miss }
          cacheDirty = true
          out[i] = { ...item, ...miss }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, worker))
  if (cacheDirty) writeEnrichCache(cache)
  return out
}

function githubRepoInfo(repo) {
  const match = String(repo).trim().match(/^(?:https:\/\/github\.com\/|https:\/\/gitee\.com\/|git@github\.com:|git@gitee\.com:)?([^\s\/?#]+)\/([^\s\/?#]+?)(?:\.git)?$/u)
  if (!match) throw new Error('仓库名格式应为 owner/name（支持完整仓库 URL 与中文路径）')
  return `${match[1]}/${match[2]}`
}

/** 「真的读到了文件内容」判定：null / 空串 / 纯空白都不算。导出供 test-suite-detect.mjs 断言。
 * 真实事故（2026-09-19，用户反馈装 dsh-whale-widget 报「未找到 .gitmodules」）：
 * 本机加速器/代理（Watt Toolkit 之类，劫持 raw.githubusercontent.com 到 127.0.0.1）
 * 会对**不存在的文件**回 2xx + 空 body；旧代码只判 `body === null`，
 * 于是空串被当成"文件存在" → 普通插件被判定成 submodule 套装置仓库 → 安装必然失败。 */
export function readBodyOrNull(body) {
  return typeof body === 'string' && body.trim() !== '' ? body : null
}

/** .gitmodules 内容校验：必须是真 gitmodules（含 [submodule "x"] 段）才算套装仓库。导出供测试。
 * 只判"探测非 null"会把代理/CDN 的垃圾响应也算成套装；判定权交给内容，不交给状态码。 */
export function looksLikeGitmodules(text) {
  return typeof text === 'string' && /^\s*\[submodule\s+"/mu.test(text)
}

/** raw 抓取外层预算（毫秒）。事件（2026-09-20，另一位用户：Android + proot Ubuntu 容器，域名解析出
 * IPv6 但容器无 IPv6 路由）：4 条通道最快也要 5.4s（curl 直连被 -m 6 掐死、node:https 5435ms、
 * jsDelivr 5564ms），旧的 5000ms 预算**必然先超时** → 抓取失败被当成"文件不存在"，
 * 报成「仓库没有 package.json」。放宽到 10s：真 404 仍是毫秒级返回，只有全网慢时才多等。 */
export const FETCH_BUDGET_MS = 10000
/** 仓库元数据（默认分支）探测预算：旧值 3s 在同一环境下同样必输 → branch 恒为 'main'，
 * 默认分支为 dev 的仓库会取错分支。 */
export const META_BUDGET_MS = 8000
export const FETCH_OK = 'ok'
export const FETCH_NOT_FOUND = 'not-found'
export const FETCH_UNREACHABLE = 'unreachable'

/** 竞速组合（纯逻辑，导出供单测）：通道结果 + 预算 → { state, body }。
 * · anyPromise 以 null 成功 = 某通道确定性 404 → not-found
 * · anyPromise 以字符串成功 = 读到内容 → ok
 * · anyPromise 全部失败（AggregateError）或超出预算 → unreachable（**不再与 404 混为一谈**） */
export function raceFetchOutcome(anyPromise, budgetMs) {
  const settled = Promise.resolve(anyPromise)
    .then((body) => (body === null ? { state: FETCH_NOT_FOUND, body: null } : { state: FETCH_OK, body }))
    .catch(() => ({ state: FETCH_UNREACHABLE, body: null }))
  return Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve({ state: FETCH_UNREACHABLE, body: null }), budgetMs)),
  ])
}

/** raw 文件读取：https 主通道（含镜像）、gh CLI、curl 直连、curl jsDelivr CDN **四通道并行竞速**。
 * 黑洞期 https/ghproxy 全挂、gh 可能不在服务进程 PATH——jsDelivr CDN 走系统网络且国内可达，是最后兜底。
 * 关键语义：**404 是确定性结果**（文件不存在，探测 .gitmodules/SKILL.md 等时的正常答案），
 * 必须立即返回 null，不能等其它分支（黑洞期 https 通道 20s+ 才失败会拖死整个请求）。
 * 返回值区分「确定性 404」与「超时/通道全灭」——二者都以"没内容"结束，但用户文案必须不同。 */
async function rawTextFetch(repo, branch, path, budgetMs = FETCH_BUDGET_MS) {
  const url = `${GITHUB_RAW}/${repo}/${encodeURIComponent(branch)}/${path}`
  // 404/4xx：确定性"不存在"，立即以 null 胜出（不等慢分支）
  const notFound = (promise) => promise
    .catch((error) => {
      if (error instanceof Error && /HTTP 404|HTTP 400|Not Found|not found|非 2xx|HTTP 非 2xx/u.test(error.message)) return null
      throw error
    })
  // 各通道统一口径：状态 2xx **且** body 非空白，才算读到文件（否则抛"非 2xx" → 归一为 null）
  const real = (promise) => promise.then((body) => {
    const text = readBodyOrNull(body)
    if (text === null) throw new Error('HTTP 非 2xx')
    return text
  })
  const https = notFound(real(githubText(url)))
  const gh = notFound(githubViaGh(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`)
    .then((data) => {
      if (data && typeof data.content === 'string') return Buffer.from(data.content, 'base64').toString('utf8')
      throw new Error('contents 无内容')
    })
    .then((text) => {
      const body = readBodyOrNull(text)
      if (body === null) throw new Error('contents 无内容')
      return body
    }))
  const curl = notFound(real(curlText(url, 9000, { ipv4: true })))
  const cdn = notFound(real(curlText(`https://cdn.jsdelivr.net/gh/${repo}@${encodeURIComponent(branch)}/${path}`, 9000, { ipv4: true })))
  return await raceFetchOutcome(Promise.any([https, gh, curl, cdn]), budgetMs)
}

/** 兼容入口：调用方只关心"有没有内容"（null = 没有）。需要区分超时/404 的场景用 rawTextFetch。 */
async function rawTextWithFallback(repo, branch, path) {
  const { state, body } = await rawTextFetch(repo, branch, path)
  return state === FETCH_OK ? body : null
}

/** 包探测（带失败原因）：reason ∈ ok / not-found / unreachable / invalid。导出供测试。
 * 事故（2026-09-20，另一位用户：Android + proot Ubuntu，容器无 IPv6 路由）：
 * 抓取超时与真 404 都让上层拿到同一个 null，于是「网络太慢」被报成「仓库没有 package.json」。 */
async function fetchRepoPackageEx(repo, branch) {
  const { state, body } = await rawTextFetch(repo, branch, 'package.json')
  if (state !== FETCH_OK) return { pkg: null, reason: state }
  try {
    const pkg = JSON.parse(body)
    if (pkg !== null && typeof pkg === 'object' && typeof pkg.name === 'string') return { pkg, reason: 'ok' }
  } catch {}
  return { pkg: null, reason: 'invalid' }
}

async function fetchRepoPackage(repo, branch) {
  return (await fetchRepoPackageEx(repo, branch)).pkg
}

/** 从 npm 的 repository 字段解析出 GitHub/Gitee 仓库标识（纯函数，单测覆盖）。
 * 支持 `https://github.com/o/r.git`、`git+https://…`、`git://…`、带 `#path` 的 monorepo 写法。 */
export function parseRepoFromUrl(url) {
  const raw = String(url ?? '').trim()
  // npm 老式简写：`github:owner/repo` / `gitee:owner/repo`
  const shorthand = raw.match(/^(?:github|gitee):([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/u)
  if (shorthand !== null) return `${shorthand[1]}/${shorthand[2]}`
  const m = raw.match(/(?:github\.com|gitee\.com)[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/u)
  if (m === null) return null
  return `${m[1]}/${m[2]}`
}

/** 结果里是否已有"名字逐词命中查询词"的条目——决定要不要再加 `in:readme` 重查一次。
 * （仓库搜索的检索面只有 名字/描述/topics；README 里的词必须显式 in:readme 才查得到） */
export function hasDirectNameHit(items, query) {
  const tokens = String(query ?? '').toLowerCase().split(/[\s\-_/.]+/u).filter((tk) => tk.length >= 3)
  if (tokens.length === 0) return true // 查询太短/太泛：不做二次查询，避免把结果冲稀
  return items.some((it) => {
    const name = String(it?.fullName ?? '').toLowerCase()
    return tokens.every((tk) => name.includes(tk))
  })
}

/** npm 包名搜索：registry 搜索接口 → 候选包 → 读 packument 的 repository.url → 映射回 GitHub 仓库。
 * 背景（2026-09-20）：用户搜 `web-all`（= npm 包 `@linxin666/dsh-web-all`）搜不到，因为 `web-all`
 * 只存在于 npm 包名、仓库文件与 README 里，而 GitHub 仓库搜索的检索面只有 名字/描述/topics。
 * 这条通道不依赖静态索引、也不依赖 GitHub 登录，且命中后可按包名直接安装。 */
export async function searchNpmPackages(query, registries, limit = 3, token = null) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q.length < 2) return []
  let hits = null
  let registry = null
  for (const reg of (registries ?? []).slice(0, 3)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await fetchJsonUrl(`${reg}/-/v1/search?text=${encodeURIComponent(q)}&size=10`, 8000)
      if (data && Array.isArray(data.objects)) { hits = data.objects; registry = reg; break }
    } catch {}
  }
  if (hits === null) return []
  const candidates = hits
    .map((o) => o?.package)
    .filter((p) => p && typeof p.name === 'string' && p.name.toLowerCase().includes(q))
    .slice(0, limit)
  const out = []
  for (const cand of candidates) {
    try {
      const encoded = cand.name.startsWith('@')
        ? `@${encodeURIComponent(cand.name.slice(1).split('/')[0])}%2f${encodeURIComponent(cand.name.split('/').slice(1).join('/'))}`
        : encodeURIComponent(cand.name)
      // eslint-disable-next-line no-await-in-loop
      const meta = await fetchJsonUrl(`${registry}/${encoded}`, 8000)
      const repo = parseRepoFromUrl(meta?.repository?.url ?? meta?.repository ?? cand.links?.repository ?? '')
      if (repo === null) continue
      // 顺带补仓库真实元数据（星数/描述/默认分支）——npm 里的信息不足，且默认分支可能是 dev
      let info = null
      try {
        // eslint-disable-next-line no-await-in-loop
        info = await githubJson(`${GITHUB_API}/repos/${repo}`, null, token)
      } catch {}
      out.push({
        fullName: repo,
        description: `${info?.description ?? cand.description ?? ''}（npm 包：${cand.name}@${cand.version ?? '?'}）`.trim(),
        htmlUrl: info?.html_url ?? `https://github.com/${repo}`,
        stars: typeof info?.stargazers_count === 'number' ? info.stargazers_count : 0,
        updatedAt: info?.updated_at ?? '',
        defaultBranch: info?.default_branch ?? null,
        topics: Array.isArray(info?.topics) ? info.topics : [],
        source: 'npm',
        sourceName: 'npm',
        packageName: cand.name,
        npmVersion: cand.version ?? null,
        npmPackage: true,
      })
    } catch {}
  }
  return out
}

/** monorepo 子包增强：GitHub 代码搜索（`<词> filename:package.json`）→ 命中 `packages/<包>/package.json`
 * → 读该 package.json 取真实包名 → 作为子包条目返回（这样 `dsh-web-all`、OpenViking 这类
 * 「只存在于仓库文件里的包名」也能被搜到，且带 packageName 可直接按包名安装）。
 * ⚠️ GitHub **代码搜索 API 强制要求登录**（未登录实测 401 Requires authentication），未登录时返回空。 */
export async function searchSubpackageItems(query, token = null, signal = null) {
  const subItems = []
  try {
    const codeData = await githubJson(
      `${GITHUB_API}/search/code?q=${encodeURIComponent(`${query} filename:package.json`)}`,
      signal,
      token,
    )
    for (const hit of (codeData.items ?? []).slice(0, 10)) {
      const hitPath = typeof hit.path === 'string' ? hit.path : ''
      if (!/^(?:packages|examples|plugins|skills|apps|extensions|src|lib)\/[^/]+\/package\.json$/u.test(hitPath)) continue
      const repoName = hit.repository?.full_name ?? ''
      if (!repoName) continue
      const dir = hitPath.split('/').slice(0, -1).join('/')
      let packageName = dir.split('/').slice(-1)[0]
      try {
        // eslint-disable-next-line no-await-in-loop
        const pkgText = await rawTextWithFallback(repoName, 'main', hitPath)
        if (pkgText !== null) {
          const pkg = JSON.parse(pkgText)
          if (pkg && typeof pkg.name === 'string') packageName = pkg.name
        }
      } catch {}
      subItems.push({
        fullName: repoName,
        description: `子包：${dir}`,
        htmlUrl: `https://github.com/${repoName}/tree/main/${dir}`,
        stars: 0,
        updatedAt: '',
        defaultBranch: 'main',
        topics: [],
        source: 'github',
        subpackagePath: dir,
        packageName,
      })
      if (subItems.length >= 5) break
    }
  } catch {}
  return subItems
}

/** 探测失败时的用户可读文案：「抓取超时/不可达」与「真的没有」必须区分开。导出供测试。 */
export function packageProbeErrorText(repo, branch, reason) {
  if (reason === FETCH_UNREACHABLE) {
    return `抓取超时/网络不可达：没能读到 ${repo}（${branch} 分支）的 package.json —— 通常是网络到 GitHub 太慢（例如解析出 IPv6 却无 IPv6 路由）。请重试；若持续失败，可先用「仓库落地」克隆到本地目录。`
  }
  if (reason === 'invalid') {
    return `仓库 ${repo} 的 package.json 不是合法的包描述（缺少 name 字段），无法作为插件安装——可改用「仓库落地」克隆到本地目录。`
  }
  return `仓库 ${repo} 没有 package.json（也不是技能仓库），无法作为插件安装——可改用「仓库落地」克隆到本地目录。`
}

/**
 * 插件安装：与官方 `dsh plugin add` 使用同一管理器——corepack → pnpm add。
 * profile 目录由 pnpm 管理；若用 npm 写入会与 pnpm 的目录重建互相破坏
 * （曾导致入口链接丢失、DSH 启动崩溃）。registry 走国内镜像。
 */
export async function pnpmInstall(profileDir, spec, registry = 'https://registry.npmmirror.com', timeout = 90000, signal = null) {
  const args = ['add', spec, '--registry', registry]
  const opts = {
    cwd: profileDir,
    timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      COREPACK_NPM_REGISTRY: registry,
      // git 通道禁止交互式凭据：避免 Git Credential Manager 弹登录窗（匿名失败即静默失败）
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    },
  }
  // 跨平台定位 corepack/pnpm（Windows 布局 / Linux npm 全局布局 / PATH 兜底）；
  // 旧代码只认 Windows 布局，Linux 上会生成 MODULE_NOT_FOUND 的命令（2026-09-20 事故）
  await runPnpmWithFallback(args, { execOpts: opts })
}

/**
 * curl 手动安装通道：node 网络黑洞（pnpm 下载卡死：socket hang up / TIMEOUT / downloaded 0）时，
 * curl 与系统 tar 仍可用——用 curl 下载 registry tarball、解压到 profile 的 node_modules。
 * 零依赖包可完整安装；带依赖包记录未补齐列表（不阻塞，供面板提示）。
 * 返回 { version, missingDeps }；失败抛错由调用方落入 next 通道。
 */
async function curlManualInstall(profileDir, packageName, registries, signal = null, exactVersion = null) {
  let meta = null
  let metaError = null
  for (const reg of registries) {
    try {
      const encoded = packageName.startsWith('@')
        ? `@${encodeURIComponent(packageName.slice(1).split('/')[0])}%2f${encodeURIComponent(packageName.split('/').slice(1).join('/'))}`
        : encodeURIComponent(packageName)
      meta = await fetchJsonUrl(`${reg}/${encoded}`)
      if (meta) break
    } catch (error) {
      metaError = error
    }
  }
  if (!meta || typeof meta !== 'object') throw new Error(`curl 通道：无法获取 registry 元数据（${metaError?.message ?? '未知'}）`)
  const version = exactVersion ?? meta['dist-tags']?.latest ?? null
  const tarball = version ? meta.versions?.[version]?.dist?.tarball ?? null : null
  if (!version || !tarball) throw new Error('curl 通道：registry 无 dist-tags.latest / tarball')
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const tmp = join(tmpdir(), `pc-curl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(tmp, { recursive: true })
  try {
    const tgz = join(tmp, 'pkg.tgz')
    await execFileAsync(bin, ['-s', '-L', '-m', '60', '-o', tgz, tarball], { timeout: 70000, windowsHide: true, ...(signal ? { signal } : {}) })
    await execFileAsync('tar', ['-xzf', tgz, '-C', tmp], { timeout: 30000, windowsHide: true, ...(signal ? { signal } : {}) })
    let pkgPath = join(tmp, 'package')
    if (!existsSync(join(pkgPath, 'package.json'))) {
      const candidates = readdirSync(tmp, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(tmp, d.name))
      pkgPath = candidates.find((p) => existsSync(join(p, 'package.json'))) ?? pkgPath
    }
    if (!existsSync(join(pkgPath, 'package.json'))) throw new Error('curl 通道：解压后未找到含 package.json 的目录')
    // 盒子实验：解压后先验证，通过才覆盖正式位置（失败保留旧版本，服务不中断）
    const box = verifyPackageBox(pkgPath, profileDir, packageName)
    const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
    const missingDeps = Object.keys(deps).filter((d) => !existsSync(join(profileDir, 'node_modules', d)))
    const target = join(profileDir, 'node_modules', packageName)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    copyTree(pkgPath, target)
    // 落真实安装时间标记：npm tarball 内文件 mtime 是固定时间戳（1985-10-26，可复现构建），
    // 解压后 package.json 的 mtime 不可靠，面板安装日期优先读此标记
    try {
      writeFileSync(join(target, '.dsh-installed-at'), String(Date.now()), 'utf8')
    } catch {}
    return { version, missingDeps, boxNote: box.note }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 安装通道并行竞速：pnpm 与 curl 同时尝试，先成功者生效；失败方被 abort 不干扰。 */
async function raceInstallChannels(profileDir, name, registries) {
  const controller = new AbortController()
  const signal = controller.signal
  const pnpmTask = (async () => {
    let lastError = null
    for (const registry of registries) {
      try {
        await pnpmInstall(profileDir, name, registry, 90000, signal)
        return { channel: 'pnpm', info: null }
      } catch (error) {
        lastError = error
        if (signal.aborted) throw error
      }
    }
    throw lastError ?? new Error('pnpm 通道失败')
  })()
  const curlTask = (async () => {
    const info = await curlManualInstall(profileDir, name, registries, signal)
    return { channel: 'curl', info }
  })()
  const waitSuccess = (promise) => promise.then((value) => ({ value }), () => new Promise(() => {}))
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 120000))
  const winner = await Promise.race([waitSuccess(pnpmTask), waitSuccess(curlTask), timeout])
  controller.abort()
  return winner ? winner.value : null
}

/**
 * 盒子实验验证：解压后的包目录先通过静态校验再允许覆盖正式位置。
 * - package.json 必须可解析且 name 与安装目标一致
 * - main / exports 入口文件必须真实存在（防"装上了但加载即崩"）
 * - bundle patch（cordis.patch.yml）引用的包必须已就位（防聚合包引用缺失崩溃）
 * 失败抛错 → 调用方保留旧版本（安装不中断服务）。
 */
function verifyPackageBox(pkgPath, profileDir, packageName, refCheckRoot = null) {
  const note = []
  const pkgRaw = readFileSync(join(pkgPath, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw)
  if (pkg.name !== packageName) {
    throw new Error(`盒子验证失败：包名不符（tarball 内为 ${pkg.name}，期望 ${packageName}），已保留旧版本`)
  }
  // 入口存在性：main 字段 / exports.'.'（字符串或对象 default）指向的文件必须存在
  let entry = typeof pkg.main === 'string' ? pkg.main : null
  if (entry === null && pkg.exports && typeof pkg.exports === 'object') {
    const dot = pkg.exports['.'] ?? pkg.exports['./package.json'] === undefined ? pkg.exports['.'] : null
    if (typeof dot === 'string') entry = dot
    else if (dot && typeof dot === 'object') entry = typeof dot.default === 'string' ? dot.default : null
  }
  if (entry !== null) {
    const entryPath = join(pkgPath, ...entry.split('/'))
    if (!existsSync(entryPath)) {
      throw new Error(`盒子验证失败：入口文件缺失（${entry}），已保留旧版本`)
    }
  }
  // bundle patch 引用预检：引用的包必须已存在于目标 node_modules（防聚合包半更新崩溃）。
  // refCheckRoot 指定检查根（宿主插件在根层 node_modules，与 profile 层不同）。
  const checkRoot = refCheckRoot ?? join(profileDir, 'node_modules')
  try {
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel === 'string') {
      const bundlePatch = join(pkgPath, patchRel)
      if (existsSync(bundlePatch)) {
        const refs = parseBundlePatchRefs(readFileSync(bundlePatch, 'utf8'))
        const missingRefs = refs.filter((r) => !existsSync(join(checkRoot, r.name)))
        if (missingRefs.length > 0) {
          note.push(`bundle 引用缺失：${missingRefs.map((r) => r.name).join('、')}（安装后由聚合完整性检查补齐/禁用）`)
        }
        if (refs.length > 0) note.push(`bundle 引用 ${refs.length} 个已就位`)
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('盒子验证失败')) throw error
  }
  return { note: note.length > 0 ? note.join('；') : null }
}

/** 解析 bundle patch（cordis.patch.yml）的 insert 引用列表（id + 包名）。 */
function parseBundlePatchRefs(text) {
  const refs = []
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
    if (/^- /u.test(line) && !/^ {4}- /u.test(line)) inInsert = false
    if (!inInsert) continue
    const idM = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
    if (!idM) continue
    const nameM = (lines[i + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
    if (nameM) refs.push({ id: idM[1], name: nameM[1] })
  }
  return refs
}

/**
 * 捆绑依赖补装（事故教训：dsh-web-ui-all 更新后 17 个捆绑依赖缺失 → 服务加载崩溃）：
 * curl/GitHub 通道只解压主包，这里逐个补装直接依赖（pnpm → curl 依次尝试）。
 * 返回仍缺失的依赖列表。
 * 安全护栏（事故教训）：@deepseek-ai/* 框架内部包**绝不补装**——它们由框架依赖树管理
 * （正确版本随 @deepseek-ai/dsh 一起安装），npm 上这些内部包的 dist-tags.latest 是远古
 * 版本（如 dsh-host-webserver@0.0.1-rc.1），无版本约束补装会覆盖框架正确版本，
 * 导致 webServer 等服务起不来、整个 profile 启动崩溃。
 */
async function backfillMissingDeps(profileDir, deps, registries) {
  const stillMissing = []
  for (const dep of deps) {
    if (/^@deepseek-ai\//u.test(dep)) continue // 框架内部包：跳过（宿主提供）
    if (existsSync(join(profileDir, 'node_modules', dep))) continue
    let ok = false
    try {
      await pnpmInstall(profileDir, dep, registries[0], 60000)
      ok = existsSync(join(profileDir, 'node_modules', dep))
    } catch {}
    if (!ok) {
      try {
        await curlManualInstall(profileDir, dep, registries)
        // 判断目标是否实际安装（修复：旧代码用 depInfo.missingDeps.length===0 判断
        // "该依赖自身无依赖"，只要目标依赖带依赖就误报缺失——即使 curl 已成功安装）
        ok = existsSync(join(profileDir, 'node_modules', dep))
      } catch {}
    }
    if (!ok) stillMissing.push(dep)
  }
  return stillMissing
}

/**
 * GitHub release 下载安装通道（npm 上不存在的包，例如面板自身 @deepseek-ai/dsh-plugin-console）：
 * 拉取仓库 latest release 源码 tarball → 盒子验证 → 覆盖 node_modules 正式位置。
 * 宿主插件特判：本面板部署在宿主根层 node_modules（import.meta.url 解析），更新时覆盖根层而非 web profile。
 */
async function githubReleaseInstall(profileDir, repo, packageName) {
  const auth = readGithubAuth()
  const headers = { 'User-Agent': 'dsh-plugin-console' }
  if (auth.token) headers.Authorization = `token ${auth.token}`
  const release = await fetchJsonUrl(`https://api.github.com/repos/${repo}/releases/latest`, 15000, headers)
  const tag = typeof release?.tag_name === 'string' ? release.tag_name : null
  if (tag === null) throw new Error('GitHub 通道：仓库没有 latest release（版本发布后才可更新）')
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const tmp = join(tmpdir(), `pc-gh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(tmp, { recursive: true })
  try {
    const tgz = join(tmp, 'pkg.tgz')
    // codeload 官方源码 tarball（已验证本机可用 200）。GitHub 黑洞期由上层通道兜底
    // （pnpm/git 通道），此处失败即报错保留旧版本。
    await execFileAsync(bin, ['-s', '-L', '-m', '60', '-o', tgz, `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`], { timeout: 70000, windowsHide: true })
    if (!existsSync(tgz) || statSync(tgz).size < 100) throw new Error(`GitHub 通道：下载源码 tarball 失败（${repo}@${tag}）`)
    await execFileAsync('tar', ['-xzf', tgz, '-C', tmp], { timeout: 60000, windowsHide: true })
    // 源码 tarball 顶层目录名是 {repo}-{sha}：定位含 package.json 的顶层目录
    const subdirs = readdirSync(tmp, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(tmp, d.name))
    const pkgPath = subdirs.find((d) => existsSync(join(d, 'package.json')))
    if (!pkgPath) throw new Error('GitHub 通道：tarball 内未找到 package.json')
    // 目标位置：宿主插件（面板自身，部署在宿主根层 node_modules）→ 覆盖自身所在目录；
    // 普通插件 → profile node_modules
    let targetRoot = join(profileDir, 'node_modules')
    try {
      const selfDir = dirname(dirname(fileURLToPath(import.meta.url))) // 自身包目录（含 package.json）
      const selfRoot = dirname(selfDir) // 自身包所在 node_modules
      if (selfRoot !== targetRoot && existsSync(join(selfDir, 'package.json'))) {
        targetRoot = selfRoot
      }
    } catch {}
    // 盒子实验：静态验证通过才覆盖（失败保留旧版本）。引用检查根用目标目录（宿主插件在根层）
    const box = verifyPackageBox(pkgPath, profileDir, packageName, targetRoot)
    const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'))
    // 只统计 dependencies（peerDependencies 是宿主契约，不补装——见 curlManualInstall 注释）
    const deps = { ...(pkg.dependencies ?? {}) }
    const missingDeps = Object.keys(deps).filter((d) => !existsSync(join(profileDir, 'node_modules', d)))
    const target = join(targetRoot, packageName)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    copyTree(pkgPath, target)
    // 版本号对齐（防死循环）：release tarball 内 package.json version 可能滞后于 tag
    // （历史发布只打 tag 不改 version），改写为 tag 版本 → 下次检测 latest===current → "已是最新"
    try {
      const targetPkgPath = join(target, 'package.json')
      const targetPkg = JSON.parse(readFileSync(targetPkgPath, 'utf8'))
      const tagVersion = tag.replace(/^v/iu, '')
      if (targetPkg.version !== tagVersion) {
        targetPkg.version = tagVersion
        writeFileSync(targetPkgPath, JSON.stringify(targetPkg, null, 4), 'utf8')
      }
    } catch {}
    try {
      writeFileSync(join(target, '.dsh-installed-at'), String(Date.now()), 'utf8')
    } catch {}
    return { version: tag.replace(/^v/iu, ''), missingDeps, boxNote: box.note, source: 'github' }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 聚合包完整性保障（事故教训）：dsh-web-ui-all 更新后捆绑依赖缺失，其 bundle patch
 * （cordis.patch.yml）引用的包未安装 → 服务加载崩溃。
 * 读已装包的 bundle patch → 检查每个 insert 引用的包是否存在 → 缺失补装（pnpm/curl）→
 * 仍缺则在用户 patch 层自动禁用该行（防崩兜底）+ 返回报告供面板提示。
 */
/** 读取聚合包 cordis.patch.yml 的 insert 行 name 列表（注册前校验用）。 */
function readBundlePatchRefNames(profileDir, pkgName) {
  try {
    const pkgJsonPath = join(profileDir, 'node_modules', pkgName, 'package.json')
    if (!existsSync(pkgJsonPath)) return []
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel !== 'string') return []
    const text = readFileSync(join(profileDir, 'node_modules', pkgName, patchRel), 'utf8')
    const names = []
    const lines = text.split(/\r?\n/u)
    let inInsert = false
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
      if (/^- /u.test(line) && !/^ {4}- /u.test(line)) inInsert = false
      if (!inInsert) continue
      const nameM = (lines[i + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
      if (nameM) names.push(nameM[1])
    }
    return names
  } catch { return [] }
}

async function ensureBundlePatchIntegrity(profileDir, pkgName, userPatchPath, transientAllow = []) {
  const report = { checked: 0, installed: [], disabled: [], missing: [], pending: [] }
  try {
    const pkgJsonPath = join(profileDir, 'node_modules', pkgName, 'package.json')
    if (!existsSync(pkgJsonPath)) return report
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel !== 'string') return report
    const bundlePatch = join(profileDir, 'node_modules', pkgName, patchRel)
    if (!existsSync(bundlePatch)) return report
    const text = readFileSync(bundlePatch, 'utf8')
    // 解析 insert 引用（与 readExtraBundleOwners 同构）：- insert: 块下 - id: xxx + name: '包名'
    const refs = []
    const lines = text.split(/\r?\n/u)
    let inInsert = false
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
      if (/^- /u.test(line) && !/^ {4}- /u.test(line)) inInsert = false
      if (!inInsert) continue
      const idM = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
      if (!idM) continue
      const nameM = (lines[i + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
      if (nameM) refs.push({ id: idM[1], name: nameM[1] })
    }
    report.checked = refs.length
    if (refs.length === 0) return report
    const registries = orderedRegistries(readSources())
    for (const ref of refs) {
      // 框架内部包跳过（事故教训：npm 上 @deepseek-ai/* 的 dist-tags.latest 是远古版本，
      // 无版本约束补装会覆盖框架正确版本导致服务崩溃——见 backfillMissingDeps 注释）
      if (/^@deepseek-ai\//u.test(ref.name)) continue
      if (existsSync(join(profileDir, 'node_modules', ref.name))) continue
      // 2026-09-06 加固：本次作业刚完成版本同步的包（transientAllow）此刻缺失=更新中途的瞬时态
      // （pnpm 原子替换/替换失败窗口），不应按"缺失→自动禁用"处理——跳过本次判定，下次校验时再检查。
      if (transientAllow.includes(ref.name)) {
        report.pending.push(ref.name)
        continue
      }
      let ok = false
      try {
        await pnpmInstall(profileDir, ref.name, registries[0], 60000)
        ok = existsSync(join(profileDir, 'node_modules', ref.name))
      } catch {}
      if (!ok) {
        try { await curlManualInstall(profileDir, ref.name, registries); ok = true } catch {}
      }
      if (ok) {
        report.installed.push(ref.name)
      } else {
        report.missing.push(ref.name)
        // 自动禁用该行（用户 patch 层，防服务加载崩溃）
        try {
          const userPatch = readFileSync(userPatchPath, 'utf8')
          if (!userPatch.includes(`id: ${ref.id}`)) {
            // issue #7 防护：清理顶层 [] 占位符后再追加（模板初始文件直接追加会生成非法 YAML）
            const clean = sanitizePatchText(userPatch)
            const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
            writeFileSync(userPatchPath, `${next}- id: ${ref.id}\n  disabled: true\n`, 'utf8')
            report.disabled.push(ref.id)
          }
        } catch {}
      }
    }
  } catch {}
  return report
}

/**
 * 后台安装任务注册表：请求立即返回，安装继续在服务端执行；
 * 面板通过 /install-status 轮询进度（stage + status），离开面板不中断。
 */
const installJobs = new Map()
let installJobSeq = 0
/** AI 赋能任务注册表（规划/执行均常驻服务端，面板轮询进度）。 */
const aiJobs = new Map()
let aiJobSeq = 0
/** 组件注册表（服务型组件：启动/停止/状态控制按钮的数据源）。 */
const componentsFile = () => join(dshHome(), 'plugin-console', 'components.json')
/** AI 赋能任务持久化文件（DSH 重启不丢计划/结果；running 任务重启后标记中断）。 */
const aiJobsFile = () => join(dshHome(), 'plugin-console', 'ai-jobs.json')
/** 仓库落地根目录（可配置，默认 ~/.dsh/repos）。 */
let reposDirCache = null
const repoLandConfFile = () => join(dshHome(), 'plugin-console', 'repo-land.json')
function getReposDir() {
  if (reposDirCache !== null) return reposDirCache
  try {
    if (existsSync(repoLandConfFile())) {
      const conf = JSON.parse(readFileSync(repoLandConfFile(), 'utf8'))
      if (typeof conf.dir === 'string' && conf.dir.trim() !== '') {
        reposDirCache = conf.dir.trim()
        return reposDirCache
      }
    }
  } catch {}
  reposDirCache = join(homedir(), '.dsh', 'repos')
  return reposDirCache
}
function setReposDir(dir) {
  reposDirCache = String(dir ?? '').trim()
  mkdirSync(dirname(repoLandConfFile()), { recursive: true })
  writeFileSync(repoLandConfFile(), JSON.stringify({ dir: reposDirCache }, null, 2), 'utf8')
  return reposDirCache
}
/** 已落地仓库列表：扫描 dir 下两级目录（owner/name 下含 .git）。 */
function listLandedRepos() {
  const dir = getReposDir()
  const out = []
  try {
    if (!existsSync(dir)) return out
    for (const owner of readdirSync(dir, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.name.startsWith('.')) continue
      const ownerDir = join(dir, owner.name)
      for (const entry of readdirSync(ownerDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const repoDir = join(ownerDir, entry.name)
        if (existsSync(join(repoDir, '.git'))) {
          out.push({ owner: owner.name, name: entry.name, repo: `${owner.name}/${entry.name}`, path: repoDir })
        }
      }
    }
  } catch {}
  return out
}
function saveAiJobs() {
  try {
    mkdirSync(dirname(aiJobsFile()), { recursive: true })
    const arr = [...aiJobs.values()].map((j) => ({ id: j.id, source: j.source, status: j.status, stage: j.stage, plan: j.plan ?? null, logText: j.logText ?? '', stepStates: j.stepStates ?? [], progress: j.progress ?? null, error: j.error ?? null, createdAt: j.createdAt, finishedAt: j.finishedAt ?? null }))
    writeFileSync(aiJobsFile(), JSON.stringify(arr, null, 2), 'utf8')
  } catch {}
}
function loadAiJobs() {
  try {
    if (!existsSync(aiJobsFile())) return
    const arr = JSON.parse(readFileSync(aiJobsFile(), 'utf8'))
    for (const j of arr) {
      if (!j || typeof j.id !== 'string') continue
      let job = j
      if (job.status === 'running') {
        job = { ...job, status: 'failed', error: 'DSH 重启，任务中断（可重新发起）', finishedAt: Date.now() }
      }
      aiJobs.set(job.id, job)
    }
  } catch {}
}
/** 静态插件索引内存缓存（/market-index 用）。 */
let marketIndexCache = null

function installJobView(job) {
  return {
    jobId: job.id,
    repo: job.repo,
    packageName: job.packageName,
    status: job.status,
    stage: job.stage,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    entryId: job.entryId ?? null,
    bundle: job.bundle ?? false,
    ai: job.ai ?? false,
    aiNote: job.aiNote ?? null,
    subpackages: job.subpackages ?? null,
    source: job.source ?? 'github',
    curlNote: job.curlNote ?? null,
    bundleNote: job.bundleNote ?? null,
    compatNote: job.compatNote ?? null,
    kind: job.kind ?? 'plugin',
    skillName: job.skillName ?? null,
    skillDir: job.skillDir ?? null,
    skillNote: job.skillNote ?? null,
    suiteReport: job.suiteReport ?? null,
    suiteNote: job.suiteNote ?? null,
    hint: job.hint ?? null,
  }
}

/**
 * 递归复制目录树（绕开 fs.cpSync 在本环境的目录复制 EIO bug：
 * cpSync 复制含子目录的树必报 `EIO, Access is denied`，而逐文件 copyFileSync 正常）。
 * 跳过 .git（技能/包副本不需要版本库元数据）。
 */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to)
    } else if (entry.isFile()) {
      copyFileSync(from, to)
    }
  }
}

/** 解析 .gitmodules：返回 [{name, path, url}]（submodule 套装识别用）。 */
function readGitmodules(dir) {
  const file = join(dir, '.gitmodules')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const subs = []
  let cur = null
  for (const line of text.split(/\r?\n/u)) {
    const m = line.match(/^\[submodule\s+"([^"]+)"\]/u)
    if (m) {
      cur = { name: m[1], path: '', url: '' }
      subs.push(cur)
      continue
    }
    if (!cur) continue
    const pm = line.match(/^\s*path\s*=\s*(.+)$/u)
    if (pm) { cur.path = pm[1].trim(); continue }
    const um = line.match(/^\s*url\s*=\s*(.+)$/u)
    if (um) cur.url = um[1].trim()
  }
  return subs.filter((s) => s.path !== '' && s.url !== '')
}

/** 递归找含 preset.yml + agent.cordis.yml 的 agent 预设目录（深度 ≤ maxDepth）。 */
function findPresetDirs(root, maxDepth = 2) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (existsSync(join(dir, 'preset.yml')) && existsSync(join(dir, 'agent.cordis.yml'))) {
      out.push(dir)
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** 包是否有构建产物（main/module/exports/bin 或 lib/index.js 任一存在）。
 * 排除类型声明（.d.ts）与 package.json 自身——exports 的 "./package.json" 是合法导出但不是运行时入口。 */
function packageEntryExists(dir, pkg) {
  const isEntry = (p) => typeof p === 'string' && p !== '' && !p.endsWith('.d.ts') && p !== './package.json' && p !== 'package.json'
  const candidates = []
  if (isEntry(pkg.main)) candidates.push(pkg.main)
  if (isEntry(pkg.module)) candidates.push(pkg.module)
  if (isEntry(pkg.bin)) candidates.push(pkg.bin)
  if (pkg.bin && typeof pkg.bin === 'object') Object.values(pkg.bin).forEach((v) => { if (isEntry(v)) candidates.push(v) })
  if (pkg.exports && typeof pkg.exports === 'object') {
    const collect = (v) => {
      if (typeof v === 'string') { if (isEntry(v)) candidates.push(v) }
      else if (v && typeof v === 'object') Object.values(v).forEach(collect)
    }
    collect(pkg.exports)
  }
  candidates.push('lib/index.js', 'dist/index.js')
  return candidates.some((c) => existsSync(join(dir, c)))
}

/** git 可执行名（跨平台）。事故（2026-09-20，另一位用户：Android + proot Ubuntu）：
 * 「仓库落地」硬编码 `git.exe` → 非 Windows 环境 spawn git.exe ENOENT，克隆必然失败。导出供测试。 */
export function gitBin() {
  return process.platform === 'win32' ? 'git.exe' : 'git'
}

/** pnpm 执行方式定位（跨平台，纯函数便于单测 → 按优先级返回列表，逐个尝试）。导出供测试。
 * 事故（2026-09-20，同一位用户，node v24 + Linux）：只按 Windows 布局找 corepack.js
 * （`<node bin>/node_modules/corepack/dist/corepack.js`），而 Linux 的 npm 全局布局在
 * `<prefix>/lib/node_modules/corepack/...` → AI 赋能的 install-npm 生成
 * `node /usr/local/bin/node_modules/corepack/dist/corepack.js pnpm add …` → MODULE_NOT_FOUND。 */
export function resolvePnpmRunners({ platform = process.platform, execPath = process.execPath, comspec = process.env.ComSpec ?? 'cmd.exe', exists = existsSync } = {}) {
  const binDir = dirname(execPath)
  const corepackCandidates = [
    join(binDir, 'node_modules', 'corepack', 'dist', 'corepack.js'), // Windows 官方安装器 / nvm-windows
    join(binDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'), // Linux/macOS npm 全局
    join(binDir, '..', 'libexec', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'), // brew / 自编译布局
  ]
  const runners = []
  for (const js of corepackCandidates) {
    if (exists(js)) {
      runners.push({ kind: 'node-corepack', note: `node ${js} pnpm`, run: (args) => ({ bin: execPath, argv: [js, 'pnpm', ...args] }) })
    }
  }
  if (platform === 'win32') {
    // .cmd 批处理不能直接 execFile（EINVAL）→ 经 cmd.exe 调用（整条命令作为一个参数）
    runners.push({
      kind: 'cmd-corepack',
      note: 'cmd /c corepack pnpm',
      run: (args) => ({ bin: comspec, argv: ['/d', '/s', '/c', ['corepack', 'pnpm', ...args].map((a) => JSON.stringify(a)).join(' ')] }),
    })
  } else {
    runners.push({ kind: 'corepack', note: 'corepack pnpm', run: (args) => ({ bin: 'corepack', argv: ['pnpm', ...args] }) })
    runners.push({ kind: 'pnpm', note: 'pnpm', run: (args) => ({ bin: 'pnpm', argv: args }) })
  }
  return runners
}

/** 依次尝试各执行方式；只有"执行方式本身不可用"（ENOENT / MODULE_NOT_FOUND）才换下一个，
 * 真正的安装失败（网络、依赖冲突等）立即抛出，并附上已尝试的清单便于排查。 */
async function runPnpmWithFallback(args, { execOpts = {}, runners = resolvePnpmRunners() } = {}) {
  let lastError = null
  for (const runner of runners) {
    const { bin, argv } = runner.run(args)
    try {
      // eslint-disable-next-line no-await-in-loop
      await execFileAsync(bin, argv, execOpts)
      return { runner }
    } catch (error) {
      lastError = error
      const message = String(error?.message ?? '')
      if (!/ENOENT|Cannot find module/u.test(message)) throw error
    }
  }
  const tried = runners.map((r) => r.note).join(' → ')
  throw new Error(`${lastError?.message ?? 'pnpm 执行失败'}（已尝试：${tried}）`)
}

/** git 非交互环境：禁止任何登录/凭据窗口弹出（私有仓库或不可达源直接失败，不做交互式重试）。 */
function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
  }
}

/** Git 克隆 URL 列表（按主→备顺序）。来源在「功能包 → 软件源 → Git 源」中自定义，
 * 可替换为 Gitee / GitLab / 自建 Gitea / 任意镜像代理，实现「换一个网站下载仓库内容」。 */
function gitCloneUrls(repoFullName, source = 'github') {
  if (source === 'gitee') return [`https://gitee.com/${repoFullName}.git`]
  const [owner = '', repo = ''] = String(repoFullName).split('/')
  let list = []
  try {
    list = readSources().gitSources ?? []
  } catch {
    list = DEFAULT_SOURCES.gitSources
  }
  const ordered = [...list].sort((a, b) => (b.primary === true ? 1 : 0) - (a.primary === true ? 1 : 0))
  const urls = ordered
    .map((s) => String(s.urlTemplate).replace(/\{owner\}/gu, owner).replace(/\{repo\}/gu, repo))
    .filter((u) => u !== '')
  return urls.length > 0 ? urls : [`https://github.com/${repoFullName}.git`]
}

/** 逐条尝试的错误汇总（纯函数，单测覆盖）：报**第一个**错误（真实原因）+ 尝试清单。
 * 为什么要这样：多源重试时若第一次失败留下半成品目录，第二次会以
 * `fatal: destination path '…' already exists and is not an empty directory` 失败，
 * 旧代码把它当 lastError 抛出去 → 用户只看到"目录非空"，真实原因（镜像/网络不可达）被完全掩盖。
 * 2026-09-20 另一位用户实测报的就是这句。 */
export function summarizeCloneErrors(errors) {
  const first = errors[0]
  const tried = errors.map((e) => (/already exists and is not an empty directory/u.test(e.message) ? `${e.url}（目录非空）` : e.url)).join('；')
  return `git clone 失败（首个错误：${first?.message ?? '未知'}）；已尝试 ${errors.length} 个源：${tried}`
}

/** git clone（镜像→直连；gitee 直连），返回 { url } 或抛错。 */
export async function gitCloneRepo(repo, dest, source = 'github', timeout = 180000) {
  const urls = gitCloneUrls(repo, source)
  const errors = []
  for (const [attempt, url] of urls.entries()) {
    // 每次尝试前都清掉目标目录：上一次可能留下半成品（git 会先建目录再传输），
    // 不清就会让第二次以"目录非空"失败并掩盖真实原因（见 summarizeCloneErrors 注释）。
    try { rmSync(dest, { recursive: true, force: true }) } catch {}
    try {
      // eslint-disable-next-line no-await-in-loop
      await execFileAsync('git', ['clone', '--depth', '1', '--quiet', url, dest], {
        timeout,
        windowsHide: true,
        env: gitEnv(),
      })
      return { url, attempt: attempt + 1 }
    } catch (error) {
      errors.push({ url, message: error?.message ?? String(error) })
    }
  }
  throw new Error(summarizeCloneErrors(errors))
}

/** 从 GitHub Release 下载预构建 tgz 装配到 node_modules/<pkgName>（gh CLI 通道，含绝对路径候选）。 */
async function installBundleFromRelease(subRepo, pkgName, target) {
  const dlDir = join(tmpdir(), `dsh-rel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dlDir, { recursive: true })
  try {
    const args = ['release', 'download', '-R', subRepo, '-p', '*.tgz', '-D', dlDir]
    let downloaded = false
    let lastError = null
    for (const bin of GH_BIN_CANDIDATES) {
      try {
        await execFileAsync(bin, args, { timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
        downloaded = true
        break
      } catch (error) {
        lastError = error
        if (error.code !== 'ENOENT') break
      }
    }
    if (!downloaded) throw new Error(lastError?.message ?? 'gh release download 失败')
    const tgz = readdirSync(dlDir).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error('Release 无 tgz 资产')
    const extractDir = join(dlDir, 'x')
    mkdirSync(extractDir, { recursive: true })
    await execFileAsync('tar', ['-xzf', join(dlDir, tgz), '-C', extractDir], { timeout: 60000, windowsHide: true })
    const pkgDir = join(extractDir, 'package')
    if (!existsSync(join(pkgDir, 'package.json'))) throw new Error('tgz 内无 package/package.json')
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    copyTree(pkgDir, target)
  } finally {
    rmSync(dlDir, { recursive: true, force: true })
  }
}

/** 套装探测（唯一入口）：main → master，且**必须内容像 .gitmodules**（含 [submodule "x"] 段）才算套装。
 * 判据是内容、不是"探测非 null"：2026-09-19 用户反馈装 dsh-whale-widget 被判成 submodule 套装置仓库、
 * clone 后报「未找到 .gitmodules」——根因就是代理/CDN 对**不存在的文件**回 2xx（空 body 也算"读到"）。 */
async function probeGitmodules(repo) {
  const main = await rawTextWithFallback(repo, 'main', '.gitmodules')
  if (looksLikeGitmodules(main)) return main
  const master = await rawTextWithFallback(repo, 'master', '.gitmodules')
  return looksLikeGitmodules(master) ? master : null
}

/** 安装类型决策（纯函数，导出供 test-suite-detect.mjs 断言）：`.gitmodules` 的**内容**说了算——
 * 显式 suite 请求若探测内容不像 .gitmodules 也回落普通插件安装（前端标记可能来自 24h 缓存的误判，
 * 不能当判据）；技能请求不受影响。 */
export function resolveInstallKind(requestKind, probeText) {
  if (requestKind === 'skill') return 'skill'
  return looksLikeGitmodules(probeText) ? 'suite' : 'plugin'
}

/** 套装安装（submodule 聚合仓库）：照仓库 install.ps1/README 语义——
 * clone 套装 → 手动镜像拉取子模块 → 按类型装配（bundle 插件含 Release tgz 兜底 / 普通插件 / 技能 / agent 预设）。
 * 不执行第三方脚本本体（安全护栏：脚本型只读语义不运行）。 */
async function runSuiteInstallJob(job, ctx) {
  const tmpDir = join(tmpdir(), `dsh-suite-${job.id}-${Date.now()}`)
  const report = []
  try {
    job.stage = 'preparing'
    mkdirSync(tmpDir, { recursive: true })
    await gitCloneRepo(job.repo, tmpDir, job.source)
    const subs = readGitmodules(tmpDir)
    if (subs.length === 0) {
      // 探测与仓库实际内容不符（假阳性 / 仓库已重构）：**不报失败**，把决定权交回调用方
      // 回落普通插件安装（npm → Release → git 规格），用户不该因为一次误判装不上插件。
      job.stage = 'detecting'
      return { notASuite: true }
    }
    job.stage = 'detecting'
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    // 手动拉取子模块（git 的 insteadOf 重写对 submodule 不生效，按镜像 URL 逐个 clone）
    for (const sub of subs) {
      const subRepo = sub.url.replace(/^https?:\/\/[^/]+\//u, '').replace(/\.git$/u, '')
      const dest = join(tmpDir, sub.path)
      try {
        mkdirSync(dirname(dest), { recursive: true })
        await gitCloneRepo(subRepo, dest, sub.url.includes('gitee.com') ? 'gitee' : 'github', 120000)
      } catch (error) {
        report.push({ component: sub.name, type: 'clone', ok: false, note: `子模块拉取失败：${error.message}` })
      }
    }
    for (const sub of subs) {
      const subDir = join(tmpDir, sub.path)
      if (!existsSync(subDir)) continue
      const subRepo = sub.url.replace(/^https?:\/\/[^/]+\//u, '').replace(/\.git$/u, '')
      let pkg = null
      try {
        const pkgPath = join(subDir, 'package.json')
        if (existsSync(pkgPath)) pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      } catch {}
      let handled = false
      // a. bundle 型插件（如 injector）：自动装配默认**跳过**并给出官方装配指引——
      // 第三方 bundle 需与当前 DSH 版本严格兼容（peer 依赖、client inject 模块、patch 语义），
      // 自动写入 bundles 曾导致启动崩溃；预设/技能/普通插件不受影响。
      if (pkg && typeof pkg.name === 'string' && pkg.dsh?.bundle) {
        report.push({ component: sub.name, type: 'bundle', ok: false, note: `${pkg.name} 是 bundle 型插件，自动装配已跳过（避免 bundle 不兼容导致启动失败）；请按详情面板「官方安装方式」命令手动装配（clone 套装后运行 install.ps1，或构建后加入 profile 的 dsh.profile.bundles）` })
        handled = true
      }
      // b. 技能（根或第一层子目录 SKILL.md）
      if (!handled) {
        let skillDir0 = ''
        if (existsSync(join(subDir, 'SKILL.md'))) {
          skillDir0 = ''
        } else {
          let found = null
          try {
            found = readdirSync(subDir, { withFileTypes: true })
              .find((d) => d.isDirectory() && existsSync(join(subDir, d.name, 'SKILL.md')))
          } catch {}
          skillDir0 = found ? found.name : null
        }
        if (skillDir0 !== null) {
          const skillsRoot = join(dshHome(), 'skills')
          mkdirSync(skillsRoot, { recursive: true })
          const dest = join(skillsRoot, sub.name)
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
          copyTree(join(subDir, skillDir0), dest)
          report.push({ component: sub.name, type: 'skill', ok: true, note: `已安装技能 ~/.dsh/skills/${sub.name}` })
          handled = true
        }
      }
      // c. agent 预设（含 preset.yml + agent.cordis.yml 的目录；预设优先于普通 npm 包——
      // 如 dsh-router-standard 既是 npm 包又带预设目录，install.ps1 意图是复制预设）
      const presets = findPresetDirs(subDir, 2)
      for (const p of presets) {
        const pname = basename(p)
        const presetsRoot = join(dshHome(), '.agent-presets')
        mkdirSync(presetsRoot, { recursive: true })
        const dest = join(presetsRoot, pname)
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
        copyTree(p, dest)
        report.push({ component: sub.name, type: 'preset', ok: true, note: `已安装预设 ${pname}（新建会话可选）` })
        handled = true
      }
      // d. 普通 npm 插件（无 bundle 且无预设/技能）
      if (!handled && pkg && typeof pkg.name === 'string') {
        const target = join(profileDir, 'node_modules', pkg.name)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        mkdirSync(dirname(target), { recursive: true })
        copyTree(subDir, target)
        const taken = new Set(listEntries(ctx).map((e) => e.rowId))
        const entryId = deriveEntryId(pkg.name, taken)
        await appendInsert(patchPath, entryId, pkg.name)
        report.push({ component: sub.name, type: 'plugin', ok: true, note: `已安装 ${pkg.name}（HMR 生效）` })
        handled = true
      }
      if (!handled) {
        report.push({ component: sub.name, type: 'unknown', ok: false, note: '未识别组件类型（无 package.json / SKILL.md / 预设）' })
      }
    }
    job.status = 'done'
    job.stage = 'done'
    job.suiteReport = report
    const okCount = report.filter((r) => r.ok).length
    const failCount = report.filter((r) => !r.ok).length
    const bundleCount = report.filter((r) => r.type === 'bundle' && r.ok).length
    job.suiteNote = `套装安装完成：${okCount} 个组件成功${failCount > 0 ? `，${failCount} 个失败（详见报告）` : ''}${bundleCount > 0 ? '。bundle 组件需重启服务生效' : ''}；预设需新建会话时选择。`
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    job.finishedAt = Date.now()
  }
}

/** 技能安装：git clone 仓库 → 定位 SKILL.md（根或第一层子目录）→ 复制到 ~/.dsh/skills/<name>/。
 * 技能由 dsh-skill-filesystem 插件扫描（发现根：<dshHome>/skills），与桌面版共享。 */
async function runSkillInstallJob(job) {
  const tmpDir = join(tmpdir(), `dsh-skill-${job.id}-${Date.now()}`)
  try {
    job.stage = 'preparing'
    const shortName = String(job.repo).split('/').pop() || job.repo
    mkdirSync(tmpDir, { recursive: true })
    const urls = gitCloneUrls(job.repo, job.source)
    let cloned = false
    let lastError = null
    for (const url of urls) {
      try {
        await execFileAsync('git', ['clone', '--depth', '1', '--quiet', url, tmpDir], {
          timeout: 120000,
          windowsHide: true,
          env: gitEnv(),
        })
        cloned = true
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!cloned) throw new Error(`git clone 失败：${lastError?.message ?? '未知'}`)
    job.stage = 'detecting'
    // 定位 SKILL.md：根目录优先，其次第一层子目录（常用布局 skills/<name>/SKILL.md）
    let skillDir = ''
    if (!existsSync(join(tmpDir, 'SKILL.md'))) {
      const sub = readdirSync(tmpDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .find((d) => existsSync(join(tmpDir, d.name, 'SKILL.md')))
      if (sub) skillDir = sub.name
    }
    if (!existsSync(join(tmpDir, skillDir, 'SKILL.md'))) {
      // 根与第一层子目录都没有：区分「技能集合仓库」与「非技能仓库」，给出可操作提示
      let collection = false
      try {
        const tree = await curlJson(`https://api.github.com/repos/${job.repo}/git/trees/${encodeURIComponent(job.source === 'gitee' ? 'master' : 'main')}?recursive=1`, 6000).catch(() => null)
        collection = (tree?.tree ?? []).filter((n) => n.type === 'blob' && /(?:^|\/)SKILL\.md$/u.test(n.path)).length > 1
      } catch {}
      if (collection) {
        throw new Error('这是技能集合仓库（含多个 SKILL.md），请安装其中单个技能仓库（根或第一层子目录含 SKILL.md 的仓库）')
      }
      throw new Error('仓库内未找到 SKILL.md（检查根目录或第一层子目录）')
    }
    // 技能名：SKILL.md frontmatter 的 name（kebab-case）优先，否则用仓库短名
    let skillName = shortName
    try {
      const text = readFileSync(join(tmpDir, skillDir, 'SKILL.md'), 'utf8')
      const m = text.match(/^name:\s*([a-z0-9][a-z0-9-]{0,63})/mu)
      if (m) skillName = m[1]
    } catch {}
    const skillsRoot = join(dshHome(), 'skills')
    const dest = join(skillsRoot, skillName)
    mkdirSync(skillsRoot, { recursive: true })
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    copyTree(join(tmpDir, skillDir), dest)
    job.kind = 'skill'
    job.skillName = skillName
    job.skillDir = dest
    job.status = 'done'
    job.stage = 'done'
    job.skillNote = `已安装技能「${skillName}」到 ${dest}。技能由 dsh-skill-filesystem 插件扫描发现（用户根 ~/.dsh/skills）；若当前 profile 未启用该插件，请在 profile 的 cordis.yml 启用 @deepseek-ai/dsh-skill-filesystem 后重启即可生效。`
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    // 无论成败都清理克隆临时目录（cpSync EIO 时代曾泄漏在 TEMP）
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    job.finishedAt = Date.now()
  }
}

/** 技能停用注入的 frontmatter 行（官方调用策略：disable-model-invocation 从模型目录/loader 排除，
 * user-invocable 从用户命令排除；两者同设 = 完整停用）。 */
const SKILL_DISABLE_LINES = ['disable-model-invocation: true', 'user-invocable: false']

/** 返回 SKILL.md frontmatter 内容区间（不含首尾 --- 行）；无 frontmatter 时 { has: false }。 */
function skillFrontmatterBounds(text) {
  if (!text.startsWith('---')) return { has: false }
  const nl = text.indexOf('\n')
  if (nl === -1) return { has: false }
  const end = text.indexOf('\n---', nl + 1)
  if (end === -1) return { has: false }
  return { has: true, start: nl + 1, end }
}

/** 技能是否已停用（frontmatter 含 disable-model-invocation: true）。 */
function isSkillDisabled(skillFile) {
  try {
    const text = readFileSync(skillFile, 'utf8')
    const fm = skillFrontmatterBounds(text)
    if (!fm.has) return false
    return /^\s*disable-model-invocation:\s*(true|yes|on|1)\s*$/mu.test(text.slice(fm.start, fm.end))
  } catch {
    return false
  }
}

/** 停用/启用技能（可逆）：停用 = 备份原始 SKILL.md 到同目录 .dsh-skill-fm.bak 后在
 * frontmatter 注入调用策略行；启用 = 恢复备份（无备份则移除注入行）。 */
function setSkillEnabled(skillFile, enabled) {
  const backup = join(dirname(skillFile), '.dsh-skill-fm.bak')
  const text = readFileSync(skillFile, 'utf8')
  const fm = skillFrontmatterBounds(text)
  if (!enabled) {
    if (!existsSync(backup)) writeFileSync(backup, text, 'utf8')
    const inject = `${SKILL_DISABLE_LINES.join('\n')}\n`
    if (!fm.has) {
      writeFileSync(skillFile, `---\n${inject}---\n\n${text}`, 'utf8')
    } else {
      writeFileSync(skillFile, `${text.slice(0, fm.start)}${inject}${text.slice(fm.start)}`, 'utf8')
    }
  } else if (existsSync(backup)) {
    writeFileSync(skillFile, readFileSync(backup, 'utf8'), 'utf8')
    rmSync(backup, { force: true })
  } else if (fm.has) {
    const content = text.slice(fm.start, fm.end)
    const cleaned = content.split('\n')
      .filter((l) => !/^\s*(disable-model-invocation|user-invocable)\s*:/u.test(l))
      .join('\n')
    writeFileSync(skillFile, `${text.slice(0, fm.start)}${cleaned}${text.slice(fm.end)}`, 'utf8')
  }
}

/** 列出已安装技能（~/.dsh/skills 下一层含 SKILL.md 的目录 + 平铺 .md 文件）。
 * 点号开头（如 .system）是系统技能根（dsh-skill-filesystem 保留目录），标记 system: true，
 * 前端展示「系统」标签且不提供删除。disabled = 已按官方调用策略停用。 */
function listInstalledSkills() {
  const root = join(dshHome(), 'skills')
  const skills = []
  try {
    if (!existsSync(root)) return skills
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const system = entry.name.startsWith('.')
      if (entry.isDirectory()) {
        const skillFile = join(root, entry.name, 'SKILL.md')
        if (existsSync(skillFile)) {
          skills.push({ name: entry.name, path: skillFile, system, disabled: isSkillDisabled(skillFile) })
        }
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
        const skillFile = join(root, entry.name)
        skills.push({ name: entry.name.slice(0, -3), path: skillFile, system, disabled: isSkillDisabled(skillFile) })
      }
    }
  } catch {}
  return skills
}

/** 服务端列出仓库子包（git trees 递归 + 并行读 package.json 的 name）。 */
async function fetchSubpackageNames(repo, branch, auth) {
  try {
    const data = await githubJson(`${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, undefined, auth)
    const paths = (data.tree ?? [])
      .filter((node) => node.type === 'blob' && /^(?:packages|examples|plugins|skills|apps|extensions|src|lib)\/[^/]+\/package\.json$/u.test(node.path))
      .map((node) => node.path)
    // 并行读取：黑洞期单条最坏 40s，24 条串行会拖到十几分钟
    const results = await Promise.all(paths.slice(0, 24).map(async (path) => {
      const bodyText = await rawTextWithFallback(repo, branch, path)
      if (bodyText === null) return null
      try {
        const pkg = JSON.parse(bodyText)
        if (pkg && typeof pkg.name === 'string') return { dir: path.split('/')[1], path: path.split('/').slice(0, -1).join('/'), name: pkg.name }
      } catch {}
      return null
    }))
    return results.filter((item) => item !== null)
  } catch {
    return []
  }
}

/** 子包候选：聚合包（名字带 all）优先，上限 8 个。 */
async function subpackageCandidates(repo, branch, auth) {
  const isAll = (name) => /(^|-)all$/u.test(name) || /-all-/u.test(name)
  const subs = await fetchSubpackageNames(repo, branch, auth)
  return subs
    .slice()
    .sort((a, b) => Number(isAll(b.name)) - Number(isAll(a.name)))
    .map((sub) => sub.name)
    .slice(0, 8)
}

/**
 * 本地 AI 修复：拉起无父上下文的 in-process 子代理接管安装。
 * 子代理与本会话使用同一套工具（终端/文件），能真实修复安装。
 */
async function aiRepair(job, ctx, profileDir, candidates, lastError) {
  job.stage = 'repairing'
  job.ai = true
  let subagents = null
  try { subagents = ctx.get('subagents') } catch {}
  const startFn = subagents?.start
  if (typeof startFn !== 'function') {
    job.status = 'failed'
    job.error = `确定性安装通道全部失败，且本地 AI 修复通道（subagents 服务）不可用。原始错误：${lastError ?? '未知'}；请手动执行：dsh plugin --profile web add <包名>`
    return
  }
  let provider = 'spawn'
  try {
    const list = subagents.list?.() ?? []
    if (!list.includes(provider)) provider = list[0]
    if (provider === undefined) throw new Error('no provider')
  } catch (error) {
    job.status = 'failed'
    job.error = `本地 AI 修复通道没有可用的子代理提供方：${String(error)}；请手动执行：dsh plugin --profile web add <包名>`
    return
  }
  // 跨平台提示：corepack 的位置随安装方式/系统而异（Windows 官方安装器在 <node bin>/node_modules，
  // Linux 的 npm 全局在 <prefix>/lib/node_modules），所以给子代理的提示不再写死路径
  const corepackRunner = resolvePnpmRunners()[0]
  const prompt = [
    '你是 DeepSeek Harness 的插件安装专家。用户通过插件管理面板安装插件失败，现在由你主动接管安装（不是被动"修复"，而是像人工一样把它装好）。',
    `目标仓库：${job.repo}`,
    `候选包名：${candidates.join('、')}`,
    `profile 目录：${profileDir}（pnpm 管理，绝不能用 npm 写入，会破坏链接）`,
    `此前确定性通道的错误：${lastError ?? '未知'}`,
    '接管步骤：',
    `1) 先弄清楚装什么：若根包是 private 的聚合仓库（monorepo），用 gh api repos/${job.repo}/git/trees/main?recursive=1 或读 packages 目录下的 package.json 找出子包名；优先选聚合包（名字含 all，如 dsh-web-ui-all，一个包装全部）；`,
    `2) 用 corepack/pnpm 安装（本机可用的执行方式：${corepackRunner?.note ?? 'corepack pnpm 或 pnpm'}，即在该方式后接 add <包名> --registry https://registry.npmmirror.com，工作目录 ${profileDir}；Windows 上是 node <corepack.js> pnpm，Linux 上通常是 corepack pnpm 或直接 pnpm）；镜像 404 时改 --registry https://registry.npmjs.org；都不行再用 git 通道；`,
    '3) **node 网络黑洞判定**：pnpm 长时间无下载进度（Progress 停在 downloaded 0）、或报 socket hang up / EPERM / TIMEOUT、或 node 脚本连 127.0.0.1 都超时，说明本机拦截 node 进程网络——此时 curl 与系统 git 通常仍可用，立即改用 curl 手动安装：先 `curl -s https://registry.npmmirror.com/<包名>` 取最新版本号，再 `curl -sL -o <临时目录>/pkg.tgz https://registry.npmmirror.com/<包名>/-/<包名>-<版本>.tgz`，解压 tar -xzf 后把 package 内容放入 profile/node_modules/<包名>（先备份旧目录）；包有 dependencies 时用同样方式逐个 curl 拉取补齐到 node_modules；零依赖包（如 dsh-skin）一条龙即可完成；',
    `4) 安装成功后按官方 dsh plugin add 规则落配置：包声明 dsh.bundle 时把包名追加进 profile 目录 package.json 的 dsh.profile.bundles 数组；普通插件在 cordis.patch.yml 追加 insert 行（id 由包名去 scope、非字母数字转连字符生成，name 填包名）；`,
    '5) 装完自查：确认包已出现在 node_modules、配置已写入；必要时用 gh api 核对仓库信息；',
    '6) 执行 git/pnpm 前先设置环境变量 GIT_TERMINAL_PROMPT=0 和 GCM_INTERACTIVE=never，禁止弹出任何登录/凭据窗口；',
    '7) 不要杀进程、不要重启服务、不要改动与本次安装无关的文件。',
    '完成后用一两句话报告结果；确实无法安装也请说明原因。',
  ].join('\n')
  try {
    // in-process 驱动要求 parent 是真实的活动 Agent（parent.ctx.agents.create）。
    // 控制台在根上下文运行，从 Agent 注册表借一个顶级会话作为结构性父代理。
    let parent = null
    try {
      const agents = ctx.get('agents')
      const candidates = typeof agents?.roots === 'function' ? agents.roots() : (typeof agents?.list === 'function' ? agents.list() : [])
      parent = candidates[0] ?? null
    } catch {}
    if (parent === null) {
      job.status = 'failed'
      job.error = `本地 AI 修复无法借用活动会话（agents 注册表为空）。原始错误：${lastError ?? '未知'}；请手动执行：dsh plugin --profile web add <包名>`
      return
    }
    const controller = new AbortController()
    const run = await startFn.call(subagents, provider, {
      label: `install-repair-${String(job.repo).split('/')[1] ?? 'plugin'}`,
      prompt: [{ type: 'text', text: prompt }],
      // 父代理深度 0，修复子代理至少深度 1（0 会触发 depth 校验失败）
      maxDepth: 1,
      signal: controller.signal,
      parent,
    })
    let settleFn = null
    try {
      const requireLocal = createRequire(join(profileDir, 'package.json'))
      ;({ settleRun: settleFn } = requireLocal('@deepseek-ai/dsh-subagent'))
    } catch {}
    const settle = settleFn ?? (async (runHandle) => {
      try {
        const result = await runHandle.result
        return { status: result?.stopReason === 'completed' ? 'completed' : 'failed', detail: String(result?.stopReason ?? 'unknown') }
      } catch (error) {
        return { status: 'failed', detail: String(error) }
      }
    })
    const outcome = await Promise.race([
      settle(run),
      new Promise((resolve) => setTimeout(() => {
        controller.abort()
        resolve({ status: 'failed', detail: '本地 AI 修复超时（10 分钟）' })
      }, 600000)),
    ])
    if (outcome.status === 'completed') {
      // 校验修复结果：任一候选包现在可解析（或已进 bundle 层）才算成功，
      // 避免子代理"跑完流程但没装上"被误报为成功
      let verified = false
      try {
        const requireLocal = createRequire(join(profileDir, 'package.json'))
        for (const name of candidates) {
          try {
            requireLocal.resolve(`${name}/package.json`)
            verified = true
            break
          } catch {}
        }
        if (!verified) {
          const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
          const bundles = manifest.dsh?.profile?.bundles ?? []
          if (candidates.some((name) => bundles.includes(name))) verified = true
        }
      } catch {}
      if (verified) {
        job.status = 'done'
        job.aiNote = '本地 AI 已接管并完成修复，请刷新页面查看'
      } else {
        job.status = 'failed'
        job.error = `本地 AI 完成了修复流程，但未能确认安装成功（候选包 ${candidates.join('、')} 均不可解析）；请手动执行：dsh plugin --profile web add <包名>`
      }
    } else {
      job.status = 'failed'
      job.error = `本地 AI 修复未成功（${outcome.detail ?? outcome.status}）。请手动执行：dsh plugin --profile web add <包名>`
    }
  } catch (error) {
    job.status = 'failed'
    job.error = `本地 AI 修复通道异常：${error instanceof Error ? error.message : String(error)}；请手动执行：dsh plugin --profile web add <包名>`
  }
}

// ============================================================
// AI 赋能：文档驱动的通用组件部署（读文档 → 出计划 → 确认 → 执行 → 组件控制）
// ============================================================

/** AI 赋能计划/执行任务视图（content 一律剥离，防密钥经轮询泄露）。 */
function aiJobView(job) {
  return {
    jobId: job.id,
    source: job.source,
    status: job.status,
    stage: job.stage,
    error: job.error ?? null,
    type: job.plan?.type ?? null,
    displayName: job.plan?.displayName ?? null,
    summary: job.plan?.summary ?? null,
    servers: (job.plan?.servers ?? []).map((s) => ({ name: s.name, healthUrl: s.healthUrl ?? null, port: s.port ?? null })),
    steps: (job.plan?.steps ?? []).map((s, i) => ({
      index: i,
      action: s.action,
      description: s.description ?? '',
      path: typeof s.path === 'string' ? resolvePlaceholders(s.path, job) : null,
      package: s.package ?? null,
      url: typeof s.url === 'string' ? maskUrl(s.url) : null,
      name: s.name ?? null,
    })),
    stepStates: job.stepStates ?? [],
    progress: job.progress ?? { done: 0, total: (job.plan?.steps ?? []).length },
    logText: (job.logText ?? '').slice(-6000),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
    workspace: job.parentCwd ?? null,
    frameworkCheck: job.frameworkCheck ?? null,
  }
}

function maskUrl(url) {
  try {
    const u = new URL(url)
    if (u.password !== '') u.password = '***'
    if (u.username !== '') u.username = '***'
    if (u.search !== '') u.search = ''
    return u.toString()
  } catch {
    return String(url).split(/[?#]/u)[0]
  }
}

/** 占位符：${home} 家目录 / ${profile} DSH profile 目录 / ${python} Python 解释器 / ${scripts} Python Scripts / ${node} node 可执行 / ${deepseekKey} DSH 凭据中的 DeepSeek 密钥。 */
let deepseekKeyCache = null
function readDeepSeekKey() {
  if (deepseekKeyCache !== null) return deepseekKeyCache
  try {
    const credFile = join(homedir(), '.dsh', '.credentials.yaml')
    if (existsSync(credFile)) {
      const m = /^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/mu.exec(readFileSync(credFile, 'utf8'))
      if (m) {
        deepseekKeyCache = m[1]
        return deepseekKeyCache
      }
    }
  } catch {}
  deepseekKeyCache = ''
  return deepseekKeyCache
}

/**
 * AI 赋能模型配置（OpenViking VLM 用）：
 * 1) 优先 ~/.dsh/plugin-console/ai-empower.json（独立区块，显式覆盖）
 *    格式：{ "vlm": { "provider": "...", "api_base": "...", "model": "..." }, "api_key": "sk-..." }
 *    api_key 缺省时继承 DSH 凭据；vlm 缺省时整体回退 DSH 当前设置。
 * 2) 未配置区块 → 跟随 DSH：settings.yaml 的 agent-default-model + .credentials.yaml 的 DEEPSEEK_API_KEY。
 */
function readAiEmpowerConfig() {
  try {
    const cfgFile = join(homedir(), '.dsh', 'plugin-console', 'ai-empower.json')
    if (existsSync(cfgFile)) return JSON.parse(readFileSync(cfgFile, 'utf8'))
  } catch {}
  return null
}

function resolveVlmForOpenViking() {
  const custom = readAiEmpowerConfig()
  let base = null
  try {
    const settings = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    const m = /agent-default-model:\s*[\s\S]*?provider:\s*(\S+)\s*\n\s*model:\s*(\S+)/u.exec(settings)
    const p = m?.[1] ?? ''
    if (p === 'deepseek-official' || p === 'deepseek') {
      base = { provider: 'openai', api_base: 'https://api.deepseek.com', model: m[2] ?? 'deepseek-v4-flash-vision-exp' }
    }
  } catch {}
  if (base === null) base = { provider: 'openai', api_base: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp' }
  const vlm = custom?.vlm ?? base
  const apiKey = typeof custom?.api_key === 'string' && custom.api_key !== '' ? custom.api_key : readDeepSeekKey()
  return { provider: vlm.provider ?? 'openai', api_base: vlm.api_base ?? 'https://api.deepseek.com', model: vlm.model ?? 'deepseek-v4-flash-vision-exp', api_key: apiKey }
}

function resolvePlaceholders(value, jobOrEnv) {
  const env = jobOrEnv ?? {}
  const profile = env.profileDir ?? ''
  const python = resolvePythonPath()
  const home = homedir()
  return String(value)
    .replaceAll('${home}', home)
    .replaceAll('${profile}', profile)
    .replaceAll('${python}', python)
    .replaceAll('${scripts}', join(dirname(python), 'Scripts'))
    .replaceAll('${node}', process.execPath)
    .replaceAll('${deepseekKey}', readDeepSeekKey())
}

function resolvePythonPath() {
  const candidates = [join('E:', 'python314', 'python.exe'), join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python314', 'python.exe'), 'python.exe']
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'python.exe'
}

function findComponents() {
  try {
    const parsed = JSON.parse(readFileSync(componentsFile(), 'utf8'))
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.components) ? parsed.components : [])
  } catch {
    return []
  }
}

function saveComponents(list) {
  mkdirSync(dirname(componentsFile()), { recursive: true })
  writeFileSync(componentsFile(), JSON.stringify(list, null, 2), 'utf8')
}

function compFind(id) {
  return findComponents().find((c) => c.id === id) ?? null
}

/** 组件 UI 地址：显式 uiUrl 优先，否则从 healthUrl 去 /health 或按端口推断。 */
function compUiUrl(c) {
  if (typeof c?.uiUrl === 'string' && c.uiUrl !== '') return c.uiUrl
  if (typeof c?.healthUrl === 'string' && c.healthUrl !== '') return String(c.healthUrl).replace(/\/health$/u, '')
  if (c?.port) return `http://127.0.0.1:${c.port}/`
  return null
}

function compUpsert(record) {
  const list = findComponents()
  const idx = list.findIndex((c) => c.id === record.id)
  if (idx >= 0) list[idx] = { ...list[idx], ...record }
  else list.push(record)
  saveComponents(list)
  return record.id
}

function compRemove(id) {
  saveComponents(findComponents().filter((c) => c.id !== id))
}

/** 写入路径白名单：只允许 DSH profile、~/.dsh、~/.openviking、~/.cache/openviking、ASCII 数据根。 */
function isAllowedWritePath(p, profileDir) {
  const norm = (s) => s.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '')
  const target = norm(resolvePlaceholders(p, { profileDir }))
  const roots = [
    norm(homedir()) + '/.dsh',
    norm(homedir()) + '/.openviking',
    norm(homedir()) + '/.cache/openviking',
    norm(homedir()) + '/.local/share/openviking',
    norm(homedir()) + '/.dsh/repos',
    norm(profileDir),
    'D:/OpenVikingData',
  ]
  return roots.some((root) => target === root || target.startsWith(root + '/'))
}

/** run-cmd 可执行文件白名单（按 basename）。 */
const ALLOWED_RUN_FILES = new Set(['curl.exe', 'curl', 'git.exe', 'git', 'node.exe', 'node', 'python.exe', 'python', 'py.exe', 'py', 'gh.exe', 'gh', 'npm.cmd', 'npm', 'ov.cmd', 'ov'])
const DESTRUCTIVE_RE = /(^|\s)(rm\s+(-[a-zA-Z]*r)|rmdir\s+\/s|del\s+\/s|format\s+[a-zA-Z]:|Remove-Item\b|taskkill\s+\/im|reg\s+delete|schtasks\s+\/delete|shutdown|cipher\s+\/w)/iu

function isSafeRunCmd(file, args) {
  const base = basename(String(file)).toLowerCase()
  if (!ALLOWED_RUN_FILES.has(base)) return false
  const joined = [file, ...(args ?? [])].join(' ')
  return !DESTRUCTIVE_RE.test(joined) && !/[&|;`$<>]/u.test(joined)
}

function jobLog(job, line) {
  job.logText = `${job.logText ?? ''}${line}\n`
}

/** 已知组件内置模板：跳过 AI 调研，直接产出经过验证的部署计划（当前仅 OpenViking）。 */
function builtinPlanFor(source) {
  // 精确匹配 OpenViking 服务器本体（npm/pip 包名 openviking 或 volcengine/OpenViking 仓库），
  // 防止宽泛子串匹配误命中 openclaw_openviking_skill 之类的第三方包（曾实际发生误判）。
  const norm = String(source).trim().toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/^www\./u, '')
    .replace(/^github\.com\//u, '')
    .replace(/^raw\.githubusercontent\.com\//u, '')
    .replace(/\.git$/u, '')
    .replace(/\/$/u, '')
  if (norm !== 'openviking' && norm !== 'volcengine/openviking') return null
  const home = homedir()
  const storage = /^[\x00-\x7F]+$/u.test(home) ? `${home}/.openviking/data` : 'D:/OpenVikingData'
  const vlm = resolveVlmForOpenViking()
  // 注意：路径必须在此处（JSON.stringify 之前）使用真实值，由 stringify 统一转义；
  // 不能在 content 中保留 ${home} 占位符——写文件时替换会把反斜杠路径变成非法 JSON 转义。
  const ovConf = {
    server: { host: '127.0.0.1', port: 1933, cors_origins: ['*'] },
    vlm: { provider: vlm.provider, api_base: vlm.api_base, api_key: vlm.api_key, model: vlm.model },
    embedding: { dense: { provider: 'local', model: 'bge-small-zh-v1.5-f16', model_path: join(home, '.cache', 'openviking', 'models', 'bge-small-zh-v1.5-f16.gguf') } },
    storage: { workspace: storage },
  }
  const server = { name: 'openviking-server', file: '${python}', args: ['-m', 'openviking_cli.server_bootstrap'], cwd: '${home}/.openviking', healthUrl: 'http://127.0.0.1:1933/health', uiUrl: 'http://127.0.0.1:1933/studio', port: 1933 }
  return {
    type: 'service',
    displayName: 'OpenViking（本地记忆服务器）',
    summary: '安装 OpenViking 服务器（Python 3.14 + llama-cpp-python）、下载中文嵌入模型、写入 ov.conf（复用 DSH 的 DeepSeek 凭据、ASCII 存储路径）、启动并健康检查；完成后重启 DSH 会话即可出现 mcp__openviking__* 工具，pending 积压自动回放。',
    servers: [server],
    steps: [
      { action: 'install-pip', package: 'openviking[local-embed]', description: '安装 OpenViking 服务器（含本地嵌入 llama-cpp-python）' },
      { action: 'download', url: 'https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true', path: '${home}/.cache/openviking/models/bge-small-zh-v1.5-f16.gguf', description: '下载中文本地嵌入模型 bge-small-zh-v1.5-f16（47MB，走 hf-mirror）' },
      { action: 'write-file', path: '${home}/.openviking/ov.conf', content: JSON.stringify(ovConf, null, 2), description: '写入 ov.conf（DeepSeek VLM + 本地嵌入 + dev 免鉴权 + ASCII 存储路径）' },
      { action: 'start-service', ...server, description: '启动 openviking-server（127.0.0.1:1933）' },
      { action: 'wait-health', url: 'http://127.0.0.1:1933/health', timeoutMs: 90000, description: '等待健康检查通过' },
    ],
  }
}

/** AI 赋能预案：把已知环境事实与踩坑点固化为提示，避免子代理每次重新踩坑。 */
function aiEmpowerPresetFor(source) {
  const common = [
    '## 本机环境事实（务必遵守）',
    '- 网络：pypi.org 不通、清华镜像 403；pip 必须用 `--index-url https://mirrors.aliyun.com/pypi/simple/`。npm registry.npmjs.org 可能黑洞，pnpm 用 `--registry https://registry.npmmirror.com`。huggingface.co 被墙，模型文件一律用 `https://hf-mirror.com/<同一路径>`（执行器会自动把 huggingface.co 换成 hf-mirror.com，计划里也可直接写 hf-mirror）。',
    '- 用户名含中文（花火）：任何写盘路径若含中文，各语言的 Rust/原生向量库会报 UnicodeDecodeError——服务数据目录必须纯 ASCII（如 `D:/OpenVikingData`）。',
    '- 凭据复用：DSH 的 DeepSeek 密钥在 `${home}/.dsh/.credentials.yaml`（YAML 行 `DEEPSEEK_API_KEY: sk-...`）；模型选择在 `${home}/.dsh/settings.yaml` 的 `agent-default-model`（provider deepseek-official）。对外 OpenAI 兼容接口：api_base `https://api.deepseek.com`，模型名 `deepseek-v4-flash-vision-exp`。',
    '- 步骤解释用中文；每个动作一个步骤；步骤数尽量少；不得包含任何破坏性命令；服务类组件必须配 start-service + wait-health。',
  ]
  if (/openviking/i.test(source)) {
    return [
      ...common,
      '## OpenViking 已验证的部署事实（v0.4.17，Python 3.14）',
      '- 安装：`pip install openviking[local-embed]`（含 llama-cpp-python 0.3.35，cp310-abi3 轮子可用；无需加 --force-reinstall）。',
      '- 嵌入模型：`bge-small-zh-v1.5-f16.gguf`（47MB，512 维中文）下载到 `${home}/.cache/openviking/models/`（写 download 步骤；URL 写 huggingface.co 会被执行器自动换 hf-mirror.com）。',
      '- ov.conf 路径 `${home}/.openviking/ov.conf`，内容：vlm = { provider: openai, api_base: https://api.deepseek.com, model: deepseek-v4-flash-vision-exp, api_key: 从 `${home}/.dsh/.credentials.yaml` 读取并内联 }；embedding.dense = { provider: local, model: bge-small-zh-v1.5-f16, model_path: <上面的 gguf 路径> }；server = { host: 127.0.0.1, port: 1933 }（不要写 root_api_key，dev 免鉴权模式自动启用）；storage.workspace = `${home}` 含非 ASCII 时写 `D:/OpenVikingData`，否则 `${home}/.openviking/data`。',
      '- 启动：start-service，file=`${python}`，args=`["-m","openviking_cli.server_bootstrap"]`，cwd=`${home}/.openviking`，healthUrl=`http://127.0.0.1:1933/health`，port=1933。服务器启动首次会建 `D:/OpenVikingData` 数据目录。',
      '- 部署完成后惯例：重启 DSH 会话后 mcp__openviking__* 工具出现，`${home}/.openviking/pending` 的积压消息会在新会话启动时自动回放——把这写进总结。',
    ].join('\n')
  }
  return common.join('\n')
}

/** AI 赋能：规划阶段——子代理只读调研文档，产出结构化部署计划（JSON）。 */
async function aiEmpowerPlan(job, ctx, profileDir) {
  job.profileDir = profileDir
  job.status = 'running'
  job.stage = 'planning'
  let subagents = null
  try { subagents = ctx.get('subagents') } catch {}
  const startFn = subagents?.start
  if (typeof startFn !== 'function') {
    job.status = 'failed'
    job.error = 'AI 赋能需要 DSH 子代理服务（subagents），当前不可用'
    job.finishedAt = Date.now()
    return
  }
  let provider = 'spawn'
  try {
    const list = subagents.list?.() ?? []
    if (!list.includes(provider)) provider = list[0]
    if (provider === undefined) throw new Error('no provider')
  } catch (error) {
    job.status = 'failed'
    job.error = `没有可用的子代理提供方：${String(error)}`
    job.finishedAt = Date.now()
    return
  }
  // 优先用「Git 源」把目标仓库克隆到本地，让子代理读本地材料：
  // 内网/离线环境下 api.github.com 与 raw 通道不可达时，这是唯一可行的调研通道。
  let materialDir = null
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(String(job.source ?? '').trim())) {
    const srcDir = join(tmpdir(), `dsh-ai-src-${job.id}-${Date.now().toString(36)}`)
    try {
      mkdirSync(srcDir, { recursive: true })
      for (const url of gitCloneUrls(job.source)) {
        try {
          await execFileAsync('git', ['clone', '--depth', '1', '--quiet', url, srcDir], { timeout: 120000, windowsHide: true, env: gitEnv() })
          materialDir = srcDir
          break
        } catch {}
      }
    } catch {}
    if (materialDir === null) {
      try { rmSync(srcDir, { recursive: true, force: true }) } catch {}
    } else {
      job.materialDir = srcDir
      // 30 分钟后自动清理（规划+执行通常早已结束）
      const timer = setTimeout(() => { try { rmSync(srcDir, { recursive: true, force: true }) } catch {} }, 30 * 60 * 1000)
      if (typeof timer?.unref === 'function') timer.unref()
    }
  }
  const prompt = [
    '你是 DSH 插件控制台挂载的「AI 赋能」部署规划器。用户想把下面的组件完整部署到本机。',
    `目标来源：${job.source}`,
    '',
    '## 框架适配检测（控制台权威结果，规划时必须引用并向用户解释）',
    frameworkCheckPromptText(job.frameworkCheck),
    '',
    '【任务】只做只读调研与规划，禁止执行任何安装/写文件/启动服务/杀进程命令（curl 的 GET 抓取、gh api 查询、读取文件是允许的）。',
    materialDir !== null
      ? `调研材料：目标仓库已由控制台通过「Git 源」克隆到本地目录 ${materialDir} —— 直接读取该目录下的 README / package.json / docs/ / install 说明即可（无需联网，内网/离线环境同样可用）。`
      : '调研材料：npm README / GitHub README / docs/ 目录 / package.json / install 说明。',
    '全部调研完成后，输出且只输出一个 ```json ... ``` 代码块，内容为部署计划；代码块之外不要输出任何文字。',
    '',
    '计划 schema（严格遵循）',
    '{',
    '  "type": "pure-plugin" | "service" | "config-only",',
    '  "displayName": "简短中文名",',
    '  "summary": "一句话：这是什么、为何这样部署",',
    '  "servers": [ { "name": "进程名", "file": "启动文件/命令", "args": ["参数..."], "cwd": "工作目录", "healthUrl": "http://127.0.0.1:端口/health", "port": 1933 } ],',
    '  "steps": [ { "action": "...", "description": "中文说明", "...": "动作参数" } ]',
    '}',
    '',
    '动作与参数（每个动作一个步骤，按依赖顺序）',
    '- install-pip: {"package":"<包名[extras]>"}',
    '- install-npm: {"package":"<npm 包名>","directory":"${profile}"}',
    '- write-file: {"path":"<目标文件>","content":"<完整文件内容原文>"}',
    '- download: {"url":"https://...","path":"<保存路径>"}',
    '- run-cmd: {"file":"可执行文件","args":["..."]}（file 仅限 curl/git/node/python/py/gh/npm/ov）',
    '- start-service: {"name":"<唯一名>","file":"...","args":["..."],"cwd":"...","healthUrl":"...","port":数字}',
    '- wait-health: {"url":"http://127.0.0.1:端口/health","timeoutMs":60000}',
    '',
    '约束',
    '- 占位符只能用 ${home} ${profile} ${python} ${scripts} ${node}；write-file 的 content 会被原样落盘',
    '- 纯 npm 插件：type=pure-plugin，只写 install-npm 步骤，不要 servers',
    '- 若用户提供的来源带 @tag（如 pkg@beta），install-npm 的 package 必须原样保留该 @tag，不得丢弃',
    '- 危险命令（rm -rf、del /s、format、Remove-Item 等）出现在计划里会被拒绝执行',
    '',
    '## 调研纪律（必须遵守）',
    '- 禁止递归扫描目录（Get-ChildItem -Recurse、find /、rg 全盘搜索）；只允许：读 ~/.openviking/、~/.dsh 顶层文件（.credentials.yaml、settings.yaml）、文档缓存目录，以及 curl 单次直连抓取',
    '- 每条命令必须带超时：curl 用 --max-time 30；PowerShell 单命令控制在 15 秒内；抓取失败就跳过，不要反复重试同一 URL',
    '- 总调研时间预算 8 分钟；剩余时间必须全部用于生成 JSON 计划，禁止重复验证已经确定的事实',
    '',
    aiEmpowerPresetFor(job.source),
  ].join('\n')

  try {
    let parent = null
    try {
      const agents = ctx.get('agents')
      const list = typeof agents?.roots === 'function' ? agents.roots() : (typeof agents?.list === 'function' ? agents.list() : [])
      // 父代理选择：优先 cwd 与 DSH 服务工作区一致的会话（子代理 cwd 继承父会话），
      // 避免多工作区/多会话时借到别的 workspace 的会话导致调研错位
      const svcCwd = String(process.cwd() ?? '').replace(/[\\/]+$/u, '')
      const cwdOf = (a) => {
        try { return String(a?.session?.header?.cwd ?? a?.cwd ?? '').replace(/[\\/]+$/u, '') } catch { return '' }
      }
      parent = list.find((a) => cwdOf(a) !== '' && cwdOf(a) === svcCwd) ?? list[0] ?? null
      job.parentCwd = parent ? cwdOf(parent) : null
    } catch {}
    if (parent === null) {
      job.status = 'failed'
      job.error = 'AI 赋能无法借用活动会话（agents 注册表为空），请先开启一个会话再试'
      job.finishedAt = Date.now()
      return
    }
    const controller = new AbortController()
    job.abort = controller
    const run = await startFn.call(subagents, provider, {
      label: `ai-empower-plan-${String(job.source).split('/')[0]?.slice(0, 20) ?? 'component'}`,
      prompt: [{ type: 'text', text: prompt }],
      maxDepth: 1,
      signal: controller.signal,
      parent,
    })
    let settleFn = null
    try {
      const requireLocal = createRequire(join(profileDir, 'package.json'))
      ;({ settleRun: settleFn } = requireLocal('@deepseek-ai/dsh-subagent'))
    } catch {}
    const settle = settleFn ?? (async (runHandle) => {
      try {
        const result = await runHandle.result
        return { status: result?.stopReason === 'completed' ? 'completed' : 'failed', detail: String(result?.stopReason ?? 'unknown') }
      } catch (error) {
        return { status: 'failed', detail: String(error) }
      }
    })
    const outcome = await Promise.race([
      settle(run),
      new Promise((resolve) => setTimeout(() => {
        controller.abort()
        resolve({ status: 'failed', detail: 'AI 赋能规划超时（15 分钟）' })
      }, 900000)),
    ])
    if (outcome.status === 'completed') {
      const plan = parsePlanJson(String(outcome.output ?? outcome.detail ?? ''))
      if (plan === null) {
        job.status = 'failed'
        job.error = '子代理完成调研但未产出可解析的部署计划 JSON，请重试或手动部署'
      } else {
        job.plan = plan
        job.status = 'plan-ready'
      }
    } else {
      job.status = 'failed'
      job.error = `AI 赋能规划未成功（${outcome.detail ?? outcome.status}）`
    }
  } catch (error) {
    job.status = 'failed'
    job.error = `AI 赋能规划异常：${error instanceof Error ? error.message : String(error)}`
  }
  job.finishedAt = Date.now()
  saveAiJobs()
}

/** 从子代理输出中提取 ```json ... ``` 计划。 */
function parsePlanJson(text) {
  const m = /```json\s*([\s\S]*?)```/u.exec(text)
  const raw = m ? m[1] : text
  try {
    const plan = JSON.parse(raw)
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) return null
    for (const s of plan.steps) {
      if (typeof s.action !== 'string' || !['install-pip', 'install-npm', 'write-file', 'download', 'run-cmd', 'start-service', 'wait-health', 'register-component'].includes(s.action)) return null
    }
    return plan
  } catch {
    return null
  }
}

/** AI 赋能：执行阶段——按用户勾选的步骤顺序执行，逐步回显日志。 */
async function aiEmpowerExecute(job, ctx, profileDir, selected) {
  job.status = 'running'
  job.stage = 'executing'
  job.stepStates = (job.plan?.steps ?? []).map((_, i) => ({ index: i, status: 'skipped' }))
  if (job.abort) job.abort = null
  const controller = new AbortController()
  job.abort = controller
  const steps = job.plan?.steps ?? []
  const chosen = new Set((selected ?? steps.map((_, i) => i)).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < steps.length))
  const chosenList = steps.map((s, i) => ({ s, i })).filter((x) => chosen.has(x.i))
  let done = 0
  for (const { s, i } of chosenList) {
    if (controller.signal.aborted) {
      job.status = 'failed'
      job.error = '已取消执行（用户中断）'
      break
    }
    job.stepStates[i].status = 'running'
    job.progress = { done, total: chosenList.length }
    jobLog(job, `▶ 步骤 ${i + 1}/${steps.length} [${s.action}] ${s.description ?? ''}`)
    try {
      await runAiStep(job, s, ctx, profileDir, controller.signal)
      job.stepStates[i].status = 'ok'
      done += 1
      jobLog(job, `✔ 步骤 ${i + 1} 完成`)
    } catch (error) {
      job.stepStates[i].status = 'fail'
      job.status = 'failed'
      job.error = `步骤 ${i + 1}（${s.action}）失败：${error instanceof Error ? error.message : String(error)}`
      jobLog(job, `✘ 步骤 ${i + 1} 失败：${job.error}`)
      break
    }
  }
  if (job.status !== 'failed') {
    job.status = 'done'
    job.stage = 'done'
  }
  job.progress = { done, total: chosenList.length }
  job.finishedAt = Date.now()
  jobLog(job, job.status === 'done' ? '🎉 AI 赋能部署完成' : '⛔ AI 赋能部署中止')
  saveAiJobs()
}

/** 单步执行器：动作白名单 + 路径白名单 + 破坏性命令拦截。 */
async function runAiStep(job, step, ctx, profileDir, signal) {
  const profile = profileDir
  switch (step.action) {
    case 'install-pip': {
      const pkg = String(step.package ?? '')
      if (!/^[A-Za-z0-9_\-\.\[\]=\s]+$/u.test(pkg) || pkg === '') throw new Error(`包名不合法：${pkg}`)
      const python = resolvePythonPath()
      const params = ['-m', 'pip', 'install', pkg, '--index-url', 'https://mirrors.aliyun.com/pypi/simple/', '--disable-pip-version-check']
      jobLog(job, `  运行: ${python} ${params.join(' ')}`)
      await execFileAsync(python, params, { timeout: 900000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal })
      return
    }
    case 'install-npm': {
      const pkg = String(step.package ?? '')
      if (!/^(@[A-Za-z0-9_\-\.]+\/)?[A-Za-z0-9_\-\.]+(@[A-Za-z0-9_\-\.]+)?$/u.test(pkg)) throw new Error(`包名不合法：${pkg}`)
      const dir = resolvePlaceholders(String(step.directory ?? profile), { profileDir: profile })
      // 跨平台：不再拼 `node <node bin>/node_modules/corepack/dist/corepack.js`（Linux 上必 MODULE_NOT_FOUND，
      // 2026-09-20 另一位用户的 install-npm 失败现场就是这一行），改为按优先级尝试可用的执行方式
      const args = ['add', pkg, '--dir', dir, '--registry', 'https://registry.npmmirror.com']
      const { runner } = await runPnpmWithFallback(args, {
        execOpts: { timeout: 900000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal },
      })
      jobLog(job, `  运行: ${runner.note} ${args.join(' ')}`)
      return
    }
    case 'write-file': {
      const target = resolvePlaceholders(String(step.path ?? ''), { profileDir: profile })
      if (!isAllowedWritePath(target, profile)) throw new Error(`写入路径不在白名单内：${target}`)
      mkdirSync(dirname(target), { recursive: true })
      let content = resolvePlaceholders(String(step.content ?? ''), { profileDir: profile })
      // JSON 内容防御：若计划生成方用了占位符导致非法转义（路径反斜杠未转义），在这里拦住并给出明确报错
      const trimmed = content.trim()
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && content.length < 1024 * 1024) {
        try {
          JSON.parse(trimmed)
        } catch {
          throw new Error('write-file 的内容不是合法 JSON（占位符替换后可能残留未转义的反斜杠路径）：请让计划以 JSON.stringify 后的原文提供 content')
        }
      }
      writeFileSync(target, content, 'utf8')
      jobLog(job, `  已写入 ${target}（${content.length} 字节）`)
      return
    }
    case 'download': {
      const url = maskUrl(String(step.url ?? ''))
      if (!/^https?:\/\//u.test(url)) throw new Error(`下载地址不合法：${url}`)
      const target = resolvePlaceholders(String(step.path ?? ''), { profileDir: profile })
      if (!isAllowedWritePath(target, profile)) throw new Error(`下载路径不在白名单内：${target}`)
      mkdirSync(dirname(target), { recursive: true })
      if (existsSync(target) && statSync(target).size > 1024 * 1024) {
        jobLog(job, `  已存在，跳过下载：${target}（${statSync(target).size} 字节）`)
        return
      }
      const realUrl = String(step.url).replaceAll('https://huggingface.co', 'https://hf-mirror.com')
      jobLog(job, `  下载 ${maskUrl(realUrl)} → ${target}`)
      await execFileAsync('curl.exe', ['-fSL', '-o', target, realUrl], { timeout: 900000, windowsHide: true, maxBuffer: 1024 * 1024, signal })
      jobLog(job, `  下载完成（${statSync(target).size} 字节）`)
      return
    }
    case 'run-cmd': {
      const file = resolvePlaceholders(String(step.file ?? ''), { profileDir: profile })
      const args = (step.args ?? []).map((a) => resolvePlaceholders(String(a), { profileDir: profile }))
      if (!isSafeRunCmd(file, args)) throw new Error('run-cmd 未通过安全白名单校验（不允许的可执行文件或破坏性参数）')
      jobLog(job, `  运行: ${[file, ...args].join(' ')}`)
      const { stdout, stderr } = await execFileAsync(file, args, { timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal })
      jobLog(job, `  输出: ${String(stdout ?? '').slice(-1500)}${stderr ? `（stderr: ${String(stderr).slice(-500)}）` : ''}`)
      return
    }
    case 'start-service': {
      const name = String(step.name ?? 'service')
      const file = resolvePlaceholders(String(step.file ?? ''), { profileDir: profile })
      const args = (step.args ?? []).map((a) => resolvePlaceholders(String(a), { profileDir: profile }))
      const cwd = resolvePlaceholders(String(step.cwd ?? homedir()), { profileDir: profile })
      const healthUrl = typeof step.healthUrl === 'string' ? resolvePlaceholders(step.healthUrl, { profileDir: profile }) : null
      const uiUrl = typeof step.uiUrl === 'string' ? resolvePlaceholders(step.uiUrl, { profileDir: profile }) : null
      const port = Number(step.port ?? 0)
      if (!isSafeRunCmd(file, args)) throw new Error('start-service 未通过安全白名单校验')
      if (healthUrl !== null) {
        try {
          const probe = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) })
          if (probe.ok) {
            const slugPre = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
            compUpsert({ id: slugPre || `svc-${Date.now()}`, name, kind: 'server', pid: null, file, args, cwd, healthUrl, uiUrl, port, repo: job.source, installedAt: Date.now() })
            jobLog(job, `  服务健康已就绪，跳过启动（复用现有进程）：${healthUrl}`)
            return
          }
        } catch {}
      }
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd, shell: false })
      child.unref()
      const pid = child.pid
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
      const id = slug || `svc-${Date.now()}`
      if (healthUrl) {
        const alive = await waitHealth(healthUrl, 60000, job, signal).catch(() => false)
        if (!alive) jobLog(job, `  ⚠ healthUrl ${healthUrl} 在 60s 内未就绪（进程 pid=${pid} 已启动，待手工排查）`)
      }
      compUpsert({ id, name, kind: 'server', pid, file, args, cwd, healthUrl, uiUrl, port, repo: job.source, installedAt: Date.now() })
      jobLog(job, `  服务已启动：${name}（pid=${pid}${healthUrl ? `，healthUrl=${healthUrl}` : ''}）`)
      return
    }
    case 'stop-service': {
      const id = String(step.id ?? '')
      const record = compFind(id)
      if (!record || !record.pid) throw new Error(`组件不存在或未记录 pid：${id || '(空)'}`)
      await execFileAsync('taskkill.exe', ['/PID', String(record.pid), '/F'], { timeout: 30000, windowsHide: true })
      compUpsert({ id, pid: null })
      jobLog(job, `  服务已停止：${record.name}`)
      return
    }
    case 'wait-health': {
      const url = resolvePlaceholders(String(step.url ?? ''), { profileDir: profile })
      const timeoutMs = Number(step.timeoutMs ?? 60000)
      const ok = await waitHealth(url, timeoutMs, job, signal)
      if (!ok) throw new Error(`健康检查未通过：${url}（${timeoutMs}ms）`)
      return
    }
    case 'register-component': {
      const id = String(step.id ?? '')
      if (!id) throw new Error('register-component 缺少 id')
      compUpsert({ id, name: String(step.name ?? id), kind: String(step.kind ?? 'server'), pid: null, file: step.file ? resolvePlaceholders(String(step.file), { profileDir: profile }) : undefined, args: (step.args ?? []).map((a) => resolvePlaceholders(String(a), { profileDir: profile })), healthUrl: step.healthUrl ? resolvePlaceholders(String(step.healthUrl), { profileDir: profile }) : undefined, uiUrl: step.uiUrl ? resolvePlaceholders(String(step.uiUrl), { profileDir: profile }) : undefined, port: Number(step.port ?? 0), repo: job.source, installedAt: Date.now() })
      return
    }
    default:
      throw new Error(`未知动作：${step.action}`)
  }
}

async function waitHealth(url, timeoutMs, job, signal) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
      last = `HTTP ${res.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    jobLog(job, `  ⏳ 健康检查 ${url} … ${last}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  jobLog(job, `  ✘ 健康检查超时：${url}（最后状态 ${last}）`)
  return false
}

/** 组件控制：启动。 */
async function compStart(id) {
  const record = compFind(id)
  if (!record) throw new Error('组件不存在')
  if (record.pid && processAlive(record.pid)) return { started: false, note: '已在运行' }
  if (!record.file || !Array.isArray(record.args)) throw new Error('该组件没有记录启动命令')
  const child = spawn(record.file, record.args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: record.cwd ?? homedir(), shell: false })
  child.unref()
  compUpsert({ id, pid: child.pid })
  return { started: true, pid: child.pid }
}

/** 组件控制：停止。 */
async function compStop(id) {
  const record = compFind(id)
  if (!record) throw new Error('组件不存在')
  if (record.pid) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(record.pid), '/F'], { timeout: 30000, windowsHide: true })
    } catch {}
  }
  compUpsert({ id, pid: null })
  return { stopped: true }
}

/** 组件控制：状态（进程存活 + 健康探测；无 pid 但健康通过按运行中处理）。 */
async function compStatus(id) {
  const record = compFind(id)
  if (!record) throw new Error('组件不存在')
  let healthy = null
  if (record.healthUrl) {
    try {
      const res = await fetch(record.healthUrl, { signal: AbortSignal.timeout(2500) })
      healthy = res.ok
    } catch {
      healthy = false
    }
  }
  const running = Boolean(record.pid && processAlive(record.pid)) || healthy === true
  return { id, name: record.name, running, healthy, pid: record.pid ?? null, port: record.port ?? null, autoStart: record.autoStart === true }
}

/** DSH 启动时自动拉起标记 autoStart 的组件（幂等：已健康/已运行则跳过）。 */
async function autostartComponents() {
  for (const c of findComponents()) {
    if (c.autoStart !== true) continue
    if (c.healthUrl) {
      try {
        const res = await fetch(c.healthUrl, { signal: AbortSignal.timeout(2500) })
        if (res.ok) continue
      } catch {}
    } else if (c.pid && processAlive(c.pid)) {
      continue
    }
    try { await compStart(c.id) } catch {}
  }
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}
async function syncAggregateSubpackageVersions(profileDir, packageName, registries) {
  const pkgPath = join(profileDir, 'node_modules', packageName, 'package.json')
  if (!existsSync(pkgPath)) return []
  let pkg = null
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { return [] }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
  const updated = []
  for (const dep of Object.keys(deps)) {
    if (dep.startsWith('@deepseek-ai/')) continue
    const spec = String(deps[dep] ?? '').replace(/^[\^~>=< ]+/u, '')
    if (!spec) continue
    const currentPath = join(profileDir, 'node_modules', dep, 'package.json')
    if (!existsSync(currentPath)) {
      try {
        await curlManualInstall(profileDir, dep, registries, null, spec)
        updated.push(`${dep}@${spec}（新装）`)
      } catch {}
      continue
    }
    try {
      const current = JSON.parse(readFileSync(currentPath, 'utf8'))
      if (current.version === spec) continue
      await curlManualInstall(profileDir, dep, registries, null, spec)
      updated.push(`${dep}@${spec}`)
    } catch {}
  }
  return updated
}

/** 当前运行框架版本（@deepseek-ai/dsh package.json）。 */
function currentFrameworkVersion(ctx) {
  try {
    const require = createRequire(ctx?.baseUrl ?? 'file:///')
    const pkgPath = require.resolve('@deepseek-ai/dsh/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 定位框架安装根（顶层 node_modules）：优先运行进程入口，其次从包目录上溯找含 .pnpm 的 node_modules。 */
function resolveFrameworkRootNodeModules(fromDir) {
  try {
    const entry = process.argv[1]
    if (typeof entry === 'string' && /bin\.js$/u.test(entry)) {
      const nm = dirname(dirname(entry))
      if (existsSync(join(nm, '.pnpm')) && existsSync(join(nm, '@deepseek-ai'))) return nm
    }
  } catch {}
  let dir = typeof fromDir === 'string' && fromDir !== '' ? fromDir : null
  for (let i = 0; i < 24 && dir !== null; i += 1) {
    if (basename(dir) === 'node_modules' && existsSync(join(dir, '.pnpm'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 框架全树 checkpoint（可靠回滚点）：镜像 .pnpm 中所有 @deepseek-ai 条目「自包」内容 +
 * 顶层 @deepseek-ai scope + lock.yaml。只镜像自包、不跟随依赖 junction，避免重复拷贝；
 * 恢复时按同路径写回 .pnpm 条目即可让整个依赖世界回到升级前。
 */
function checkpointFrameworkTree(fwRoot, destRoot) {
  const pnpmRoot = join(fwRoot, '.pnpm')
  const dest = join(destRoot, 'fw-tree', String(Date.now()))
  mkdirSync(dest, { recursive: true })
  let mirrored = 0
  const selfNameOf = (entryName) => entryName.slice('@deepseek-ai+'.length).split('@')[0]
  for (const entry of readdirSync(pnpmRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('@deepseek-ai+')) continue
    const name = selfNameOf(entry.name)
    const selfDir = join(pnpmRoot, entry.name, 'node_modules', '@deepseek-ai', name)
    if (!existsSync(join(selfDir, 'package.json'))) continue
    copyTree(selfDir, join(dest, '.pnpm', entry.name, 'node_modules', '@deepseek-ai', name))
    mirrored += 1
  }
  const topScope = join(fwRoot, '@deepseek-ai')
  if (existsSync(topScope)) copyTree(topScope, join(dest, 'top-@deepseek-ai'))
  try { copyFileSync(join(pnpmRoot, 'lock.yaml'), join(dest, 'lock.yaml')) } catch {}
  try { copyFileSync(join(fwRoot, 'package.json'), join(dest, 'fw-package.json')) } catch {}
  return { dest, mirrored }
}

/**
 * 预设/组合文件的配置迁移门禁（2026-09-10 事故）：
 * 框架升级会改「插件配置 schema」——0.1.5 的 @deepseek-ai/dsh-persona 把 text 改名为 prefix（必填）。
 * 适配门只扫「已装插件包源码」，**预设不在其中**（~/.dsh/.agent-presets/<name>/agent.cordis.yml），
 * 于是升级后预设挂载失败 → 服务/会话起不来（这次就是这么挂的）。
 * 升级前按目标版本扫描并自动迁移（写 .bak 备份），返回迁移清单供步骤展示。
 */
const PRESET_CONFIG_MIGRATIONS = [
  { pkg: '@deepseek-ai/dsh-persona', from: 'text', to: 'prefix', since: '0.1.5' },
]

/**
 * 生成「拉起 DSH 服务」的 PowerShell 前导块（升级脚本 / 回滚脚本共用，v0.3.37 事故修复）。
 *
 * 2026-09-11 事故：脚本在「重启服务」这一步崩溃，服务没人拉起（框架其实已经升级成功，
 * 界面却显示全红）。根因是一条**静默的 null**：
 *     $binNow = ''; try { $binNow = (& node -e "…require.resolve…" | Select-Object -Last 1) } catch {}
 *     if ($binNow -ne '' -and (Test-Path $binNow)) { … }
 * 当 node 解析那一瞬间失败（新版链接尚未就绪等）时输出为空 → `Select-Object -Last 1` 让
 * `$binNow` 变成 **$null**，而 PowerShell 里 `$null -ne ''` 是 **true**（守卫失效）→
 * `Test-Path $null` 抛「无法将参数绑定到参数"Path"，因为该参数是空值」→ 脚本当场终止。
 * 同一段代码原先被复制了 5 份，所以这个坑反复出现。
 *
 * 现在：只保留这一份实现，并且
 *   1) 返回值**永不为 $null**（非字符串一律归一成空串，再做 IsNullOrWhiteSpace 判断）；
 *   2) 解析走**多级回退**（不再假设某一处路径一定可用）：node resolve → 目标版本的 .pnpm 实体
 *      目录 → 顶层可见链接 → .pnpm 里最新的一个；
 *   3) 全路径参数一律 `Test-Path -LiteralPath`，失败只记录、不抛错。
 */
function relaunchPrelude({ nodePath, pluginDir, fwRoot, target, ps }) {
  const probe = "const path=require('path');const p=require.resolve('@deepseek-ai/dsh/package.json',{paths:[process.env.DSH_RESOLVE_ROOT]});console.log(path.join(path.dirname(p),'lib','bin.js'))"
  const pnpmBin = (dirExpr) => `Join-Path ${dirExpr} 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'`
  return [
    `$launchLog = ''`,
    // 心跳（v0.3.39）：脚本每推进一小步就更新一次心跳文件的时间戳。服务端据此区分
    // 「脚本还在干活」与「脚本进程被系统/启动器杀掉」。2026-09-11 真机事故：回滚脚本
    // 干完活之后被 Ctrl+C 类事件结束（计划任务 Last Result = 0xC000013A），终态没写成，
    // 界面就永远卡在「回滚中…」——有心跳就能判定「脚本已死 + 现实是什么」。
    `$hb = $state + '.hb'`,
    `function Beat { try { Set-Content -Path $hb -Value ([string](Get-Date).Ticks) -Encoding UTF8 } catch {} }`,
    `try { Beat } catch {}`,
    `try { if ($log) { $launchLog = Join-Path (Split-Path -LiteralPath $log) 'fw-relaunch.log' } } catch {}`,
    `if ([string]::IsNullOrWhiteSpace($launchLog)) { $launchLog = Join-Path $env:TEMP 'fw-relaunch.log' }`,
    `function Resolve-DshBin {`,
    `  $cand = ''`,
    `  try { $env:DSH_RESOLVE_ROOT = ${ps(pluginDir)}; $cand = (& ${ps(nodePath)} -e "${probe}" 2>$null | Select-Object -Last 1) } catch { $cand = '' }`,
    `  if ($cand -isnot [string]) { $cand = '' }`,
    `  $cand = ([string]$cand).Trim()`,
    `  if ($cand -ne '' -and (Test-Path -LiteralPath $cand)) { return $cand }`,
    `  try { foreach ($d in @(Get-ChildItem -Path (Join-Path ${ps(fwRoot)} '.pnpm') -Directory -Filter '@deepseek-ai+dsh@${target}*' -ErrorAction SilentlyContinue)) { $c = ${pnpmBin('$d.FullName')}; if (Test-Path -LiteralPath $c) { return $c } } } catch {}`,
    `  try { $c = ${ps(join(fwRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))}; if (Test-Path -LiteralPath $c) { return $c } } catch {}`,
    `  try { foreach ($d in @(Get-ChildItem -Path (Join-Path ${ps(fwRoot)} '.pnpm') -Directory -Filter '@deepseek-ai+dsh@*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) { $c = ${pnpmBin('$d.FullName')}; if (Test-Path -LiteralPath $c) { return $c } } } catch {}`,
    `  return ''`,
    `}`,
    `function Invoke-DshRelaunch($tag) {`,
    `  $bin = Resolve-DshBin`,
    `  if ([string]::IsNullOrWhiteSpace($bin)) { Log ('拉起失败（' + $tag + '）：node resolve / .pnpm / 顶层链接 三种方式都找不到 dsh 的 bin.js，请手动启动 DSH'); return $false }`,
    `  try { Add-Content -Path $launchLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' 拉起(' + $tag + '): ' + $bin) -Encoding UTF8 } catch {}`,
    `  try { Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + ${ps(nodePath)} + '" "' + $bin + '" web >> "' + $launchLog + '" 2>&1')) -WindowStyle Hidden } catch { Log ('拉起进程启动失败（' + $tag + '）：' + $_.Exception.Message); return $false }`,
    `  Log ('已发起拉起服务（' + $tag + '，输出见 fw-relaunch.log）')`,
    `  return $true`,
    `}`,
  ].join('\r\n')
}

/** 待扫描的 agent 配置文件：所有预设 + profile 的 host 组合。 */
function collectAgentConfigFiles(profileDir) {
  const files = []
  const presetRoot = join(dshHome(), '.agent-presets')
  try {
    for (const entry of readdirSync(presetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const name of ['agent.cordis.yml', 'agent.cordis.yaml']) {
        const f = join(presetRoot, entry.name, name)
        if (existsSync(f)) files.push(f)
      }
    }
  } catch {}
  for (const name of ['cordis.yml', 'cordis.yaml', 'cordis.patch.yml']) {
    const f = join(profileDir, name)
    if (existsSync(f)) files.push(f)
  }
  return files
}

/** 迁移一个文件里 persona 行 config 的旧键（仅当尚无新键时改写，先写 .bak）。 */
function migratePresetPersona(file, mig) {
  let text = null
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const lines = text.split(/\r?\n/u)
  let rowAt = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp(`name:\\s*['"]?${escapeRegExp(mig.pkg)}['"]?\\s*$`, 'u').test(lines[i])) { rowAt = i; break }
  }
  if (rowAt === -1) return null
  let cfgAt = -1
  for (let i = rowAt + 1; i < lines.length; i += 1) {
    if (/^\s*config:\s*$/u.test(lines[i])) { cfgAt = i; break }
    if (/^\s*-\s+id:/u.test(lines[i])) break
  }
  if (cfgAt === -1) return null
  const cfgIndent = lines[cfgAt].match(/^\s*/u)[0].length
  let endAt = lines.length
  for (let i = cfgAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    if (line.match(/^\s*/u)[0].length <= cfgIndent) { endAt = i; break }
  }
  let hasNew = false
  let hit = -1
  for (let i = cfgAt + 1; i < endAt; i += 1) {
    if (new RegExp(`^\\s*${mig.to}:`, 'u').test(lines[i])) { hasNew = true; break }
    if (new RegExp(`^\\s*${mig.from}:`, 'u').test(lines[i])) hit = i
  }
  if (hasNew || hit === -1) return null
  lines[hit] = lines[hit].replace(new RegExp(`^(\\s*)${mig.from}:`, 'u'), `$1${mig.to}:`)
  try {
    copyFileSync(file, `${file}.bak-${Date.now()}`)
    writeFileSync(file, lines.join('\n'), 'utf8')
  } catch { return null }
  return { file, from: mig.from, to: mig.to, line: hit + 1, pkg: mig.pkg }
}

/** 目标版本是否 ≥ since（只比 major.minor.patch，忽略 rc 段——0.1.5-rc.1 也算已达 0.1.5 变更）。 */
function isVersionAtLeast(target, since) {
  const t = parseFrameworkVersion(target)
  const s = parseFrameworkVersion(since)
  if (t === -1 || s === -1) return false
  if (t.maj !== s.maj) return t.maj > s.maj
  if (t.min !== s.min) return t.min > s.min
  return t.pat >= s.pat
}

/** 升级前扫描预设/组合文件并按目标版本迁移（返回迁移清单）。导出供测试直接调用。 */
export function migrateAgentConfigsForUpgrade(profileDir, targetVersion) {
  const out = []
  if (typeof targetVersion !== 'string' || targetVersion === '') return out
  for (const mig of PRESET_CONFIG_MIGRATIONS) {
    if (!isVersionAtLeast(targetVersion, mig.since)) continue
    for (const file of collectAgentConfigFiles(profileDir)) {
      const done = migratePresetPersona(file, mig)
      if (done !== null) out.push(done)
    }
  }
  return out
}

/**
 * 启动失败日志分析器（纯函数，导出供测试）：
 * 从服务/预设的启动失败日志里提取「谁把服务搞挂了」——用于**启动失败隔离**（升级后服务拉不起来时，
 * 先禁用/隔离肇事者并重试，而不是整包回滚）。三类信号：
 *   ① 预设挂载失败：`preset "router-spec" failed to mount` 或路径 `.agent-presets/<name>/agent.cordis.yml`
 *   ② loader 条目应用失败：`failed to apply loader entry <rowId> (<moduleName>)`
 *   ③ 模块解析失败：`Cannot find module '<moduleName>'`
 * 返回 { presets:[name], modules:[{rowId,moduleName}], lines:[命中行] }
 */
export function analyzeBootFailure(logText) {
  const text = String(logText ?? '')
  const presets = new Set()
  const modules = new Map() // moduleName -> rowId|null
  const hits = []
  const pushHit = (line) => { if (hits.length < 40 && !hits.includes(line.trim())) hits.push(line.trim().slice(0, 300)) }

  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    let matched = false
    for (const m of line.matchAll(/preset\s+"([^"]+)"\s+failed to mount/gu)) { presets.add(m[1]); matched = true }
    for (const m of line.matchAll(/\.agent-presets[\\/]([^\\/\s"']+)[\\/]agent\.cordis\.ya?ml/gu)) { presets.add(m[1]); matched = true }
    for (const m of line.matchAll(/failed to apply loader entry\s+(\S+)\s+\(([^)]+)\)/gu)) { modules.set(m[2], m[1]); matched = true }
    for (const m of line.matchAll(/Cannot find module '([^']+)'/gu)) {
      if (!modules.has(m[1])) modules.set(m[1], null)
      matched = true
    }
    if (matched) pushHit(line)
  }
  return {
    presets: [...presets],
    modules: [...modules].map(([moduleName, rowId]) => ({ moduleName, rowId })),
    lines: hits,
  }
}

/** 启动失败隔离决策器（纯函数，导出供测试）。
 * 输入：启动失败日志 + 当前可开关行清单（[{rowId,moduleName,toggleable}]）。
 * 输出一份**可直接执行的隔离方案**（PowerShell 侧只负责照做，不掺判断逻辑）：
 *   presets  要隔离的预设文件（改名 .broken-<ts>，避免预设挂载失败拖垮整个服务）
 *   rows     要写入 disabled:true 的行（已剔除核心行/受保护行/控制台自身）
 *   safeMode 无明确肇事者时是否建议安全模式（禁用全部第三方行，先让服务起来）
 *   coreHits 命中的行属于核心/受保护（禁它没用，正确动作是回滚框架）
 * 设计依据：loader 单行 import 失败 = 整个服务启动崩溃；静态扫描抓不到全部不兼容，
 * 所以必须有一条「起不来 → 定位肇事者 → 隔离 → 重试」的运行时兜底。 */
export function planQuarantine({ logText, candidates, presetRoot = null, exists = existsSync }) {
  const analysis = analyzeBootFailure(logText)
  const byModule = new Map()
  const byRow = new Map()
  for (const c of candidates ?? []) {
    if (typeof c?.rowId !== 'string' || c.rowId === '') continue
    if (typeof c.moduleName === 'string' && c.moduleName !== '') byModule.set(c.moduleName, c)
    byRow.set(c.rowId, c)
  }
  const rows = []
  const coreHits = []
  const unknown = []
  for (const m of analysis.modules) {
    const hit = (m.rowId !== null && byRow.get(m.rowId)) || byModule.get(m.moduleName) || null
    if (hit === null) { unknown.push(m.moduleName); continue }
    const isCore = CORE_PATCH_ROW_IDS.has(hit.rowId) || hit.rowId === 'plugin-console'
    if (isCore || hit.toggleable === false) { coreHits.push({ rowId: hit.rowId, moduleName: hit.moduleName }); continue }
    if (!rows.includes(hit.rowId)) rows.push(hit.rowId)
  }
  const root = presetRoot ?? join(dshHome(), '.agent-presets')
  const presets = []
  for (const name of analysis.presets) {
    const file = join(root, name, 'agent.cordis.yml')
    presets.push({ name, file, exists: exists(file) })
  }
  return {
    presets,
    rows,
    unknown,
    coreHits,
    safeMode: presets.length === 0 && rows.length === 0,
    lines: analysis.lines,
  }
}

/** 框架升级前置门禁（用户硬要求：「升级后所有不适配的必须先禁用」）。
 * 在升级脚本执行**之前**扫描全部可开关行，对目标框架版本判定为 fail 的行就地写 disabled:true，
 * 并记入 compat-pending（UI 显示「待适配」，更新后一键解锁）。这样新框架 boot 时不会因为
 * 某行 import 失败而整树崩溃（loader 单行失败 = 服务起不来）。
 * 受保护行/核心行/自身永不禁用——禁它们本身就会让服务起不来。
 * 返回 { disabled:[{rowId,moduleName,version,reason}], skipped:[{rowId,reason}] } */
export async function preflightDisableIncompatible({ ctx, profileDir, patchPath, targetVersion }) {
  const disabled = []
  const skipped = []
  const gate = readCompatGate()
  if (typeof targetVersion !== 'string' || targetVersion === '') return { disabled, skipped }
  let entries = []
  try { entries = listEntries(ctx) } catch { return { disabled, skipped } }
  let pending = readCompatPending()
  if (pending === null || !Array.isArray(pending.pending)) pending = { frameworkVersion: targetVersion, upgradeFrom: null, pending: [] }
  for (const entry of entries) {
    if (typeof entry.rowId !== 'string' || entry.rowId === '') continue
    if (!entry.enabled) continue
    if (entry.rowId === 'plugin-console') continue // 控制台自己永不禁用
    if (!entry.toggleable || CORE_PATCH_ROW_IDS.has(entry.rowId)) {
      skipped.push({ rowId: entry.rowId, reason: '受保护/核心行（禁用会让服务起不来，改由启动失败隔离兜底）' })
      continue
    }
    let pkg = null
    let pkgDir = null
    try {
      const pkgPath = resolvePackageJson(entry.moduleName, profileDir)
      if (pkgPath !== null) { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); pkgDir = dirname(pkgPath) }
    } catch {}
    if (pkg === null) {
      skipped.push({ rowId: entry.rowId, reason: '无法读取包信息（保持启用，改由启动失败隔离兜底）' })
      continue
    }
    // v0.3.35：框架自带包永不自动禁用（真机演练抓到：框架自己的 settings 控制器被误判成不适配）。
    // 它们与框架同源安装，禁用不是正确处置——正确处置是回滚；误判则直接砍掉框架功能。
    if (isFrameworkOwnedPackage(pkgDir, profileDir)) {
      skipped.push({ rowId: entry.rowId, reason: '框架自带包（与框架同源安装，禁用不是正确处置，改由回滚兜底）' })
      continue
    }
    let check = { decision: 'unknown', reason: '' }
    try { check = checkPluginFrameworkCompat(pkg, targetVersion, pkgDir) } catch (error) { check = { decision: 'unknown', reason: error instanceof Error ? error.message : String(error) } }
    if (check.decision !== 'fail') continue // pass / unknown 一律不禁用（避免过度禁用把功能砍掉）
    if (gate.autoDisable !== true) {
      // 总开关关闭：只报告不动开关（用户定案：自动行为必须可关）
      skipped.push({ rowId: entry.rowId, reason: `判定不适配（${check.reason ?? '不兼容'}），但「升级时自动禁用」已关闭——保持启用，请手动处理` })
      continue
    }
    try {
      await disableEntry(patchPath, entry.rowId)
    } catch (error) {
      skipped.push({ rowId: entry.rowId, reason: `禁用写入失败：${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const version = typeof pkg.version === 'string' ? pkg.version : null
    disabled.push({ rowId: entry.rowId, moduleName: entry.moduleName, version, reason: check.reason ?? null })
    const record = {
      rowId: entry.rowId,
      moduleName: entry.moduleName,
      version,
      status: 'pending',
      check: 'fail',
      checkNote: check.reason ?? null,
      forcedAt: Date.now(),
      source: 'preflight-disabled-before-upgrade',
    }
    const at = pending.pending.findIndex((p) => p.rowId === entry.rowId)
    if (at >= 0) pending.pending[at] = { ...pending.pending[at], ...record }
    else pending.pending.push(record)
  }
  if (disabled.length > 0) {
    pending.frameworkVersion = targetVersion
    pending.updatedAt = new Date().toISOString()
    writeCompatPending(pending)
  }
  return { disabled, skipped }
}

/** 移除补丁中的单行 disabled/forced 覆盖块（兼容门解锁用）。 */
function removeDisableBlock(patchPath, rowId) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    const overrideRe = new RegExp(`^- id: ${escapeRegExp(rowId)}\\s*\\r?\\n {2}disabled: (true|false)\\s*\\r?\\n`, 'mu')
    const next = text.replace(overrideRe, '')
    if (next !== text) await writeFile(patchPath, sanitizePatchText(next), 'utf8')
  })
}

/** 从「子包版本对齐」记录解析纯包名（如 '@linxin666/dsh-pet@0.2.1（新装）'）。 */
function syncNameFromNote(note) {
  const m = String(note ?? '').match(/^((?:@[^/]+\/)?[^@]+)/u)
  return m ? m[1] : null
}

/**
 * 框架升级适配门：安装/更新完成后自动校验兼容性，
 * 通过（版本已变化 + 未在声明/依赖层面明确不兼容）则移除补丁禁用块并解锁启用。
 */
async function maybeAutoAdaptCompat({ profileDir, packageName, syncedNames, patchPath, ctx }) {
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
async function frameworkCompatReportFor(source, ctx, profileDir) {
  const fwVer = currentFrameworkVersion(ctx)
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

async function runInstallJob(job, ctx) {
  try {
    job.stage = 'preparing'
    // 2026-09-06 事故（室友机器）：对 deepseek-ai/deepseek-harness（框架本体仓库）点「添加到本地/安装」
    // 会按 bundle 规则注册其 patch，其中 deepseek-ai-dsh-root 等框架级行的包只存在于 npx 缓存/框架树，
    // profile node_modules 不存在 → 整服务启动崩溃。直接拦截。
    const repoNorm = String(job.repo ?? '').toLowerCase().replace(/^git\+/u, '').replace(/\.git$/u, '')
    if (repoNorm === 'deepseek-ai/deepseek-harness') {
      job.status = 'failed'
      job.error = '这是 DSH 框架本体仓库，不能按插件安装（其组件引用框架内部包，安装后会导致服务启动失败）。如需升级框架请用「框架升级」按钮；如需生态插件请选择 dsh-plugin 插件仓库。'
      return
    }
    let candidates = [job.packageName].filter((name) => typeof name === 'string' && name !== '')
    let subpackageMode = false
    if (candidates.length === 0) {
      // 套装兜底：submodule 聚合仓库（根 .gitmodules 内容校验通过）→ 自动转套装安装，
      // 不依赖前端标记（搜索结果 enrich 是异步的、索引浏览条目无 enrich）。
      // 判据是**内容**（resolveInstallKind），不是"探测非 null"：后者会把代理/CDN 对不存在文件回的
      // 2xx 空 body、垃圾页当成套装（2026-09-19 用户反馈的「未找到 .gitmodules」事故根因）。
      if (resolveInstallKind(job.kind, await probeGitmodules(job.repo)) === 'suite') {
        job.kind = 'suite'
        const suiteResult = await runSuiteInstallJob(job, ctx)
        // clone 后才发现没有 .gitmodules（探测假阳性 / 仓库已重构）→ 回落普通安装，不给用户一个失败
        if (suiteResult?.notASuite !== true) return
        job.kind = 'plugin'
        job.suiteNote = '探测到的 .gitmodules 与仓库实际内容不符（不是 submodule 套装仓库），已自动回落普通插件安装'
      }
      // 兜底：宿主端自行拉取仓库元数据（githubJson 与 curl 竞速 + 8s 超时降级，黑洞期不卡 40s）。
      // 8s 而非旧值 3s：IPv6 无路由的环境里单条通道就要 5.4s，3s 预算必输 → branch 恒为 main，
      // 默认分支为 dev 的仓库会取错分支（2026-09-20 另一位用户实测）。
      const meta = await Promise.race([
        Promise.any([
          githubJson(`${GITHUB_API}/repos/${job.repo}`),
          curlJson(`${GITHUB_API}/repos/${job.repo}`, 12000, {}, { ipv4: true }),
        ]),
        new Promise((resolve) => setTimeout(() => resolve(null), META_BUDGET_MS)),
      ]).catch(() => null)
      const branch = meta?.default_branch ?? 'main'
      const { pkg, reason } = await fetchRepoPackageEx(job.repo, branch)
      if (pkg === null) {
        // 无 package.json：先探测是否技能仓库（含 SKILL.md）→ 自动转技能安装；
        // 否则标记 hint=repo-land，前端给出「仓库落地」一键入口（克隆到本地目录）。
        const skillProbe = await detectSkillRepo(job.repo, branch)
        if (skillProbe.hasSkill) {
          job.kind = 'skill'
          await runSkillInstallJob(job)
          return
        }
        job.status = 'failed'
        job.hint = 'repo-land'
        // 文案区分「抓取超时/不可达」与「真的没有」——旧代码两者共用一个出口，报错永远说"文件不存在"
        job.error = packageProbeErrorText(job.repo, branch, reason)
        job.probeReason = reason
        return
      }
      if (pkg.private === true) {
        // 私有 monorepo 根：自动列出子包作为候选（把人工修复经验自动化），聚合包优先
        subpackageMode = true
        // 2026-09-20 事故（用户点装 zhu1090093659/dsh-web，报"未发现子包"）：该仓库根包确实
        // private: true，但 main/dev 各有 22 个子包目录。失败原因是当时市场索引源全挂、网络受限，
        // subpackageCandidates() 读不到列表 —— 旧代码只有"有没有子包"一个出口，把**没读到**
        // 报成了**不存在**，直接把用户带偏。教训：探测失败必须与确定性结论分开表达。
        let subs = await subpackageCandidates(job.repo, branch)
        if (subs.length === 0) {
          // 读不到时先换一条分支重试：meta 探测失败时 branch 恒为 main，而默认分支为 dev 的仓库
          // （本例 dsh-web 就是 dev 为默认分支）main 上的子包布局可能不同/为空；
          // 换分支几乎零成本，却能把"分支取错"这一类假失败挡在报错之前。
          const altBranch = branch === 'main' ? 'dev' : 'main'
          subs = await subpackageCandidates(job.repo, altBranch)
          if (subs.length > 0) job.subpackageNote = `子包列表取自 ${altBranch} 分支（默认分支探测可能失败）`
        }
        if (subs.length === 0) {
          job.status = 'failed'
          // 文案要点：说清"这是读不到、不是没有"，并给出可直接复制的安装命令 ——
          // 用户看到"未发现子包"会去翻仓库找，而真相多半只是本次网络没读成。
          job.error = `仓库 ${job.repo} 的根包未发布到 npm（private: true），且本次没能读到它的子包列表（多为网络受限/超时，不代表没有子包）。请重试；或在「查看」详情里确认子包名后直接安装，例如：dsh plugin --profile web add @linxin666/dsh-web-all`
          job.probeReason = 'subpackages-unreadable'
          return
        }
        candidates = subs
        job.subpackages = candidates
      } else {
        candidates = [pkg.name]
      }
      job.packageName = pkg.name
    }
    // 给了根包名但根包实际是 private 聚合仓库（如直接填 dsh-web-ui）：
    // 与仓库模式同路径——直接展开子包（聚合包优先），跳过 git 装根包的无意义尝试
    if (!subpackageMode && job.repo && job.packageName !== null) {
      const rootPkg = await fetchRepoPackage(job.repo, 'main')
      if (rootPkg !== null && rootPkg.private === true) {
        subpackageMode = true
        const subs = await subpackageCandidates(job.repo, 'main', readGithubAuth().token)
        if (subs.length > 0) {
          candidates = [...subs.filter((name) => !candidates.includes(name)), ...candidates]
          job.subpackages = subs
        }
      }
    }
    job.stage = 'installing'
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const taken = new Set(listEntries(ctx).map((entry) => entry.rowId))
    const patch = await readPatchState(patchPath)
    for (const id of [...patch.inserts, ...patch.disables, ...patch.forced]) taken.add(id)
    let installedName = null
    let lastError = null
    let expanded = false
    // 可配置软件源：主→备依次尝试（默认 npmmirror → npmjs，可增删自定义/内网源）
    const registries = orderedRegistries(readSources())
    const deadline = Date.now() + 8 * 60 * 1000
    for (let index = 0; index < candidates.length && installedName === null; index += 1) {
      if (Date.now() > deadline) break
      const name = candidates[index]
        // 加法优化：包已在 node_modules 且名字匹配时，不再重复安装/触发 EPERM，直接进入启用流程
        if (installedName === null) {
          const existingTarget = join(profileDir, 'node_modules', name, 'package.json')
          if (existsSync(existingTarget)) {
            try {
              const existingPkg = JSON.parse(readFileSync(existingTarget, 'utf8'))
              if (existingPkg && existingPkg.name === name && job.update !== true) {
                installedName = name
                job.curlNote = `已检测到本地已安装 ${name}@${existingPkg.version ?? '?'}，跳过重复下载`
              }
            } catch {}
          }
        }
        // 加法并行竞速：pnpm 与 curl 同时启动，先成功者生效；失败方 abort，不影响后续串行通道
        if (installedName === null && !subpackageMode && !expanded) {
          const raced = await raceInstallChannels(profileDir, name, registries)
          if (raced) {
            installedName = name
            if (raced.channel === 'curl') {
              const racedInfo = raced.info
              const stillMissing = await backfillMissingDeps(profileDir, racedInfo.missingDeps, registries)
              job.curlNote = `已通过并行 curl 通道安装 v${racedInfo.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
              if (racedInfo.boxNote) job.curlNote += `（盒子验证：${racedInfo.boxNote}）`
            }
          }
        }
      // 通道 1..n：配置的软件源依次尝试（每源 90 秒封顶）
      for (let ri = 0; ri < registries.length && installedName === null; ri += 1) {
        try {
          await pnpmInstall(profileDir, name, registries[ri])
          installedName = name
          break
        } catch (error) {
          lastError = error
        }
      }
      if (installedName === null) {
        // 通道 n+1：curl 手动安装（node 网络黑洞时 pnpm 下载卡死、curl 可用）——
        // 下载 registry tarball 解压到 node_modules，零依赖包可完整安装
        if (!subpackageMode && !expanded) {
          try {
            const info = await curlManualInstall(profileDir, name, registries)
            installedName = name
            const stillMissing = await backfillMissingDeps(profileDir, info.missingDeps, registries)
            job.curlNote = `已通过 curl 通道安装 v${info.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
            if (info.boxNote) job.curlNote += `（盒子验证：${info.boxNote}）`
          } catch (curlError) {
            lastError = curlError
          }
        }
      }
      if (installedName === null) {
        // 通道 n+1b：GitHub release 下载安装（npm 上不存在的包，例如面板自身
        // @deepseek-ai/dsh-plugin-console）——拉 latest release 源码 tarball → 盒子验证 → 覆盖。
        // 触发条件：curl 通道失败（registry 404/网络），且能从 job.repo 或已装包 repository 反查到 GitHub。
        if (!subpackageMode && !expanded) {
          let ghRepo = typeof job.repo === 'string' && job.repo !== '' && job.repo.includes('/') ? job.repo : null
          if (ghRepo === null) {
            try {
              const meta = entryPkgMeta(name, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
              const repoUrl = typeof meta?.repository === 'string' ? meta.repository : (meta?.repository && typeof meta.repository === 'object' ? meta.repository.url : null)
              const m = typeof repoUrl === 'string' ? repoUrl.replace(/^git\+/u, '').match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/u) : null
              if (m) ghRepo = m[1]
            } catch {}
          }
          if (ghRepo !== null) {
            try {
              const info = await githubReleaseInstall(profileDir, ghRepo, name)
              installedName = name
              const stillMissing = await backfillMissingDeps(profileDir, info.missingDeps, registries)
              job.curlNote = `已通过 GitHub release 通道安装 v${info.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
              if (info.boxNote) job.curlNote += `（盒子验证：${info.boxNote}）`
            } catch (ghError) {
              lastError = ghError
            }
          }
        }
      }
      if (installedName === null) {
        // 通道 n+2：git 通道（GitHub 走加速代理+直连；Gitee 走对应平台；各 60 秒封顶）
        if (!subpackageMode && !expanded) {
          const gitSpecs = job.source === 'gitee'
            ? [`git+https://gitee.com/${job.repo}.git`]
            : [
                ...gitCloneUrls(job.repo).map((u) => `git+${u}`),
                `github:${job.repo}`,
              ]
          for (const spec of gitSpecs) {
            try {
              await pnpmInstall(profileDir, spec, undefined, 60000)
              installedName = name
              break
            } catch (gitError) {
              lastError = gitError
            }
          }
        }
      }
      if (installedName !== null) break
      // Windows 原子替换失败（陈旧目录 / _tmp_ 残留）是 EPERM 类错误的根因：
      // 清理后用主源重试一次（把 AI 人工修复经验自动化，减少 AI 兜底触发）
      if (installedName === null && /EPERM|EACCES|rename/i.test(String(lastError?.message ?? ''))) {
        const cleaned = cleanupStalePackageDir(profileDir, name)
        if (cleaned > 0) {
          try {
            await pnpmInstall(profileDir, name, registries[0])
            installedName = name
          } catch (error) {
            lastError = error
          }
        }
      }
      if (installedName !== null) break
      // 懒惰展开：registry 与 git 通道都失败时，自动发现仓库子包继续尝试（聚合包优先），
      // 覆盖"给了根包名但根包未发布"的场景——AI 兜底只处理真正无解的案例
      if (!expanded && job.repo) {
        expanded = true
        let subs = await fetchSubpackageNames(job.repo, 'main', readGithubAuth().token)
        if (subs.length === 0) subs = await fetchSubpackageNames(job.repo, 'master', readGithubAuth().token)
        if (subs.length > 0) {
          const extra = subs
            .slice()
            .sort((a, b) => Number(/(^|-)all$/u.test(b.name) || /-all-/u.test(b.name)) - Number(/(^|-)all$/u.test(a.name) || /-all-/u.test(a.name)))
            .map((sub) => sub.name)
            .filter((n) => !candidates.includes(n))
            .slice(0, 8)
          if (extra.length > 0) {
            candidates = [...candidates, ...extra]
            if (!Array.isArray(job.subpackages)) job.subpackages = []
            for (const e of extra) if (!job.subpackages.includes(e)) job.subpackages.push(e)
          }
        }
      }
    }
    if (installedName === null) {
      // 本地 AI 兜底会调用模型 API、产生费用：挂起等待用户明确同意后再执行
      job.stage = 'ai-consent'
      job.aiPending = { lastError: lastError?.message ?? null }
      job.aiWait = new Promise((resolve) => { job.aiPending.resolver = resolve })
      const decision = await Promise.race([
        job.aiWait,
        new Promise((resolve) => setTimeout(() => resolve({ approved: false, timeout: true }), 600000)),
      ])
      job.aiPending = null
      job.aiWait = null
      if (decision.approved === true) {
        await aiRepair(job, ctx, profileDir, candidates, lastError?.message ?? null)
      } else {
        job.status = 'failed'
        job.error = decision.timeout === true
          ? '等待授权超时（10 分钟），已取消本地 AI 兜底（该操作会调用模型 API 产生费用）'
          : '用户取消本地 AI 兜底（该操作会调用模型 API 产生费用）'
      }
      return
    }
    job.packageName = installedName
    // 聚合包子包版本对齐（确保更新后所有子包也到新版声明版本）
    let syncedNames = []
    try {
      const synced = await syncAggregateSubpackageVersions(profileDir, installedName, registries)
      if (synced.length > 0) {
        syncedNames = synced.map(syncNameFromNote).filter((n) => n !== null)
        job.bundleNote = (job.bundleNote ? job.bundleNote + '；' : '') + `子包版本对齐：更新 ${synced.length} 个（${synced.join('、')}）`
      }
    } catch {}
    // 聚合包完整性保障（防崩）：bundle patch 引用的包缺失 → 补装；仍缺自动禁用该行。
    // 本次作业刚同步过版本的包（syncedNames）处于更新瞬时态，跳过"缺失自动禁用"判定。
    try {
      const integrity = await ensureBundlePatchIntegrity(profileDir, installedName, patchPath, [...syncedNames, installedName])
      if (integrity.checked > 0) {
        job.bundleNote = `聚合包完整性：检查 ${integrity.checked} 个引用`
          + (integrity.installed.length > 0 ? `，补装 ${integrity.installed.length} 个（${integrity.installed.join('、')}）` : '')
          + (integrity.disabled.length > 0 ? `，自动禁用缺失行 ${integrity.disabled.length} 个（${integrity.disabled.join('、')}）` : '')
          + (integrity.pending.length > 0 ? `，本次已同步包跳过缺失判定 ${integrity.pending.length} 个（${integrity.pending.join('、')}）` : '')
          + (integrity.missing.length > 0 ? `，仍缺失 ${integrity.missing.join('、')}（网络恢复后建议重新更新）` : '')
      }
    } catch {}
    // 框架升级适配门：更新完成后自动校验兼容性，通过则移除禁用块解锁启用
    try {
      const adapt = await maybeAutoAdaptCompat({ profileDir, packageName: installedName, syncedNames, patchPath, ctx })
      if (adapt !== null && adapt.ran === true) job.compatNote = adapt.note
    } catch {}
    job.stage = 'configuring'
    // 2026-09-06 事故（i18n 更新变重复行）：@linxin666/dsh-i18n 声明了 dsh.bundle.patch，
    // 更新流程按「bundle 安装规则」把它追加进 bundles → 与全家桶内的 web-ui-i18n 行（同包）重复。
    // 防护：该包已被现有行提供 → 只更新包，不注册任何新行/bundle。
    const alreadyServed = listEntries(ctx).some((e) => String(e.moduleName).startsWith(installedName)
      || String(e.moduleName) === installedName
      || packageNameOf(e.moduleName) === installedName)
    if (await detectBundleOnly(profileDir, installedName)) {
      // 官方 dsh plugin add 行为：声明 dsh.bundle 的包追加为 profile bundle 层，
      // 其 cordis.patch.yml 在下次启动时参与组合（含皮肤包与 web-ui-settings 这类有入口的包）
      if (!alreadyServed) {
        // 通用防线（2026-09-06 事故：装 dsh-desktop 类插件时,其 bundle patch 引用 @deepseek-ai/dsh-root 等
        // 框架级行,包不在 profile node_modules → 注册后整服务启动崩溃）：
        // 注册前校验 bundle patch 引用的行模块全部可解析（**含 @deepseek-ai/* —— 正是室友崩塌的那些框架级包**）,
        // 缺失即拒绝注册并给出清单。
        const refs = readBundlePatchRefNames(profileDir, installedName)
        const missing = refs.filter((n) => resolvePackageJson(n, profileDir) === null)
        if (missing.length > 0) {
          job.status = 'failed'
          job.error = `该聚合包（${installedName}）的插件组引用以下未安装模块：${missing.join('、')}。若这些是框架内部包（@deepseek-ai/*）,该包不能作为插件安装（会导致服务启动失败）；若为本应随包安装的依赖,请重试或检查网络。已取消注册。`
          return
        }
        await addBundleToManifest(profileDir, installedName)
        job.bundle = true
      } else {
        job.bundleNote = (job.bundleNote ? job.bundleNote + '；' : '') + `${installedName} 已由已安装聚合包提供，仅更新包本身，不再注册重复行`
      }
      job.status = 'done'
      return
    }
    if (alreadyServed) {
      job.note = `${installedName} 已由已安装条目提供，仅更新包本身，不重复注册`
      job.status = 'done'
      return
    }
    const entryId = deriveEntryId(installedName, taken)
    await appendInsert(patchPath, entryId, installedName)
    job.entryId = entryId
    job.status = 'done'
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    job.finishedAt = Date.now()
  }
}

/** 组装当前插件清单（镜像 dsh-host-plugin-inventory 的读取逻辑）。 */
function listEntries(ctx) {  const entries = []
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const moduleName = entry.options.name
    const rowId = rowIdOf(ctx, entry.id)
    const protectedRow = isProtectedModule(moduleName)
    entries.push({
      entryId: entry.id,
      rowId,
      moduleName,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      protected: protectedRow,
      toggleable: rowId !== 'plugin-console'
        && !protectedRow
        && typeof moduleName === 'string'
        && !moduleName.startsWith('cordis:'),
    })
  }
  return entries
}

/** 应用插件：注册 /plugin-console 路由。 */
export function apply(ctx) {
  // 恢复 AI 赋能任务（restart 后 running 置失败，plan-ready/结果保留）
  loadAiJobs()
  // 升级脚本的「启动失败隔离」记录并入适配门清单（让用户看到谁被自动关了）
  // v0.3.44：这里的 catch 不再静默 —— 2026-09-11 那次隔离记录（20 行）就是这样凭空消失的：
  // 合并函数在中途抛错、catch 吞掉，界面只剩一个没有解释的【停用】。失败必须留痕。
  try { mergeQuarantineRecord(ctx) } catch (error) { logQuarantineMergeError(error) }
  // v0.3.45：清单与现实对账 —— 补 moduleName（否则「全家桶一键启用已适配」永远匹配不到），
  // 以及把「已经启用、却还挂着 pending」的记录转成已适配（用户实测：启用后重启又变【待适配】）
  try {
    const fixed = reconcileCompatPending(ctx)
    if (fixed.backfilled > 0 || fixed.adopted > 0) {
      try { writeFileSync(join(dshHome(), 'plugin-console', 'fw-merge-error.log'), `${new Date().toISOString()} 清单对账：补 moduleName ${fixed.backfilled} 行，已启用转已适配 ${fixed.adopted} 行\n`, { flag: 'a' }) } catch {}
    }
  } catch (error) { logQuarantineMergeError(error) }
  // 启动时清掉上次升级/回滚/重启留下的僵尸计划任务（脚本被强杀时来不及自删）
  try { cleanupStaleFwTasks() } catch {}
  // DSH 启动时自动拉起标记了「自启动」的服务器组件（幂等，不阻塞启动）
  autostartComponents().catch(() => {})
  ctx.effect(() => {
    const route = {
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
          sendError(res, 403, '仅允许本机访问')
          return
        }
        const port = webPort(ctx)
        const host = typeof req.headers?.host === 'string' ? req.headers.host : ''
        if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
          sendError(res, 403, 'Host 校验失败（仅允许本机访问）')
          return
        }
        // 安全护栏（issue #9）：写路由必须是本机同源请求，防止恶意网页跨站驱动敏感操作。
        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD' && !isAllowedWriteOrigin(req, port)) {
          sendError(res, 403, '跨站请求被拒绝（Origin/Sec-Fetch-Site 校验）')
          return
        }
        try {
          await handle(ctx, req, res)
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
      },
    }
    return ctx.webServer.register(route)
  }, 'plugin-console: routes')
}

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/state`) {
    const patchPath = findPatchPath(ctx)
    const patch = await readPatchState(patchPath)
    // 补丁安全自愈（核心行误禁用恢复 / 缺失模块行自动禁用）——每 2 分钟最多跑一次
    let patchHeal = null
    try {
      if (patchHealAt === null || Date.now() - patchHealAt > 120000) {
        patchHealAt = Date.now()
        patchHeal = await healPatchSafety(patchPath)
      } else {
        patchHeal = patchHealReport
      }
      if (patchHeal !== null) patchHealReport = patchHeal
    } catch {}
    const extraRows = await readExtraBundleRows(dirname(patchPath))
    const compatPending = readCompatPending()
    const compatPendingRows = new Set((compatPending?.pending ?? []).filter((p) => (p.status ?? 'pending') === 'pending').map((p) => p.rowId))
    // 兼容门总开关 + 自动检测（只提示不自动开）
    const compatGate = readCompatGate()
    const adoptable = compatGate.autoDetect ? detectAdoptablePending(ctx) : new Map()
    let rollbackRec = null
    try {
      const rr = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8'))
      if (rr !== null && typeof rr.checkpointDir === 'string' && existsSync(join(rr.checkpointDir, '.pnpm'))) {
        rollbackRec = { from: rr.from ?? null, to: rr.to ?? null, at: rr.at ?? null, applicable: true }
      }
    } catch {}
    const entries = listEntries(ctx).map((entry) => {
      const meta = entryPkgMeta(entry.moduleName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
      return {
        ...entry,
        userDisabled: patch.disables.includes(entry.rowId),
        userForced: patch.forced.includes(entry.rowId),
        extra: patch.inserts.includes(entry.rowId) || extraRows.has(entry.moduleName) || extraRows.has(entry.rowId),
        installDate: meta?.installDate ?? null,
        version: meta?.version ?? null,
        repository: meta?.repository ?? null,
        // v0.3.45：只有"补丁里此刻确实还禁着它"的行才显示【待适配】——
        // 记录与开关脱节时（用户手动启用过 / 补丁块被清掉）不能继续挂着「待适配」误导人
        pendingCompat: compatPendingRows.has(entry.rowId) && patch.disables.includes(entry.rowId),
        // 自动检测结果（只提示，不自动开）：该待适配行现在是否已适配（插件已更新 + 扫描通过）
        adoptable: adoptable.get(entry.rowId) ?? null,
      }
    })
    const compat = await detectCompat(ctx.baseUrl ?? 'file:///')
    const auth = readGithubAuth()
    const jobs = [...installJobs.values()].filter((job) => job.status === 'installing').map(installJobView)
    const recentFailures = [...installJobs.values()].filter((job) => job.status === 'failed').slice(-3).map(installJobView)
    // 框架升级检测与适配（备份快照 + 重打框架补丁），try 包裹不阻塞 state 返回
    let framework = null
    try { framework = detectFrameworkUpgrade(ctx) } catch {}
    // 回滚可用性（2026-09-11 用户困惑：版本已经回滚了，回滚按钮还能点）——
    // 当前版本已经等于记录里的 from 时，再点回滚等于"恢复到你现在这个版本"，无意义。
    if (rollbackRec !== null) {
      const currentVer = typeof framework?.version === 'string' ? framework.version : null
      rollbackRec.applicable = !(currentVer !== null && rollbackRec.from !== null && currentVer === rollbackRec.from)
    }
    let selfVersion = null
    try {
      const selfPkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
      selfVersion = typeof selfPkg.version === 'string' ? selfPkg.version : null
    } catch {}
    sendJson(res, 200, { ok: true, entries, patchPath, compat, installJobs: jobs, recentFailures, github: { loggedIn: auth.loggedIn, login: auth.login }, patch: { disables: patch.disables, forced: patch.forced, inserts: patch.inserts }, framework, patchHeal: patchHeal === null ? null : { healed: patchHeal.healed ?? [], autoDisabled: patchHeal.autoDisabled ?? [], healedAt: patchHeal.healedAt ?? 0 }, compatPending: compatPending === null ? null : { frameworkVersion: compatPending.frameworkVersion ?? null, upgradeFrom: compatPending.upgradeFrom ?? null, pending: (compatPending.pending ?? []).filter((p) => (p.status ?? 'pending') === 'pending').map((p) => ({ rowId: p.rowId, moduleName: p.moduleName, version: p.version ?? null, checkNote: p.checkNote ?? null, check: p.check ?? null, riskyApprovedAt: p.riskyApprovedAt ?? null, adoptable: adoptable.get(p.rowId) ?? null })) }, compatGate, rollback: rollbackRec, selfVersion, components: findComponents().map((c) => ({ id: c.id, name: c.name, kind: c.kind ?? 'server', pid: c.pid ?? null, port: c.port ?? null, healthUrl: c.healthUrl ?? null, uiUrl: compUiUrl(c), autoStart: c.autoStart === true })) })
    return
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/sources`) {
    const sources = readSources()
    sendJson(res, 200, { ok: true, sources: maskSources(sources), giteeStatus: giteeStatusView(sources) })
    return
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/gitee-oauth-url`) {
    const gitee = readGiteeConfig(readSources())
    if (!gitee.clientId) {
      sendError(res, 400, '请先在软件源管理中配置 Gitee 应用的 client_id / client_secret')
      return
    }
    const port = webPort(ctx)
    const redirect = `http://127.0.0.1:${port}/plugin-console/gitee-oauth-callback`
    // scope 请求 user_info + projects：Gitee 会校验请求的 scope 必须在应用已勾选的权限范围内，
    // 应用权限必须同步勾选 user_info、projects，否则报「请求范围无效、未知或格式不正确」
    const state = createGiteeOAuthState()
    const url = `${GITEE_AUTH_URL}?client_id=${encodeURIComponent(gitee.clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent('user_info projects')}&state=${encodeURIComponent(state)}`
    sendJson(res, 200, { ok: true, url, redirect, state })
    return
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/gitee-oauth-callback`) {
    const code = new URL(req.url ?? '/', 'http://x').searchParams.get('code')
    const state = new URL(req.url ?? '/', 'http://x').searchParams.get('state')
    const sources = readSources()
    const gitee = readGiteeConfig(sources)
    const failPage = (text) => {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<h3>${text}</h3>`)
    }
    if (!code) {
      failPage('这是 Gitee 授权回调地址，不能直接访问。<br>正确流程：插件面板 → 软件源管理 → 填入 client_id / client_secret → 保存配置 → 点击「授权登录 Gitee」，授权完成后会自动跳回这里。')
      return
    }
    if (!state || !consumeGiteeOAuthState(state)) {
      failPage('Gitee OAuth state 校验失败，请重新发起授权。')
      return
    }
    if (!gitee.clientId || !gitee.clientSecret) {
      failPage('未配置 Gitee 应用：请先在 gitee.com 创建第三方应用（回调地址填本页完整地址），再在插件面板 → 软件源管理 中填入 client_id / client_secret 并保存。')
      return
    }
    const port = webPort(ctx)
    const redirect = `http://127.0.0.1:${port}/plugin-console/gitee-oauth-callback`
    const result = await postJsonUrl(GITEE_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      client_id: gitee.clientId,
      client_secret: gitee.clientSecret,
      redirect_uri: redirect,
    })
    if (result.status < 200 || result.status >= 300 || !result.body || !result.body.access_token) {
      failPage('Gitee 授权失败：token 交换错误，请检查 client_id / client_secret')
      return
    }
    gitee.token = result.body.access_token
    try {
      const user = await fetchJsonUrl(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(gitee.token)}`)
      gitee.login = user && typeof user.login === 'string' ? user.login : ''
    } catch {}
    sources.gitee = gitee
    await writeSources(sources)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h3>Gitee 授权成功，可以关闭此页面并回到插件面板</h3>')
    return
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/framework-upgrade-status`) {
    // 框架升级进度（页面断连后重连恢复进度条用）：读状态文件 {status|message}
    let status = { status: 'idle', message: null }
    try {
      const f = join(dshHome(), 'plugin-console', 'fw-upgrade-state.txt')
      if (existsSync(f)) {
        // PS5.1 Set-Content -Encoding UTF8 会写 BOM——strip 掉，否则 status 变成 '\uFEFFdone'，
        // 客户端 status === 'done' 永不匹配（进度条/悬浮按钮不消失）
        let raw = readFileSync(f, 'utf8')
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
        const [st, ...rest] = raw.split('|')
        const at = statSync(f).mtimeMs
        // v0.3.37：失败记录里带 stage=<崩溃前最后阶段>，界面据此把已完成的步骤显示成 ✓（而不是整列 ✕）
        const stageRaw = rest.find((p) => p.startsWith('stage='))
        const stage = stageRaw === undefined ? null : (stageRaw.slice(6) || null)
        status = { status: st ?? 'idle', message: rest.filter((p) => !p.startsWith('stage=')).join('|') || null, stage, at }
        // ── v0.3.39 状态自愈 ──────────────────────────────────────────────────
        // 2026-09-11 真机：回滚脚本干完活之后**进程被 Ctrl+C 类事件结束**（计划任务 Last Result
        // = 0xC000013A），终态没写成 → 界面永远卡在「回滚中…」并每 3 秒轮询。心跳 + 现实核对
        // 能把它纠正回来：脚本不再心跳（>90 秒没动静）时，用「已装版本 vs 回滚记录的 from/to」
        // 判断真实结果；同时清掉残留的 DSH-FW-* 计划任务。
        const terminal = status.status === 'idle' || status.status === 'done' || status.status === 'failed'
        if (!terminal) {
          let hbAge = null
          try { hbAge = Date.now() - statSync(`${f}.hb`).mtimeMs } catch { hbAge = null }
          const scriptAlive = hbAge !== null && hbAge < 90000
          if (!scriptAlive) {
            let rec = null
            let current = null
            try { rec = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8')) } catch {}
            try {
              const localRequire = createRequire(ctx.baseUrl ?? 'file:///')
              current = JSON.parse(readFileSync(localRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version ?? null
            } catch {}
            const upgradedTo = rec !== null && typeof rec.to === 'string' && current === rec.to
            const rolledBackTo = rec !== null && typeof rec.from === 'string' && current === rec.from
            // 「安装阶段」不能靠 from 判定（那时本来就还是旧版本），只认 to
            if (upgradedTo) {
              status = { ...status, status: 'done', reconciled: { from: st, note: `脚本进程已中断，但框架已是 ${current}、服务正常 —— 实际结果：升级成功` } }
            } else if (rolledBackTo && (st === 'rollback' || st === 'relaunching' || st === 'stopped')) {
              status = { ...status, status: 'done', reconciled: { from: st, note: `脚本进程已中断，但框架已回到 ${current}、服务正常 —— 实际结果：回滚成功` } }
            } else if (hbAge !== null) {
              status = { ...status, stalled: true, note: '升级/回滚脚本已超过 90 秒没有心跳，进程可能已被结束——请用「重新检查版本」核对，必要时重启服务' }
            }
            if (status.reconciled !== undefined) cleanupStaleFwTasks()
          }
        }
        // 失败但框架本体其实已经装到目标版本：明确告诉用户「升级本体成功、失败的是重启那一步」，
        // 免得整列红叉让人以为白干了（2026-09-11 真机事故就是这样）。
        if (status.status === 'failed') {
          try {
            const rr = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8'))
            const cur = JSON.parse(readFileSync(join(rr.fwRoot, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
            if (typeof rr.to === 'string' && rr.to !== '' && cur === rr.to) status.frameworkAtTarget = cur
          } catch {}
        }
        // 残留清理：非终止状态（starting/stopped/installing/rollback/pkg/relaunching）超过 15 分钟
        // 视为上次升级的残留——升级脚本要么成功（done）要么失败（failed），服务重启后不可能还在
        // 中途；任务调度失败/脚本空跑时状态会永远停在 starting，重启后不应再自动恢复进度条。
        // （升级进行中页面断连后用户手动重启服务属边缘情况：<15 分钟不受影响，进度仍可恢复）
        if (status.status !== 'idle' && status.status !== 'done' && status.status !== 'failed'
          && Date.now() - at > 15 * 60 * 1000) {
          try { writeFileSync(f, 'idle|', 'utf8') } catch {}
          status = { status: 'idle', message: null, at: Date.now() }
        }
      }
    } catch {}
    sendJson(res, 200, { ok: true, ...status })
    return
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/framework-relaunch`) {
    // 手动拉起服务（升级期间左侧悬浮按钮调用）：Start-Process node bin.js web。
    // 端口已有监听则不重复拉起；bin.js 缺失时明确报错。
    const port = webPort(ctx)
    const binPath = resolveDshBin()
    const nodePath = process.execPath
    if (binPath === null || !existsSync(binPath)) {
      sendError(res, 500, '无法定位 DSH 启动入口（bin.js 缺失）')
      return
    }
    try {
      const ps1 = join(tmpdir(), `console-relaunch-${Date.now()}.ps1`)
      const lines = [
        '$ok = $false',
        `try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true } } catch {}`,
        `if (-not $ok) { Start-Process -FilePath ${JSON.stringify(nodePath)} -ArgumentList ${JSON.stringify(binPath)},'web' -WindowStyle Hidden }`,
      ]
      writeFile(ps1, lines.join('\r\n'), 'utf8').then(
        () => execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true }, () => {}),
        () => {},
      )
      sendJson(res, 200, { ok: true, message: '已发起手动拉起（端口无监听时自动启动服务）' })
    } catch (error) {
      sendError(res, 500, `拉起失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/skills-installed`) {
    // 已安装技能清单（~/.dsh/skills 用户根）+ 插件自带技能（ctx.skills 聚合，只读展示）
    const skills = listInstalledSkills()
    let pluginSkills = []
    try {
      const skillsSvc = ctx.get('skills')
      const extra = await Promise.race([
        (async () => (typeof skillsSvc?.list === 'function' ? await skillsSvc.list({}) : []))(),
        new Promise((resolve) => setTimeout(() => resolve([]), 1500)),
      ])
      for (const s of extra ?? []) {
        if (s && typeof s.name === 'string' && !skills.some((x) => x.name === s.name)) {
          pluginSkills.push({ name: s.name, description: s.description ?? null, provider: s.provider ?? null, system: true })
        }
      }
    } catch {}
    sendJson(res, 200, { ok: true, skills, pluginSkills })
    return
  }

  // GET 兼容白名单：只读且无副作用的接口允许 GET 调用
  // （market-index 曾被客户端以 GET 调用，落进 405 后错误被静默吞掉，导致静态索引长期未生效）
  const GET_COMPAT = new Set([`${ROUTE_PREFIX}/market-index`])
  if (method !== 'POST' && !(method === 'GET' && GET_COMPAT.has(pathname))) {
    sendError(res, 405, '不支持的方法')
    return
  }

  const body = await readBody(req)

  if (pathname === `${ROUTE_PREFIX}/github-login`) {
    // GitHub 登录（市场页「未登录 GitHub」徽章 → 内联面板）：用粘贴的 token 换登录名并写入
    // <DSH_HOME>/github-auth.json —— 与独立插件 dsh-github-login 同一份文件、同一格式 { token, login }。
    //
    // 三条安全约束（改这里时不要破）：
    //   ① token 只进不出：响应只回 login，绝不回显 token，也不写任何日志（日志会落进 console 文件）
    //   ② 先校验形状再发网络请求：明显不是 PAT 的串不浪费一次 GitHub 往返
    //   ③ 落盘尽量收紧权限（POSIX 0600；Windows 无此权限模型，失败忽略）
    const token = typeof body?.token === 'string' ? body.token.trim() : ''
    // classic（ghp_/gho_/ghu_/ghs_/ghr_）与 fine-grained（github_pat_）两种 PAT 形状
    if (!/^(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/u.test(token)) {
      sendError(res, 400, '令牌格式不正确（应为 GitHub personal access token，ghp_/github_pat_ 开头）')
      return
    }
    // 为什么不用 githubJson 校验：它内部会与 gh CLI 通道并行竞速（raceFirst2xx），而 gh 默认用
    // 本机 keyring 里已有的凭据、**完全忽略我们传入的 token**。本机装了已登录的 gh 时，一个填错的
    // token 也会因 gh 通道 2xx 而"验证成功"（2026-09-20 实测：本机 gh 登录 Noob-stupid，ghp_aaa…
    // 能拿到 Noob-stupid），于是错误 token 被写进 github-auth.json，把用户真实登录态顶掉。
    // githubJsonUserWithToken 的两条通道都只认用户给的这个 token（详见其注释）。
    let login = null
    try {
      const me = await githubJsonUserWithToken(token)
      login = typeof me?.login === 'string' && me.login !== '' ? me.login : null
    } catch (error) {
      // gh 通道的原始报错带 execFile 的 "Command failed: gh api …" 命令回显与多行 stderr，
      // 压成一行再给用户看（原文只含状态与命令名，不含 token —— 我们从不把 token 传进命令行）
      const message = (error instanceof Error ? error.message : String(error))
        .replace(/Command failed:[^\n]*\n?/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
      // 与"子包列表读不到 ≠ 不存在"同一课：**"没验成"不等于"令牌无效"**。通道全挂（证书/超时/DNS）
      // 时报"令牌无效"会把用户往错的方向带（去重新生成 token），必须分开说；文案里仍然不带 token 本身。
      const transport = /证书|certificate|超时|timeout|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket|network|aborted|未找到 gh CLI/iu.test(message)
      sendError(res, 400, transport
        ? `无法连接 GitHub 校验令牌（网络/证书问题，不代表令牌无效，可重试）：${message}`
        : `令牌无效或权限不足：${message}`)
      return
    }
    if (login === null) {
      sendError(res, 400, '令牌无效或权限不足：GitHub 未返回登录名')
      return
    }
    const authFile = join(dshHome(), 'github-auth.json')
    try {
      mkdirSync(dshHome(), { recursive: true })
      // mode 只在新建时生效，所以再显式 chmod 一次：老文件可能是 0644（token 不该对同机其他用户可读）
      await writeFile(authFile, `${JSON.stringify({ token, login }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(authFile, 0o600) } catch {}
    } catch (error) {
      sendError(res, 500, `写入登录状态失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    sendJson(res, 200, { ok: true, login })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/details`) {
    const { entryId } = body
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    const entry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
    if (!entry) {
      sendError(res, 404, `没有名为 ${entryId} 的插件条目`)
      return
    }
    const moduleName = entry.options.name
    const details = await readPluginDetails(moduleName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
    sendJson(res, 200, { ok: true, entryId, rowId: rowIdOf(ctx, entryId), moduleName, ...details })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/toggle`) {
    const { entryId, enabled } = body
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    if (typeof enabled !== 'boolean') {
      sendError(res, 400, 'enabled 必须是布尔值')
      return
    }
    const exists = ctx.loader.entries().some((entry) => entry.id === entryId)
    if (!exists) {
      sendError(res, 404, `没有名为 ${entryId} 的插件条目`)
      return
    }
    const target = ctx.loader.entries().find((entry) => entry.id === entryId)
    if (isProtectedModule(target?.options?.name)) {
      sendError(res, 403, `${target.options.name} 属于宿主基础设施，禁止开关（停用会破坏热加载/传输/存储链）`)
      return
    }
    const rowId = rowIdOf(ctx, entryId)
    if (rowId === 'plugin-console') {
      sendError(res, 400, '不能停用插件控制台自身')
      return
    }
    if (enabled) {
      // 框架升级适配门（用户定案 2026-09-11：**软禁**）——自动禁用的目的是「保证新框架能起来」，
      // 不是「剥夺用户控制权」：默认自动禁用，但允许手动强行启用（首次请求返回 needsConfirm，
      // 前端弹风险提示确认框；带 confirmRisky:true 才放行）。
      // 注意下面还有一条**硬**门禁：启用前的 import 冒烟检查——那条是事实性崩溃（模块根本加载不了），
      // 不允许覆盖（否则下次启动必崩，与「服务永不崩」冲突）。
      const compatPending = readCompatPending()
      const pend = (compatPending?.pending ?? []).find((p) => p.rowId === rowId && (p.status ?? 'pending') === 'pending')
      if (pend) {
        if (body.confirmRisky !== true) {
          sendError(
            res,
            409,
            `「${rowId}」在框架升级适配门清单中（框架 ${compatPending.frameworkVersion ?? '?'}${pend.checkNote ? `，判定：${pend.checkNote}` : ''}）——已自动禁用。强行启用可能让 DSH 下次启动失败，需要你确认。`,
            {
              code: 'compat-confirm',
              rowId,
              moduleName: pend.moduleName ?? null,
              frameworkVersion: compatPending.frameworkVersion ?? null,
              checkNote: pend.checkNote ?? null,
            },
          )
          return
        }
        try {
          const next = readCompatPending()
          const rec = (next?.pending ?? []).find((p) => p.rowId === rowId)
          if (rec) { rec.riskyApprovedAt = Date.now(); writeCompatPending(next) }
        } catch {}
      }
    }
    const patchPath = findPatchPath(ctx)
    // 启用前冒烟检查（服务永不崩机制）：第三方模块在独立子进程中试 import，
    // 失败（SyntaxError/缺失导出/模块缺失）即拒绝启用，杜绝「单行 import 失败→整个服务启动崩溃」
    if (enabled) {
      const moduleName = target?.options?.name
      if (typeof moduleName === 'string' && !moduleName.startsWith('cordis:') && !moduleName.startsWith('@deepseek-ai/')) {
        try {
          const probe = await probePluginImport(moduleName, dirname(patchPath))
          if (probe.ok !== true) {
            sendError(res, 409, `启用前冒烟检查未通过：模块加载失败（${probe.detail ?? '未知'}）——该插件与当前框架不兼容或依赖缺失，已阻止启用（服务不会再被拖崩）；请先「检测更新/更新并适配」其适配版`)
            return
          }
        } catch {}
      }
    }
    const result = enabled
      ? await enableEntry(patchPath, rowId)
      : await disableEntry(patchPath, rowId)
    // v0.3.45（用户定案：启用即视为已适配，但保留痕迹）：手动启用一个待适配行后，
    // 清单里的 pending 记录要转成 adopted —— 否则重启后界面上会出现「已启用却还挂着【待适配】」，
    // 用户实测就是这样（5 行）。check / checkNote / riskyApprovedAt 一律保留供事后查。
    if (enabled) {
      try {
        const list = readCompatPending()
        const meta = rowIdModuleMap(ctx).get(rowId) ?? null
        if (list !== null && markPendingAdopted(list, rowId, 'manual-enable', meta)) {
          list.updatedAt = new Date().toISOString()
          writeCompatPending(list)
        }
      } catch {}
    }
    sendJson(res, 200, { ok: true, entryId, rowId, enabled, changed: result.changed, patchPath })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/uninstall`) {
    const { entryId } = body
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    const entry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
    if (!entry) {
      sendError(res, 404, `没有名为 ${entryId} 的插件条目`)
      return
    }
    const moduleName = entry.options.name
    const rowId = rowIdOf(ctx, entryId)
    if (rowId === 'plugin-console') {
      sendError(res, 400, '不能删除插件控制台自身')
      return
    }
    if (isProtectedModule(moduleName)) {
      sendError(res, 403, `${moduleName} 属于宿主基础设施，禁止删除`)
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const patch = await readPatchState(patchPath)
    // bundle 来源的额外插件（如皮肤中心）：删除其所属 bundle
    const owners = await readExtraBundleOwners(profileDir)
    const ownerBundle = owners.get(rowId) ?? owners.get(moduleName)
    if (ownerBundle !== undefined) {
      // 2026-09-04 事故教训：删除聚合包子路径行（如 @linxin666/dsh-web-all/plugin-manager）时
      // 曾把整个 bundle 从清单移除，pnpm 卸载失败（corepack 报错）后重启，全家桶整体消失。
      // 现改为：任何 bundle 行的「删除」= 仅停用该行（patch disabled:true），bundle 清单不动，
      // 之后随时可「启用」恢复；整体卸载请走包管理器。
      await disableEntry(patchPath, rowId)
      sendJson(res, 200, {
        ok: true,
        removed: 'row',
        packageName: moduleName,
        restart: false,
        note: '该行来自聚合包 ' + ownerBundle + '，已仅停用本行（bundle 保留，可随时启用恢复）；整体卸载请用包管理器执行 pnpm remove ' + ownerBundle,
      })
      return
    }
    if (!patch.inserts.includes(rowId)) {
      sendError(res, 400, '该插件不是用户安装的额外插件（不可删除）')
      return
    }
    await removeInsertRow(patchPath, rowId)
    let uninstallError = null
    try {
      await pnpmRemove(profileDir, moduleName)
    } catch (error) {
      uninstallError = error instanceof Error ? error.message : String(error)
    }
    sendJson(res, 200, { ok: true, removed: 'entry', packageName: moduleName, restart: false, uninstallError })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/search`) {
    const raw = typeof body.q === 'string' ? body.q.trim() : ''
    const query = raw === '' ? DEFAULT_SEARCH : raw
    const page = Math.max(Math.min(Number.parseInt(String(body.page), 10) || 1, 5), 1)
    const source = typeof body.source === 'string' && body.source !== '' ? body.source : 'github'
    const all = body.all === true
    const auth = readGithubAuth()
    let items = []
    // 给前端的补充说明（如"代码搜索需登录"）——放响应里，前端据此给提示，不改 items 结构
    const extraNotes = {}
    // 增量检索（前端浏览器直连成功时**并行**调用）：只补「npm 包名映射 + in:readme 重查 + 代码搜索子包」，
    // 不重复仓库搜索。为什么需要它：直连成功就不会走本路由，而未登录用户恰恰只能走直连
    // （2026-09-20 事故：未登录 + 索引加载失败 → 三条检索路全断，搜 web-all 搜不到 dsh-web）。
    if (body.extras === true) {
      const extra = []
      if (raw !== '') {
        try { extra.push(...await searchNpmPackages(raw, orderedRegistries(readSources()), 3, auth.token)) } catch {}
        try {
          const again = await githubJson(
            `${GITHUB_API}/search/repositories?q=${encodeURIComponent(`${raw} in:name,description,readme${all ? '' : ' topic:dsh-plugin'}`)}&sort=stars&order=desc&per_page=20&page=1`,
            req.signal,
            auth.token,
          )
          extra.push(...normalizePlatformItems(again.items ?? [], 'main').map((it) => ({ ...it, source: 'github', viaReadme: true })))
        } catch {}
        try { extra.push(...await searchSubpackageItems(raw, auth.token, req.signal)) } catch {}
      }
      sendJson(res, 200, {
        ok: true,
        query: raw,
        items: extra,
        extras: true,
        authenticated: auth.loggedIn,
        source: 'github',
        ...(raw !== '' && !auth.loggedIn ? { codeSearchSkipped: true } : {}),
      })
      return
    }
    if (body.multi === true) {
      // 多源汇总：GitHub + 全部自定义搜索源并行检索，结果合并（每项带 source 标记）。
      // Gitee 为直装模式（关键词搜索无意义），不参与多源汇总。
      const sources = readSources()
      const tasks = [
        (async () => {
          try {
            const data = await githubJson(
              `${GITHUB_API}/search/repositories?q=${encodeURIComponent(all ? query : `${query} topic:dsh-plugin`)}&sort=stars&order=desc&per_page=20&page=${page}`,
              req.signal,
              auth.token,
            )
            return normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github', sourceName: 'GitHub' }))
          } catch {
            return []
          }
        })(),
        ...sources.searchSources.filter((s) => s.type === 'custom').map((s) => (async () => {
          try {
            const url = s.url.replace('{q}', encodeURIComponent(query)).replace('{page}', String(page))
            const data = await fetchJsonUrl(url, 15000, s.headers ?? {})
            return normalizePlatformItems(data, 'main').map((item) => ({ ...item, source: s.id, sourceName: s.name }))
          } catch {
            return []
          }
        })()),
      ]
      const results = await Promise.all(tasks)
      items = results.flat()
      items = await enrichItems(items)
      sendJson(res, 200, { ok: true, query, items, authenticated: auth.loggedIn, source: 'all', multi: true })
      return
    }
    if (body.skills === true) {
      // 技能模式搜索：agent-skills / claude-skills / dsh-skill 三 topic 并行检索后合并去重
      // （GitHub search 的 OR 语法优先级不可靠，分开查最稳），按 star 排序取前 20。
      if (source !== 'github') {
        sendError(res, 400, '技能搜索仅支持 GitHub 源')
        return
      }
      const keyword = raw === '' ? '' : `${raw} in:name,description,topics `
      const tasks = SKILL_TOPICS.map((topic) => (async () => {
        try {
          const data = await githubJson(
            `${GITHUB_API}/search/repositories?q=${encodeURIComponent(`${keyword}topic:${topic}`)}&sort=stars&order=desc&per_page=20&page=${page}`,
            req.signal,
            auth.token,
          )
          return normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github', skillTopics: [topic] }))
        } catch {
          return []
        }
      })())
      const merged = (await Promise.all(tasks)).flat()
      const seen = new Set()
      items = []
      for (const item of merged.sort((a, b) => b.stars - a.stars)) {
        if (seen.has(item.fullName)) continue
        seen.add(item.fullName)
        items.push(item)
        if (items.length >= 20) break
      }
      items = await enrichItems(items)
      sendJson(res, 200, { ok: true, query, items, authenticated: auth.loggedIn, source: 'github', skills: true })
      return
    }
    if (source === 'gitee') {
      // Gitee 官方 v5 搜索接口（search/repositories）已废弃（恒返回空）；
      // so.gitee.com/v1（Indexea 后端）有百度云 WAF 反爬且需映答账号 token。
      // 因此 Gitee 源采用仓库直装模式：输入 owner/repo 直接取仓库信息（公开接口，无需登录）。
      const gitee = readGiteeConfig(readSources())
      let repo = ''
      let giteeError = ''
      try {
        repo = githubRepoInfo(query)
      } catch (error) {
        giteeError = error instanceof Error ? error.message : String(error)
      }
      if (repo) {
        try {
          const tokenQ = gitee.token ? `?access_token=${encodeURIComponent(gitee.token)}` : ''
          // repo 已由 githubRepoInfo 校验；分段编码（只编码中文等非 ASCII，斜杠保留原样——
          // Gitee 服务器不认 %2F 编码的路径分隔，返回 404）
          const [owner, name] = repo.split('/')
          const data = await fetchJsonUrl(`https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${tokenQ}`)
          items = normalizePlatformItems([data], 'master').map((item) => ({ ...item, source: 'gitee' }))
        } catch (error) {
          giteeError = error instanceof Error ? error.message : String(error)
        }
      }
      sendJson(res, 200, { ok: true, query, items, authenticated: auth.loggedIn, source, giteeNeedsLogin: false, directOnly: true, giteeError })
      return
    } else if (source !== 'github') {
      // 自定义搜索源：URL 模板（{q}/{page} 占位符），返回数组或 {items} 结构；支持配置的请求头
      const sources = readSources()
      const custom = sources.searchSources.find((s) => s.id === source && s.type === 'custom')
      if (!custom) {
        sendError(res, 404, `没有这个搜索源：${source}`)
        return
      }
      const url = custom.url
        .replace('{q}', encodeURIComponent(query))
        .replace('{page}', String(page))
      const data = await fetchJsonUrl(url, 15000, custom.headers ?? {})
      items = normalizePlatformItems(data, 'main').map((item) => ({ ...item, source, sourceName: custom.name }))
    } else {
      // npm 包名搜索与 GitHub 仓库搜索**并行**：npm 侧要查 registry 搜索 + packument + 仓库元数据
      // （实测 4.5~9s），串行会把两段等待叠加到用户身上。
      const npmPromise = raw !== '' && !body.skills
        ? searchNpmPackages(raw, orderedRegistries(readSources()), 3, auth.token).catch(() => [])
        : Promise.resolve([])
      const data = await githubJson(
        `${GITHUB_API}/search/repositories?q=${encodeURIComponent(all ? query : `${query} topic:dsh-plugin`)}&sort=stars&order=desc&per_page=20&page=${page}`,
        req.signal,
        auth.token,
      )
      items = normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github' }))
      items = await enrichItems(items)
      // monorepo 子包增强（OpenViking/examples/dsh-memory-plugin 等可按子包名搜到；
      // 代码搜索需登录，未登录时该函数返回空数组，见 searchSubpackageItems 的说明）
      if (raw !== '' && !body.skills) {
        for (const sub of await searchSubpackageItems(raw, auth.token, req.signal)) {
          if (!items.some((x) => x.fullName === sub.fullName)) items.push(sub)
        }
      }
      // ── B′：README 重查（2026-09-20）────────────────────────────────────────
      // 仓库搜索只在「仓库名 + 描述 + topics」里找词，所以只写在 README 或仓库文件里的名字搜不到。
      // 典型：`web-all` 只是 npm 包名 + `packages/dsh-web-all/package.json` 的内容，
      // `q=web-all topic:dsh-plugin` 32 条里没有 dsh-web；而 `web-all in:readme` 第 9 条就是它。
      // 首屏没有"名字逐词命中"的条目时，用 in:name,description,readme 再查一次（未登录也能用）。
      if (raw !== '' && !body.skills && page === 1 && !hasDirectNameHit(items, raw)) {
        try {
          const again = await githubJson(
            `${GITHUB_API}/search/repositories?q=${encodeURIComponent(`${raw} in:name,description,readme${all ? '' : ' topic:dsh-plugin'}`)}&sort=stars&order=desc&per_page=20&page=1`,
            req.signal,
            auth.token,
          )
          for (const it of normalizePlatformItems(again.items ?? [], 'main')) {
            if (items.some((x) => x.fullName === it.fullName)) continue
            items.push({ ...it, source: 'github', viaReadme: true })
            if (items.length >= 40) break
          }
        } catch {}
      }
      // ── A：npm 包名搜索（2026-09-20）────────────────────────────────────────
      // 用户输入常常是 npm 包名（`web-all`），而 GitHub 元数据里没有它 → 走 registry 搜索接口反查
      // 包 → repository.url → 仓库，命中**置顶**并带 npmPackage 标记（前端按包名安装）。
      // 不依赖静态索引、不依赖 GitHub 登录；registry 走配置的软件源（默认国内镜像）。
      // 已在列表里的同仓库条目（例如代码搜索加进来的"子包"）合并 npm 信息后上移——精确命中不该排在第 21 位。
      if (raw !== '' && !body.skills) {
        for (const it of (await npmPromise).reverse()) {
          const existingIdx = items.findIndex((x) => x.fullName === it.fullName)
          const existing = existingIdx >= 0 ? items.splice(existingIdx, 1)[0] : null
          items.unshift({ ...(existing ?? {}), ...it })
        }
      }
      // 代码搜索（monorepo 子包）需要 GitHub 登录：未登录时它拿不到结果，
      // 前端据此提示"登录后可按子包名搜索"（2026-09-20 事故复盘：未登录用户三条检索路径全断）
      if (raw !== '' && !body.skills && !auth.loggedIn) extraNotes.codeSearchSkipped = true
    }
    items = items.filter((item) => item.fullName !== '')
    sendJson(res, 200, { ok: true, query, items, authenticated: auth.loggedIn, source, ...(extraNotes) })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/enrich`) {
    // 为浏览器直连的搜索结果补官方/聚合标记（服务端通道可靠；客户端直连无标记能力）
    const raw = Array.isArray(body.items) ? body.items.slice(0, 30) : []
    const items = await enrichItems(raw)
    sendJson(res, 200, { ok: true, items })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/repo`) {
    const repo = githubRepoInfo(typeof body.repo === 'string' ? body.repo : '')
    const auth = readGithubAuth()
    // meta 降级策略：githubJson（https+镜像+gh）与 curl 竞速，8 秒超时即降级——
    // Promise.any 全失败时要等最慢分支（黑洞期 https 41.5s），加 race 超时避免拖累整体。
    // 8s 而非旧值 3s：IPv6 无路由的环境里单条通道就要 5.4s（2026-09-20 实测），3s 必输 → branch 取错。
    let meta = null
    try {
      meta = await Promise.race([
        Promise.any([
          githubJson(`${GITHUB_API}/repos/${repo}`, req.signal, auth.token),
          curlJson(`${GITHUB_API}/repos/${repo}`, 12000, {}, { ipv4: true }),
        ]),
        new Promise((resolve) => setTimeout(() => resolve(null), META_BUDGET_MS)),
      ])
    } catch {}
    const branch = meta?.default_branch ?? 'main'
    const pkg = await fetchRepoPackage(repo, branch)
    const skill = await detectSkillRepo(repo, branch)
    const skillMeta = skill.hasSkill ? await fetchSkillMeta(repo, branch, skill.skillDir) : null
    // 套装识别：根 .gitmodules 存在**且内容真的是 gitmodules**（只判非 null 会被代理/CDN 对不存在
    // 文件回的 2xx 空 body 骗到，把普通插件标成套装——2026-09-19 用户反馈事故）
    const hasSuite = looksLikeGitmodules(await rawTextWithFallback(repo, branch, '.gitmodules'))
    // 官方安装方式（详情面板展示 + 一键复制，供用户手动安装）：
    // 套装 → 仓库 install.ps1/README 的官方步骤；普通/聚合 → dsh plugin add 官方命令
    let installCommand = null
    if (hasSuite) {
      const short = repo.split('/')[1] ?? repo
      const hasInstallScript = (await rawTextWithFallback(repo, branch, 'install.ps1')) !== null
        || (await rawTextWithFallback(repo, branch, 'install.sh')) !== null
      // 纯命令（无注释，CMD/PowerShell 通用）；不再关闭 TLS 校验；
      // 脚本用 powershell -File 调用，CMD 里也能跑
      installCommand = [
        `git clone --recurse-submodules ${gitCloneUrls(repo)[0]}`,
        `cd ${short}`,
        hasInstallScript
          ? `powershell -ExecutionPolicy Bypass -File install.ps1`
          : `git submodule update --init --recursive`,
      ].join('\n')
    } else {
      installCommand = `dsh plugin --profile web add github:${repo}`
    }
    sendJson(res, 200, {
      ok: true,
      repo,
      defaultBranch: branch,
      description: meta?.description ?? '',
      stars: meta?.stargazers_count ?? 0,
      packageName: pkg?.name ?? null,
      packageDescription: pkg?.description ?? null,
      hasPackageJson: pkg !== null,
      privateRoot: pkg !== null && pkg.private === true,
      hasSkill: skill.hasSkill,
      skillDir: skill.skillDir,
      skill: skillMeta,
      hasSuite,
      installCommand,
      dshHint: pkg !== null && (
        typeof pkg.name === 'string' && /(^|-)dsh[-/]/u.test(pkg.name)
        || pkg.peerDependencies?.['@deepseek-ai/cordis'] !== undefined
        || Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin')
      ),
    })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/subpackages`) {
    const repo = githubRepoInfo(typeof body.repo === 'string' ? body.repo : '')
    const branch = typeof body.branch === 'string' && body.branch ? body.branch : 'main'
    const auth = readGithubAuth()
    // 复用安装链的防护实现：任一 raw 拉取失败只跳过该子包，不整体 500
    const subpackages = await fetchSubpackageNames(repo, branch, auth.token)
    sendJson(res, 200, { ok: true, repo, branch, subpackages })
    return
  }

  // 软件源扫描：并发探测每个 npm 源的「可达性 / 延迟 / 该源上的最新版本」。
  // 用于判断主源是否最优（内网私服 vs 公共镜像），结果直接在前端软件源列表里显示。
  if (pathname === `${ROUTE_PREFIX}/registry-scan`) {
    const sources = readSources()
    const scanPkg = '@noob-stupid/dsh-plugin-console'
    const encoded = encodeURIComponent(scanPkg)
    const scanOne = async (r) => {
      const started = Date.now()
      const base = { id: r.id, name: r.name, url: r.url, primary: r.primary === true }
      try {
        const response = await fetch(`${String(r.url).replace(/\/+$/u, '')}/${encoded}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          signal: AbortSignal.timeout(8000),
        })
        const ms = Date.now() - started
        if (!response.ok) return { ...base, ok: false, ms, status: response.status, latest: null, versions: null, error: `HTTP ${response.status}` }
        const data = await response.json()
        const latest = typeof data?.['dist-tags']?.latest === 'string' ? data['dist-tags'].latest : null
        const versions = data?.versions !== undefined && data.versions !== null && typeof data.versions === 'object' ? Object.keys(data.versions).length : null
        return { ...base, ok: true, ms, status: response.status, latest, versions, error: null }
      } catch (error) {
        const ms = Date.now() - started
        const message = error?.name === 'TimeoutError'
          ? '超时（8s）'
          : (error instanceof Error ? error.message : String(error))
        return { ...base, ok: false, ms, status: null, latest: null, versions: null, error: message }
      }
    }
    const results = await Promise.all(sources.registries.map((r) => scanOne(r)))
    sendJson(res, 200, { ok: true, pkg: scanPkg, scannedAt: Date.now(), results })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/sources`) {
    const { action } = body
    const sources = readSources()
    if (action === 'add') {
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '软件源地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      if (sources.registries.some((r) => r.url === url)) {
        sendError(res, 400, '该软件源已存在')
        return
      }
      const entry = {
        id: `src-${Date.now().toString(36)}`,
        name: name || url,
        url,
        primary: sources.registries.length === 0,
      }
      sources.registries.push(entry)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'remove') {
      sendError(res, 400, '软件源不可删除（插件安装依赖的 npm 源，请使用编辑/设为主源）')
      return
    }
    if (action === 'edit') {
      const id = typeof body.id === 'string' ? body.id : ''
      const target = sources.registries.find((r) => r.id === id)
      if (!target) {
        sendError(res, 404, '没有这个软件源')
        return
      }
      const url = typeof body.url === 'string' ? body.url.trim() : target.url
      const name = typeof body.name === 'string' ? body.name.trim() : target.name
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '软件源地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      if (sources.registries.some((r) => r.url === url && r.id !== id)) {
        sendError(res, 400, '该软件源地址已存在')
        return
      }
      target.url = url
      target.name = name || url
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'set-primary') {
      const id = typeof body.id === 'string' ? body.id : ''
      if (!sources.registries.some((r) => r.id === id)) {
        sendError(res, 404, '没有这个软件源')
        return
      }
      for (const r of sources.registries) r.primary = r.id === id
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'add-search') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '搜索地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      if (!url.includes('{q}')) {
        sendError(res, 400, '搜索 URL 模板必须包含 {q} 占位符')
        return
      }
      if (sources.searchSources.some((s) => s.url === url)) {
        sendError(res, 400, '该搜索源已存在')
        return
      }
      // 可选请求头（认证等）：[{name, value}] 结构，仅服务端使用，不下发浏览器
      const headers = Array.isArray(body.headers)
        ? body.headers
          .filter((h) => h && typeof h.name === 'string' && h.name.trim() !== '' && typeof h.value === 'string')
          .map((h) => ({ name: h.name.trim().slice(0, 100), value: h.value.slice(0, 500) }))
        : []
      sources.searchSources.push({
        id: `search-${Date.now().toString(36)}`,
        name: name || url,
        type: 'custom',
        url,
        ...(headers.length > 0 ? { headers } : {}),
      })
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'remove-search') {
      const id = typeof body.id === 'string' ? body.id : ''
      const target = sources.searchSources.find((s) => s.id === id)
      if (!target) {
        sendError(res, 404, '没有这个搜索源')
        return
      }
      if (target.type === 'builtin') {
        sendError(res, 400, '内置搜索源不可删除')
        return
      }
      sources.searchSources = sources.searchSources.filter((s) => s.id !== id)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'add-index') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '索引地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      if ((sources.indexSources ?? []).some((s) => s.url === url)) {
        sendError(res, 400, '该索引源已存在')
        return
      }
      sources.indexSources = [...(sources.indexSources ?? []), {
        id: `idx-${Date.now().toString(36)}`,
        name: name || url,
        url,
        primary: (sources.indexSources ?? []).length === 0,
      }]
      marketIndexCache = null
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'edit-index') {
      const id = typeof body.id === 'string' ? body.id : ''
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '索引地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      const target = (sources.indexSources ?? []).find((s) => s.id === id)
      if (!target) {
        sendError(res, 404, '没有这个索引源')
        return
      }
      target.name = name || url
      target.url = url
      marketIndexCache = null
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'set-index-primary') {
      const id = typeof body.id === 'string' ? body.id : ''
      const list = sources.indexSources ?? []
      if (!list.some((s) => s.id === id)) {
        sendError(res, 404, '没有这个索引源')
        return
      }
      for (const s of list) s.primary = s.id === id
      marketIndexCache = null
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'remove-index') {
      const id = typeof body.id === 'string' ? body.id : ''
      const list = sources.indexSources ?? []
      if (!list.some((s) => s.id === id)) {
        sendError(res, 404, '没有这个索引源')
        return
      }
      const rest = list.filter((s) => s.id !== id)
      if (rest.length === 0) {
        sendError(res, 400, '至少保留一个索引源（可先添加自建镜像再删除默认源）')
        return
      }
      if (!rest.some((s) => s.primary)) rest[0].primary = true
      sources.indexSources = rest
      marketIndexCache = null
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'set-index-merge') {
      sources.indexMerge = body.merge === true
      marketIndexCache = null
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'add-git') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const urlTemplate = typeof body.urlTemplate === 'string' ? body.urlTemplate.trim() : ''
      if (!urlTemplate.includes('{owner}') || !urlTemplate.includes('{repo}')) {
        sendError(res, 400, 'Git 源模板必须同时包含 {owner} 与 {repo} 占位符')
        return
      }
      if (!isAllowedGitSourceUrl(urlTemplate)) {
        sendError(res, 400, 'Git 源地址必须是 https://（或本机/私网 http://、file:// 本地裸仓库）的合法 URL')
        return
      }
      if ((sources.gitSources ?? []).some((s) => s.urlTemplate === urlTemplate)) {
        sendError(res, 400, '该 Git 源已存在')
        return
      }
      sources.gitSources = [...(sources.gitSources ?? []), {
        id: `git-${Date.now().toString(36)}`,
        name: name || urlTemplate,
        urlTemplate,
        primary: (sources.gitSources ?? []).length === 0,
      }]
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'edit-git') {
      const id = typeof body.id === 'string' ? body.id : ''
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const urlTemplate = typeof body.urlTemplate === 'string' ? body.urlTemplate.trim() : ''
      if (!urlTemplate.includes('{owner}') || !urlTemplate.includes('{repo}')) {
        sendError(res, 400, 'Git 源模板必须同时包含 {owner} 与 {repo} 占位符')
        return
      }
      if (!isAllowedGitSourceUrl(urlTemplate)) {
        sendError(res, 400, 'Git 源地址必须是 https://（或本机/私网 http://、file:// 本地裸仓库）的合法 URL')
        return
      }
      const target = (sources.gitSources ?? []).find((s) => s.id === id)
      if (!target) {
        sendError(res, 404, '没有这个 Git 源')
        return
      }
      target.name = name || urlTemplate
      target.urlTemplate = urlTemplate
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'set-git-primary') {
      const id = typeof body.id === 'string' ? body.id : ''
      const list = sources.gitSources ?? []
      if (!list.some((s) => s.id === id)) {
        sendError(res, 404, '没有这个 Git 源')
        return
      }
      for (const s of list) s.primary = s.id === id
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'remove-git') {
      const id = typeof body.id === 'string' ? body.id : ''
      const list = sources.gitSources ?? []
      if (!list.some((s) => s.id === id)) {
        sendError(res, 404, '没有这个 Git 源')
        return
      }
      const rest = list.filter((s) => s.id !== id)
      if (rest.length === 0) {
        sendError(res, 400, '至少保留一个 Git 源（可先添加自建镜像再删除默认源）')
        return
      }
      if (!rest.some((s) => s.primary)) rest[0].primary = true
      sources.gitSources = rest
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'reset') {
      const defaults = JSON.parse(JSON.stringify(DEFAULT_SOURCES))
      marketIndexCache = null
      await writeSources(defaults)
      sendJson(res, 200, { ok: true, sources: maskSources(defaults) })
      return
    }
    if (action === 'gitee-setup') {
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
      const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : ''
      const keepClientId = body.keepClientId === true
      if ((!keepClientId && !clientId) || !clientSecret) {
        sendError(res, 400, 'client_id 与 client_secret 不能为空')
        return
      }
      const current = readGiteeConfig(sources)
      // keepClientId：前端回显的是打码 clientId（abc12345…），用户只改了 secret 时保留原配置
      sources.gitee = { ...current, clientId: keepClientId ? current.clientId : clientId, clientSecret }
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'gitee-clear') {
      const current = readGiteeConfig(sources)
      sources.gitee = { clientId: current.clientId, clientSecret: current.clientSecret, token: '', login: '' }
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    sendError(res, 400, '未知操作（add / edit / set-primary / remove / add-search / remove-search / add-index / edit-index / set-index-primary / remove-index / set-index-merge / add-git / edit-git / set-git-primary / remove-git / gitee-setup / gitee-clear / reset）')
    return
  }

  if (pathname === `${ROUTE_PREFIX}/market-index`) {
    // 静态插件索引：按「软件源 → 索引源」主→备顺序拉取 + 10 分钟内存缓存（市场秒开、零 GitHub API 调用）。
    // 全部索引源失败时回退落盘缓存（内网/断网仍可浏览，响应带 offline 标记），无缓存则区分错误类型。
    if (marketIndexCache !== null && Date.now() - marketIndexCache.at < 600000) {
      sendJson(res, 200, { ok: true, sourceName: marketIndexCache.sourceName ?? null, ...marketIndexCache.data })
      return
    }
    const indexConf = readSources()
    let indexList = [...(indexConf.indexSources ?? [])].sort((a, b) => (b.primary === true ? 1 : 0) - (a.primary === true ? 1 : 0))
    // 合并模式：并发拉取所有索引源并去重合并（公共索引 + 内网私有索引同时可见）
    if (indexConf.indexMerge === true && indexList.length > 1) {
      const fetched = await Promise.all(indexList.map(async (src) => {
        try {
          // 各源独立短超时：单个慢源（被墙镜像/不可达内网）不该拖垮整体
          const data = await fetchJsonUrl(src.url, 8000)
          return data && Array.isArray(data.items) ? { src, data } : null
        } catch { return null }
      }))
      const good = fetched.filter((x) => x !== null)
      if (good.length > 0) {
        const seen = new Set()
        const skillSeen = new Set()
        const items = []
        const skills = []
        for (const { data } of good) {
          for (const it of data.items) {
            const key = typeof it?.fullName === 'string' ? it.fullName : JSON.stringify(it)
            if (seen.has(key)) continue
            seen.add(key)
            items.push(it)
          }
          for (const sk of (Array.isArray(data.skills) ? data.skills : [])) {
            const key = typeof sk?.fullName === 'string' ? sk.fullName : JSON.stringify(sk)
            if (skillSeen.has(key)) continue
            skillSeen.add(key)
            skills.push(sk)
          }
        }
        const sourceName = good.map((g) => g.src.name).join(' + ')
        const merged = { items, skills, skillCount: skills.length, merged: true, sourceName }
        marketIndexCache = { at: Date.now(), data: merged, sourceName }
        try { await writeFile(MARKET_INDEX_CACHE_FILE, JSON.stringify({ at: Date.now(), data: merged, sourceName }), 'utf8') } catch {}
        sendJson(res, 200, { ok: true, ...merged })
        return
      }
      // 所有源都失败 → 跳过逐个重试，直接进入下方缓存兜底
      indexList = []
    }
    let lastError = null
    let formatError = null
    // 总预算：索引源扩容到 5 个后必须封顶，否则用户只会看到"市场一直转圈"。
    // 实测（2026-09-20）：fetchJsonUrl 内部是「curl 一次 + node:https 兜底（默认 20s 超时）」，
    // 单个源最坏要 ~28s，5 个源曾实测到 **65s** 才回退到落盘缓存。
    // 这里改为**每源单次 curl**（curlJson，8s 硬超时）+ 整体 12s 预算 → 最坏 ≈ 20s，常见 <1s。
    const deadline = Date.now() + 12000
    for (const src of indexList) {
      if (Date.now() > deadline) break
      try {
        const data = await curlJson(src.url, 8000)
        if (data && Array.isArray(data.items)) {
          marketIndexCache = { at: Date.now(), data, sourceName: src.name }
          try { await writeFile(MARKET_INDEX_CACHE_FILE, JSON.stringify({ at: Date.now(), data, sourceName: src.name }), 'utf8') } catch {}
          sendJson(res, 200, { ok: true, sourceName: src.name, ...data })
          return
        }
        formatError = `索引格式异常（${src.name} 未返回 items 数组）`
      } catch (error) {
        lastError = error
      }
    }
    try {
      const cached = JSON.parse(readFileSync(MARKET_INDEX_CACHE_FILE, 'utf8'))
      if (cached && cached.data && Array.isArray(cached.data.items)) {
        marketIndexCache = { at: Date.now(), data: cached.data, sourceName: cached.sourceName ?? null }
        sendJson(res, 200, { ok: true, offline: true, cachedAt: typeof cached.at === 'number' ? cached.at : null, sourceName: cached.sourceName ?? null, ...cached.data })
        return
      }
    } catch {}
    const reason = formatError !== null
      ? formatError
      : `网络不可达（${indexList.length} 个索引源全部失败）：${lastError?.message ?? '未知错误'}`
    // 说清后果（2026-09-20 另一位用户实测的困惑）：索引不在时市场只剩 GitHub 实时结果，
    // 收录条目与本地索引模糊匹配一起失效（他搜 web-all 搜不到 dsh-web 全家桶就是这个原因）
    sendError(res, 500, `索引加载失败：${reason}（此时市场只能搜 GitHub 实时结果，收录条目可能看不到；可在「软件源 → 索引源」增删/更换索引源后重试）`)
    return
  }

  if (pathname === `${ROUTE_PREFIX}/framework-check`) {
    // 框架版本检查（「功能包 → 框架」常驻面板用）：当前版本 / latest / next / 升级目标。
    // 与升级路由同一套判定规则，但**只读**（不备份、不写状态文件）；5 分钟内存缓存 +
    // body.refresh === true 强制重查——面板是常驻入口，不能每次打开都打 registry。
    const now = Date.now()
    if (body.refresh === true || fwCheckCache === null || now - fwCheckCache.at > 300000) {
      let latest = null
      let next = null
      let registryError = null
      try {
        const data = await fetchJsonUrl('https://registry.npmmirror.com/@deepseek-ai%2fdsh')
        latest = data?.['dist-tags']?.latest ?? null
        next = data?.['dist-tags']?.next ?? null
      } catch (error) {
        registryError = error instanceof Error ? error.message : String(error)
      }
      let current = null
      try {
        const localRequire = createRequire(ctx.baseUrl ?? 'file:///')
        const pkg = JSON.parse(readFileSync(localRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
        current = typeof pkg.version === 'string' ? pkg.version : null
      } catch {}
      const target = latest !== null && current !== null && isFrameworkVersionNewer(latest, current)
        ? latest
        : (next !== null && current !== null && isFrameworkVersionNewer(next, current) ? next : null)
      fwCheckCache = { at: now, data: { current, latest, next, target, registryError } }
    }
    sendJson(res, 200, { ok: true, ...fwCheckCache.data, checkedAt: fwCheckCache.at })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/compat-gate`) {
    // 兼容门总开关（用户定案 2026-09-11）：自动行为必须可关，关掉即回到纯手动。
    //  autoDisable —— 升级前是否自动禁用判定不适配的行
    //  autoDetect  —— 打开控制台时是否自动检测「已适配」（仅提示，绝不自动解锁）
    const patchBody = {}
    if (typeof body.autoDisable === 'boolean') patchBody.autoDisable = body.autoDisable
    if (typeof body.autoDetect === 'boolean') patchBody.autoDetect = body.autoDetect
    const gateNext = Object.keys(patchBody).length > 0 ? writeCompatGate(patchBody) : readCompatGate()
    sendJson(res, 200, { ok: true, compatGate: gateNext })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/adapt-unlock`) {
    // 待适配行「已适配，立即解锁」：无需等新版本——对已装模块重跑源码扫描，通过即移除禁用块。
    const rowId = typeof body.rowId === 'string' ? body.rowId : ''
    if (!/^[A-Za-z0-9_:.-]{1,80}$/u.test(rowId)) {
      sendError(res, 400, 'rowId 无效')
      return
    }
    const pending = readCompatPending()
    const entry = (pending?.pending ?? []).find((p) => p.rowId === rowId && (p.status ?? 'pending') === 'pending')
    if (entry === undefined) {
      sendError(res, 404, '该行不在适配门待适配清单中（或已解锁）')
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    let pkg = null
    let pkgDir = null
    let version = null
    try {
      const require = createRequire(join(profileDir, 'package.json'))
      const pkgPath = resolvePackageJson(entry.moduleName, profileDir)
      if (pkgPath !== null) {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        version = typeof pkg?.version === 'string' ? pkg.version : null
        pkgDir = dirname(pkgPath)
      }
    } catch {}
    const fwVer = typeof pending.frameworkVersion === 'string' ? pending.frameworkVersion : '?'
    const check = pkg !== null ? checkPluginFrameworkCompat(pkg, fwVer, pkgDir) : { decision: 'unknown', reason: '无法读取包信息' }
    if (check.decision === 'fail') {
      sendError(res, 409, `适配校验未通过：${check.reason}`)
      return
    }
    await removeDisableBlock(patchPath, rowId)
    entry.status = 'adopted'
    entry.adoptedAt = Date.now()
    entry.adoptedVersion = version
    entry.adoptedFramework = fwVer
    entry.check = check.decision
    entry.checkNote = check.reason ?? null
    writeCompatPending(pending)
    sendJson(res, 200, { ok: true, rowId, adopted: true, check: check.decision, note: check.reason ?? null })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/adapt-unlock-all`) {
    // 全家桶「一键启用已适配」：对家庭内所有待适配行批量重跑源码扫描，通过的全部解锁，未通过保留禁用。
    const root = typeof body.root === 'string' ? body.root : ''
    if (!/^(@[a-z0-9-][a-z0-9-._~]*\/)?[a-z0-9-][a-z0-9-._~]*$/u.test(root) || root.length > 214) {
      sendError(res, 400, 'root 无效')
      return
    }
    const pending = readCompatPending()
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    // v0.3.45：匹配规则改成「moduleName 前缀 **或** 属主行集合」——
    // 隔离记录合并进来的老行 moduleName 为空（脚本只写 rowId），只按 moduleName 比会匹配不到，
    // 于是用户点「一键启用已适配」得到「该全家桶没有待适配行」（实测就是这个）。
    const info = rowIdModuleMap(ctx)
    const bundleRowIds = new Set()
    for (const [rowId, meta] of info) {
      const name = meta?.moduleName
      if (typeof name === 'string' && name !== '' && (name === root || name.startsWith(root + '/'))) bundleRowIds.add(rowId)
    }
    const inFamily = (p) => {
      if (typeof p.moduleName === 'string' && p.moduleName !== '' && (p.moduleName === root || p.moduleName.startsWith(root + '/'))) return true
      return bundleRowIds.has(p.rowId) || info.get(p.rowId)?.moduleName === root
    }
    // 目标 = ① 待适配（pending）② **已记已适配、但从没通过源码扫描**（check !== 'pass'）。
    // ② 这类正是"账面上已适配、补丁里却还禁着"的行 —— 老逻辑只挑 pending，于是用户点「一键启用已适配」
    // 得到"没有待适配行、无需操作"，可它们其实一行都没启用（实测就是这个）。
    const targets = (pending?.pending ?? []).filter((p) => {
      if (!inFamily(p)) return false
      const status = p.status ?? 'pending'
      if (status === 'pending') return true
      return status === 'adopted' && p.check !== 'pass'
    })
    if (targets.length === 0) {
      // 无待适配行=全部已适配/已解锁，属正常状态：返回友好提示而非错误（点击「一键启用已适配」不应报"操作失败"）
      sendJson(res, 200, { ok: true, unlocked: [], kept: [], note: '该全家桶内没有待扫描/待解锁的行（全部已通过源码扫描或已解锁）' })
      return
    }
    const fwVer = typeof pending.frameworkVersion === 'string' ? pending.frameworkVersion : '?'
    const unlocked = []
    const kept = []
    for (const p of targets) {
      let pkg = null
      let pkgDir = null
      let version = null
      try {
        const pkgPath = resolvePackageJson(p.moduleName, profileDir)
        if (pkgPath !== null) {
          pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          version = typeof pkg?.version === 'string' ? pkg.version : null
          pkgDir = dirname(pkgPath)
        }
      } catch {}
      const check = pkg !== null ? checkPluginFrameworkCompat(pkg, fwVer, pkgDir) : { decision: 'fail', reason: '无法读取包信息' }
      if (check.decision === 'fail') {
        kept.push({ rowId: p.rowId, reason: check.reason })
        continue
      }
      await removeDisableBlock(patchPath, p.rowId)
      p.status = 'adopted'
      p.adoptedAt = Date.now()
      p.adoptedVersion = version
      p.adoptedFramework = fwVer
      p.check = check.decision
      p.checkNote = check.reason ?? null
      unlocked.push(p.rowId)
    }
    writeCompatPending(pending)
    // kept = 扫描未通过（保持禁用，并带上原因）；unlocked = 本次真解锁的行
    sendJson(res, 200, {
      ok: true,
      root,
      unlocked,
      kept,
      scanned: targets.length,
      note: kept.length === 0
        ? `已重跑源码扫描并解锁 ${unlocked.length} 行`
        : `扫描 ${targets.length} 行：解锁 ${unlocked.length} 行，${kept.length} 行未通过（保持禁用，原因见下）`,
    })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/check-update`) {
    // 检测已安装插件是否有新版本：curl registry 元数据取 dist-tags.latest（node 网络黑洞时 curl 可用）。
    // 聚合包（有 dependencies）额外对比子包版本：声明版本 vs 本地 node_modules 实际版本，
    // 返回 depsOutdated 提示"更新本包需同步子包"，避免半更新混搭导致启动冲突。
    const packageName = packageNameOf(typeof body.packageName === 'string' ? body.packageName.trim() : '')
    if (!packageName) {
      sendError(res, 400, 'packageName 不能为空')
      return
    }
    let latest = null
    let next = null
    let beta = null
    let depsOutdated = []
    let error = null
    let source = 'npm'
    try {
      const encoded = packageName.startsWith('@')
        ? `@${encodeURIComponent(packageName.slice(1).split('/')[0])}%2f${encodeURIComponent(packageName.split('/').slice(1).join('/'))}`
        : encodeURIComponent(packageName)
      const data = await fetchJsonUrl(`https://registry.npmmirror.com/${encoded}`)
      latest = data?.['dist-tags']?.latest ?? null
      next = data?.['dist-tags']?.next ?? null
      beta = data?.['dist-tags']?.beta ?? null
      if (latest === null) throw new Error(`registry 无 dist-tags.latest（${packageName}）`)
      // 子包配套检查：最新版声明依赖 vs 本地实际版本
      const patchPath = findPatchPath(ctx)
      const profileDir = dirname(patchPath)
      const declared = latest ? data?.versions?.[latest]?.dependencies ?? {} : {}
      const keys = typeof declared === 'object' ? Object.keys(declared) : []
      for (const dep of keys) {
        const required = String(declared[dep] ?? '').replace(/^[\^~>=< ]+/u, '')
        if (!required) continue
        let current = null
        try {
          const pkgPath = join(profileDir, 'node_modules', dep, 'package.json')
          if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
            current = typeof pkg.version === 'string' ? pkg.version : null
          }
        } catch {}
        if (current !== null && current !== required) {
          depsOutdated.push({ name: dep, current, required })
        }
      }
    } catch (err) {
      // GitHub 发布回退（自身/未发布到 npm 的插件）：npm registry 404/无 latest 时，
      // 从已装包 package.json 的 repository 字段反查 GitHub 最新版本。
      // 通道顺序：GitHub API（带 token）→ jsDelivr 版本 API（GitHub 黑洞期可用，已验证 200）。
      // 覆盖 dsh-plugin-console（本面板）这类"源码在 GitHub、npm 上不存在"的宿主插件。
      let fallbackError = err instanceof Error ? err.message : String(err)
      try {
        const meta = entryPkgMeta(packageName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
        const repo = typeof meta?.repository === 'string'
          ? meta.repository.replace(/^git\+/u, '').replace(/\.git$/u, '')
          : (meta?.repository && typeof meta.repository === 'object' ? meta.repository.url : null)
        const m = typeof repo === 'string' ? repo.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/u) : null
        if (m) {
          let tag = null
          // 通道 1：GitHub API（匿名可读，限流 60/h；token 时 5000/h）
          try {
            const auth = readGithubAuth()
            const headers = { 'User-Agent': 'dsh-plugin-console' }
            if (auth.token) headers.Authorization = `token ${auth.token}`
            const release = await fetchJsonUrl(`https://api.github.com/repos/${m[1]}/releases/latest`, 12000, headers)
            if (typeof release?.tag_name === 'string') tag = release.tag_name
          } catch {}
          // 通道 2：jsDelivr 版本列表（GitHub 直连黑洞时可用；取最高版本号）
          if (tag === null) {
            try {
              const data = await fetchJsonUrl(`https://data.jsdelivr.com/v1/packages/gh/${m[1]}`, 12000)
              const versions = Array.isArray(data?.versions) ? data.versions.map((v) => String(v.version ?? '')) : []
              // 按语义版本号排序取最高（v 前缀剥离后比较）
              const parsed = versions
                .map((v) => ({ raw: v, ver: v.replace(/^v/iu, '') }))
                .filter((x) => /^\d+\.\d+\.\d+/u.test(x.ver))
                .sort((a, b) => {
                  const pa = a.ver.split(/[.-]/u).map((n) => (Number.isFinite(Number(n)) ? Number(n) : n))
                  const pb = b.ver.split(/[.-]/u).map((n) => (Number.isFinite(Number(n)) ? Number(n) : n))
                  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                    const x = pa[i] ?? -1; const y = pb[i] ?? -1
                    if (x !== y) return typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : 1
                  }
                  return 0
                })
              if (parsed.length > 0) tag = parsed[parsed.length - 1].raw
            } catch {}
          }
          if (tag !== null) {
            latest = tag.replace(/^v/iu, '')
            next = null
            source = 'github'
            error = null
            fallbackError = null
          }
        }
        if (fallbackError !== null && latest === null) error = `npm 与 GitHub 均未检测到版本（${fallbackError}）`
      } catch (fbErr) {
        error = `npm registry 查询失败且 GitHub 回退不可用（${fallbackError}；${fbErr instanceof Error ? fbErr.message : String(fbErr)}）`
      }
    }
    // migrate 换名检测（2026-09-04 缺陷修复）：本地包声明 dsh.migrate.to 时查目标包最新版/引擎声明，
    // 识别「项目已改名/迁移发布」的更新（如 @linxin666/dsh-web-ui-all → @linxin666/dsh-web-all 0.3.14）
    let migrate = null
    try {
      const localPath = resolvePackageJson(packageName, profileDir)
      if (localPath !== null) {
      const localPkg = JSON.parse(readFileSync(localPath, 'utf8'))
      const to = typeof localPkg.dsh?.migrate?.to === 'string' ? localPkg.dsh.migrate.to : null
      if (to !== null && to !== '' && to !== packageName) {
        const encTo = to.startsWith('@')
          ? `@${encodeURIComponent(to.slice(1).split('/')[0])}%2f${encodeURIComponent(to.split('/').slice(1).join('/'))}`
          : encodeURIComponent(to)
        const meta = await fetchJsonUrl(`https://registry.npmmirror.com/${encTo}`)
        const toLatest = meta?.['dist-tags']?.latest ?? meta?.['dist-tags']?.next ?? null
        const toPkg = toLatest !== null ? (meta?.versions?.[toLatest] ?? null) : null
        const engine = toPkg?.dsh?.engines?.dsh ?? toPkg?.engines?.dsh ?? null
        const fwVer = currentFrameworkVersion(ctx)
        const compatible = fwVer !== null && (engine === null || semverRangeMatchLoose(fwVer, engine))
        migrate = { to, latest: toLatest, engine, compatible }
      }
      }
    } catch {}
    sendJson(res, 200, { ok: true, packageName, latest, next, beta, depsOutdated, error, source, migrate })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/framework-upgrade`) {
    // 框架升级入口：一键流程 = 备份配置快照 + 备份框架本体（回滚点）+ 自动升级
    // （npx 缓存 dsh 本体 + profile 官方配套包）+ 失败自动回滚 + 重启提示。
    // 升级完成重启后，框架适配逻辑自动：备份新版本快照 + 重打框架补丁 + 版本提示。
    let current = null
    let dshDir = null
    // 面板自报名（自报名一致性校验用）：从插件自身 package.json 读，与部署目录比对
    let selfName = null
    try {
      const selfPkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
      selfName = typeof selfPkg.name === 'string' ? selfPkg.name : null
    } catch {}
    try {
      const require = createRequire(ctx.baseUrl ?? 'file:///')
      const dshPkgPath = require.resolve('@deepseek-ai/dsh/package.json')
      const dshPkg = JSON.parse(readFileSync(dshPkgPath, 'utf8'))
      current = dshPkg.version ?? null
      dshDir = dirname(dshPkgPath) // .../node_modules/@deepseek-ai/dsh
    } catch {
      // 兜底：ctx.baseUrl 不可用时从插件自身目录解析（与 resolveDshBin 同源）
      try {
        const requireLocal = createRequire(join(dirname(fileURLToPath(import.meta.url)), 'package.json'))
        const dshPkgPath = requireLocal.resolve('@deepseek-ai/dsh/package.json')
        const dshPkg = JSON.parse(readFileSync(dshPkgPath, 'utf8'))
        current = dshPkg.version ?? null
        dshDir = dirname(dshPkgPath)
      } catch {}
    }
    let latest = null
    let next = null
    let registryError = null
    try {
      const data = await fetchJsonUrl('https://registry.npmmirror.com/@deepseek-ai%2fdsh')
      latest = data?.['dist-tags']?.latest ?? null
      next = data?.['dist-tags']?.next ?? null
    } catch (error) {
      // 网络黑洞/超时：区分「检测失败」与「无更新」，避免误导用户以为已是最新
      registryError = error instanceof Error ? error.message : String(error)
    }
    // 升级目标：稳定版 latest 优先；latest 不高于当前而 next（预发布渠道）确实更新时，目标取 next。
    // 必须用版本号比较而不是字符串不等（避免 current=0.1.1 稳定版时被 next=0.1.1-rc.3 反向降级）。
    const target = latest !== null && current !== null && isFrameworkVersionNewer(latest, current)
      ? latest
      : (next !== null && current !== null && isFrameworkVersionNewer(next, current) ? next : null)
    const profileDir = dirname(findPatchPath(ctx))
    // 1) 升级前打包备份现有配置（patch / profile package.json / 插件清单）
    let backupDir = null
    try {
      if (current !== null) backupDir = backupProfileSnapshot(profileDir, current, ctx)
    } catch {}
    const hasUpdate = target !== null
    const steps = []
    let upgraded = false
    // 1.5) 预设/config 迁移门禁（写在生成升级脚本之前）：框架新版不再接受的旧字段
    //（如 0.1.5 的 persona.text → prefix）会让升级后**预设挂载失败、服务起不来**——
    // 适配门只扫插件包，扫不到预设；这里就地改名并留 .bak，避免整次升级被一个字段搞死。
    let configMigrations = []
    if (hasUpdate) {
      try {
        configMigrations = migrateAgentConfigsForUpgrade(profileDir, target)
      } catch (error) {
        steps.push(`预设配置迁移检查失败：${error instanceof Error ? error.message : String(error)}`)
      }
      for (const m of configMigrations) {
        steps.push(`预设字段迁移：${m.file} 第 ${m.line} 行 ${m.from} → ${m.to}（${m.pkg}，已留 .bak 备份）`)
      }
      if (configMigrations.length > 0) {
        steps.push(`自动迁移了 ${configMigrations.length} 处框架新版不再接受的预设字段（不迁移会让升级后预设挂载失败、服务拉不起来）`)
      }
    }
    // 1.6) 不适配行预禁用（用户硬要求：「更新框架后所有不适配的必须先禁用」）。
    // 适配门此前只有「执行侧」（读清单→锁启用→更新后解锁），**检测侧从未实现**：
    // 那份 compat-pending.json 一直是人工/一次性脚本产出的（v0.3.25 起遗留至今）。
    // 这里补上检测侧：升级脚本执行**前**扫描全部可开关行，判定 fail 的就地禁用 + 记入清单，
    // 保证新框架 boot 时不会被某行 import 失败拖垮（loader 单行失败 = 整个服务起不来）。
    let preflight = { disabled: [], skipped: [] }
    if (hasUpdate) {
      try {
        preflight = await preflightDisableIncompatible({ ctx, profileDir, patchPath: findPatchPath(ctx), targetVersion: target })
      } catch (error) {
        steps.push(`不适配行预禁用失败（不阻塞升级，改由启动失败隔离兜底）：${error instanceof Error ? error.message : String(error)}`)
      }
      for (const row of preflight.disabled) {
        steps.push(`已预先禁用不适配行：${row.rowId}（${row.moduleName}@${row.version ?? '?'}）— ${row.reason ?? '判定不兼容目标框架'}`)
      }
      if (preflight.disabled.length > 0) {
        steps.push(`共预先禁用 ${preflight.disabled.length} 行：新框架启动不会再被它们拖垮；等它们发布适配版本后点「更新并适配」即可解锁`)
      }
      if (preflight.skipped.length > 0) {
        steps.push(`另有 ${preflight.skipped.length} 行无法预判（受保护行/包信息读不到），保持启用，由升级后的启动失败隔离兜底`)
      }
    }
    // 2) 自动升级框架：运行中的服务锁着 dsh/lib 目录（EBUSY 无法原地替换），
    //    因此生成独立升级脚本（kill 服务 → npm 升级 → 失败回滚 → 拉起服务），后台执行。
    //    与 /restart 同款自守护模式：端口无监听会自动拉起，不会留下"服务起不来"。
    if (hasUpdate && dshDir !== null) {
      const port = webPort(ctx)
      const nodePath = process.execPath
      const binPath = resolveDshBin()
      const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      // 事故教训：npm 的 lib/cli.js 是「函数模块」（module.exports = (process) => validateEngines(...)），
      // 直跑 `node lib/cli.js` 只加载函数定义、不执行命令——立即退出 exit 0（假成功，曾导致
      // "npm 退出码 0 但版本未更新"）。唯一正确入口是 bin/npm-cli.js（它调用 cli.js 函数）。
      const corepackJs = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js')
      // 预检（事故教训）：corepack（pnpm 通道）/ dsh bin.js 缺失时**拒绝生成升级脚本**（不 kill 服务）——
      // 避免"kill 后升级/拉起双双失败，服务永久 down"
      if (!existsSync(corepackJs) || binPath === null || !existsSync(binPath)) {
        steps.push(`升级已取消：无法定位 ${!existsSync(corepackJs) ? 'corepack（pnpm 通道）' : 'dsh bin.js'}（框架安装可能不完整），服务保持运行；请先修复框架再升级`)
        sendJson(res, 200, { ok: true, current, latest, next, target, hasUpdate, upgraded: false, backupDir, configMigrations, preflight, steps, hints: steps })
        return
      }
      const profileDir2 = profileDir
      // 官方配套包列表（profile package.json 里的 @deepseek-ai/* 依赖）
      let officialList = ''
      try {
        const profilePkg = JSON.parse(readFileSync(join(profileDir2, 'package.json'), 'utf8'))
        const deps = { ...(profilePkg.dependencies ?? {}), ...(profilePkg.devDependencies ?? {}) }
        officialList = Object.keys(deps).filter((d) => d.startsWith('@deepseek-ai/')).join(' ')
      } catch {}
      const rollbackDir = backupDir !== null ? join(backupDir, 'dsh-package-backup') : null
      // 官方配套包参数（Start-Process ArgumentList 需要逐包独立元素；包名无空格，单引号安全）
      const pkgArgs = officialList !== '' ? officialList.split(' ').map((p) => `'${p}'`) : []
      const taskName = `DSH-FW-Upgrade-${process.pid}`
      // 备份 dsh 目录（回滚点）
      try {
        if (rollbackDir !== null) {
          mkdirSync(rollbackDir, { recursive: true })
          copyTree(dshDir, rollbackDir)
        }
      } catch {}
      // 安全护栏（事故教训）：回滚点必须真实有效（含 lib/bin.js），否则升级失败时无副本可恢复
      // ——曾因备份缺失导致回滚后框架目录为空、服务无法重启。备份无效直接取消升级。
      if (rollbackDir === null || !existsSync(join(rollbackDir, 'lib', 'bin.js'))) {
        sendError(res, 500, `框架备份失败（回滚点${rollbackDir !== null ? `：${rollbackDir}` : '（无）'}缺失或无效），已取消升级——请检查磁盘空间/权限后重试`)
        return
      }
      // 框架安装根识别（事故教训 2026-09-04）：require.resolve 返回 .pnpm 内部 realpath，
      // 旧逻辑 dirname(dirname(dshDir)) 指向 .pnpm/<entry>/node_modules——「重链跳过：.pnpm 目录不存在」、
      // 依赖修复 0 个，pnpm 还在错误 cwd 里把新 CLI 原位覆盖进旧 .pnpm 目录，旧树就此被毁。
      const fwRoot = resolveFrameworkRootNodeModules(dshDir)
      if (fwRoot === null || !existsSync(join(fwRoot, '.pnpm')) || !existsSync(join(fwRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
        sendError(res, 500, `无法定位框架安装根（期望含 .pnpm 与 @deepseek-ai/dsh 的顶层 node_modules，实际：${fwRoot ?? '未找到'}）——已取消升级，请修复框架安装后重试`)
        return
      }
      // 框架全树 checkpoint（可靠回滚点）：升级前镜像全部 @deepseek-ai 版本包（自包内容）+ 顶层 scope + lock
      let fwCheckpoint = null
      try {
        const cpRoot = backupDir !== null ? backupDir : join(FRAMEWORK_BACKUP_ROOT(), current ?? 'unknown')
        fwCheckpoint = checkpointFrameworkTree(fwRoot, cpRoot)
        steps.push(`框架全树 checkpoint 完成：${fwCheckpoint.dest}（镜像 ${fwCheckpoint.mirrored} 个 @deepseek-ai 版本包；升级失败/拉起失败会自动全树回滚，也可用框架卡片的「回滚到上一版」一键回滚）`)
      } catch (error) {
        steps.push(`框架全树 checkpoint 失败：${error instanceof Error ? error.message : String(error)}（回滚点降级为 CLI 备份）`)
      }
      // 一键回滚记录：框架卡片「回滚到上一版」按钮读取
      try {
        writeFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), JSON.stringify({ from: current, to: target, checkpointDir: fwCheckpoint?.dest ?? null, cliBackupDir: rollbackDir, fwRoot, at: Date.now() }, null, 2), 'utf8')
      } catch {}
      const ps1 = join(tmpdir(), `fw-upgrade-${process.pid}.ps1`)
      const logFile = join(dshHome(), 'plugin-console', 'fw-upgrade.log')
      const stateFile = join(dshHome(), 'plugin-console', 'fw-upgrade-state.txt')
      // 启动失败隔离所需的两个文件（升级脚本在服务起不来时调用）：
      // ① 分析器：直接 import 本插件的 planQuarantine，避免把判断逻辑再写一份到 PowerShell；
      // ② 候选行快照：升级发起时的可开关行（决策器据此把日志里的模块名映射回行 id）。
      const qHelperPath = join(dshHome(), 'plugin-console', 'fw-analyze-boot.mjs')
      const qCandidatesPath = join(dshHome(), 'plugin-console', 'fw-quarantine-candidates.json')
      const qRecordPath = join(dshHome(), 'plugin-console', 'fw-quarantine.json')
      let thirdPartyRows = []
      try {
        thirdPartyRows = listEntries(ctx)
          .filter((e) => e.enabled && e.toggleable && e.rowId !== 'plugin-console'
            && !CORE_PATCH_ROW_IDS.has(e.rowId)
            && typeof e.moduleName === 'string' && !e.moduleName.startsWith('@deepseek-ai/'))
          .map((e) => e.rowId)
      } catch {}
      try {
        const selfLibUrl = new URL('./index.js', import.meta.url).href
        const helperSource = [
          '// 自动生成：启动失败隔离分析器（升级脚本在服务起不来时调用；逻辑在插件内，本文件只做转发）',
          `import { planQuarantine } from ${JSON.stringify(selfLibUrl)}`,
          "import { readFileSync } from 'node:fs'",
          'const [logPath, candPath] = process.argv.slice(2)',
          "let logText = ''",
          "try { logText = readFileSync(logPath, 'utf8').split(/\\r?\\n/u).slice(-400).join('\\n') } catch {}",
          'let candidates = []',
          'try { candidates = JSON.parse(readFileSync(candPath, "utf8")) } catch {}',
          'try { process.stdout.write(JSON.stringify(planQuarantine({ logText, candidates }))) } catch (error) { process.stdout.write(JSON.stringify({ error: String(error && error.message ? error.message : error) })) }',
          '',
        ].join('\n')
        writeFileSync(qHelperPath, helperSource, 'utf8')
        const candidateSnapshot = listEntries(ctx)
          .filter((e) => typeof e.rowId === 'string' && e.rowId !== '')
          .map((e) => ({ rowId: e.rowId, moduleName: e.moduleName, toggleable: e.toggleable === true, enabled: e.enabled === true }))
        writeFileSync(qCandidatesPath, JSON.stringify(candidateSnapshot, null, 2), 'utf8')
      } catch {}
      try { mkdirSync(dirname(logFile), { recursive: true }) } catch {}
      // PowerShell 字符串里反斜杠是字面量（无 \\ 转义）：JSON.stringify 产生的 \\ 必须还原为 \，
      // 否则所有路径无效（npm 调不起来、回滚无效、拉起失败——曾导致升级脚本空跑）
      // PowerShell 双引号字面量：反斜杠还原 + 空串产出 ''（JSON 的 "" 被单引号包裹会变成字面量 "" ，
      // 曾导致 $cp = '""' → Test-Path 恒假 → 全树回滚被静默跳过）+ $ / 反引号转义（路径含 $ 不被插值）
      const ps = (s) => {
        const j = JSON.stringify(String(s)).replace(/\\\\/gu, '\\')
        if (j === '""') return "''"
        return j.replace(/`/gu, '``').replace(/\$/gu, '`$')
      }
      const patchFilePath = join(profileDir, 'cordis.patch.yml')
      // 拉起服务的 PowerShell 片段（隔离重试用；与升级/回滚路径共用 relaunchPrelude 里的同一份实现）
      const launchSnippet = (tag) => `if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '${tag}') { $started = $true } }; Beat`
      const lines = [
        `$state = ${ps(stateFile)}`,
        `$log = ${ps(logFile)}`,
        "function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }",
        "function SetState($s, $m) {",
        // v0.3.37：失败时把**崩溃前最后到达的阶段**一起写进状态文件（stage=…）——
        // 否则界面只能看到 failed，把已经成功的步骤全打成 ✕（2026-09-11 用户实测就是这个观感：
        // 框架其实升好了，卡片却整列红叉）。$script:stage 未设置时 [string] 会安全地变成空串。
        "  try { if ($s -eq 'failed') { Set-Content -Path $state -Value ($s + '|' + $m + '|stage=' + [string]$script:stage) -Encoding UTF8; return } } catch {}",
        "  try { if ($s -ne 'done' -and $s -ne 'idle') { $script:stage = $s }; Set-Content -Path $state -Value ($s + '|' + $m) -Encoding UTF8; Beat } catch {}",
        "}",
        relaunchPrelude({ nodePath, pluginDir: join(dirname(fileURLToPath(import.meta.url)), '..'), fwRoot, target, ps }),
        // 全局异常兜底（事故教训）：脚本任何未捕获异常都会无声死亡、状态永远卡住、服务没人拉起。
        // trap 捕获后：写 failed 状态 + 日志 + 尝试拉起服务 + 自删任务 + 退出
        "trap {",
        "  try { SetState 'failed' ('升级脚本异常终止：' + $_.Exception.Message) } catch {}",
        // 事故教训（2026-09-10）：只记消息无法定位是哪一行崩的 —— 连出错位置一起写日志
        "  try { Log ('升级脚本异常终止：' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage) } catch {}",
        `  try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if (-not $c) { [void](Invoke-DshRelaunch '异常兜底') } } catch {}`,
        `  schtasks /delete /f /tn ${taskName} 2>$null`,
        "  exit 1",
        "}",
        "SetState 'starting' '备份配置…'",
        "Log '框架升级脚本启动'",
        // 流程优化（用户建议）：先在线下载安装（服务保持运行、页面不断、进度可见），
        // 成功后最后重启服务生效；在线替换失败（服务占用框架目录 EBUSY）才停止服务重试
        `SetState 'installing' '升级框架 ${current} -> ${target}（npm 下载中，服务保持在线）'`,
        `Log '升级框架本体 ${current} -> ${target}…'`,
        // 关键：npm 的工作目录必须是缓存 node_modules（schtasks 默认 cwd 是 system32/用户目录，
        // 不指定会装错位置——缓存永远不更新的根因）
        `Set-Location -Path ${ps(fwRoot)}`,
        // npm 安装函数：Start-Process 跑 npm-cli.js（唯一正确入口——lib/cli.js 是函数模块，
        // 直跑只加载不执行，假成功 exit 0）+ --force（显式指定版本但已在 package.json 的
        // semver 范围内时 npm 会跳过安装，假成功）+ 15 分钟总时长硬超时。注意：**不能加
        // -RedirectStandardOutput/-RedirectStandardError**——schtasks 任务环境下带重定向的
        // Start-Process 子进程会启动即异常退出（ExitCode 读不到、输出 0 字节，实测）；
        // 无重定向时 ExitCode 正常（实测 exit=0）。npm 自身 debug 日志（cache\_logs）留档。
        // 超时策略：总时长 15 分钟硬上限 + npm debug 日志 5 分钟无更新判定卡死（网络黑洞/挂起时
        // 快速失败换 registry，不用干等 15 分钟）；等待期间每 15 秒更新进度状态（客户端可见）。
        // 成功后校验 package.json 版本 === target（防 npm 假成功）。
        // 另注意：npm install 在 schtasks 环境启动慢（约 1-2 分钟 0 日志，初始化/编译缓存），
        // 属正常，5 分钟卡死阈值不会误杀。
        `function Install-Framework($reg) {`,
        `  $startAt = Get-Date`,
        `  $deadline = $startAt.AddMinutes(15)`,
        `  $stallDeadline = $startAt.AddMinutes(5)`,
        `  $lastLogM = (Get-Date)`,
        `  $logSeen = $false`,
        `  $cacheDir = ''`,
        `  try {`,
        `    $npmrcFile = Join-Path $env:USERPROFILE '.npmrc'`,
        `    if (Test-Path $npmrcFile) { $m = Select-String -Path $npmrcFile -Pattern '^cache\\s*=\\s*(.+)$' | Select-Object -Last 1; if ($m) { $cacheDir = $m.Matches[0].Groups[1].Value.Trim().Trim('"') } }`,
        `  } catch {}`,
        `  if ($cacheDir -eq '') { $fb = Join-Path $env:APPDATA 'npm-cache'; if (Test-Path (Join-Path $fb '_logs')) { $cacheDir = $fb } }`,
        `  $npmOut = $log + '.npm.out.txt'`,
        `  $marker = $log + '.pnpm.marker'`,
        `  try { Remove-Item $marker -Force -ErrorAction SilentlyContinue } catch {}`,
        `  $proc = $null`,
        `  try {`,
        `    # pnpm 通道 + 黑框实时进度：start 独立窗口（有真实 stdout，黑框显示 pnpm 进度条，`,
        `    # 标题 DSH-Upgrade）；pnpm 结束后 cmd 写 marker（含退出码），脚本轮询 marker 判断完成`,
        `    $cmdLine = 'start "DSH-Upgrade" cmd /c "title DSH-Upgrade && ${nodePath} ${corepackJs} pnpm install @deepseek-ai/dsh@${target} --force --config.dangerouslyAllowAllBuilds=true --registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"'`,
        `    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdLine) -PassThru -WindowStyle Hidden`,
        `  } catch {`,
        `    Log ('启动 pnpm 失败：' + $_.Exception.Message)`,
        `    return 1`,
        `  }`,
        `  $done = $false`,
        `  $code = 1`,
        `  while (-not $done -and (Get-Date) -lt $deadline) {`,
        `    Start-Sleep -Seconds 5`,
        `    if (Test-Path $marker) {`,
        `      $mc = Get-Content $marker -Raw -ErrorAction SilentlyContinue`,
        `      $mm = [regex]::Match($mc, 'DSH-DONE:(\\d+)')`,
        `      if ($mm.Success) { $code = [int]$mm.Groups[1].Value; $done = $true }`,
        `    }`,
        `    if (-not $done) {`,
        `      SetState 'installing' ('升级框架 ${current} -> ${target}（已等待 ' + [int]((Get-Date) - $startAt).TotalSeconds + ' 秒，进度见 DSH-Upgrade 窗口）')`,
        `    }`,
        `  }`,
        `  if (-not $done) {`,
        `    Log 'pnpm 超过 15 分钟未完成，判定超时'`,
        `    try { taskkill /F /FI "WINDOWTITLE eq DSH-Upgrade" 2>$null | Out-Null } catch {}`,
        `    return 1`,
        `  }`,
        `  if ($code -eq 0) {`,
        `    try {`,
        // 事故教训（2026-09-10）：版本校验必须看「启动器可见路径」（顶层 @deepseek-ai\dsh），
        // 而不是 require.resolve 得到的 .pnpm 内部路径——旧逻辑查 .pnpm 里的旧副本，
        // 于是 pnpm 明明装好了却报「版本未更新，按失败处理」，白等两轮。
        `      $v = (Get-Content ${ps(join(fwRoot, '@deepseek-ai', 'dsh', 'package.json'))} -Raw | ConvertFrom-Json).version`,
        `      if ($v -ne '${target}') { Log ('pnpm 退出码 0 但顶层可见版本未更新（顶层 ' + $v + '，目标 ${target}），按失败处理'); $code = 1 }`,
        `    } catch { Log 'pnpm 退出码 0 但无法读取顶层版本，按失败处理'; $code = 1 }`,
        `  }`,
        `  return $code`,
        `}`,
        // 回滚函数（2026-09-04 事故后升级为「全树优先」）：robocopy 支持长路径（Copy-Item 对 >260
        // 字符路径静默失败，曾导致回滚后框架目录缺失、服务无法重启）；回滚前确保服务已停
        // （进程 cwd 会锁住框架目录）。checkpoint 存在 → 恢复全部 @deepseek-ai 版本包 + 顶层 scope；
        // checkpoint 缺失 → CLI 兜底。
        `function Invoke-Rollback {`,
        `  SetState 'rollback' '升级失败，回滚框架（全树/CLI 备份）…'`,
        `  Log '升级失败，回滚框架…'`,
        // 事故教训（2026-09-10）：整个回滚体包 try/catch —— 脚本崩在回滚里（曾报
        // 「无法将参数绑定到参数 Path」，回滚没跑完、旧树半新半旧），必须记录出错位置而不是
        // 只留一句 trap 消息；回滚失败也要明确写状态，别让人以为已回滚。
        `  try {`,
        `    try { $svc = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($svc) { $svc | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3 } } catch {}`,
        `    $cp = ${ps(fwCheckpoint?.dest ?? '')}`,
        `    if ($cp -and (Test-Path (Join-Path $cp '.pnpm'))) {`,
        `      $restored = 0`,
        `      $entries = Get-ChildItem -Path (Join-Path $cp '.pnpm') -Directory -ErrorAction SilentlyContinue`,
        `      foreach ($e in $entries) {`,
        `        if ($e.Name -notlike '*+*') { continue }`,
        `        $name = @($e.Name -split '\\+')[1] -replace '@.*$', ''`,
        `        if (-not $name) { continue }`,
        `        $src = Join-Path $e.FullName ('node_modules\\@deepseek-ai\\' + $name)`,
        `        $dst = Join-Path (Join-Path ${ps(fwRoot)} ('.pnpm\\' + $e.Name)) ('node_modules\\@deepseek-ai\\' + $name)`,
        `        if (Test-Path (Join-Path $src 'package.json')) { New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null; robocopy $src $dst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null; $restored++ }`,
        `      }`,
        `      $topSrc = Join-Path $cp 'top-@deepseek-ai'`,
        `      if (Test-Path $topSrc) { Remove-Item ${ps(join(fwRoot, '@deepseek-ai'))} -Recurse -Force -ErrorAction SilentlyContinue; robocopy $topSrc ${ps(join(fwRoot, '@deepseek-ai'))} /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null }`,
        `      try { Copy-Item (Join-Path $cp 'lock.yaml') ${ps(join(fwRoot, '.pnpm', 'lock.yaml'))} -Force -ErrorAction SilentlyContinue } catch {}`,
        `      Log ('全树回滚完成：恢复 ' + $restored + ' 个版本包 + 顶层 scope')`,
        `      $script:rolledBack = $true`,
        `      return`,
        `    }`,
        `    # CLI 兜底（checkpoint 缺失或损坏）`,
        `    if (-not (Test-Path ${ps(join(rollbackDir, 'lib', 'bin.js'))})) { Log ('回滚失败：CLI 备份也缺失（' + ${ps(rollbackDir)} + '）'); return }`,
        `    Remove-Item ${ps(dshDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
        `    robocopy ${ps(rollbackDir)} ${ps(dshDir)} /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null`,
        `    if (Test-Path ${ps(join(dshDir, 'lib', 'bin.js'))}) { Log '回滚完成（CLI 恢复）'; $script:rolledBack = $true } else { Log '回滚失败：复制失败，请手动修复框架安装' }`,
        `  } catch {`,
        `    Log ('回滚过程异常：' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)`,
        `    SetState 'failed' ('回滚过程异常，框架可能处于混合状态：' + $_.Exception.Message)`,
        `  }`,
        `}`,
        `$script:rolledBack = $false`,
        `$code = Install-Framework 'https://registry.npmmirror.com'`,
        `if ($code -ne 0) { Log ('npmmirror 安装失败（exit=' + $code + '），切换 registry.npmjs.org 重试一次'); $code = Install-Framework 'https://registry.npmjs.org' }`,
        `if ($code -ne 0) {`,
        `  # 在线安装失败（服务可能占用框架目录导致替换失败）：停止服务后重试一次`,
        `  SetState 'stopped' '在线安装失败（框架目录可能被服务占用），停止服务后重试…'`,
        `  Log '在线安装失败，停止服务后重试'`,
        `  try { $svc = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($svc) { $svc | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3 } } catch {}`,
        `  $code = Install-Framework 'https://registry.npmmirror.com'`,
        `  if ($code -ne 0) { Log ('（停服后）npmmirror 安装失败（exit=' + $code + '），切换 registry.npmjs.org 重试一次'); $code = Install-Framework 'https://registry.npmjs.org' }`,
        `}`,
        `if ($code -ne 0) { Invoke-Rollback } else {`,
        `  Log '框架本体升级完成'`,
        // 事故教训（2026-09-10）：启动器（桌面端/`npx dsh`）用的是**顶层** @deepseek-ai\dsh；
        // 若它是 npm 时代的真实目录，pnpm 无法把它换成链接 → 顶层永远停在旧版，
        // 桌面端下次自己拉服务就跑旧框架（版本错配 → 拉起失败 → 又提示升级，循环）。
        // 这里校验「启动器可见版本」，是实体目录就改名备份后重装一次，让 pnpm 重建链接。
        `  $visible = ${ps(join(fwRoot, '@deepseek-ai', 'dsh'))}`,
        `  $vv = ''`,
        `  try { $vv = (Get-Content (Join-Path $visible 'package.json') -Raw | ConvertFrom-Json).version } catch {}`,
        `  if ($vv -ne '${target}') {`,
        `    $item = Get-Item $visible -Force -ErrorAction SilentlyContinue`,
        `    if ($item -and -not $item.LinkType) {`,
        `      $bakName = 'dsh.npm-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')`,
        `      try { Rename-Item -Path $visible -NewName $bakName -ErrorAction Stop; Log ('顶层为旧版实体目录（' + $vv + '）→ 已改名备份 ' + $bakName + '，重装以重建链接…') } catch { Log ('顶层实体目录改名失败：' + $_.Exception.Message) }`,
        `      $code = Install-Framework 'https://registry.npmmirror.com'`,
        `      if ($code -ne 0) { $code = Install-Framework 'https://registry.npmjs.org' }`,
        `      $vv = ''`,
        `      try { $vv = (Get-Content (Join-Path $visible 'package.json') -Raw | ConvertFrom-Json).version } catch {}`,
        `      if ($vv -eq '${target}') { Log '顶层可见版本已修正为 ${target}' } else { Log ('顶层可见版本仍为 ' + $vv + '（拉起不受影响：Node 按链接真实路径解析依赖）') }`,
        `    } else { Log ('顶层可见版本异常（' + $vv + '）且非实体目录，跳过改名（LinkType=' + $item.LinkType + '）') }`,
        `  } else { Log '顶层可见版本校验通过' }`,
        `}`,
        // 回滚后跳过重链/依赖修复/版本对齐（它们按新树预期运行，会对已恢复的旧树造成二次破坏）
        `if (-not $script:rolledBack) {`,
        // 重新链接框架配套包（事故教训）：pnpm 升级到新版本时 .pnpm 目录重建，
        // 但顶层 node_modules/@deepseek-ai/* 不会自动切换，仍指向旧版（如 0.1.0-rc.7）——
        // 导致框架混版本（如 dsh-llm-deepseek 旧版无 vision 模型）、部分功能异常。
        // 升级成功后：遍历顶层 @deepseek-ai 的 dsh-* 包，读 .pnpm 主目录里的最新版本，
        // 若与顶层不一致则重建为 Junction（旧版备份 .bak-rc7）。
        `$relinked = 0`,
        `function Relink-FrameworkPackages($version) {`,
        `  # dshDir = .../node_modules/@deepseek-ai/dsh → nodeModules = .../node_modules`,
        `  $nodeModules = ${ps(fwRoot)}`,
        `  $pnpm = Join-Path $nodeModules '.pnpm'`,
        `  if (-not (Test-Path $pnpm)) { Log ('重链跳过：.pnpm 目录不存在'); return }`,
        `  $topPkgs = Get-ChildItem -Path (Join-Path $nodeModules '@deepseek-ai') -Directory | Where-Object { $_.Name -like 'dsh-*' }`,
        `  # 版本数值比较（修复：字符串比较在版本号位数变化时出错，如 0.1.10 < 0.1.9；PS5.1 兼容，不用三元运算符）`,
        `  function Compare-Version($a, $b) {`,
        `    if ($a -eq $b) { return 0 }`,
        `    $pa = [regex]::Match($a, '^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(?:[a-z]+\\.)?(\\d+))?' )`,
        `    $pb = [regex]::Match($b, '^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(?:[a-z]+\\.)?(\\d+))?' )`,
        `    if (-not $pa.Success -or -not $pb.Success) { return ($a.CompareTo($b)) }`,
        `    for ($i = 1; $i -le 4; $i++) {`,
        `      if ($pa.Groups[$i].Success) { $va = [int]$pa.Groups[$i].Value } else { $va = 2147483647 }`,
        `      if ($pb.Groups[$i].Success) { $vb = [int]$pb.Groups[$i].Value } else { $vb = 2147483647 }`,
        `      if ($va -ne $vb) { if ($va -lt $vb) { return -1 } else { return 1 } }`,
        `    }`,
        `    return 0`,
        `  }`,
        `  foreach ($top in $topPkgs) {`,
        `    $name = $top.Name`,
        `    $topPkgJson = Join-Path $top.FullName 'package.json'`,
        `    if (-not (Test-Path $topPkgJson)) { continue }`,
        `    try { $topVer = (Get-Content $topPkgJson -Raw | ConvertFrom-Json).version } catch { continue }`,
        `    # 找 .pnpm 里该包的所有主目录（@deepseek-ai+dsh-<name>@<ver>_<hash> 或 @deepseek-ai+dsh-<name>@<ver>-rc.x_<hash>）`,
        `    $cands = Get-ChildItem -Path $pnpm -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match ('^@deepseek-ai\\\\+dsh-' + [regex]::Escape($name.Substring(4)) + '@') }`,
        `    $best = $null; $bestVer = ''`,
        `    foreach ($c in $cands) {`,
        `      $inner = Join-Path $c.FullName ('node_modules\\@deepseek-ai\\' + $name)`,
        `      $pj = Join-Path $inner 'package.json'`,
        `      if (-not (Test-Path $pj)) { continue }`,
        `      try { $v = (Get-Content $pj -Raw | ConvertFrom-Json).version } catch { continue }`,
        `      if ($null -eq $best -or (Compare-Version $v $bestVer) -gt 0) { $bestVer = $v; $best = $inner }`,
        `    }`,
        `    if ($null -eq $best) { continue }`,
        `    if ($bestVer -eq $topVer) { continue }`,
        `    try {`,
        `      $bak = $top.FullName + '.bak-' + $topVer`,
        `      if (Test-Path $bak) { Remove-Item $bak -Recurse -Force -ErrorAction SilentlyContinue }`,
        `      Rename-Item -LiteralPath $top.FullName -NewName ($name + '.bak-' + $topVer) -Force`,
        `      cmd /c mklink /J "$($top.FullName)" "$($best)" 2>$null | Out-Null`,
        `      if (Test-Path (Join-Path $top.FullName 'package.json')) { $script:relinked++; Log ('重链 ' + $name + ': ' + $topVer + ' -> ' + $bestVer) } else { Log ('重链失败：' + $name) }`,
        `    } catch { Log ('重链异常：' + $name + ' ' + $_.Exception.Message) }`,
        `  }`,
        `}`,
        `Relink-FrameworkPackages '${target}'`,
        `Log ('重链框架配套包完成（' + $script:relinked + ' 个）')`,
        // 依赖树完整性验证（事故教训：升级只装框架主包，pnpm 不重装依赖树——dsh-client-* 等
        // 39 个客户端组件仍停旧版（如 0.1.0-rc.7），新旧混版本导致输入框传图卡死等异常。
        // 修复：扫描 web-app 声明的 @deepseek-ai 依赖，与顶层实际版本比对，
        // 不一致则按声明版本从 npm registry 精确下载 tarball 修复（绕过 pnpm dist-tags 远古版陷阱）。
        `$treeFixed = 0`,
        `function Verify-DependencyTree($refVersion) {`,
        `  # dshDir = .../node_modules/@deepseek-ai/dsh → nodeModules = .../node_modules`,
        `  $nodeModules = ${ps(fwRoot)}`,
        `  $webApp = Join-Path $nodeModules '@deepseek-ai\\dsh-web-app\\package.json'`,
        `  if (-not (Test-Path $webApp)) { Log ('依赖树验证跳过：dsh-web-app 未找到'); return }`,
        `  try { $deps = (Get-Content $webApp -Raw | ConvertFrom-Json).dependencies } catch { Log ('依赖树验证跳过：读取失败'); return }`,
        `  foreach ($dep in $deps.PSObject.Properties) {`,
        `    $name = $dep.Name`,
        `    if (-not ($name -match '^@deepseek-ai/')) { continue }`,
        `    $short = $name.Substring(13)`,
        `    $topDir = Join-Path $nodeModules (@('@deepseek-ai', $short) -join '\')`,
        `    $topPkgJson = Join-Path $topDir 'package.json'`,
        `    if (-not (Test-Path $topPkgJson)) { continue }`,
        `    try { $curVer = (Get-Content $topPkgJson -Raw | ConvertFrom-Json).version } catch { continue }`,
        `    if ($curVer -eq $refVersion) { continue }`,
        `    try {`,
        `      # 按声明版本精确下载 npm tarball（registry 的 dist-tags.latest 是远古版不可信，必须显式版本）`,
        `      $tmpDir = Join-Path $env:TEMP ('dsh-depfix-' + [guid]::NewGuid().ToString('N'))`,
        `      New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null`,
        `      $tgz = Join-Path $tmpDir 'pkg.tgz'`,
        `      $encName = $name.Replace('/','%2f')`,
        `      $url = 'https://registry.npmmirror.com/' + $encName + '/-/' + $short + '-' + $refVersion + '.tgz'`,
        `      curl.exe -s -L -m 60 -o $tgz $url`,
        `      if (-not (Test-Path $tgz) -or (Get-Item $tgz).Length -lt 1000) {`,
        `        $url = 'https://registry.npmjs.org/' + $encName + '/-/' + $short + '-' + $refVersion + '.tgz'`,
        `        curl.exe -s -L -m 60 -o $tgz $url`,
        `      }`,
        `      if (-not (Test-Path $tgz) -or (Get-Item $tgz).Length -lt 1000) { Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue; continue }`,
        `      tar -xzf $tgz -C $tmpDir`,
        `      $ver = (Get-Content (Join-Path $tmpDir 'package\\package.json') -Raw | ConvertFrom-Json).version`,
        `      if ($ver -eq $refVersion) {`,
        `        $bak = $topDir + '.bak-' + $curVer`,
        `        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force -ErrorAction SilentlyContinue }`,
        `        Rename-Item -LiteralPath $topDir -NewName ($short + '.bak-' + $curVer) -Force`,
        `        Copy-Item (Join-Path $tmpDir 'package') $topDir -Recurse -Force`,
        `        $script:treeFixed++`,
        `        Log ('依赖修复 ' + $short + ': ' + $curVer + ' -> ' + $ver)`,
        `      }`,
        `      Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue`,
        `    } catch { Log ('依赖修复异常：' + $short + ' ' + $_.Exception.Message) }`,
        `  }`,
        `}`,
        `Verify-DependencyTree '${target}'`,
        `Log ('依赖树完整性修复完成（' + $script:treeFixed + ' 个）')`,
        // 自报名一致性校验（事故教训：面板自身部署名与代码自报名不一致崩溃）——
        // 曾把 @noob-stupid/dsh-plugin-console 的代码装进 @deepseek-ai/dsh-plugin-console 目录，
        // 浏览器端报 loaded without registering "@deepseek-ai/dsh-plugin-console"（加载器期望
        // 目录名 = 包名 = 登记 ID，三者必须一致）。校验面板自身：export const name / client.js
        // 注册 id 必须与部署目录名一致，不一致则日志告警（升级脚本不自动改名——避免破坏运行时）。
        `function Verify-SelfNameConsistency($expectedName) {`,
        `  $selfDir = ${ps(dirname(dirname(fileURLToPath(import.meta.url))))}`,
        `  $indexJs = Join-Path $selfDir 'lib\\index.js'`,
        `  $clientJs = Join-Path $selfDir 'lib\\client.js'`,
        `  if (-not (Test-Path $indexJs)) { Log ('自报名校验跳过：index.js 未找到'); return }`,
        `  # 计算部署目录的完整包名（scoped 包为 @scope/name，非 scoped 包为 name）`,
        `  $leaf = Split-Path $selfDir -Leaf`,
        `  $parentLeaf = Split-Path (Split-Path $selfDir -Parent) -Leaf`,
        `  if ($parentLeaf.StartsWith('@')) { $deployName = $parentLeaf + '/' + $leaf } else { $deployName = $leaf }`,
        `  $idx = Get-Content $indexJs -Raw`,
        `  $nameOk = $idx.Contains("export const name = '" + $expectedName + "'")`,
        `  $clientOk = $true`,
        `  if (Test-Path $clientJs) {`,
        `    $cli = Get-Content $clientJs -Raw`,
        `    $clientOk = $cli.Contains('id: "' + $expectedName + '"')`,
        `  }`,
        `  $dirOk = ($deployName -eq $expectedName)`,
        `  if ($nameOk -and $clientOk -and $dirOk) { Log ('自报名一致性 OK：' + $expectedName + ' @ ' + $deployName) } else { Log ('⚠️ 自报名一致性异常：部署目录=' + $deployName + '，期望 ' + $expectedName + '（index=' + $nameOk + ' client=' + $clientOk + ' dir=' + $dirOk + '）——请检查部署目录与包名是否匹配') }`,
        `}`,
        `Verify-SelfNameConsistency '${selfName ?? '@noob-stupid/dsh-plugin-console'}'`,
        pkgArgs.length > 0 ? `SetState 'pkg' '更新官方配套包…'\n  Log '更新官方配套包…'\n  Set-Location -Path ${ps(profileDir2)}\n  if (Test-Path ${ps(corepackJs)}) {\n    $pp = Start-Process -FilePath ${ps(nodePath)} -ArgumentList @(${ps(corepackJs)}, 'pnpm', 'update', ${pkgArgs.join(', ')}, '--no-optional', '--registry', 'https://registry.npmmirror.com') -PassThru -WindowStyle Hidden\n    if (-not $pp.WaitForExit(300000)) { Stop-Process -Id $pp.Id -Force -ErrorAction SilentlyContinue; Log '官方配套包更新超时（5 分钟），已跳过' } else { try { Log ('官方配套包更新结束（exit=' + $pp.ExitCode + '）') } catch { Log '官方配套包更新结束（退出码读取失败）' } }\n  }` : '',
        "}",
        "SetState 'relaunching' '升级完成，重启 DSH 服务生效…'",
        "Log '重启 DSH 服务生效…'",
        // 升级全程服务保持在线（先下载后重启）：这里停掉旧服务（内存仍是旧代码），拉起新版本生效
        `try { $svc = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($svc) { $svc | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3; Log '旧服务已停止（重启生效）' } } catch {}`,
        '$ok = $false',
        '$started = $false',
        `for ($i = 0; $i -lt 20; $i++) {`,
        `  try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
        `  if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '升级后') { $started = $true } }; Beat`,
        '  Start-Sleep -Seconds 5',
        '}',
        // ── 启动失败隔离（用户硬要求）：新框架起不来时先隔离肇事者再重试，不直接回滚 ──
        // 判定逻辑全在 Node 决策器（fw-analyze-boot.mjs → planQuarantine）；这里只执行方案。
        `function Invoke-Quarantine {`,
        `  $helper = ${ps(qHelperPath)}`,
        `  if (-not (Test-Path $helper)) { Log '隔离分析器缺失，跳过隔离'; return $false }`,
        `  $logPath = Join-Path (Split-Path $log) 'fw-relaunch.log'`,
        `  if (-not (Test-Path $logPath)) { $logPath = $log }`,
        `  $out = ''`,
        `  try { $out = (& ${ps(nodePath)} $helper $logPath ${ps(qCandidatesPath)} 2>$null | Select-Object -Last 1) } catch { Log ('隔离分析调用失败：' + $_.Exception.Message); return $false }`,
        `  if (-not $out) { Log '隔离分析无输出'; return $false }`,
        `  $plan = $null`,
        `  try { $plan = $out | ConvertFrom-Json } catch { Log '隔离分析输出无法解析'; return $false }`,
        `  $acted = $false; $doneP = @(); $doneR = @(); $mode = 'targeted'`,
        `  foreach ($p in @($plan.presets)) {`,
        `    if (-not $p.exists) { continue }`,
        `    try { Rename-Item -LiteralPath $p.file -NewName ((Split-Path $p.file -Leaf) + '.broken-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -ErrorAction Stop; $doneP += $p.name; $acted = $true; Log ('已隔离预设：' + $p.name + '（改名 .broken，不再参与挂载）') } catch { Log ('预设隔离失败：' + $p.name + ' ' + $_.Exception.Message) }`,
        `  }`,
        `  foreach ($r in @($plan.rows)) {`,
        `    try {`,
        `      $has = Select-String -Path ${ps(patchFilePath)} -Pattern ('^- id: ' + [regex]::Escape($r) + '\\s*$') -Quiet -ErrorAction SilentlyContinue`,
        `      if (-not $has) { Add-Content -Path ${ps(patchFilePath)} -Value ('- id: ' + $r) -Encoding UTF8; Add-Content -Path ${ps(patchFilePath)} -Value '  disabled: true' -Encoding UTF8 }`,
        `      $doneR += $r; $acted = $true; Log ('已禁用不适配行：' + $r)`,
        `    } catch { Log ('禁用行失败：' + $r + ' ' + $_.Exception.Message) }`,
        `  }`,
        `  if (-not $acted -and $plan.safeMode) {`,
        `    $mode = 'safe-mode'`,
        `    foreach ($r in @(${thirdPartyRows.length > 0 ? thirdPartyRows.map((r) => ps(r)).join(', ') : "''"})) {`,
        `      try { $has = Select-String -Path ${ps(patchFilePath)} -Pattern ('^- id: ' + [regex]::Escape($r) + '\\s*$') -Quiet -ErrorAction SilentlyContinue; if (-not $has) { Add-Content -Path ${ps(patchFilePath)} -Value ('- id: ' + $r) -Encoding UTF8; Add-Content -Path ${ps(patchFilePath)} -Value '  disabled: true' -Encoding UTF8 }; $doneR += $r; $acted = $true } catch {}`,
        `    }`,
        `    if ($acted) { Log ('安全模式：已禁用 ' + $doneR.Count + ' 个第三方行，先让服务起来（适配后逐个解锁）') }`,
        `  }`,
        `  if ($acted) {`,
        `    try {`,
        `      $rec = [pscustomobject]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); mode = $mode; presets = $doneP; rows = $doneR; lines = $plan.lines } | ConvertTo-Json -Depth 4`,
        `      Set-Content -Path ${ps(qRecordPath)} -Value $rec -Encoding UTF8`,
        `    } catch {}`,
        `  } else { Log '隔离分析未定位到可隔离对象' }`,
        `  return $acted`,
        `}`,
        `if (-not $ok -and -not $script:rolledBack) {`,
        `  Log '服务拉起失败 → 先做启动失败隔离（隔离肇事者后重试，不直接回滚）'`,
        `  for ($q = 1; $q -le 3; $q++) {`,
        `    if (-not (Invoke-Quarantine)) { Log ('第 ' + $q + ' 轮：未定位到可隔离对象，停止隔离'); break }`,
        `    $ok = $false; $started = $false`,
        `    for ($i = 0; $i -lt 12; $i++) {`,
        `      try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
        `      ${launchSnippet('隔离后重试')}`,
        `      Start-Sleep -Seconds 5`,
        `    }`,
        `    if ($ok) { Log ('第 ' + $q + ' 轮隔离后服务已起来（被隔离项可在控制台解锁）'); break }`,
        `    Log ('第 ' + $q + ' 轮隔离后仍失败')`,
        `  }`,
        `}`,
        // 隔离也救不回才回滚（2026-09-04 教训：自动全树回滚并再拉起一次）
        `if (-not $ok -and -not $script:rolledBack) {`,
        `  Log '服务拉起失败，尝试自动回滚到升级前版本…'`,
        `  Invoke-Rollback`,
        `  $ok = $false`,
        `  $started = $false`,
        `  for ($i = 0; $i -lt 20; $i++) {`,
        `    try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
        `    if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '回滚后') { $started = $true } }; Beat`,
        `    Start-Sleep -Seconds 5`,
        `  }`,
        `}`,
        `if ($ok) { if ($script:rolledBack) { SetState 'failed' '升级失败，已自动回滚到升级前版本（服务已恢复）' ; Log '升级失败已自动回滚，服务已恢复' } else { SetState 'done' '升级完成，服务已监听 ${port}' ; Log '服务已监听 ${port}，升级完成' } } else { SetState 'failed' '拉起失败且自动回滚未生效：请手动运行 node ${binPath} web' ; Log '拉起失败且自动回滚未生效：请手动运行 node ${binPath} web（参考本日志排查）' }`,
        `schtasks /delete /f /tn ${taskName} 2>$null`,
      ].filter((l) => l !== '').join('\r\n')
      // 初始状态（备份完成、脚本即将执行）
      try { writeFileSync(stateFile, 'starting|备份配置完成，启动升级脚本…', 'utf8') } catch {}
      // 版本检查缓存作废：升级后 [框架] 面板要立刻显示新版本（否则 5 分钟内还显示"可升级到…"）
      fwCheckCache = null
      // UTF-8 BOM：powershell 5.1 按 ANSI 读无 BOM 文件，中文会乱码——加 BOM 保证解析正确。
      // 执行方式：schtasks 一次性计划任务（Task Scheduler 启动，独立于服务进程树/Job Object）——
      // 服务进程被杀时，其子进程（execFile/detached 的 powershell）会被 Job/进程树连带杀死，
      // 曾多次卡死在「停止服务」之后；计划任务彻底脱离，杀服务绝对影响不到升级脚本。
      writeFile(ps1, `\uFEFF${lines}`, 'utf8').then(
        () => {
          const ps1Posix = ps1.replace(/\\/gu, '/')
          // 无引号 /tr（重要）：Task Scheduler 对带引号命令的解析会把 Command 拆坏成
          // `"powershell ... -File \"`（非有效可执行文件）——任务显示 Ready、/run 报 SUCCESS
          // 但永不执行（曾导致升级/重启脚本反复"已启动"却不动作、服务不停止）。实测无引号
          // 格式（exe 与脚本路径均无空格时）任务正常执行、脚本完整跑通。仅当脚本路径含空格
          // 时才退回带引号格式（schtasks 引号解析在服务 execFile 上下文不可靠，此时宁可用它）。
          const tr = / /.test(ps1Posix)
            ? `"powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"${ps1Posix}\\""`
            : `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${ps1Posix}`
          execFile('schtasks.exe', ['/create', '/f', '/tn', taskName, '/tr', tr, '/sc', 'once', '/st', '00:00'], { windowsHide: true }, (error) => {
            if (error) {
              // 兜底：schtasks 不可用时退回 detached（可能仍受 Job 影响，但尽力）
              try { writeFileSync(stateFile, 'starting|升级脚本将通过 detached 启动（schtasks 不可用）|detached', 'utf8') } catch {}
              execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
              return
            }
            try { writeFileSync(stateFile, 'starting|升级脚本已通过计划任务启动|schtasks', 'utf8') } catch {}
            // create 回调里立即 /run 会因任务注册未完成而静默失败（曾导致任务从未执行）：
            // 延迟 800ms 再 run；run 仍失败则退回 detached 兜底
            setTimeout(() => {
              execFile('schtasks.exe', ['/run', '/tn', taskName], { windowsHide: true }, (runError) => {
                if (runError) {
                  try { writeFileSync(stateFile, 'starting|计划任务运行失败，改用 detached 兜底|detached-fallback', 'utf8') } catch {}
                  execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
                }
              })
            }, 800)
          })
        },
        () => {},
      )
      upgraded = true
      steps.push(`框架升级脚本已启动：${current} → ${target}（在线下载安装，服务保持运行，成功后自动重启生效，约 1-3 分钟）`)
      steps.push(`升级前配置已打包：${backupDir ?? '（跳过）'}；框架本体回滚点：${rollbackDir ?? '（跳过）'}`)
    } else if (hasUpdate) {
      steps.push('检测到新版本，但无法定位框架安装目录（@deepseek-ai/dsh 解析失败），已取消升级——请修复框架安装后重试')
    } else if (!hasUpdate) {
      steps.push(registryError !== null ? `版本检测失败（${registryError}），无法确认是否有新版本——请检查网络后重试` : '当前已是最新版本，无需升级')
    }
    // 4) 配置移植说明：cordis.patch.yml / bundles 位于 profile（升级不触碰），天然保留；
    //    重启后框架适配逻辑自动备份新版本快照 + 重打补丁
    const hints = [
      `现有配置已打包备份：${backupDir ?? '（跳过）'}。升级不触碰 profile 配置（cordis.patch.yml / bundles 天然保留）。`,
      '重要：升级全程约 1-3 分钟，服务保持在线（进度实时可见），仅最后重启生效时页面短暂断开——期间请勿手动拉起服务或重启桌面端，否则会中断升级。',
      ...steps,
      '升级完成后请重启 DSH 服务生效——重启后 Hub 自动：备份新版本配置快照、重打框架补丁（issue #5 容错）、给出适配提示。',
      '官方配套组件（@deepseek-ai/*）随框架一起升级，请勿在市场单独更新。',
    ]
    sendJson(res, 200, { ok: true, current, latest, next, target, hasUpdate, upgraded, backupDir, registryError, configMigrations, preflight, steps, hints })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/framework-rollback`) {
    // 一键回滚（2026-09-04 事故后的新能力）：读 framework-rollback.json（升级时写入），
    // 生成分离脚本：停服 → 全树恢复（.pnpm 自包镜像 + 顶层 scope + lock）→ 拉起 → 状态。
    let rec = null
    try { rec = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8')) } catch {}
    if (rec === null || typeof rec.checkpointDir !== 'string' || typeof rec.fwRoot !== 'string'
      || !existsSync(join(rec.checkpointDir, '.pnpm')) || !existsSync(join(rec.fwRoot, '.pnpm'))) {
      sendError(res, 409, '没有可用的框架全树回滚点（framework-rollback.json 缺失或 checkpoint 已清理）')
      return
    }
    const port = webPort(ctx)
    const nodePath = process.execPath
    const taskName = `DSH-FW-Rollback-${process.pid}`
    const ps1 = join(tmpdir(), `fw-rollback-${process.pid}.ps1`)
    const logFile = join(dshHome(), 'plugin-console', 'fw-upgrade.log')
    const stateFile = join(dshHome(), 'plugin-console', 'fw-upgrade-state.txt')
    const ps = (s) => JSON.stringify(s).replace(/\\\\/gu, '\\')
    const lines = [
      `$state = ${ps(stateFile)}`,
      `$log = ${ps(logFile)}`,
      "function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }",
      "function SetState($s, $m) {",
      "  try { if ($s -eq 'failed') { Set-Content -Path $state -Value ($s + '|' + $m + '|stage=' + [string]$script:stage) -Encoding UTF8; return } } catch {}",
      "  try { if ($s -ne 'done' -and $s -ne 'idle') { $script:stage = $s }; Set-Content -Path $state -Value ($s + '|' + $m) -Encoding UTF8; Beat } catch {}",
      "}",
      relaunchPrelude({ nodePath, pluginDir: join(dirname(fileURLToPath(import.meta.url)), '..'), fwRoot: rec.fwRoot, target: rec.from ?? '', ps }),
      "trap {",
      "  try { SetState 'failed' ('回滚脚本异常终止：' + $_.Exception.Message) } catch {}",
      `  schtasks /delete /f /tn ${taskName} 2>$null`,
      "  exit 1",
      "}",
      "SetState 'rollback' '回滚到升级前版本…'",
      "Log '一键回滚脚本启动'",
      `try { $svc = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($svc) { $svc | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3 } } catch {}`,
      "Log '服务已停止（回滚生效）'",
      `$cp = ${ps(rec.checkpointDir)}`,
      `$restored = 0`,
      `$entries = Get-ChildItem -Path (Join-Path $cp '.pnpm') -Directory -ErrorAction SilentlyContinue`,
      `foreach ($e in $entries) {`,
      `  $name = @($e.Name -split '\\+')[1].Split('@')[0]`,
      `  $src = Join-Path $e.FullName ('node_modules\\@deepseek-ai\\' + $name)`,
      `  $dst = Join-Path (Join-Path ${ps(rec.fwRoot)} ('.pnpm\\' + $e.Name)) ('node_modules\\@deepseek-ai\\' + $name)`,
      `  if (Test-Path (Join-Path $src 'package.json')) { New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null; robocopy $src $dst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null; $restored++ }`,
      `}`,
      `$topSrc = Join-Path $cp 'top-@deepseek-ai'`,
      `if (Test-Path $topSrc) { Remove-Item ${ps(join(rec.fwRoot, '@deepseek-ai'))} -Recurse -Force -ErrorAction SilentlyContinue; robocopy $topSrc ${ps(join(rec.fwRoot, '@deepseek-ai'))} /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null }`,
      `try { Copy-Item (Join-Path $cp 'lock.yaml') ${ps(join(rec.fwRoot, '.pnpm', 'lock.yaml'))} -Force -ErrorAction SilentlyContinue } catch {}`,
      `Log ('全树回滚完成：恢复 ' + $restored + ' 个版本包 + 顶层 scope，拉起验证中…')`,
      `$ok = $false`,
      `$started = $false`,
      `for ($i = 0; $i -lt 20; $i++) {`,
      `  try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
      `  if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '回滚后') { $started = $true } }; Beat`,
      `  Start-Sleep -Seconds 5`,
      `}`,
      `if ($ok) { SetState 'done' ('已回滚到升级前版本 ${rec.from ?? '?'}，服务正常') ; Log '回滚完成，服务已恢复' } else { SetState 'failed' '回滚后服务拉起失败：请手动运行 node ${resolveDshBin() ?? '<bin>'} web' ; Log '回滚后拉起失败' }`,
      `schtasks /delete /f /tn ${taskName} 2>$null`,
    ].filter((l) => l !== '').join('\r\n')
    try { writeFileSync(stateFile, 'rollback|回滚脚本已启动…', 'utf8') } catch {}
    fwCheckCache = null // 回滚后 [框架] 面板要立刻显示回滚到的版本
    writeFile(ps1, `\uFEFF${lines}`, 'utf8').then(
      () => {
        const ps1Posix = ps1.replace(/\\/gu, '/')
        const tr = / /.test(ps1Posix)
          ? `"powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"${ps1Posix}\\""`
          : `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${ps1Posix}`
        execFile('schtasks.exe', ['/create', '/f', '/tn', taskName, '/tr', tr, '/sc', 'once', '/st', '00:00'], { windowsHide: true }, (error) => {
          if (error) {
            execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
            return
          }
          setTimeout(() => {
            execFile('schtasks.exe', ['/run', '/tn', taskName], { windowsHide: true }, (runError) => {
              if (runError) {
                execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
              }
            })
          }, 800)
        })
      },
      () => {},
    )
    sendJson(res, 200, { ok: true, from: rec.from ?? null, checkpointDir: rec.checkpointDir })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/clean-residuals`) {
    // 清理残余备份/旧子包：删除 .old-* 备份目录，以及聚合包未声明的 @linxin666 旧子包
    const profileDir = dirname(findPatchPath(ctx))
    const nodeModules = join(profileDir, 'node_modules')
    const removed = []
    // 1) 删除 .old-* 残余备份（顶层 + 作用域目录）
    const scanDirs = [nodeModules]
    try { if (existsSync(join(nodeModules, '@linxin666'))) scanDirs.push(join(nodeModules, '@linxin666')) } catch {}
    for (const dir of scanDirs) {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          if (!/\.old-/u.test(entry.name)) continue
          const target = join(dir, entry.name)
          rmSync(target, { recursive: true, force: true })
          removed.push(entry.name)
        }
      } catch {}
    }
    // 2) 删除聚合包未声明的 @linxin666 旧子包（以 dsh-web-ui-all 的 dependencies 为准）
    try {
      const allPkgPath = join(nodeModules, '@linxin666', 'dsh-web-ui-all', 'package.json')
      if (existsSync(allPkgPath)) {
        const allPkg = JSON.parse(readFileSync(allPkgPath, 'utf8'))
        const declared = new Set(Object.keys(allPkg.dependencies ?? {}).filter((n) => n.startsWith('@linxin666/')))
        declared.add('@linxin666/dsh-web-ui-all')
        const scoped = join(nodeModules, '@linxin666')
        for (const entry of readdirSync(scoped, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const full = '@linxin666/' + entry.name
          if (declared.has(full)) continue
          const pkgJson = join(scoped, entry.name, 'package.json')
          if (existsSync(pkgJson)) {
            rmSync(join(scoped, entry.name), { recursive: true, force: true })
            removed.push(full)
          }
        }
      }
    } catch {}
    sendJson(res, 200, { ok: true, removed, count: removed.length })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/self-update`) {
    // Hub 自身一键更新：下载 npm 最新 tarball 到当前 profile，成功后由前端重启生效
    let selfVersion = null
    try {
      const selfPkg = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('../package.json'), 'utf8'))
      selfVersion = typeof selfPkg.version === 'string' ? selfPkg.version : null
    } catch {}
    let latest = null
    try {
      const data = await fetchJsonUrl('https://registry.npmmirror.com/@noob-stupid%2fdsh-plugin-console')
      latest = data?.['dist-tags']?.latest ?? null
    } catch {}
    if (!latest || selfVersion === null || latest === selfVersion) {
      sendJson(res, 200, { ok: false, current: selfVersion, latest, updated: false, reason: latest === selfVersion ? '已是最新版本' : '版本检测失败' })
      return
    }
    const profileDir = dirname(findPatchPath(ctx))
    const registries = orderedRegistries(readSources())
    try {
      const info = await curlManualInstall(profileDir, '@noob-stupid/dsh-plugin-console', registries)
      sendJson(res, 200, { ok: true, current: selfVersion, latest, updated: true, version: info.version, note: '已下载最新代码，重启服务后生效' })
    } catch (error) {
      sendError(res, 500, `Hub 自动更新失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/install`) {
    // repo 允许为空：纯 registry 更新（已安装插件的"检测更新"走此路径，无 git 兜底）
    const rawRepo = typeof body.repo === 'string' ? body.repo.trim() : ''
    let repo = ''
    if (rawRepo !== '') {
      try { repo = githubRepoInfo(rawRepo) } catch {}
    }
    const givenName = typeof body.packageName === 'string' ? body.packageName.trim() : ''
    // 框架本体拦截：deepseek-harness 仓库与其根包 @deepseek-ai/dsh-root 是 DSH 框架自身，
    // 作为插件安装会试图构建整个框架源码——直接拒绝并提示
    if (repo === 'deepseek-ai/deepseek-harness'
      || givenName === '@deepseek-ai/dsh-root'
      || givenName === '@deepseek-ai/dsh') {
      sendError(res, 400, 'deepseek-harness 是 DSH 框架本体，不是插件——无需安装（升级请用官方 dsh 升级方式）')
      return
    }
    const requestedKind = body.kind === 'skill' ? 'skill' : body.kind === 'suite' ? 'suite' : 'plugin'
    if ((requestedKind === 'skill' || requestedKind === 'suite') && repo === '') {
      sendError(res, 400, `${requestedKind === 'skill' ? '技能' : '套装'}安装必须提供仓库（owner/name）`)
      return
    }
    const source = body.source === 'gitee' ? body.source : 'github'
    const npmNamePattern = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u
    if (givenName !== '' && (!npmNamePattern.test(givenName) || givenName.length > 214)) {
      sendError(res, 400, 'packageName 不是合法的 npm 包名')
      return
    }
    // 防重（事故教训）：同一插件已在安装/更新中时拒绝新任务——否则反复点更新/安装会产生
    // 几十个并发下载任务（同一插件重复安装、消息刷屏、浪费流量）
    const dupJob = [...installJobs.values()].some((j) => j.status === 'installing'
      && ((repo !== '' && j.repo === repo) || (givenName !== '' && j.packageName === givenName)))
    if (dupJob) {
      sendError(res, 409, '该插件正在安装/更新中，请等待当前任务完成后再试')
      return
    }
    // 套装请求必须复检内容（2026-09-19 事故）：前端标记可能来自 24h enrich 缓存的误判，
    // 探测内容不像 .gitmodules 就按普通插件安装——别把用户送进注定失败的套装通道。
    let kind = requestedKind
    let suiteNote = null
    if (requestedKind === 'suite') {
      kind = resolveInstallKind('suite', await probeGitmodules(repo))
      if (kind !== 'suite') suiteNote = '探测未发现有效的 .gitmodules（不是 submodule 套装仓库），已按普通插件安装'
    }
    const job = {
      id: `job-${installJobSeq += 1}`,
      repo,
      source,
      packageName: givenName || null,
      status: 'installing',
      stage: 'preparing',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      entryId: null,
      bundle: false,
      ai: false,
      aiNote: null,
      subpackages: null,
      lastError: null,
        update: body.update === true,
      kind,
    }
    if (suiteNote !== null) job.suiteNote = suiteNote
    installJobs.set(job.id, job)
    // 套装通道兜底：探测说有、clone 下来却没有 .gitmodules（假阳性 / 仓库已重构）时
    // 回落普通插件安装，而不是给用户一个「未找到 .gitmodules」的失败。
    const runSuiteThenFallback = async () => {
      const result = await runSuiteInstallJob(job, ctx)
      if (result?.notASuite !== true) return
      job.kind = 'plugin'
      job.suiteNote = '仓库实际内容与探测不符（没有 .gitmodules），已自动回落普通插件安装'
      await runInstallJob(job, ctx)
    }
    // 后台执行：请求立即返回，安装不受客户端断开/离开面板影响
    void (kind === 'skill' ? runSkillInstallJob(job) : kind === 'suite' ? runSuiteThenFallback() : runInstallJob(job, ctx))
    sendJson(res, 200, { ok: true, jobId: job.id, status: 'installing', kind, ...(suiteNote !== null ? { suiteNote } : {}) })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/skill-remove`) {
    // 删除已安装技能：仅接受 kebab-case 名称（防目录穿越），删除 ~/.dsh/skills/<name>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.startsWith('.')) {
      // 点号开头是系统/隐藏技能根（如 .system，dsh-skill-filesystem 保留目录）：禁止删除
      sendError(res, 403, `技能 ${name} 属于系统/隐藏技能，禁止删除（保留 DSH 自带技能）`)
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
      sendError(res, 400, '技能名称无效（仅允许 kebab-case）')
      return
    }
    const dest = join(dshHome(), 'skills', name)
    if (!existsSync(dest)) {
      sendError(res, 404, `技能 ${name} 不存在`)
      return
    }
    try {
      rmSync(dest, { recursive: true, force: true })
      sendJson(res, 200, { ok: true, name })
    } catch (error) {
      sendError(res, 500, `删除技能失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/skill-toggle`) {
    // 停用/启用技能：写入官方调用策略 frontmatter（disable-model-invocation / user-invocable），
    // 可逆（原始内容备份于技能目录 .dsh-skill-fm.bak）；系统/隐藏技能禁止停用（保护机制）。
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.startsWith('.')) {
      // 点号开头是系统/隐藏技能根（如 .system，dsh-skill-filesystem 保留目录）：禁止停用
      sendError(res, 403, `技能 ${name} 属于系统/隐藏技能，禁止停用（保留 DSH 自带技能）`)
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
      sendError(res, 400, '技能名称无效（仅允许 kebab-case）')
      return
    }
    const dest = join(dshHome(), 'skills', name)
    let skillFile = join(dest, 'SKILL.md')
    if (!existsSync(skillFile)) {
      // 平铺技能（<name>.md）
      const flat = `${dest}.md`
      if (existsSync(flat)) skillFile = flat
      else {
        sendError(res, 404, `技能 ${name} 不存在`)
        return
      }
    }
    const enabled = body.enabled === true
    try {
      setSkillEnabled(skillFile, enabled)
      sendJson(res, 200, { ok: true, name, enabled, skillFile })
    } catch (error) {
      sendError(res, 500, `${enabled ? '启用' : '停用'}技能失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/install-status`) {
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const job = installJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个安装任务')
      return
    }
    sendJson(res, 200, { ok: true, ...installJobView(job) })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/ai-consent`) {
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const approved = body.approved === true
    const job = installJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个安装任务')
      return
    }
    if (job.stage !== 'ai-consent' || typeof job.aiWait?.then !== 'function') {
      sendError(res, 400, '该任务不在等待 AI 授权状态')
      return
    }
    const resolver = job.aiPending?.resolver
    job.aiWait = null
    job.aiPending = null
    if (typeof resolver === 'function') resolver({ approved })
    sendJson(res, 200, { ok: true, jobId, approved })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/ai-empower/plan`) {
    const source = typeof body.source === 'string' ? body.source.trim() : ''
    if (source === '' || source.length > 200) {
      sendError(res, 400, '请提供要部署的组件来源（npm 包名或 GitHub 仓库）')
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const jobId = `ai-${Date.now()}-${++aiJobSeq}`
    const job = { id: jobId, source, status: 'running', stage: 'planning', createdAt: Date.now(), logText: '', stepStates: [] }
    // 框架适配预检（兼容门 + registry 声明）：规划期即给出权威说明，供子代理引用与用户查看
    try { job.frameworkCheck = await frameworkCompatReportFor(source, ctx, profileDir) } catch { job.frameworkCheck = null }
    aiJobs.set(jobId, job)
    const builtin = builtinPlanFor(source)
    if (builtin !== null) {
      job.plan = builtin
      job.status = 'plan-ready'
      job.stage = 'builtin'
      job.finishedAt = Date.now()
      saveAiJobs()
      sendJson(res, 200, { ok: true, jobId, frameworkCheck: job.frameworkCheck })
      return
    }
    aiEmpowerPlan(job, ctx, profileDir).catch((error) => {
      job.status = 'failed'
      job.error = `规划任务异常：${error instanceof Error ? error.message : String(error)}`
      job.finishedAt = Date.now()
    })
    sendJson(res, 200, { ok: true, jobId, frameworkCheck: job.frameworkCheck })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/ai-empower/status`) {
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const job = aiJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个 AI 赋能任务')
      return
    }
    sendJson(res, 200, { ok: true, ...aiJobView(job) })
    return
  }
  if (pathname === `${ROUTE_PREFIX}/ai-empower/list`) {
    // 并发任务列表（轻量视图，不含日志全文）：面板展示/切换多个并发 AI 赋能任务
    const list = [...aiJobs.values()].slice(-10).reverse().map((job) => ({
      jobId: job.id,
      source: job.source,
      status: job.status,
      stage: job.stage,
      type: job.plan?.type ?? null,
      displayName: job.plan?.displayName ?? null,
      progress: job.progress ?? { done: 0, total: (job.plan?.steps ?? []).length },
      error: job.error ?? null,
      createdAt: job.createdAt,
    }))
    sendJson(res, 200, { ok: true, tasks: list })
    return
  }
  if (pathname === `${ROUTE_PREFIX}/ai-empower/run`) {
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const selected = Array.isArray(body.steps) ? body.steps : null
    // 纵深防御：必须显式确认（前端「同意并部署」按钮携带 confirmed:true），防止任何绕过同意直接执行
    if (body.confirmed !== true) {
      sendError(res, 400, '未确认部署：请先在面板勾选步骤并点击「同意并部署」')
      return
    }
    const job = aiJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个 AI 赋能任务')
      return
    }
    if (job.status !== 'plan-ready') {
      sendError(res, 400, '任务状态不是 plan-ready，无法执行')
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    aiEmpowerExecute(job, ctx, profileDir, selected).catch((error) => {
      job.status = 'failed'
      job.error = `执行任务异常：${error instanceof Error ? error.message : String(error)}`
      job.finishedAt = Date.now()
      saveAiJobs()
    })
    sendJson(res, 200, { ok: true, jobId })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/ai-empower/cancel`) {
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const job = aiJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个 AI 赋能任务')
      return
    }
    try { job.abort?.abort() } catch {}
    if (job.status === 'running' && job.stage === 'executing') {
      job.status = 'failed'
      job.error = '已取消执行（用户中断）'
      job.finishedAt = Date.now()
      saveAiJobs()
    }
    sendJson(res, 200, { ok: true, jobId })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/components`) {
    const list = findComponents()
    const enriched = []
    for (const c of list) {
      try {
        enriched.push(await compStatus(c.id))
      } catch {
        enriched.push({ id: c.id, name: c.name, running: false, healthy: null, pid: null, port: c.port ?? null, autoStart: c.autoStart === true })
      }
    }
    sendJson(res, 200, { ok: true, components: enriched.map((x) => ({ ...x, uiUrl: compUiUrl(compFind(x.id) ?? {}) })) })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/repo-clone`) {
    // 仓库落地：克隆任意项目到 <配置路径>/<owner>/<name>（地址由「软件源 → Git 源」决定，
    // 因此这里接受任意平台的仓库链接：GitHub / Gitee / GitLab / 自建 Gitea / 镜像代理前缀）
    const raw = typeof body.repo === 'string' ? body.repo.trim() : ''
    // 循环剥离协议/域名前缀：镜像代理链接可能叠两层（ghproxy.net/https://github.com/...）
    let repo = raw
    for (let guard = 0; guard < 4; guard += 1) {
      const next = repo
        .replace(/^https?:\/\/[^/]+\//u, '')
        .replace(/^git@[^:]+:/u, '')
      if (next === repo) break
      repo = next
    }
    repo = repo.replace(/\.git$/u, '').replace(/\/+$/u, '')
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(repo)
    if (!m) {
      sendError(res, 400, '仓库格式不正确：请提供 owner/repo 或仓库链接（如 https://gitee.com/owner/repo）')
      return
    }
    const [, owner, name] = m
    const root = getReposDir()
    const target = join(root, owner, name)
    if (existsSync(target)) {
      sendError(res, 400, `已存在：${target}（如需更新请先手动处理该目录）`)
      return
    }
    try {
      mkdirSync(root, { recursive: true })
      const urls = gitCloneUrls(`${owner}/${name}`)
      let lastError = null
      let cloned = false
      let usedUrl = ''
      for (const url of urls) {
        try {
          await execFileAsync(gitBin(), ['clone', '--depth', '1', url, target], { cwd: root, timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: gitEnv() })
          cloned = true
          usedUrl = url
          break
        } catch (error) {
          lastError = error
          // 失败可能留下半成品目录，清理后再试下一个源，否则会因目标已存在而连环失败
          try { rmSync(target, { recursive: true, force: true }) } catch {}
        }
      }
      if (!cloned) throw lastError ?? new Error('未知错误')
      sendJson(res, 200, { ok: true, owner, name, path: target, url: usedUrl })
    } catch (error) {
      sendError(res, 500, `克隆失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/repo-list`) {
    try {
      sendJson(res, 200, { ok: true, dir: getReposDir(), repos: listLandedRepos() })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/repo-land-config`) {
    const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
    if (dir === '' || !/^[A-Za-z]:[\\/]/.test(dir) && !/^\\\\/.test(dir)) {
      sendError(res, 400, '保存路径不合法：请提供绝对路径（如 D:\\dsh\\repos）')
      return
    }
    try {
      setReposDir(dir)
      sendJson(res, 200, { ok: true, dir: getReposDir() })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/repo-remove`) {
    const target = typeof body.path === 'string' ? body.path : ''
    const rootNorm = getReposDir().replace(/[\\/]+$/u, '')
    const tNorm = target.replace(/[\\/]+$/u, '')
    if (!tNorm.startsWith(rootNorm) || tNorm === rootNorm || !existsSync(target)) {
      sendError(res, 400, '路径不在仓库落地目录内或不存在')
      return
    }
    try {
      rmSync(target, { recursive: true, force: true })
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendError(res, 500, `删除失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/repo-open`) {
    const target = typeof body.path === 'string' ? body.path : ''
    const rootNorm = getReposDir().replace(/[\\/]+$/u, '')
    const tNorm = target.replace(/[\\/]+$/u, '')
    if (!tNorm.startsWith(rootNorm) || tNorm === rootNorm) {
      sendError(res, 400, '路径不在仓库落地目录内')
      return
    }
    if (!existsSync(target)) {
      sendError(res, 404, `目录不存在：${target}`)
      return
    }
    try {
      execFile('explorer.exe', [target], { windowsHide: true, detached: true }).unref()
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendError(res, 500, `打开失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/component/autostart`) {
    const id = typeof body.id === 'string' ? body.id : ''
    const enabled = body.enabled === true
    if (id === '') {
      sendError(res, 400, '缺少组件 id')
      return
    }
    if (!compFind(id)) {
      sendError(res, 404, '组件不存在')
      return
    }
    compUpsert({ id, autoStart: enabled })
    if (enabled) {
      compStart(id).catch(() => {})
    }
    sendJson(res, 200, { ok: true, id, autoStart: enabled })
    return
  }

  if (pathname === `${ROUTE_PREFIX}/component/start`) {
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      sendError(res, 400, '缺少组件 id')
      return
    }
    try {
      sendJson(res, 200, { ok: true, ...(await compStart(id)) })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/component/stop`) {
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      sendError(res, 400, '缺少组件 id')
      return
    }
    try {
      sendJson(res, 200, { ok: true, ...(await compStop(id)) })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/component/status`) {
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      sendError(res, 400, '缺少组件 id')
      return
    }
    try {
      sendJson(res, 200, { ok: true, ...(await compStatus(id)) })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (pathname === `${ROUTE_PREFIX}/restart`) {
    // 自带守护的自杀式重启：分离脚本杀掉本进程后，若端口无人监听则自动拉起服务。
    // 不再依赖桌面端监督器（它并不总是会重启服务，曾导致用户需要重启电脑）。
    // 安全护栏（事故教训）：无法定位 dsh bin 或 bin.js 不存在时**拒绝重启**——
    // 避免"kill 后拉不起"（框架缓存损坏时常见），提示先修复框架安装。
    //
    // v0.3.43 事故修复（2026-09-11 用户实测「重启后服务没自己拉起来，只能手动重启」）：
    // 现场证据＝一堆 Ready 僵尸任务（DSH-Restart-13804 / -31688 / -3744 / V2 / V3），
    // 说明脚本杀完服务后**自己也被结束了**（与升级/回滚脚本同一个毛病：0xC000013A），
    // 于是"检查端口→拉起"那几行根本没跑到；而且原来只等 3 秒、只查一次端口。
    // 现在改成三层保险：
    //   ① 主脚本：等到端口真正空出来（最多 20 秒轮询）→ 拉起 → 重试 3 次 → 写 console-restart.log
    //   ② **守护任务**（关键）：主脚本动手**之前**就注册一个每分钟跑一次的独立计划任务，
    //      服务被杀、主脚本被杀都不影响它；端口起来了它自删，起不来就继续拉（最多 5 次）
    //   ③ bin 解析用与升级/回滚同一套多级回退（node resolve → .pnpm → 顶层链接）
    const port = webPort(ctx)
    const binPath = resolveDshBin()
    const nodePath = process.execPath
    if (binPath === null || !existsSync(binPath)) {
      sendError(res, 500, `无法定位 DSH 启动入口（bin.js${binPath !== null ? `：${binPath}` : ''}），已取消重启——框架安装可能已损坏，请先修复 @deepseek-ai/dsh 后再重启`)
      return
    }
    if (process.platform === 'win32') {
      const consoleDir = join(dshHome(), 'plugin-console')
      try { mkdirSync(consoleDir, { recursive: true }) } catch {}
      const restartLog = join(consoleDir, 'console-restart.log')
      const fwRoot = resolveFrameworkRootNodeModules(dirname(dirname(binPath)))
      let installedVersion = ''
      try { installedVersion = JSON.parse(readFileSync(join(dirname(dirname(binPath)), 'package.json'), 'utf8')).version ?? '' } catch {}
      const ps = (s) => {
        const j = JSON.stringify(String(s)).replace(/\\\\/gu, '\\')
        if (j === '""') return "''"
        return j.replace(/`/gu, '``').replace(/\$/gu, '`$')
      }
      const prelude = relaunchPrelude({ nodePath, pluginDir: join(dirname(fileURLToPath(import.meta.url)), '..'), fwRoot: fwRoot ?? dirname(dirname(binPath)), target: installedVersion, ps })
      const taskName = `DSH-Restart-${process.pid}`
      const guardName = `DSH-RestartGuard-${process.pid}`
      const guardCount = join(consoleDir, `restart-guard-${process.pid}.count`)
      const killLine = `Stop-Process -Id ${process.pid} -Force -ErrorAction SilentlyContinue`
      // ① 主脚本：等端口空 → 拉起（重试 3 次）
      const mainLines = [
        `$log = ${ps(restartLog)}`,
        `$state = ${ps(join(consoleDir, 'fw-upgrade-state.txt'))}`,
        `function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }`,
        prelude,
        `Log ('重启脚本启动：目标端口 ${port}，bin=' + ${ps(binPath)})`,
        killLine,
        // 等到端口真正空出来（原实现只 sleep 3 秒、只查一次 —— 端口还占着就误判"已有人监听"而跳过拉起）
        `$free = $false`,
        `for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 1; try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if (-not $c -or $c.Count -eq 0) { $free = $true; break } } catch { $free = $true; break } }`,
        `Log ('端口 ' + ${ps(String(port))} + ' 状态：' + $(if ($free) { '已释放' } else { '仍被占用（可能被其它实例占着）' }))`,
        `$up = $false`,
        `for ($a = 1; $a -le 3; $a++) {`,
        `  [void](Invoke-DshRelaunch ('重启第 ' + $a + ' 次'))`,
        `  for ($w = 0; $w -lt 8; $w++) { Start-Sleep -Seconds 2; try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c -and $c.Count -gt 0) { $up = $true; break } } catch {} }; if ($up) { break }`,
        `}`,
        `if ($up) { Log '服务已重新监听，重启完成' } else { Log '三次拉起后端口仍未监听：守护任务会继续尝试（输出见 fw-relaunch.log）' }`,
        `schtasks /delete /f /tn ${taskName} 2>$null`,
      ]
      // ② 守护任务：独立于主脚本与服务进程，端口不起来就一直拉（最多 5 次）
      const guardLines = [
        `$log = ${ps(restartLog)}`,
        `$state = ${ps(join(consoleDir, 'fw-upgrade-state.txt'))}`,
        `function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' [guard] ' + $m) -Encoding UTF8 } catch {} }`,
        prelude,
        `$c = $null`,
        `try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue } catch {}`,
        `if ($c -and $c.Count -gt 0) { Log '服务已在监听，守护任务收工'; Remove-Item ${ps(guardCount)} -Force -ErrorAction SilentlyContinue; schtasks /delete /f /tn ${guardName} 2>$null; schtasks /delete /f /tn ${taskName} 2>$null; exit 0 }`,
        `$n = 0`,
        `try { $n = [int](Get-Content ${ps(guardCount)} -Raw -ErrorAction SilentlyContinue) } catch { $n = 0 }`,
        `$n = $n + 1`,
        `if ($n -gt 5) { Log ('已尝试 ' + ($n - 1) + ' 次仍拉不起来，放弃并自删（请手动启动，或看 fw-relaunch.log / console-restart.log）'); schtasks /delete /f /tn ${guardName} 2>$null; exit 0 }`,
        `try { Set-Content -Path ${ps(guardCount)} -Value ([string]$n) -Encoding UTF8 } catch {}`,
        `Log ('端口 ' + ${ps(String(port))} + ' 无监听，第 ' + $n + ' 次拉起')`,
        `[void](Invoke-DshRelaunch ('守护第 ' + $n + ' 次'))`,
      ]
      const ps1 = join(tmpdir(), `console-restart-${process.pid}.ps1`)
      const guardPs1 = join(tmpdir(), `console-restart-guard-${process.pid}.ps1`)
      const scheduleFor = (file, name, scheduleArgs) => {
        const posix = String(file).replace(/\\/gu, '/')
        // 无引号 /tr（重要）：Task Scheduler 对带引号命令的解析会把 Command 拆坏成
        // `"powershell ... -File \"`（非有效可执行文件）——任务显示 Ready、/run 报 SUCCESS
        // 但永不执行（曾导致升级/重启脚本反复"已启动"却不动作、服务不停止）。实测无引号
        // 格式（exe 与脚本路径均无空格时）任务正常执行、脚本完整跑通。仅当脚本路径含空格
        // 时才退回带引号格式（schtasks 引号解析在服务 execFile 上下文不可靠，此时宁可用它）。
        const tr = / /.test(posix)
          ? `"powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"${posix}\\""`
          : `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${posix}`
        return new Promise((resolve) => {
          execFile('schtasks.exe', ['/create', '/f', '/tn', name, '/tr', tr, ...scheduleArgs], { windowsHide: true }, (error) => resolve(error ?? null))
        })
      }
      Promise.all([
        writeFile(ps1, `\uFEFF${mainLines.join('\r\n')}`, 'utf8'),
        writeFile(guardPs1, `\uFEFF${guardLines.join('\r\n')}`, 'utf8'),
      ]).then(
        async () => {
          // 守护任务先注册（每分钟一次，独立于服务进程树）——主脚本被杀也有它兜底
          const guardError = await scheduleFor(guardPs1, guardName, ['/sc', 'minute', '/mo', '1'])
          const mainError = await scheduleFor(ps1, taskName, ['/sc', 'once', '/st', '00:00'])
          if (mainError !== null) {
            // schtasks 不可用：退回 detached 直接执行主脚本（守护任务仍可能已建）
            execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
            return
          }
          execFile('schtasks.exe', ['/run', '/tn', taskName], { windowsHide: true }, () => {})
          if (guardError !== null) {
            try { writeFileSync(restartLog, `[warn] 守护任务注册失败（${guardError.message}），仅靠主脚本重启\n`, { flag: 'a' }) } catch {}
          }
        },
        () => {},
      )
    } else {
      const script = process.platform === 'win32'
        ? `Start-Sleep -Seconds 2; Stop-Process -Id ${process.pid} -Force`
        : `sleep 2; kill -9 ${process.pid}`
      const cmd = process.platform === 'win32' ? 'powershell.exe' : 'sh'
      const args = process.platform === 'win32'
        ? ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script]
        : ['-c', script]
      execFile(cmd, args, { windowsHide: true }, () => {})
    }
    sendJson(res, 200, { ok: true, message: `正在重启 DSH 服务（自带守护，端口 ${port} 无监听会自动拉起），页面稍后自动恢复` })
    return
  }

  sendError(res, 404, `未知接口 ${pathname}`)
}
