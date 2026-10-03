// L2 · routes —— 市场（/search · /enrich · /repo · /subpackages · /market-index）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readGithubAuth } from '../domain/install.js'
import { enrichItems, fetchRepoPackage, fetchSubpackageNames, githubRepoInfo, hasDirectNameHit, normalizePlatformItems, searchNpmPackages, searchSubpackageItems } from '../domain/market.js'
import { buildPageEnvelope, rankSearchResults } from '../domain/market-search.js'
import { SKILL_TOPICS, detectSkillRepo, fetchSkillMeta } from '../domain/skills.js'
import { DEFAULT_SEARCH, gitCloneUrls, orderedRegistries, readGiteeConfig, readSources } from '../domain/sources.js'
import { GITHUB_API, META_BUDGET_MS, curlJson, fetchJsonUrl, githubJson, looksLikeGitmodules, rawTextWithFallback } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { marketIndexCacheFile } from '../infra/paths.js'
import { marketIndexCache, setMarketIndexCache } from '../state.js'

/** 技能检索的 per_page：三 topic 合并去重后不一定还有 20 条，取少了下拉就白丢条目
 *  （旧行为每 topic 20 条再截前 20 ⇒ 点「加载更多」也翻不出新东西）。 */
const SKILL_TOPIC_PER_PAGE = 50
/** 技能池缓存：同一个查询的**同一份合并池**重复切片 ⇒ 翻页幂等（不重不漏）。
 *  不进 state.js：这是路由层的短命缓存（与静态索引缓存不是一回事）。 */
const SKILL_POOL_TTL_MS = 300000
const skillPoolCache = new Map()
function skillPoolCacheGet(key) {
  const hit = skillPoolCache.get(key)
  if (hit === undefined) return null
  if (Date.now() - hit.at > SKILL_POOL_TTL_MS) { skillPoolCache.delete(key); return null }
  return hit.items
}
function skillPoolCacheSet(key, items) {
  if (skillPoolCache.size >= 8) skillPoolCache.delete(skillPoolCache.keys().next().value)
  skillPoolCache.set(key, { at: Date.now(), items })
}

