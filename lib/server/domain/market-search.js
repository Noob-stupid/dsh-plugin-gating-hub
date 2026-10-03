// L1 · domain —— market-search.js（0.5.35：市场页搜索的**唯一一份排序判据** + 分页/截断语义）
//
// 真机缺陷（2026-10-03 用户实测，市场页输入他刚发布的仓库确切名字 `dsh-connection-card-host`）：
//   ① 结果里只有三条**无关的高星**条目（dsh-desktop ★29812 / awesome-dsh-plugin ★17621 /
//      dsh-desktop ★11682，都带「聚合」角标），**他要的仓库既不在前排、往下也没有**；
//   ② 下面**没有「加载更多」**，也就无从"往下看"。
// 定位结论（离线复现，见 tests/test-market-search.mjs）：
//   · 那三条来自 `lib/client.js` 的**本地索引模糊匹配**（500 条封顶的静态索引里没有这个新仓库；
//     索引匹配只按"子串 / 编辑距离 ≤2"打分，结果里全是恰好带 `dsh`、`host` 这类 token 的无关仓库），
//     且它选出来的 12 条**按"星数"排的结果**被当作最终顺序**直接 return** —— 活搜 GitHub
//     （本来会把逐字同名的仓库排第一）根本没被执行；
//   · 「加载更多」按钮的渲染条件是 `market.data.length >= 20`：三条命中 ⇒ 按钮不渲染；
//   · 服务端 /search 还把 `page` **夹到 1..5**，翻到第 6 次开始原地返回第 5 页。
//
// ★ 用户定案（原话）：「所有的搜索链，都应该以**名字相似为主排序**，然后才往下按 star 走」★
//   即**不是**"只把精确命中置顶"，而是**名字相似度分层** —— 同一层内才比 star：
//
//     Tier 0  full_name 逐字相等（owner/repo 或裸 repo）
//     Tier 1  name 逐字相等（大小写不敏感）
//     Tier 2  name 前缀命中（以查询词开头）
//     Tier 3  name 含查询子串
//     Tier 4  name 的 token **全部**命中（可乱序）
//     Tier 5  description / topics 命中
//     Tier 6  README 命中
//     其余    不匹配（排在最后，不参与前七层）
//     同 Tier 内：stars 降序 → 再同分：最近更新优先 → 最后 full_name 字典序（确定性兜底）
//
// 本模块只做**纯函数**（无网络、无落盘、无 ctx）：查询词归一、分层判据、排序、分页/截断/合计。
// 「一处定义、处处复用」的落地方式（**双份实现必须逐字一致，由架构守卫钉死**）：
//   · 服务端：`lib/server/routes/market.js` 直接 import 本模块；
//   · 浏览器：`lib/client.js` 是**单文件打包产物**（`window.__ModuleLoader__.load`），不能用 import，
//     所以那里的排序块是**逐字移植**的同一份代码，两端都用下面的提取标记圈住：
//         // <<<market-rank:begin>>>  …  // <<<market-rank:end>>>
//     `tests/test-market-rank-canonical.mjs` 断言两份**去缩进后逐字相等**（改一边必须改另一边），
//     架构守卫里同一断言也跑一遍。这样"唯一排序函数"是可验证的事实，而不是口头约定。
//
// 铁律：① 只调整**展示顺序**与**分页口径**，绝不改变"谁被搜出来"（过滤条件一处不动）；
//       ② 分页**幂等可重复**：同一查询同一页永远同一批条目（排序里必须有确定性 tiebreaker）。

// <<<market-rank:begin>>>
/** 排序层级（越小越靠前）。Tier 0-6 与用户定案逐条对应；NOT_MATCHED 只是"没有名字/描述命中"。 */
const RANK_TIER = Object.freeze({
  FULL_NAME_EXACT: 0,
  NAME_EXACT: 1,
  NAME_PREFIX: 2,
  NAME_SUBSTRING: 3,
  NAME_TOKENS: 4,
  DESCRIPTION_OR_TOPICS: 5,
  README: 6,
  NOT_MATCHED: 7,
})

/** 归一化：小写 + 去掉尾部 `.git` / 首尾空白。所有判据都用它，避免大小写与 `.git` 差异漏判。 */
function normalizeSearchName(value) {
  return String(value ?? '').trim().replace(/\.git$/iu, '').toLowerCase()
}

/** 查询词按分隔符切出的 token（≥2 字符，去重保序）——用于 Tier 4「token 全命中」判据。 */
function queryTokens(query) {
  const q = normalizeSearchName(query)
  if (q === '') return []
  const out = []
  for (const tk of q.split(/[\s\-_/.]+/u)) {
    if (tk.length >= 2 && !out.includes(tk)) out.push(tk)
  }
  return out
}

