// L1 · domain —— market.js（分层 Step 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { detectSkillRepo } from './skills.js'
import { FETCH_OK, FETCH_UNREACHABLE, GITHUB_API, curlJson, curlText, fetchJsonUrl, githubJson, looksLikeGitmodules, rawTextFetch, rawTextWithFallback } from '../infra/http.js'
import { ENRICH_CACHE_FILE, baseDirOf, resolvePackageJson } from '../infra/paths.js'

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

function githubRepoInfo(repo) {
  const match = String(repo).trim().match(/^(?:https:\/\/github\.com\/|https:\/\/gitee\.com\/|git@github\.com:|git@gitee\.com:)?([^\s\/?#]+)\/([^\s\/?#]+?)(?:\.git)?$/u)
  if (!match) throw new Error('仓库名格式应为 owner/name（支持完整仓库 URL 与中文路径）')
  return `${match[1]}/${match[2]}`
}

/** 从 npm 的 repository 字段解析出 GitHub/Gitee 仓库标识（纯函数，单测覆盖）。
 * 支持 `https://github.com/o/r.git`、`git+https://…`、`git://…`、带 `#path` 的 monorepo 写法。 */
function parseRepoFromUrl(url) {
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
function hasDirectNameHit(items, query) {
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
async function searchNpmPackages(query, registries, limit = 3, token = null) {
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
async function searchSubpackageItems(query, token = null, signal = null) {
  const subItems = []
  try {
    const codeData = await githubJson(
      `${GITHUB_API}/search/code?q=${encodeURIComponent(`${query} filename:package.json`)}`,
      signal,
      token,
    )
    for (const hit of (codeData.items ?? []).slice(0, 10)) {
      const hitPath = typeof hit.path === 'string' ? hit.path : ''
      if (!/^(?!node_modules\/)[^/]+(?:\/[^/]+)?\/package\.json$/u.test(hitPath)) continue
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

/** 包探测（带失败原因）：reason ∈ ok / not-found / unreachable / invalid。
 * 事故（2026-09-20，另一位用户：Android + proot Ubuntu，容器无 IPv6 路由）：
 * 抓取超时与真 404 都让上层拿到同一个 null，于是「网络太慢」被报成「仓库没有 package.json」，
 * 用户与日志都被误导。现在把两种结局分开，文案也分开。 */
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

/** 探测失败时的用户可读文案：「抓取超时/不可达」与「真的没有」必须区分开。 */
function packageProbeErrorText(repo, branch, reason) {
  if (reason === FETCH_UNREACHABLE) {
    return `抓取超时/网络不可达：没能读到 ${repo}（${branch} 分支）的 package.json —— 通常是网络到 GitHub 太慢（例如解析出 IPv6 却无 IPv6 路由）。请重试；若持续失败，可先用「仓库落地」克隆到本地目录。`
  }
  if (reason === 'invalid') {
    return `仓库 ${repo} 的 package.json 不是合法的包描述（缺少 name 字段），无法作为插件安装——可改用「仓库落地」克隆到本地目录。`
  }
  return `仓库 ${repo} 没有 package.json（也不是技能仓库），无法作为插件安装——可改用「仓库落地」克隆到本地目录。`
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

/** 服务端列出仓库子包（git trees 递归 + 并行读 package.json 的 name）。 */
async function fetchSubpackageNames(repo, branch, auth) {
  try {
    const data = await githubJson(`${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, undefined, auth)
    const paths = (data.tree ?? [])
      .filter((node) => node.type === 'blob' && /^(?!node_modules\/)[^/]+(?:\/[^/]+)?\/package\.json$/u.test(node.path))
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

/** 子包候选：聚合包（名字带 all）优先，上限 8 个。
 * 2026-09-20 真装演练：`@dsh-suite/all` 这种 **scope 根形式**（`/all` 结尾）不被
 * `(^|-)all$` 命中，聚合包没能排到最前（那次纯属仓库目录顺序碰巧第一）。补上 `/all$`。 */
async function subpackageCandidates(repo, branch, auth) {
  const isAll = (name) => /(^|-)all$/u.test(name) || /-all-/u.test(name) || /\/all$/u.test(name)
  const subs = await fetchSubpackageNames(repo, branch, auth)
  return subs
    .slice()
    .sort((a, b) => Number(isAll(b.name)) - Number(isAll(a.name)))
    .map((sub) => sub.name)
    .slice(0, 8)
}

const ENRICH_CACHE_TTL = 24 * 60 * 60 * 1000

export { readEnrichCache, writeEnrichCache, enrichItemOne, enrichItems, normalizePlatformItems, githubRepoInfo, fetchRepoPackage, fetchRepoPackageEx, packageProbeErrorText, searchNpmPackages, searchSubpackageItems, parseRepoFromUrl, hasDirectNameHit, summarizeReadme, readPluginDetails, fetchSubpackageNames, subpackageCandidates, ENRICH_CACHE_TTL }
