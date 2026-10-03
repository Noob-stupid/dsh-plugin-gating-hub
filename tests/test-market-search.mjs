// 0.5.35 市场搜索：**唯一排序函数** + 分页/截断语义 —— 离线硬门槛（注入 fetcher，不出网）
//
// 真机缺陷（2026-10-03 用户实测，输入他刚发布的仓库确切名字 dsh-connection-card-host）：
//   ① 结果里只有三条**无关的高星**条目（dsh-desktop ★29812 / awesome-dsh-plugin ★17621 /
//      dsh-desktop ★11682），他要的仓库既不在前排、往下也没有；
//   ② 没有「加载更多」，无从往下看；
//   ③ 点两次搜索，结果不一样。     （三条同源：两条搜索链竞态 + 按星排 + 按钮判据错）
//
// 用户定案（原话）：「所有的搜索链，都应该以名字相似为主排序，然后才往下按 star 走」。
// 本套把它钉死成可执行断言（全离线：私有 DSH_HOME + 注入 fetcher）：
//   ① 双份实现的**逐字一致**（服务端模块 ↔ 浏览器单文件产物里的移植块）
//   ② Tier 0-6 分层逐条 + 「★1 精确命中必须压过 ★99230 / ★29812」这个用户场景
//   ③ 同层才比 star（stars 降序 → 最近更新优先 → full_name 兜底）
//   ④ 唯一入口：所有搜索链都调 rankSearchResults（源码级断言：不许再有第二套排序）
//   ⑤ 连续两次搜索**结果一致**（同一输入 ⇒ 逐位相同）
//   ⑥ 分页不重不漏（逐页切片并集 == 全集；每页内顺序 == 全序）
//   ⑦ 信封三态：0 条 / 被截断（可继续加载）/ 到底（hasMore=false）
//   ⑧ 失败路径**不静默**：两条链都失败 ≠ 0 命中（信封必须带 truncated + reason）
//   ⑨ 客户端渲染判据："加载更多"看 hasMore（不再看 length>=20）+ 计数行 + 截断提示
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = join(ROOT, '.testdir', 'market-rank-home')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'profiles', 'web'), { recursive: true })
// 私有 DSH_HOME：不读真实 profile / 不读真实 GitHub 凭证（readGithubAuth 走这里 → loggedIn=false）
process.env.DSH_HOME = HOME
// 私有软件源：registry 指向本机死端口（searchNpmPackages 内部走真 fetchJsonUrl，
// 不注入就真出网 —— 那会让"条目数/顺序"随 npm 上真包变化而漂移，CI 也不该依赖外网）。
// 自定义搜索源只留 GitHub：多源分支不会去连任何外部地址。
writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
  version: 1,
  registries: [{ id: 'dead', name: 'dead', url: 'http://127.0.0.1:9', primary: true }],
  // 多源分支要有一条**自定义**源才跑得起来（builtin 的 github/gitee 不参与 multi 的自定义源任务）；
  // 地址是桩，测试里由注入的 fetchJson 接住，不会真出网。
  searchSources: [
    { id: 'github', name: 'GitHub' },
    { id: 'stub', name: '桩源', url: 'http://127.0.0.1:9/search?q={q}' },
  ],
  indexSources: [{ id: 'dead', name: 'dead', url: 'http://127.0.0.1:9/index.json', primary: true }],
}, null, 2), 'utf8')

