// L1 · domain —— sources.js（分层 Step 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三

import { readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { sourcesFile, sourcesSecretsFile } from '../infra/paths.js'

/** 读取软件源配置（损坏/缺失时回退默认）。 */
function readSources() {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_SOURCES))
  try {
    const data = JSON.parse(readFileSync(sourcesFile(), 'utf8'))
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
  await writeFile(sourcesFile(), JSON.stringify(main, null, 2) + '\n', 'utf8')
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

function readSourceSecrets() {
  try {
    const data = JSON.parse(readFileSync(sourcesSecretsFile(), 'utf8'))
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
    try { rmSync(sourcesSecretsFile(), { force: true }) } catch {}
    return
  }
  await writeFile(sourcesSecretsFile(), JSON.stringify({ gitee, headers }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

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

const DEFAULT_SOURCES = {
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
    { id: 'jsdelivr', name: 'jsDelivr CDN', url: 'https://cdn.jsdelivr.net/gh/Noob-stupid/dsh-plugin-gating-hub@main/marketplace/index.json', primary: true },
    { id: 'jsdelivr-gcore', name: 'jsDelivr (gcore)', url: 'https://gcore.jsdelivr.net/gh/Noob-stupid/dsh-plugin-gating-hub@main/marketplace/index.json', primary: false },
    { id: 'jsdelivr-fastly', name: 'jsDelivr (fastly)', url: 'https://fastly.jsdelivr.net/gh/Noob-stupid/dsh-plugin-gating-hub@main/marketplace/index.json', primary: false },
    { id: 'ghproxy', name: 'ghproxy 镜像', url: 'https://ghproxy.net/https://raw.githubusercontent.com/Noob-stupid/dsh-plugin-gating-hub/main/marketplace/index.json', primary: false },
    { id: 'raw', name: 'GitHub raw 直连', url: 'https://raw.githubusercontent.com/Noob-stupid/dsh-plugin-gating-hub/main/marketplace/index.json', primary: false },
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

/** Gitee OAuth state 一次性凭证（防止登录 CSRF / token 替换）。 */
const GITEE_OAUTH_STATES = new Map()

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

/** Gitee OAuth 端点（第三方应用需在 gitee.com → 数据管理 → 第三方应用 创建）。 */
const GITEE_AUTH_URL = 'https://gitee.com/oauth/authorize'

const GITEE_TOKEN_URL = 'https://gitee.com/oauth/token'
const DEFAULT_SEARCH = 'dsh-plugin'
export { readSources, writeSources, maskSources, readSourceSecrets, writeSourceSecrets, isAllowedSourceUrl, isAllowedGitSourceUrl, readGiteeConfig, giteeStatusView, orderedRegistries, createGiteeOAuthState, consumeGiteeOAuthState, DEFAULT_SOURCES, GITEE_OAUTH_STATES, gitCloneUrls, GITEE_AUTH_URL, GITEE_TOKEN_URL, DEFAULT_SEARCH }