/** 条目的两个名字形态（都归一化）：`full` = owner/repo，`short` = 裸名（缺 name 时从 full 取尾段）。 */
function itemNameForms(item) {
  const full = normalizeSearchName(item?.fullName ?? item?.full_name)
  const short = normalizeSearchName(item?.name) || (full === '' ? '' : (full.split('/').pop() ?? ''))
  return { full, short }
}

/** 名字里按分隔符切出的 token（小写）。`dsh-connection-card-host` → [dsh, connection, card, host]。 */
function nameTokens(name) {
  return String(name ?? '').toLowerCase().split(/[\s\-_/.]+/u).filter(Boolean)
}

/** description / topics 是不是命中查询词（整词子串，大小写不敏感）。 */
function textHitsQuery(query, item) {
  const q = normalizeSearchName(query)
  if (q === '') return false
  const desc = normalizeSearchName(item?.description)
  if (desc !== '' && desc.includes(q)) return true
  const topics = Array.isArray(item?.topics) ? item.topics : []
  return topics.some((topic) => normalizeSearchName(topic).includes(q))
}

/** README 命中：优先看条目**自带**的 readme 文本；没有就认标记位（服务端 in:readme 重查补进来的条目）。
 *  标记位是"这条是从 README 检索面捞到的"的既成事实，不编造内容。 */
function readmeHitsQuery(query, item) {
  const q = normalizeSearchName(query)
  if (q === '') return false
  const readme = normalizeSearchName(item?.readme)
  if (readme !== '' && readme.includes(q)) return true
  return item?.viaReadme === true
}

/** 名字相似度分层（唯一判据；越小越靠前）。owner/repo 查询只按 full_name 判 Tier 0，
 *  避免"同名不同 owner"被当成逐字命中（与用户"输入确切名字要排第一"的预期一致）。 */
function rankTier(query, item) {
  const q = normalizeSearchName(query)
  if (q === '') return RANK_TIER.NOT_MATCHED
  const { full, short } = itemNameForms(item)
  const tokens = queryTokens(query)
  const hasOwner = q.includes('/')
  const target = short !== '' ? short : full
  if (full !== '' && full === q) return RANK_TIER.FULL_NAME_EXACT
  if (!hasOwner && short !== '' && short === q) return RANK_TIER.NAME_EXACT
  if (target !== '' && target.startsWith(q)) return RANK_TIER.NAME_PREFIX
  if (target !== '' && target.includes(q)) return RANK_TIER.NAME_SUBSTRING
  if (tokens.length > 0) {
    const owned = nameTokens(full !== '' ? full : short)
    if (tokens.every((tk) => owned.includes(tk))) return RANK_TIER.NAME_TOKENS
  }
  if (textHitsQuery(query, item)) return RANK_TIER.DESCRIPTION_OR_TOPICS
  if (readmeHitsQuery(query, item)) return RANK_TIER.README
  return RANK_TIER.NOT_MATCHED
}