const {
  RANK_TIER, rankTier, rankSearchResults, rankTiers, buildPageEnvelope,
} = await import('../lib/server/domain/market-search.js')
const { routeSearch } = await import('../lib/server/routes/market.js')
// 路由会把 GitHub 原始条目归一化（normalizePlatformItems）—— 期望值也用同一个归一化，保证同形状比较
const { normalizePlatformItems } = await import('../lib/server/domain/market.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── ⓪ 双份实现逐字一致（唯一排序函数是**可验证的事实**，不是口头约定）──────────────
/** 取标记块（含 begin/end 两行），去掉行的公共前导空白 + 统一 LF。 */
function rankBlockOf(source) {
  const lines = source.replace(/\r\n/gu, '\n').split('\n')
  const begin = lines.findIndex((l) => l.trimStart().startsWith('// <<<market-rank:begin>>>'))
  const end = lines.findIndex((l) => l.trimStart().startsWith('// <<<market-rank:end>>>'))
  if (begin < 0 || end <= begin) return null
  const block = lines.slice(begin, end + 1)
  return block.map((l) => {
    const m = l.match(/^[ \t]*/u)
    return l.slice(m === null ? 0 : m[0].length)
  }).join('\n').trim()
}
const serverSrc = readFileSync(join(ROOT, 'lib', 'server', 'domain', 'market-search.js'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const serverBlock = rankBlockOf(serverSrc)
const clientBlock = rankBlockOf(clientSrc)
check('① 两端都有排序标记块（服务端 domain / 浏览器单文件产物）', serverBlock !== null && clientBlock !== null,
  `server=${serverBlock === null ? '缺失' : `${serverBlock.split('\n').length} 行`} client=${clientBlock === null ? '缺失' : `${clientBlock.split('\n').length} 行`}`)
check('① ★ 两份实现**去缩进后逐字相等**（改一边必须改另一边）', serverBlock !== null && serverBlock === clientBlock,
  serverBlock === clientBlock ? '一致' : '不一致 —— 唯一排序函数被分叉了')
check('① 排序块里确实只有**一个**排序入口 rankSearchResults（compareByRank 内部一次 sort；另一处是纯展示的层分组）',
  [...serverBlock.matchAll(/function rankSearchResults\(/gu)].length === 1
  && [...serverBlock.matchAll(/return list\.sort\(compareByRank\(query\)\)/gu)].length === 1,
  `rankSearchResults=${[...serverBlock.matchAll(/function rankSearchResults\(/gu)].length} 入口=${[...serverBlock.matchAll(/return list\.sort\(compareByRank\(query\)\)/gu)].length}`)

// ── ① Tier 0-6 逐条（判据本体）─────────────────────────────────────────────────
const Q = 'dsh-connection-card-host'
const T = (item, query = Q) => rankTier(query, item)
const caseOf = (name, item, want, query = Q) => {
  const got = T(item, query)
  const label = Object.keys(RANK_TIER).find((k) => RANK_TIER[k] === got) ?? String(got)
  check(`① ${name} → ${Object.keys(RANK_TIER).find((k) => RANK_TIER[k] === want)}`, got === want, `实得 ${label}`)
}
caseOf('Tier 0 full_name 逐字相等（owner/repo 查询）', { fullName: 'me/dsh-connection-card-host' }, RANK_TIER.FULL_NAME_EXACT, `me/${Q}`)
// 注：查询是**裸名**时，`me/dsh-connection-card-host` 属于 Tier 1（name 逐字相等），不是 Tier 0 ——
// 这正是"输入确切 repo 名也要排第一"的效果（Tier 0/1 都在所有相似度层之上）。
caseOf('Tier 1 裸名查询命中同名字段（大小写不敏感）', { fullName: 'me/dsh-connection-card-host' }, RANK_TIER.NAME_EXACT)
caseOf('Tier 0 owner/repo 查询下同名不同 owner 不算逐字命中（owner 不是那个 owner ⇒ 不是"确切的仓库"）',
  { fullName: 'other/dsh-connection-card-host' }, RANK_TIER.NOT_MATCHED, `me/${Q}`)
caseOf('Tier 0 owner/repo 查询下名字也无关 ⇒ NOT_MATCHED',
  { fullName: 'other/repo-x' }, RANK_TIER.NOT_MATCHED, `me/${Q}`)
caseOf('Tier 1 大小写不敏感（name 逐字相等）', { fullName: 'me/Dsh-Connection-Card-Host' }, RANK_TIER.NAME_EXACT)
caseOf('Tier 0 尾部 .git 归一', { fullName: 'me/dsh-connection-card-host.git' }, RANK_TIER.FULL_NAME_EXACT, `me/${Q}`)
caseOf('Tier 1 裸名逐字相等（full_name 更长时）', { fullName: 'me/rx', name: Q }, RANK_TIER.NAME_EXACT)
caseOf('Tier 2 前缀命中', { fullName: 'me/dsh-connection-card-host-preview' }, RANK_TIER.NAME_PREFIX)
caseOf('Tier 3 含查询子串', { fullName: 'me/awesome-dsh-connection-card-host-tools' }, RANK_TIER.NAME_SUBSTRING)
caseOf('Tier 4 token 全命中（乱序）', { fullName: 'me/host-card-connection-dsh' }, RANK_TIER.NAME_TOKENS)
caseOf('Tier 5 描述命中', { fullName: 'me/unrelated', description: `wrapper for ${Q}` }, RANK_TIER.DESCRIPTION_OR_TOPICS)
caseOf('Tier 5 topics 命中', { fullName: 'me/unrelated', topics: [Q] }, RANK_TIER.DESCRIPTION_OR_TOPICS)
caseOf('Tier 6 README 命中（自带 readme 文本）', { fullName: 'me/unrelated', readme: `usage: ${Q}` }, RANK_TIER.README)
caseOf('Tier 6 README 命中（in:readme 重查标记位）', { fullName: 'me/unrelated', viaReadme: true }, RANK_TIER.README)
caseOf('未命中 → NOT_MATCHED（排最后）', { fullName: 'dsh-desktop/dsh-desktop', description: 'a desktop shell' }, RANK_TIER.NOT_MATCHED)
check('① 分层严格递增（Tier 0 < 1 < … < 6 < NOT_MATCHED）',
  RANK_TIER.FULL_NAME_EXACT < RANK_TIER.NAME_EXACT && RANK_TIER.NAME_EXACT < RANK_TIER.NAME_PREFIX
  && RANK_TIER.NAME_PREFIX < RANK_TIER.NAME_SUBSTRING && RANK_TIER.NAME_SUBSTRING < RANK_TIER.NAME_TOKENS
  && RANK_TIER.NAME_TOKENS < RANK_TIER.DESCRIPTION_OR_TOPICS && RANK_TIER.DESCRIPTION_OR_TOPICS < RANK_TIER.README
  && RANK_TIER.README < RANK_TIER.NOT_MATCHED, JSON.stringify(RANK_TIER))

// ── ② ★ 用户场景：★1 的逐字命中必须压过 ★99230 / ★29812 ─────────────────────────
const USER_SCENE = [
  { fullName: 'dsh-desktop/dsh-desktop', stars: 99230, updatedAt: '2026-10-03T02:00:00Z', description: 'dsh desktop host' },
  { fullName: 'Noob-stupid/awesome-dsh-plugin', stars: 29812, updatedAt: '2026-10-03T01:00:00Z', description: 'awesome list' },
  { fullName: 'Noob-stupid/dsh-connection-card-host', stars: 1, updatedAt: '2026-10-02T00:00:00Z', description: '连接卡片宿主' },
]
{
  const ordered = rankSearchResults(USER_SCENE, Q)
  check('② ★ 用户场景：★1 的逐字命中排第 1（不再被 ★99230/★29812 埋没）',
    ordered[0].fullName === 'Noob-stupid/dsh-connection-card-host',
    ordered.map((x) => `${x.fullName}★${x.stars}`).join(' > '))
  check('② 未命中的高星条目退到最后（同层内仍然 star 降序）',
    ordered[1].stars === 99230 && ordered[2].stars === 29812,
    ordered.map((x) => `★${x.stars}`).join(' > '))
  const buckets = rankTiers(USER_SCENE, Q)
  check('② 分层视图：命中层从 Tier 1 起（裸名查询）且未命中的高星条不入列',
    buckets[0].tier === RANK_TIER.NAME_EXACT && buckets[0].items.length === 1
    && buckets[0].items[0].fullName === 'Noob-stupid/dsh-connection-card-host'
    && buckets.every((b) => b.tier <= RANK_TIER.README)
    && buckets.every((b) => b.items.every((it) => it.fullName !== 'dsh-desktop/dsh-desktop')),
    buckets.map((b) => `T${b.tier}:${b.items.length}`).join(','))
}

// ── ③ 同层内：stars 降序 → 最近更新优先 → full_name 兜底 ─────────────────────────
{
  const same = [
    { fullName: 'a/dsh-connection-card-host-x', stars: 5, updatedAt: '2026-01-01T00:00:00Z' },
    { fullName: 'b/dsh-connection-card-host-y', stars: 50, updatedAt: '2020-01-01T00:00:00Z' },
    { fullName: 'c/dsh-connection-card-host-z', stars: 5, updatedAt: '2026-09-01T00:00:00Z' },
    { fullName: 'd/dsh-connection-card-host-w', stars: 5, updatedAt: '2026-09-01T00:00:00Z' },
  ]
  const ordered = rankSearchResults(same, Q).map((x) => x.fullName)
  check('③ 同层内 stars 降序', ordered[0] === 'b/dsh-connection-card-host-y', ordered.join(' > '))
  check('③ 同层同星 → 最近更新优先', ordered[1] === 'c/dsh-connection-card-host-z' && ordered[2] === 'd/dsh-connection-card-host-w', ordered.join(' > '))
  check('③ 全同 → full_name 字典序兜底（分页不抖动）', ordered[3] === 'a/dsh-connection-card-host-x', ordered.join(' > '))
  const noTime = rankSearchResults([
    { fullName: 'x/dsh-connection-card-host-1', stars: 1, updatedAt: '' },
    { fullName: 'y/dsh-connection-card-host-2', stars: 1, updatedAt: '2026-01-01T00:00:00Z' },
  ], Q).map((x) => x.fullName)
  check('③ 没给更新时间的排最后（绝不编造"刚更新"）', noTime[0] === 'y/dsh-connection-card-host-2', noTime.join(' > '))
}
check('③ 绝不改内容：只改顺序（字段逐字不变，且返回新数组）',
  (() => {
    const src = [{ fullName: `me/${Q}`, stars: 1, description: 'x' }, { fullName: 'z/z', stars: 9 }]
    const before = JSON.stringify(src)
    const out = rankSearchResults(src, Q)
    return out !== src && JSON.stringify([...src].sort(() => 0)) === before && JSON.stringify(out.find((x) => x.fullName === `me/${Q}`)) === JSON.stringify(src[0])
  })())
check('③ 空查询/非数组输入不炸（返回空或原样）',
  rankSearchResults(null, Q).length === 0 && rankSearchResults([], Q).length === 0 && rankSearchResults([{ fullName: 'a/b' }], '').length === 1)

// ── ④ ⑤ 唯一入口 + 连续两次搜索一致 ─────────────────────────────────────────────
{
  const a = rankSearchResults(USER_SCENE, Q).map((x) => x.fullName)
  const b = rankSearchResults(USER_SCENE, Q).map((x) => x.fullName)
  const c = rankSearchResults([...USER_SCENE].reverse(), Q).map((x) => x.fullName)
  check('⑤ ★ 连续两次搜索（含输入顺序颠倒）结果**逐位一致**（点两次不会再变）',
    JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) === JSON.stringify(c), a.join(' > '))
}

// ── ⑥ ⑦ 分页不重不漏 + 三态信封 ────────────────────────────────────────────────
{
  const total = 47
  const universe = Array.from({ length: total }, (_, i) => ({
    fullName: `org${String(i).padStart(2, '0')}/dsh-connection-card-host-${i}`,
    stars: 1000 - i,
    updatedAt: '2026-01-01T00:00:00Z',
  }))
  const full = rankSearchResults(universe, Q)
  const pages = [1, 2, 3].map((p) => full.slice((p - 1) * 20, p * 20))
  check('⑥ 每页 20 条（第 3 页 7 条）', pages[0].length === 20 && pages[1].length === 20 && pages[2].length === 7,
    pages.map((x) => x.length).join('/'))
  const union = pages.flat().map((x) => x.fullName)
  check('⑥ ★ 逐页切片**不重不漏**（并集 == 全集、且顺序 == 全序）',
    union.length === total && new Set(union).size === total
    && union.every((n, i) => n === full[i].fullName), `${union.length} 条 / 去重后 ${new Set(union).size}`)
  const env = (p) => buildPageEnvelope({ shown: pages[p - 1].length, total, page: p })
  check('⑦ 还有更多：hasMore=true 且 truncated=true（已取到的没覆盖总数）',
    env(1).hasMore === true && env(1).truncated === true && env(1).total === total && typeof env(1).reason === 'string',
    JSON.stringify(env(1)))
  check('⑦ 到底：最后一页 hasMore=false', env(3).hasMore === false, JSON.stringify(env(3)))
  const zero = buildPageEnvelope({ shown: 0, total: 0, page: 1 })
  check('⑦ 0 条：total=0 / hasMore=false / **truncated=false**（"就是没有"与"被截断"必须分得开）',
    zero.total === 0 && zero.hasMore === false && zero.truncated === false && zero.reason === null, JSON.stringify(zero))
  const inCap = buildPageEnvelope({ shown: 20, total: 5432, page: 49, perPage: 20 })
  const atCap = buildPageEnvelope({ shown: 20, total: 5432, page: 50, perPage: 20 })
  const pastCap = buildPageEnvelope({ shown: 20, total: 5432, page: 51, perPage: 20 })
  check('⑦ 数据源硬上限（>1000）明说原因（"最多只返回前 1000 条"）',
    inCap.truncated === true && inCap.reason.includes('1000') && atCap.truncated === true, inCap.reason)
  // ★ 真机实测：GitHub 的 `page=51&per_page=20`（第 1001 条起）是 **HTTP 422**，不是空页。
  // 所以"还能翻"必须在越过上限时转 false —— 否则按钮会把用户送到一个必然报错的请求上。
  check('⑦ ★ 越过 1000 条上限后 hasMore=false（不给"点了必然 422"的按钮）',
    inCap.hasMore === true && atCap.hasMore === false && pastCap.hasMore === false
    && atCap.reason.includes('无法再往下'),
    `p49=${inCap.hasMore} p50=${atCap.hasMore} p51=${pastCap.hasMore}`)
  const unknown = buildPageEnvelope({ shown: 20, total: null, page: 1 })
  check('⑦ 数据源没给总数：只说"已显示 M 条"，但满页仍可继续（不编造总数）',
    unknown.total === null && unknown.hasMore === true && unknown.truncated === true && typeof unknown.reason === 'string', JSON.stringify(unknown))
  check('⑦ 信封幂等（同一参数永远同一结论）',
    JSON.stringify(env(1)) === JSON.stringify(env(1)) && JSON.stringify(atCap) === JSON.stringify(buildPageEnvelope({ shown: 20, total: 5432, page: 50, perPage: 20 })))
}

// ── ⑧ 路由级：注入 fetcher 真跑 /search（不联网）────────────────────────────────
const GH_URL = 'https://api.github.com/search/repositories'
const itemsOf = (value) => (Array.isArray(value) ? value : [])
/** 造一个 /search 用的假响应对（githubJson + fetchJson 两个注入缝）。 */
function fakeRoute(reply) {
  const seen = []
  const githubJson = async (url) => { seen.push(String(url)); return reply(String(url)) }
  const fetchJson = async (url) => { seen.push(String(url)); return reply(String(url)) }
  const call = async (body, extraDeps = {}) => {
    const res = { status: 0, body: null }
    res.writeHead = (s) => { res.status = s }
    res.end = (p) => { res.body = p }
    await routeSearch(
      { signal: { aborted: false, addEventListener: () => {} } },
      res,
      { ctx: {}, url: new URL('http://127.0.0.1/plugin-console/search'), pathname: '/plugin-console/search', method: 'POST', body, deps: { DEFAULT_SEARCH: 'dsh-plugin', githubJson, fetchJson, ...extraDeps } },
    )
    return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
  }
  return { call, seen }
}
const repo = (fullName, stars, extra = {}) => ({
  full_name: fullName, description: extra.description ?? '', html_url: `https://github.com/${fullName}`,
  stargazers_count: stars, updated_at: extra.updatedAt ?? '2026-10-01T00:00:00Z',
  default_branch: 'main', topics: extra.topics ?? [],
})
/** 归一化后的条目形状（= normalizePlatformItems 的产物）：canonical 判据读的是这一套字段。
 *  （路由返回给客户端的就是这个形状；原始 GitHub 形状见上面的 repo()，别混用。） */
const item = (fullName, stars, extra = {}) => ({
  fullName, description: extra.description ?? '', htmlUrl: `https://github.com/${fullName}`,
  stars, updatedAt: extra.updatedAt ?? '2026-10-01T00:00:00Z', defaultBranch: 'main', topics: extra.topics ?? [],
})

// ⑧-① github 主链：一次请求内合并「命中 + 未命中」，顺序必须按名字分层而不是按 star
{
  const hit = repo('Noob-stupid/dsh-connection-card-host', 1)
  const noiseA = repo('dsh-desktop/dsh-desktop', 99230, { description: 'desktop shell' })
  const noiseB = repo('Noob-stupid/awesome-dsh-plugin', 29812, { description: 'awesome list' })
  const { call, seen } = fakeRoute((url) => {
    if (!url.startsWith(GH_URL)) throw new Error(`不该请求：${url.slice(0, 60)}`)
    if (url.includes('in%3Areadme') || url.includes('in:readme')) return { total_count: 0, items: [] }
    return { total_count: 3, items: [noiseA, noiseB, hit] }
  })
  const r = await call({ q: 'dsh-connection-card-host', page: 1, all: true })
  check('⑧ 路由 200 + ok', r.status === 200 && r.json.ok === true, `status=${r.status}`)
  check('⑧ ★ 服务端返回顺序：★1 逐字命中第 1，高星无关条退后',
    itemsOf(r.json.items)[0]?.fullName === 'Noob-stupid/dsh-connection-card-host',
    itemsOf(r.json.items).map((x) => `${x.fullName}★${x.stars}`).join(' > '))
  check('⑧ ★ 两次请求（同一注入数据）结果逐位一致 —— 分页幂等/点两次不变',
    JSON.stringify(itemsOf((await call({ q: 'dsh-connection-card-host', page: 1, all: true })).json.items))
    === JSON.stringify(itemsOf(r.json.items)))
  check('⑧ 信封：total=3 / hasMore=false / truncated=false（三条全在这页）',
    r.json.total === 3 && r.json.hasMore === false && r.json.truncated === false, JSON.stringify({ total: r.json.total, hasMore: r.json.hasMore, truncated: r.json.truncated }))
  check('⑧ 请求真的走了注入缝（没有真网络）', seen.length >= 1 && seen.every((u) => u.startsWith(GH_URL)), `${seen.length} 次`)
}

// ⑧-② 真·翻页（total 很大）：逐页请求 → 不重不漏；第 6 页也**不许**原地返回第 5 页
{
  const big = Array.from({ length: 105 }, (_, i) => repo(`org${i}/dsh-connection-card-host-${i}`, 900 - i))
  const { call } = fakeRoute((url) => {
    const m = url.match(/[&?]page=(\d+)/u)
    const page = m === null ? 1 : Number(m[1])
    return { total_count: big.length, items: big.slice((page - 1) * 20, page * 20) }
  })
  const got = []
  const perPage = []
  for (const page of [1, 2, 3, 4, 5, 6]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await call({ q: 'dsh-connection-card-host', page, all: true })
    got.push(...itemsOf(r.json.items).map((x) => x.fullName))
    perPage.push({ page, n: itemsOf(r.json.items).length, hasMore: r.json.hasMore })
  }
  check('⑧ ★ 第 6 页不再回到第 5 页（page 解夹 ≥1；旧行为把 page 夹到 1..5）',
    perPage[5].n === 5 && got[100] === 'org100/dsh-connection-card-host-100' && got[104] === 'org104/dsh-connection-card-host-104',
    perPage.map((x) => `p${x.page}:${x.n}`).join(' '))
  check('⑧ ★ 逐页合并（按 fullName 去重）不重不漏 == 105 条',
    got.length === 105 && new Set(got).size === 105, `${got.length} / ${new Set(got).size}`)
  check('⑧ hasMore 三态如实：前 5 页 true、第 6 页（刚好取满）false',
    perPage.slice(0, 5).every((x) => x.hasMore === true) && perPage[5].hasMore === false,
    perPage.map((x) => `p${x.page}:${x.hasMore}`).join(' '))
}

// ⑧-③ skills 链：并集池排序去重 + 切片（旧行为截前 20 ⇒ 加载更多翻不出新条目）
{
  const skills = Array.from({ length: 55 }, (_, i) => repo(`sk/dsh-connection-card-host-skill-${i}`, 500 - i, { topics: ['agent-skills'] }))
  const { call } = fakeRoute((url) => {
    if (!url.startsWith(GH_URL)) throw new Error(`不该请求：${url.slice(0, 60)}`)
    return { total_count: skills.length, items: skills }
  })
  const p1 = await call({ q: 'dsh-connection-card-host', page: 1, skills: true })
  const p2 = await call({ q: 'dsh-connection-card-host', page: 2, skills: true })
  const first = itemsOf(p1.json.items).map((x) => x.fullName)
  const second = itemsOf(p2.json.items).map((x) => x.fullName)
  check('⑧ ★ 技能链第 2 页真的翻出新条目（旧行为恒为 0 条空转）', second.length === 20 && second.every((n) => !first.includes(n)), `p1=${first.length} p2=${second.length}`)
  check('⑧ 技能链信封：total=并集去重后的池大小（不是三 topic total_count 相加）',
    p1.json.total === 55 && p1.json.hasMore === true && p1.json.page === 1, JSON.stringify({ total: p1.json.total, hasMore: p1.json.hasMore }))
  check('⑧ 技能链逐页切片与全序一致（不重不漏）',
    JSON.stringify([...first, ...second]) === JSON.stringify(rankSearchResults(normalizePlatformItems(skills, 'main'), 'dsh-connection-card-host').map((x) => x.fullName).slice(0, 40)),
    `p1+p2=${first.length + second.length} 条`)
}

// ⑧-④ 多源链：合并后也过同一排序函数
{
  const { call } = fakeRoute((url) => {
    if (!url.startsWith(GH_URL)) return { items: [repo('custom/dsh-connection-card-host-zz', 7), repo('custom/zz-other', 9000)] }
    return { total_count: 3, items: [repo('dsh-desktop/dsh-desktop', 99230), repo('me/dsh-connection-card-host', 1)] }
  })
  const r = await call({ q: 'dsh-connection-card-host', page: 1, multi: true })
  check('⑧ ★ 多源合并后同样以名字分层为主（★1 命中压过 ★99230 / ★9000）',
    itemsOf(r.json.items)[0]?.fullName === 'me/dsh-connection-card-host',
    itemsOf(r.json.items).map((x) => `${x.fullName}★${x.stars}`).join(' > '))
  check('⑧ 多源信封存在且幂等', r.json.hasMore === false && r.json.total === 3, JSON.stringify({ total: r.json.total, hasMore: r.json.hasMore }))
}

// ⑧-⑤ 失败路径**不静默**：取数失败绝不伪装成"0 命中"
{
  // all:true ⇒ 不触发 in:readme 重查；githubJson 直接 reject = 上游失败。
  // 既有语义是"抛出去 → 路由错误响应"，本套把它钉死（**绝不许**变成 ok:true + 空列表，
  // 那样用户看到的是"没有这个插件"而不是"这次没搜到"）。
  const network = fakeRoute(() => Promise.reject(new Error('桩：网络全断')))
  let caught = null
  let res = null
  try {
    res = await network.call({ q: 'dsh-connection-card-host', page: 1, all: true })
  } catch (error) { caught = error }
  check('⑧ ★ 上游失败**不静默**：不许回 200/ok + 空列表（那会被读成"没有这个插件"）',
    caught !== null && res === null, caught === null ? `竟然返回了 status=${res.status} body=${JSON.stringify(res.json)}` : String(caught.message))
  // 真 0 命中（数据源明确说 total_count=0）→ 信封如实说"就是没有"
  const ok0 = fakeRoute(() => ({ total_count: 0, items: [] }))
  const z = await ok0.call({ q: 'dsh-connection-card-host', page: 1, all: true })
  check('⑧ ★ 真 0 命中：total=0 / hasMore=false / truncated=false（与"取数失败"分得开）',
    z.json.total === 0 && z.json.hasMore === false && z.json.truncated === false && z.json.reason === null,
    JSON.stringify({ total: z.json.total, hasMore: z.json.hasMore, truncated: z.json.truncated, reason: z.json.reason }))
  // 逐源失败（多源：GitHub 挂了但自定义源活着）→ 如实返回活着的那些，不整体失败
  const partial = fakeRoute((url) => {
    if (url.startsWith(GH_URL)) throw new Error('桩：GitHub 挂了')
    return { items: [repo('custom/dsh-connection-card-host-zz', 3)] }
  })
  const pr = await partial.call({ q: 'dsh-connection-card-host', page: 1, multi: true })
  check('⑧ 多源里单源失败：其余源照常返回（不死整条链）',
    pr.status === 200 && itemsOf(pr.json.items).length === 1 && itemsOf(pr.json.items)[0].fullName === 'custom/dsh-connection-card-host-zz',
    JSON.stringify(itemsOf(pr.json.items).map((x) => x.fullName)))
}

// ── ⑨ 客户端接线（源码级：浏览器单文件产物无法在此实例化 React）──────────────────
{
  const strip = (s) => s.replace(/\r\n/gu, '\n')
  const client = strip(clientSrc)
  check('⑨ ★ "加载更多"的渲染判据改为数据源口径 hasMore（旧条件 length>=20 已不在该处）',
    /market\.hints[^\n]*hasMore === true/u.test(client)
    && !/market\.status === "ready" && market\.data\.length >= 20/u.test(client),
    'market.hints.hasMore === true')
  check('⑨ 计数行：共 N 条 / 已显示 M 条（无总数时只说已显示 M 条）',
    client.includes('t("marketCount")') && client.includes('t("marketCountKnown")'))
  check('⑨ 截断明说：可继续加载 / 没有更多了（两态都有文案）',
    client.includes('t("marketTruncated")') && client.includes('t("marketTruncatedEnd")'))
  check('⑨ ★ 本地索引"模糊匹配抢先 return"那条链已删除（它就是第二次搜索变高星的元凶）',
    !client.includes('fuzzyMatchIndex') && !/fuzzy: true/u.test(client))
  check('⑨ ★ 两条链不再互相覆盖：每次 search 递增序号，晚到的旧响应被丢弃',
    client.includes('const searchSeqRef = react.useRef(0);') && client.includes('if (!current()) return;'))
  check('⑨ ★ 浏览器直连链也过唯一排序函数（直连/服务端顺序一致）',
    client.includes('const items = rankSearchResults(rawItems, query);')
    && client.includes('const items = rankSearchResults(data.items ?? [], query);'))
  check('⑨ ★ enrich 补标不再"取末尾 N 条"（排序变了，末尾不一定是新页）→ 按 fullName 就地更新',
    client.includes('const patchByName = (list) =>') && !/m\.data\.slice\(0, m\.data\.length - /u.test(client))
  check('⑨ 翻页合并有去重（appendPage 的 seen 集合）', client.includes('const appendPage = (prevList, pageItems, baseHints, mergeHints, page, perPage = 20) =>'))
}

// ── ⑩ 不含本机路径（0 命中扫描的同类守卫，防止把现场路径写进测试）────────────────
{
  const self = readFileSync(join(ROOT, 'tests', 'test-market-search.mjs'), 'utf8')
  // 只在"路径上下文"里找盘符（`D:\` 这样的字面路径）：正则/注释里提及不算命中
  const bad = self.match(/[A-Za-z]:\\\\(?!\\)[\w.$-]/gu)
  check('⑩ 本测试自身 0 处本机绝对路径', bad === null, bad === null ? undefined : String(bad.slice(0, 3)))
}

// ── ⑪ 本机化纪律：本轮**新增**文件里 0 处本机绝对路径 / 用户名（与既有的同类扫描同口径）────
{
  // 只扫本轮新增的文件。已存在的文件（client.js / routes/market.js / 架构守卫 / CI 配置）不进来：
  // 它们是**追加**的（基线已在 HEAD 里，逐行由 git 管），而 CI 运行器的用户名恰好是通用词 `runner`
  // —— `job runner` / `pnpm-runners` 这种正文会被裸子串匹配误判（第一次上线就被 CI 抓到了）。
  const CHANGED = [
    'lib/server/domain/market-search.js',
    'tests/test-market-search.mjs',
  ]
  // 允许清单：**逐条写清理由**（都是通用形态，不是本机识别信息）
  const ALLOW = [
    /[A-Za-z]:\\Users\\user\b/u,   // 中性占位
    /%LOCALAPPDATA%/u,
    /node_cache/u,                 // npm 缓存目录名（历史形态，见 CHANGELOG v0.5.31）
    /_npx/u,                       // npx 缓存目录名
    /app\.asar/u,                  // Electron 打包路径片段
  ]
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const userName = home === '' ? '' : home.split(/[\\/]/u).pop()
  const PERCENT = userName === '' ? '' : encodeURIComponent(userName)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  // 用户名必须出现在**路径位置**（前面是分隔符 / 盘符 / 家目录形态）；
  // 裸子串会把通用词（`runner`）在正文里的正常出现算成命中 —— 那是假阳性。
  const asPath = (s) => new RegExp(`(?:[\\\\/]|[A-Za-z]:|\\$HOME[\\\\/]|~[\\\\/])${esc(s)}`, 'u')
  const BANNED = [
    { name: '本机用户名（路径位置，原样）', re: userName.length < 2 ? null : asPath(userName) },
    { name: '本机用户名（路径位置，百分号编码）', re: PERCENT === '' || PERCENT === userName ? null : asPath(PERCENT) },
    { name: '本机家目录明文', re: home === '' ? null : new RegExp(home.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
    { name: '本次工作副本绝对路径', re: new RegExp(ROOT.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
  ].filter((b) => b.re !== null)
  const hits = []
  for (const rel of CHANGED) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/u)
    lines.forEach((line, i) => {
      if (ALLOW.some((re) => re.test(line))) return
      for (const b of BANNED) if (b.re.test(line)) hits.push(`${rel}:${i + 1} ${b.name} → ${line.trim().slice(0, 80)}`)
    })
  }
  check(`⑪ ★ 本轮新增的 ${CHANGED.length} 个文件里本机绝对路径 / 用户名 0 出现（允许清单 ${ALLOW.length} 条）`,
    hits.length === 0, hits.slice(0, 5).join(' | ') || undefined)
  check('⑪ 扫描断言本身有效：构造的违规串必须被抓到，通用词不得误报',
    (BANNED.some((b) => b.re.test(`x ${home} y`)) || home === '')
    && (userName.length < 2 || !asPath(userName).test('job runner')),
    `userName=${userName === '' ? '(空)' : '已隐去'}；'job runner' 误报=${userName.length < 2 ? 'n/a' : asPath(userName).test('job runner')}`)
}

console.log(failed === 0 ? '\nALL PASS（市场搜索：唯一排序 + 分页/截断/失败路径）' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