async function routeSearch(req, res, rc) {
  const DEFAULT_SEARCH = rc.deps.DEFAULT_SEARCH
  // 网络取数的注入缝（默认就是真通道）：测试要断言"排序/分页/失败路径"时喂固定数据，
  // 免得把判据与 CI 稳定性绑在网络可用性上（与 routes/index.js 的 deps 同一种风格）。
  const fetchJson = typeof rc.deps?.fetchJson === 'function' ? rc.deps.fetchJson : fetchJsonUrl
  const searchRepos = typeof rc.deps?.githubJson === 'function' ? rc.deps.githubJson : githubJson
  const ctx = rc.ctx
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const raw = typeof body.q === 'string' ? body.q.trim() : ''
    const query = raw === '' ? DEFAULT_SEARCH : raw
    // 0.5.35 改错：旧代码把 page **夹到 1..5** —— 第 6 次「加载更多」起原地返回第 5 页，
    // 用户看到的是"怎么点都不出新条目"（与本次"没有加载更多"同族的第二个截断层）。
    // 现在只做合法性下限（≥1），真实可翻页性由 buildPageEnvelope 依据数据源的 total 如实回报。
    const page = Math.max(Number.parseInt(String(body.page), 10) || 1, 1)
    const source = typeof body.source === 'string' && body.source !== '' ? body.source : 'github'
    const all = body.all === true
    const auth = readGithubAuth()
    let items = []
    // 数据源报的**总命中数**（GitHub search 的 total_count；自定义源没有就留 null —— 绝不编造）
    let total = null
    // in:readme 重查那一层有没有被自己的 40 条上限截断（说清楚，别让用户以为"就是没有"）
    let readmeTruncated = false
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
          const again = await searchRepos(
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
        // 增量结果同样过**唯一**排序函数：客户端拿到后只需合并，不需要（也不许）自己另排一份
        items: rankSearchResults(extra, raw),
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
            const data = await searchRepos(
              `${GITHUB_API}/search/repositories?q=${encodeURIComponent(all ? query : `${query} topic:dsh-plugin`)}&sort=stars&order=desc&per_page=20&page=${page}`,
              req.signal,
              auth.token,
            )
            if (typeof data?.total_count === 'number') total = data.total_count
            return normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github', sourceName: 'GitHub' }))
          } catch {
            return []
          }
        })(),
        ...sources.searchSources.filter((s) => s.type === 'custom').map((s) => (async () => {
          try {
            const url = s.url.replace('{q}', encodeURIComponent(query)).replace('{page}', String(page))
            const data = await fetchJson(url, 15000, s.headers ?? {})
            return normalizePlatformItems(data, 'main').map((item) => ({ ...item, source: s.id, sourceName: s.name }))
          } catch {
            return []
          }
        })()),
      ]
      const results = await Promise.all(tasks)
      items = results.flat()
      items = await enrichItems(items)
      // 多源合并后**只排一次**（唯一排序函数）：跨源条目按同一套名字分层，同层才比 star
      items = rankSearchResults(items, raw)
      sendJson(res, 200, {
        ok: true, query, items, authenticated: auth.loggedIn, source: 'all', multi: true,
        ...buildPageEnvelope({ shown: items.length, total, page }),
      })
      return
    }
    if (body.skills === true) {
      // 技能模式搜索：agent-skills / claude-skills / dsh-skill 三 topic 并行检索后合并去重。
      // （GitHub search 的 OR 语法优先级不可靠，分开查最稳。）
      // 0.5.35 改错：旧行为「取前 20 条」把合并池**截断**在 20 —— 客户端点「加载更多」请求下一页，
      // 服务端仍从**每个 topic 的第 N 页**取 20 条再截前 20，去重后经常一条新的都没有（按钮白点）。
      // 现在：合并池按唯一排序函数排序 + 去重，然后**照分页口径切片**；并集池按查询缓存，
      // 同一查询的任何一页都从同一份池里切 ⇒ 翻页幂等（不重不漏）。
      if (source !== 'github') {
        sendError(res, 400, '技能搜索仅支持 GitHub 源')
        return
      }
      const keyword = raw === '' ? '' : `${raw} in:name,description,topics `
      const poolKey = `${raw}\u0000${all ? '1' : '0'}`
      let pool = skillPoolCacheGet(poolKey)
      if (pool === null) {
        const tasks = SKILL_TOPICS.map((topic) => (async () => {
          try {
            const data = await searchRepos(
              `${GITHUB_API}/search/repositories?q=${encodeURIComponent(`${keyword}topic:${topic}`)}&sort=stars&order=desc&per_page=${SKILL_TOPIC_PER_PAGE}&page=1`,
              req.signal,
              auth.token,
            )
            if (typeof data?.total_count === 'number') total = (total ?? 0) + data.total_count
            return normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github', skillTopics: [topic] }))
          } catch {
            return []
          }
        })())
        const merged = (await Promise.all(tasks)).flat()
        const seen = new Set()
        const deduped = []
        for (const item of rankSearchResults(merged, raw)) {
          if (seen.has(item.fullName)) continue
          seen.add(item.fullName)
          deduped.push(item)
        }
        pool = deduped
        skillPoolCacheSet(poolKey, pool)
      }
      const perPage = 20
      const start = (page - 1) * perPage
      items = pool.slice(start, start + perPage)
      items = await enrichItems(items)
      sendJson(res, 200, {
        ok: true, query, items, authenticated: auth.loggedIn, source: 'github', skills: true,
        // 技能池的真实总量（三 topic 并集去重后的条数），不是 GitHub 的 total_count 之和
        // （三个 topic 之间有重叠，直接相加会把"共 N 条"报大）
        ...buildPageEnvelope({ shown: items.length, total: pool.length, page, perPage }),
      })
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
          const data = await fetchJson(`https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${tokenQ}`)
          items = normalizePlatformItems([data], 'master').map((item) => ({ ...item, source: 'gitee' }))
        } catch (error) {
          giteeError = error instanceof Error ? error.message : String(error)
        }
      }
      sendJson(res, 200, {
        ok: true, query, items, authenticated: auth.loggedIn, source, giteeNeedsLogin: false, directOnly: true, giteeError,
        ...buildPageEnvelope({ shown: items.length, total, page }),
      })
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
      const data = await fetchJson(url, 15000, custom.headers ?? {})
      items = normalizePlatformItems(data, 'main').map((item) => ({ ...item, source, sourceName: custom.name }))
    } else {
      // npm 包名搜索与 GitHub 仓库搜索**并行**：npm 侧要查 registry 搜索 + packument + 仓库元数据
      // （实测 4.5~9s），串行会把两段等待叠加到用户身上。
      const npmPromise = raw !== '' && !body.skills
        ? searchNpmPackages(raw, orderedRegistries(readSources()), 3, auth.token).catch(() => [])
        : Promise.resolve([])
      const data = await searchRepos(
        `${GITHUB_API}/search/repositories?q=${encodeURIComponent(all ? query : `${query} topic:dsh-plugin`)}&sort=stars&order=desc&per_page=20&page=${page}`,
        req.signal,
        auth.token,
      )
      items = normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github' }))
      if (typeof data?.total_count === 'number') total = data.total_count
      items = await enrichItems(items)
      // monorepo 子包增强（OpenViking/examples/dsh-memory-plugin 等可按子包名搜到；
      // 代码搜索需登录，未登录时该函数返回空数组，见 domain/market.js 说明）
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
          const again = await searchRepos(
            `${GITHUB_API}/search/repositories?q=${encodeURIComponent(`${raw} in:name,description,readme${all ? '' : ' topic:dsh-plugin'}`)}&sort=stars&order=desc&per_page=20&page=1`,
            req.signal,
            auth.token,
          )
          for (const it of normalizePlatformItems(again.items ?? [], 'main')) {
            if (items.some((x) => x.fullName === it.fullName)) continue
            items.push({ ...it, source: 'github', viaReadme: true })
            // 截断上限 40 是**既有**的检索面口径（不改"谁被搜出来"）：只影响 in:readme 重查这一路，
            // 且被截断这件事由下面的 envelope 如实告知（truncated/reason），不再静默。
            if (items.length >= 40) { readmeTruncated = true; break }
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
    // ★ 唯一一处排序 ★：所有搜索链（github 多路合并 / multi 多源 / custom / gitee）在**这里**统一
    // 过同一个名字分层函数。上一版各分支自己排/自己截（skills 还截前 20），才会有"点两次结果不同"
    // 与"高星无关仓库压过逐字命中"。
    items = rankSearchResults(items, raw)
    // 分页/截断如实回报：客户端据此决定「加载更多」是否可点、要不要明说"已截断"。
    const envelope = buildPageEnvelope({ shown: items.length, total, page })
    sendJson(res, 200, {
      ok: true, query, items, authenticated: auth.loggedIn, source,
      ...envelope,
      // 自己那一层 40 条上限截断了 → 明说（否则用户以为"就是没有"；翻页也解不了这一层）
      ...(readmeTruncated ? { truncated: true, reason: envelope.reason !== null ? `${envelope.reason}；另：README 重查层已取满 40 条` : 'README 重查层已取满 40 条（可换更精确的关键词缩小范围）' } : {}),
      ...(extraNotes),
    })
    return
}

async function routeEnrich(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 为浏览器直连的搜索结果补官方/聚合标记（服务端通道可靠；客户端直连无标记能力）
    const raw = Array.isArray(body.items) ? body.items.slice(0, 30) : []
    const items = await enrichItems(raw)
    sendJson(res, 200, { ok: true, items })
    return
}

async function routeRepo(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
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

async function routeSubpackages(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const repo = githubRepoInfo(typeof body.repo === 'string' ? body.repo : '')
    const branch = typeof body.branch === 'string' && body.branch ? body.branch : 'main'
    const auth = readGithubAuth()
    // 复用安装链的防护实现：任一 raw 拉取失败只跳过该子包，不整体 500
    const subpackages = await fetchSubpackageNames(repo, branch, auth.token)
    sendJson(res, 200, { ok: true, repo, branch, subpackages })
    return
}

async function routeMarketIndex(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
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
        setMarketIndexCache({ at: Date.now(), data: merged, sourceName })
        try { await writeFile(marketIndexCacheFile(), JSON.stringify({ at: Date.now(), data: merged, sourceName }), 'utf8') } catch {}
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
          setMarketIndexCache({ at: Date.now(), data, sourceName: src.name })
          try { await writeFile(marketIndexCacheFile(), JSON.stringify({ at: Date.now(), data, sourceName: src.name }), 'utf8') } catch {}
          sendJson(res, 200, { ok: true, sourceName: src.name, ...data })
          return
        }
        formatError = `索引格式异常（${src.name} 未返回 items 数组）`
      } catch (error) {
        lastError = error
      }
    }
    try {
      const cached = JSON.parse(readFileSync(marketIndexCacheFile(), 'utf8'))
      if (cached && cached.data && Array.isArray(cached.data.items)) {
        setMarketIndexCache({ at: Date.now(), data: cached.data, sourceName: cached.sourceName ?? null })
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

export { routeSearch, routeEnrich, routeRepo, routeSubpackages, routeMarketIndex }