/** 星数（缺省 0；非数字按 0 处理——索引/GitHub 都是外部数据，不能拿它当数字用）。 */
function starsOf(item) {
  const n = item?.stars ?? item?.stargazers_count
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/** 更新时间戳（毫秒）。缺省/非法一律 0（"没给时间"排最后；绝不编造"刚更新"）。 */
function updatedAtOf(item) {
  const raw = item?.updatedAt ?? item?.updated_at
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 确定性兜底 tiebreaker：同层同星同时间时按 full_name 字典序（分页不抖动）。 */
function nameOf(item) {
  return normalizeSearchName(item?.fullName ?? item?.full_name ?? item?.name)
}

/** 统一比较器：Tier 0-6 升序 → stars 降序 → updatedAt 降序 → full_name 升序。
 *  「名字相似为主、同层才比 star」的全部语义都在这一个函数里；所有搜索链只许调它。 */
function compareByRank(query) {
  return (a, b) => {
    const ta = rankTier(query, a)
    const tb = rankTier(query, b)
    if (ta !== tb) return ta - tb
    const sa = starsOf(a)
    const sb = starsOf(b)
    if (sa !== sb) return sb - sa
    const ua = updatedAtOf(a)
    const ub = updatedAtOf(b)
    if (ua !== ub) return ub - ua
    const na = nameOf(a)
    const nb = nameOf(b)
    return na < nb ? -1 : (na > nb ? 1 : 0)
  }
}

/** **唯一入口**：按用户定案排序（返回**新数组**；条目对象一个字段都不动 —— 只改顺序不改内容）。
 *  分页幂等的根本保证：同一数组同一 query 的排序结果逐位相同（比较器无随机、无时间依赖）。 */
function rankSearchResults(items, query) {
  const list = Array.isArray(items) ? items.slice() : []
  if (list.length < 2) return list
  return list.sort(compareByRank(query))
}

/** 分层结果（UI 角标/说明与测试用）：[{ tier, items }] 只含**真的命中**（Tier 0-6）的层，层序固定。 */
function rankTiers(items, query) {
  const buckets = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const tier = rankTier(query, item)
    if (tier > RANK_TIER.README) continue
    if (!buckets.has(tier)) buckets.set(tier, [])
    buckets.get(tier).push(item)
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((tier) => ({ tier, items: buckets.get(tier) }))
}

/**
 * 分页 + 截断口径（纯函数；GitHub search 的 `total_count` 与 `per_page` 都进这里）：
 *   · shown   本次实际显示的条目数
 *   · total   数据源报的**总命中数**（未知传 null → UI 只说"已显示 M 条"，绝不编造总数）
 *   · hasMore 还能不能往下翻（`page*perPage < total` **且没有翻过数据源硬上限**；总数为 null 时退化为"本页满页"）
 *   · truncated 结果被截断了（总数 > 本次已取到的范围）——UI 必须**明说**，不许让用户以为"就是没有"
 *   · reason  截断的**可读原因**（GitHub API 最多 1000 条 / 索引封顶 / 无 total 但满页）
 * 幂等：同一 (page, perPage, total) 永远同一结论。
 *
 * ★ 0.5.35 实测（真机 GitHub，2026-10-03）：`per_page=20&page=51`（第 1001 条起）不是"返回空"而是
 *   **HTTP 422 `Only the first 1000 search results are available`** —— 也就是说越过上限再翻页必然报错。
 *   所以 hasMore 在 `page*perPage >= min(total, cap)` 时必须为 false：按钮不给，用户就不会点出一个错误。
 *   它也在标记块**之内**：浏览器那一半用同一份口径算「加载更多」与「共 N 条」。
 */
function buildPageEnvelope({ shown = 0, total = null, page = 1, perPage = 20, cap = 1000, capReason = null } = {}) {
  const n = Number.isFinite(shown) && shown > 0 ? shown : 0
  const p = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
  const size = Number.isFinite(perPage) && perPage > 0 ? Math.floor(perPage) : 20
  const known = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? Math.floor(total) : null
  const capValue = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : Infinity
  const fetched = p * size
  // 数据源硬上限之内还能取到条数（GitHub search 只有前 1000 条；越过就是 422，不是空页）
  const reachable = known === null ? Infinity : Math.min(known, capValue)
  // hasMore 只由**总数与上限**决定（`shown > 0`）：本页返回 0 条就是到底了，不许再让用户点空按钮，
  // 也不许让用户点到必然 422 的那一页。
  const hasMore = known === null ? n >= size : (n > 0 && fetched < reachable)
  // 截断分两种，都必须让用户看见（而不是以为"就是没有"）：
  //   ① 数据源硬上限（GitHub search 只给前 1000 条）→ 这是**始终**成立的事实，与翻到第几页无关；
  //   ② 本次只取到前 fetched 条（还有更多没取）→ 翻页可解。
  const overCap = known !== null && known > cap
  const truncated = overCap || (known === null ? n >= size : known > fetched)
  let reason = null
  if (overCap) reason = capReason !== null ? capReason : `数据源最多只返回前 ${cap} 条（命中 ${known} 条）`
  else if (known === null && n >= size) reason = '数据源未返回总数（只能按每页满页判断还有更多）'
  else if (known !== null && known > fetched) reason = `共 ${known} 条，本次只取到前 ${Math.min(fetched, known)} 条`
  // 已经翻到/翻过硬上限：再说"可继续加载"就是骗人（GitHub 第 1001 条起是 422）
  if (overCap && fetched >= cap) {
    reason = capReason !== null ? capReason : `数据源最多只返回前 ${cap} 条（命中 ${known} 条）：已翻到第 ${fetched} 条，无法再往下`
  }
  return { shown: n, total: known, page: p, perPage: size, hasMore, truncated, reason }
}
// <<<market-rank:end>>>

export {
  RANK_TIER,
  normalizeSearchName,
  queryTokens,
  itemNameForms,
  nameTokens,
  textHitsQuery,
  readmeHitsQuery,
  rankTier,
  starsOf,
  updatedAtOf,
  compareByRank,
  rankSearchResults,
  rankTiers,
  buildPageEnvelope,
}
