// L1 · domain —— release-source.js（GitHub Release 源解析，issue #3）
//
// 背景（用户 issue，附逐条实测）：安装 yjh051108/dsh-routing-suite（根包 @dsh-external/dsh-super-injector，
// private: true）时 npm registry 404 → 直接掉进 AI 兜底（约 4 分钟）。真正能装上的产物在**另一个仓库**
// yjh051108/dsh-super-injector 的 release 里（asset 形如 dsh-external-dsh-super-injector-0.3.5.tgz）。
// 旧 githubReleaseInstall() 只用 job.repo 找仓库、只看 releases/latest、且对同一 release 下多个 asset
// 不按包名匹配 —— 于是"产物在别的仓库"这一整类包永远装不上。
//
// 本模块把这条链路的**选源与挑选**独立出来（纯逻辑 + 只读网络探测；下载/落盘仍由 install.js 做）：
//   ① 候选仓库集合按优先级：显式 repo → 已装包 package.json.repository → npm registry 元数据 → GitHub 搜索包名
//   ② 遍历候选仓库的最近 ≤10 条 release，把每条 release 的 assets **全部**列出，按包名匹配挑选
//   ③ 选不中时给出"尝试过的仓库 + asset 清单"的清单式错误（排查用），
//      并且**任何单个来源探测失败都只是"这个来源没有"**，绝不让探测异常冒泡成未捕获异常。
//
// 为什么不抛：这条通道是安装兜底链的最后一环，探测失败（限流/未登录/仓库不存在/没有 release）是常态，
// 该做的是换下一个候选来源并如实汇报，而不是把整条作业打断。

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { GITHUB_API, fetchJsonUrl, githubJson } from '../infra/http.js'
import { GH_BIN_CANDIDATES, execFileAsync } from '../infra/exec.js'
import { copyTree } from '../infra/fsx.js'
import { baseDirOf, entryPkgMeta, pluginRoot } from '../infra/paths.js'
import { githubRepoInfo, parseRepoFromUrl } from './market.js'
import { orderedRegistries, readSources } from './sources.js'
import { compareSemverText, parseSemverText } from '../infra/semver.js'

/** 每个候选仓库最多看多少条 release：翻页对收益极小（产物一般在最近几条），却可能把作业拖到超时。 */
const RELEASE_LIST_LIMIT = 10
/** 候选仓库上限：每个仓库至少 1 次 releases 接口调用，候选太多会把时间预算吃光。 */
const MAX_RELEASE_CANDIDATE_REPOS = 5
/** 真正去扫 release 的候选仓库上限（issue #3 的硬预算之一）：候选列表可以长，但只对排在前面的少数几个
 *  花"列 release"的钱——后面的候选要么是搜索出来的同名无关仓库，要么命中率极低。 */
const RELEASE_SCAN_MAX_REPOS = 3
/** **整条反查链路的总时间预算**（issue #3 明确要求）：反查候选仓库 + 逐仓库列 release + 挑 asset 全算在内。
 *  到点即放弃、把控制权交回安装主链的下一条通道——这条通道是兜底链的最后一环，
 *  任何情况下都不允许它把一次安装在"没有产物的候选"上拖住（现场：私有聚合根展开出 3 个候选，
 *  每个候选都要重打一遍 registry + 搜索接口才算"没有"）。 */
const RELEASE_CHANNEL_BUDGET_MS = 20000
/** GitHub 搜索命中的、仓库名与包名逐字对上的候选最多取几个（同名仓库可能有多个，按星数排）。 */
const RELEASE_SEARCH_REPOS = 2
/** 搜索接口单页条数。 */
const RELEASE_SEARCH_LIMIT = 5
/** 元数据探测超时（registry packument）：404 是确定性结论，超时即换下一个来源。 */
const RELEASE_META_TIMEOUT_MS = 12000
/** release 产物体积上限：asset 可以是任何东西（安装包/镜像/视频），DSH 插件本体都在几 MB 内；
 *  超限即失败换下一个候选，避免把大文件拉进临时目录（下载本身仍受 curl -m 60 的时间上限约束）。 */
const MAX_RELEASE_ASSET_BYTES = 128 * 1024 * 1024
/** release 产物下载的镜像前缀（与 raw/api 用的是同一批加速器）。
 *  ★ 为什么必须有（2026-09-22 实测）：本机 curl 直连 `https://github.com/<owner>/<repo>/releases/download/…`
 *  返回 exit 35（SSL connect error；node https 也报 unable to verify the first certificate），
 *  而**同一个 URL 经 ghproxy.net 是 200 / 358KB** —— 只试直连会让"反查命中 + asset 挑对"之后
 *  仍然装不上（issue #3 的现场正是这样被拖进 AI 兜底 4 分钟）。顺序 = 信任顺序：直连优先，镜像兜底。 */
const RELEASE_DOWNLOAD_MIRROR_PREFIXES = [
  'https://ghproxy.net/',
  'https://ghfast.top/',
]
/** 包名→仓库的反查结果缓存（10 分钟）：同一个作业里多个候选包、同一包多次重试都不必重打搜索接口
 *  （GitHub 搜索接口限额 30 次/分，是最容易被自己打满的一条）。 */
const releaseRepoCache = new Map()
const RELEASE_REPO_CACHE_TTL = 10 * 60 * 1000

/** 清空反查缓存（单测用：避免用例间互相污染）。 */
function clearReleaseSourceCache() {
  releaseRepoCache.clear()
}

/** 这条链路的总预算文案（失败时如实告诉用户"为什么后面没试"）。 */
function releaseBudgetText() {
  return `release 反查总预算 ${Math.round(RELEASE_CHANNEL_BUDGET_MS / 1000)} 秒`
}

/** 距 deadline 还剩多少毫秒；deadline 非有限值（Infinity）= 不限制。 */
function remainingMs(deadline) {
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : Number.POSITIVE_INFINITY
}

/** 把"剩余预算"变成可中断的 AbortSignal（githubJson 支持 signal，超时会真的中断 https 请求与镜像竞速）。
 *  拿不到就返回 undefined —— 此时仍由调用方的时间判断 + githubJson 自带超时兜底。 */
function budgetSignal(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
  return AbortSignal.timeout(Math.max(1, Math.ceil(ms)))
}

/** asset 文件名归一：大小写不敏感 + 下划线/短横线互换（issue #3 明确要求容忍这两种变体）。 */
function normalizeAssetName(name) {
  return String(name ?? '').toLowerCase().replace(/_/gu, '-')
}

/** 包名 → 可接受的 asset 文件名主干（去版本号后应与其中之一相等）。
 * `@scope/pkg` → `scope-pkg`（精确形式）与 `pkg`（裸名形式）；非 scoped 包只有一种形式。
 * 顺序即优先级：**精确形式优先**（少一次"同名不同 scope"的误判机会）。 */
function releaseAssetStems(packageName) {
  const raw = normalizeAssetName(String(packageName ?? '').trim())
  if (raw === '') return []
  const m = raw.match(/^@([^/]+)\/(.+)$/u)
  if (m) return [`${m[1]}-${m[2]}`, m[2]]
  return [raw]
}

/** asset 名 → 包名匹配信息（纯函数，单测覆盖）。返回 null = 不是这个包的产物。
 * 容忍：`scope-pkg-<version>.tgz`、`scope-pkg.tgz`、`pkg-<version>.tgz`、`pkg.tgz`（大小写/下划线变体）。
 * 只认 tarball（.tgz / .tar.gz）：zip/exe/源码包没有安装路径，当它们不存在比"装了再说"安全。 */
function assetMatchInfo(assetName, packageName) {
  const file = normalizeAssetName(assetName)
  const base = file.replace(/\.tar\.gz$/u, '').replace(/\.tgz$/u, '')
  if (base === file || base === '') return null
  const stems = releaseAssetStems(packageName)
  for (let i = 0; i < stems.length; i += 1) {
    const stem = stems[i]
    if (base === stem) return { file, exact: i === 0, version: null }
    if (!base.startsWith(`${stem}-`)) continue
    // 版本号必须紧跟主干：`scope-pkg-other-1.0.0` 这种"别的包名以本包名开头"不能算命中
    const rest = base.slice(stem.length + 1)
    if (!/^v?\d/u.test(rest)) continue
    return { file, exact: i === 0, version: parseSemverText(rest) === null ? null : rest.replace(/^v/u, '') }
  }
  return null
}

/** 候选产物的排序（纯函数，单测覆盖）：① 包名精确匹配优先 ② 版本更高优先（带版本 > 不带版本）
 * ③ release 更新优先 ④ 文件名兜底（保证结果确定，不受输入顺序影响）。 */
function compareAssetMatch(a, b) {
  if (a.exact !== b.exact) return a.exact ? -1 : 1
  const av = a.version === null ? null : parseSemverText(a.version)
  const bv = b.version === null ? null : parseSemverText(b.version)
  if (av !== null && bv !== null) {
    const d = compareSemverText(bv, av)
    if (d !== 0) return d
  } else if (av !== null || bv !== null) {
    return av !== null ? -1 : 1
  }
  const byTime = (b.publishedAt ?? 0) - (a.publishedAt ?? 0)
  if (byTime !== 0) return byTime
  return String(a.file).localeCompare(String(b.file))
}

/** 一条 release 的 assets → 与包名匹配的候选（已排序）。 */
function rankReleaseAssets(assets, packageName, publishedAt = 0) {
  const out = []
  for (const asset of (Array.isArray(assets) ? assets : [])) {
    const name = typeof asset?.name === 'string' ? asset.name : ''
    const info = assetMatchInfo(name, packageName)
    if (info === null) continue
    out.push({ asset, ...info, publishedAt })
  }
  return out.sort(compareAssetMatch)
}

/** 遍历的分组（每个候选仓库 + 它的 release 列表）→ 选定结果（纯函数，单测覆盖）。
 *   命中：{ ok:true, repo, release, asset, file, version, tried }
 *   未命中：{ ok:false, tried, message }  ← message 是清单式排查文案，**不是抛出的异常**
 * 语义：候选仓库按优先级**依次**尝试，第一个找到匹配 asset 的仓库胜出（不再跨仓库比版本——
 * 否则"最可疑的仓库"会被"更晚反查到的仓库"顶掉，来源就不可预期了）。 */
function planReleaseInstall(packageName, groups) {
  const tried = []
  for (const group of (Array.isArray(groups) ? groups : [])) {
    const repo = group?.repo ?? null
    if (group?.error) {
      tried.push({ repo, error: String(group.error), releases: [] })
      continue
    }
    const matches = []
    const rows = []
    for (const release of (Array.isArray(group?.releases) ? group.releases : [])) {
      const at = Date.parse(release?.published_at ?? release?.created_at ?? '') || 0
      const ranked = rankReleaseAssets(release?.assets, packageName, at)
      rows.push({
        tag: typeof release?.tag_name === 'string' ? release.tag_name : null,
        assets: (Array.isArray(release?.assets) ? release.assets : []).map((a) => (typeof a?.name === 'string' ? a.name : '')),
        matched: ranked.map((r) => r.file),
      })
      for (const r of ranked) matches.push({ ...r, release })
    }
    if (matches.length > 0) {
      matches.sort(compareAssetMatch)
      const best = matches[0]
      const tag = typeof best.release?.tag_name === 'string' ? best.release.tag_name.replace(/^v/iu, '') : null
      return { ok: true, repo, release: best.release, asset: best.asset, file: best.file, version: best.version ?? tag, tried }
    }
    tried.push({ repo, releases: rows })
  }
  return { ok: false, tried, message: releaseChannelFailureText(packageName, tried) }
}

/** 失败时的清单式文案（纯函数，单测覆盖）：把"尝试过哪些仓库、每个仓库有哪些 release/asset"**如实**摊开——
 * 排查这类问题全靠这份清单（旧文案只有一句"仓库没有 latest release"，用户根本不知道还试过谁）。 */
function releaseChannelFailureText(packageName, tried) {
  const name = String(packageName ?? '（未知名）')
  const head = `GitHub release 通道：没能找到与包名 ${name} 匹配的发布产物`
  if (!Array.isArray(tried) || tried.length === 0) {
    return `${head}（也没能反查到候选仓库：显式仓库为空、本机没有已安装的该包、npm registry 元数据与 GitHub 搜索都没能给出仓库）。`
  }
  const lines = tried.map((t) => {
    const repo = t?.repo ?? '（未知仓库）'
    if (t?.error) return `· ${repo}：读取 releases 失败（${t.error}）`
    const releases = Array.isArray(t?.releases) ? t.releases : []
    if (releases.length === 0) return `· ${repo}：没有任何 release`
    const rows = releases.map((r) => `${r.tag ?? '（无 tag）'} → ${r.assets.length > 0 ? r.assets.join('、') : '（无 asset）'}`)
    return `· ${repo}：${rows.join('；')}`
  })
  return `${head}。已尝试的仓库与资产清单：\n${lines.join('\n')}`
}

/** 仓库标识归一（`owner/name`、完整 URL、`git+https://…`）：非法输入返回 null 而不是抛。
 * 复用 market.js 的 githubRepoInfo（仓库名格式的唯一权威），它抛错就说明用户给的不是仓库。 */
function normalizeRepoSpec(value) {
  const raw = String(value ?? '').trim().replace(/^git\+/u, '')
  if (raw === '') return null
  try {
    return githubRepoInfo(raw)
  } catch {
    return null
  }
}

/** npm 包名 → packument URL 段（与 curlManualInstall 同一口径：scope 的 `/` 编成 %2f）。 */
function encodeNpmName(packageName) {
  const name = String(packageName)
  return name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1).split('/')[0])}%2f${encodeURIComponent(name.split('/').slice(1).join('/'))}`
    : encodeURIComponent(name)
}

/** npm registry 元数据反查仓库：多源依次尝试（镜像/官方），命中 repository 即返回。
 * 注：包根本没发布到 registry（issue 里的 @dsh-external/* 正是如此，npmjs/npmmirror 双 404）时这里就是空手，
 * 必须靠后面的 GitHub 搜索兜底——所以这一段的失败绝不能当成"没有可用产物"。
 * 预算：每个 registry 的单次超时是 min(RELEASE_META_TIMEOUT_MS, 剩余预算)，预算耗尽即整体放弃。 */
async function repoFromNpmMetadata(packageName, registries, fetchJson, deadline = Number.POSITIVE_INFINITY) {
  for (const reg of (registries ?? []).slice(0, 3)) {
    const left = remainingMs(deadline)
    if (left <= 0) break
    try {
      const meta = await fetchJson(`${reg}/${encodeNpmName(packageName)}`, Math.max(1000, Math.min(RELEASE_META_TIMEOUT_MS, left)))
      const repo = parseRepoFromUrl(meta?.repository?.url ?? meta?.repository ?? '')
      if (repo !== null) return { repo, from: `npm 元数据（${reg}）` }
    } catch {}
  }
  return null
}

/** 从包名推导仓库：GitHub 仓库搜索，按"仓库名与包名逐字对上 → 星数"挑。
 * 实测（2026-09-22，issue #3 验收）：`@scope/name` 的 `scope name` 查询**常常 0 条**——scope 不在仓库检索面里
 * （dsh-external dsh-super-injector → 0 条，而 dsh-super-injector → 5 条且首位就是正确仓库）。
 * 所以先按 scope+name 试一次，没有再退回裸包名；未登录/限流/网络失败一律跳过，不抛。
 * 预算：每次搜索都带剩余预算的 AbortSignal，到点即停（搜索接口限额 30 次/分，也不该多打）。 */
async function reposFromGithubSearch(packageName, token, ghJson, deadline = Number.POSITIVE_INFINITY) {
  const raw = normalizeAssetName(String(packageName ?? '').trim())
  if (raw === '') return []
  const m = raw.match(/^@([^/]+)\/(.+)$/u)
  const base = m ? m[2] : raw
  const queries = m ? [`${m[1]} ${base}`, base] : [base]
  for (const q of queries) {
    const left = remainingMs(deadline)
    if (left <= 0) break
    let items = []
    try {
      const data = await ghJson(`${GITHUB_API}/search/repositories?q=${encodeURIComponent(q)}&per_page=${RELEASE_SEARCH_LIMIT}`, budgetSignal(left), token)
      items = Array.isArray(data?.items) ? data.items : []
    } catch {
      continue
    }
    const hitName = (it) => normalizeAssetName(String(it?.name ?? ''))
    const named = items.filter((it) => hitName(it) === base)
    const picked = (named.length > 0 ? named : items.filter((it) => hitName(it).includes(base)))
      .slice()
      .sort((a, b) => (b?.stargazers_count ?? 0) - (a?.stargazers_count ?? 0))
      .slice(0, named.length > 0 ? RELEASE_SEARCH_REPOS : 1)
    const out = picked
      .map((it) => ({ repo: normalizeRepoSpec(it?.full_name), from: `GitHub 搜索「${q}」` }))
      .filter((c) => c.repo !== null)
    if (out.length > 0) return out
  }
  return []
}

/** 网络侧的两条反查（带 10 分钟缓存）。deadline 是整条 release 链路的总预算终点。 */
async function networkCandidateRepos(packageName, { registries, token, fetchers, deadline = Number.POSITIVE_INFINITY }) {
  const key = String(packageName ?? '')
  const hit = releaseRepoCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < RELEASE_REPO_CACHE_TTL) return hit.repos
  const repos = []
  const npm = await repoFromNpmMetadata(packageName, registries, fetchers.fetchJson, deadline)
  if (npm !== null) repos.push(npm)
  if (repos.length < MAX_RELEASE_CANDIDATE_REPOS && remainingMs(deadline) > 0) {
    repos.push(...await reposFromGithubSearch(packageName, token, fetchers.githubJson, deadline))
  }
  releaseRepoCache.set(key, { at: Date.now(), repos })
  return repos
}

/** 候选仓库集合（按优先级，去重，上限 MAX_RELEASE_CANDIDATE_REPOS）：
 * ① 显式给的 repo（现有行为，优先级最高——调用方说哪个仓库就是哪个）
 * ② name 已安装/可解析时读其 package.json 的 repository（复用 entryPkgMeta，本地零网络成本）
 * ③ npm registry 元数据的 repository
 * ④ 从包名推导：GitHub 搜索 scope/name（失败即跳过）
 * 每条都带 from（来源），最终写进用户可见的"来源"说明里。 */
async function resolveReleaseCandidateRepos(options = {}) {
  const {
    repo = null, packageName = null, baseUrl = null, profileDir = null,
    registries = null, token = null, fetchers = {},
    deadline = Date.now() + RELEASE_CHANNEL_BUDGET_MS,
  } = options
  const fetch = { fetchJson: fetchers.fetchJson ?? fetchJsonUrl, githubJson: fetchers.githubJson ?? githubJson }
  const out = []
  const push = (candidate) => {
    if (candidate?.repo == null) return
    if (out.some((c) => c.repo.toLowerCase() === candidate.repo.toLowerCase())) return
    if (out.length >= MAX_RELEASE_CANDIDATE_REPOS) return
    out.push(candidate)
  }
  push({ repo: normalizeRepoSpec(repo), from: '调用方显式指定' })
  if (typeof packageName === 'string' && packageName !== '') {
    try {
      const meta = entryPkgMeta(packageName, baseUrl ?? 'file:///', profileDir ?? null)
      push({ repo: parseRepoFromUrl(meta?.repository ?? ''), from: '本机已装包的 package.json.repository' })
    } catch {}
    for (const c of await networkCandidateRepos(packageName, {
      registries: Array.isArray(registries) && registries.length > 0 ? registries : orderedRegistries(readSources()),
      token,
      fetchers: fetch,
      deadline,
    })) push(c)
  }
  return out
}

/** 取一个仓库的最近若干条 release（**一次**接口调用拿到 release 及其 assets，不翻页）。
 * 失败不抛：返回 { releases: [], error }，由清单式文案如实汇报"这个仓库没读成"。
 * budgetMs 是这条链路剩余的预算：≤0 时直接返回"超出预算"（不发起请求），正数则作为本次调用的硬上限。 */
async function fetchReleaseList(repo, token = null, ghJson = githubJson, limit = RELEASE_LIST_LIMIT, budgetMs = RELEASE_CHANNEL_BUDGET_MS) {
  const left = Number.isFinite(budgetMs) ? Math.min(budgetMs, RELEASE_CHANNEL_BUDGET_MS) : RELEASE_CHANNEL_BUDGET_MS
  if (!(left > 0)) return { releases: [], error: `${releaseBudgetText()}已用尽，未再请求该仓库` }
  try {
    const data = await ghJson(`${GITHUB_API}/repos/${repo}/releases?per_page=${limit}`, budgetSignal(left), token)
    const releases = (Array.isArray(data) ? data : []).filter((r) => r !== null && typeof r === 'object')
    // 新→旧：接口默认按创建时间倒序，这里显式排序，保证"逐条尝试"的顺序与"版本更高优先"的输入确定
    releases.sort((a, b) => (Date.parse(b.published_at ?? b.created_at ?? '') || 0) - (Date.parse(a.published_at ?? a.created_at ?? '') || 0))
    return { releases, error: null }
  } catch (error) {
    return { releases: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** 选源主入口：反查候选仓库 → 逐仓库取 release 列表 → 第一个匹配上的仓库胜出。
 * 返回 planReleaseInstall 的结果，外加：
 *   · repos/froms：反查到的候选仓库（如实写进用户可见来源/排查文案）
 *   · sourceFallback：全部候选都没有匹配 asset 时，仍可用的"最新 tag 源码 tarball"（老行为兜底）
 *   · expired：本次是否因为总预算用尽而提前收工（失败文案要把这件事说清楚）
 * 任何探测失败都不抛——未命中时由调用方决定是抛清单式错误还是走兜底。
 * ★ 硬预算（issue #3）：整个过程被 RELEASE_CHANNEL_BUDGET_MS 封顶，且只对前 RELEASE_SCAN_MAX_REPOS 个
 *   候选仓库"列 release"；到点即返回未命中，绝不阻塞安装主链。 */
async function selectReleaseInstall(options = {}) {
  const {
    repo = null, packageName = null, baseUrl = null, profileDir = null,
    registries = null, token = null, fetchers = {},
    budgetMs = RELEASE_CHANNEL_BUDGET_MS,
  } = options
  const deadline = Date.now() + (Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : RELEASE_CHANNEL_BUDGET_MS)
  const ghJson = fetchers.githubJson ?? githubJson
  const candidates = await resolveReleaseCandidateRepos({ repo, packageName, baseUrl, profileDir, registries, token, fetchers, deadline })
  const groups = []
  let expired = false
  for (const candidate of candidates.slice(0, RELEASE_SCAN_MAX_REPOS)) {
    const left = remainingMs(deadline)
    if (left <= 0) {
      expired = true
      groups.push({ repo: candidate.repo, from: candidate.from, releases: [], error: `${releaseBudgetText()}已用尽，未再扫描该仓库` })
      continue
    }
    // 逐仓库串行：拿到第一个有匹配 asset 的仓库就停（后面的候选连 releases 都不必读）
    const fetched = await fetchReleaseList(candidate.repo, token, ghJson, RELEASE_LIST_LIMIT, left)
    if (fetched.error !== null && remainingMs(deadline) <= 0) expired = true
    groups.push({ repo: candidate.repo, from: candidate.from, error: fetched.error, releases: fetched.releases })
    const plan = planReleaseInstall(packageName, groups)
    if (plan.ok) return { ...plan, repos: candidates.map((c) => ({ ...c })), groups, expired }
  }
  if (candidates.length > RELEASE_SCAN_MAX_REPOS) {
    groups.push({
      repo: `（另有 ${candidates.length - RELEASE_SCAN_MAX_REPOS} 个候选仓库）`, from: '预算裁剪',
      releases: [], error: `候选仓库扫描上限为 ${RELEASE_SCAN_MAX_REPOS} 个（预算裁剪），未再扫描`,
    })
  }
  const plan = planReleaseInstall(packageName, groups)
  if (expired) plan.message = `${plan.message}\n（注：${releaseBudgetText()}已用尽，剩余候选仓库与资产未再扫描——这是时间预算，不代表它们没有产物）`
  return { ...plan, repos: candidates.map((c) => ({ ...c })), groups, sourceFallback: sourceTarballFallback(groups), expired }
}

/** 老行为兜底（**保留**，不是新增能力）：候选仓库的 release 里一个匹配 asset 都没有时，仍按
 * "第一条 release 的 tag + codeload 源码 tarball"装——很多插件仓库就是只打 tag 不发 asset 的，
 * 删掉这条路会让它们从"能装"变成"装不上"。盒子验证照旧把关包名，装错包名一律被拒绝。 */
function sourceTarballFallback(groups) {
  for (const group of (Array.isArray(groups) ? groups : [])) {
    const first = (Array.isArray(group?.releases) ? group.releases : [])[0]
    const tag = typeof first?.tag_name === 'string' ? first.tag_name : null
    if (tag !== null) return { repo: group.repo, tag }
  }
  return null
}

/** release 产物的下载候选地址（纯函数，单测覆盖）：直连优先 + 镜像兜底。
 *  空 url 返回空数组（调用方按"没有下载地址"报错，不去打无意义的请求）。 */
function releaseDownloadUrls(url) {
  const raw = String(url ?? '').trim()
  if (raw === '') return []
  return [raw, ...RELEASE_DOWNLOAD_MIRROR_PREFIXES.map((prefix) => `${prefix}${raw}`)]
}

/** curl 下载 release 产物到 dest（带体积上下限与超时）：asset 是仓库里的任意文件，
 * 太小=没下成（黑洞期常见 0 字节/错误页），太大=不该拉进临时目录。runner 可注入（单测）。
 * 下载地址按 releaseDownloadUrls 顺序依次尝试，**总时长被 timeoutMs 封顶**（每次尝试只拿到剩余预算，
 * 所以镜像再多也不会把兜底通道拖长）；第一个下成并通过体积校验的即胜出。 */
async function downloadReleaseArtifact(url, dest, options = {}) {
  const { bin = null, maxBytes = MAX_RELEASE_ASSET_BYTES, timeoutMs = 70000, runner = execFileAsync, mirrors = true } = options
  const curlBin = bin ?? (process.platform === 'win32' ? 'curl.exe' : 'curl')
  const urls = mirrors ? releaseDownloadUrls(url) : [String(url ?? '')].filter((u) => u !== '')
  if (urls.length === 0) throw new Error('GitHub 通道：没有下载地址')
  const deadline = Date.now() + timeoutMs
  let lastError = null
  for (let i = 0; i < urls.length; i += 1) {
    const left = deadline - Date.now()
    if (left < 5000) { lastError = lastError ?? new Error(`下载总预算 ${Math.round(timeoutMs / 1000)} 秒已用尽`); break }
    const attempt = urls[i]
    try {
      await runner(curlBin, ['-s', '-L', '-m', String(Math.max(5, Math.min(60, Math.floor(left / 1000)))), '-o', dest, attempt], { timeout: Math.min(timeoutMs, left) + 3000, windowsHide: true })
      if (!existsSync(dest)) throw new Error(`下载没有落盘（${attempt}）`)
      const size = statSync(dest).size
      if (size < 100) throw new Error(`下载内容过小（${size} 字节，${attempt}）`)
      if (size > maxBytes) throw new Error(`产物超过体积上限（${(size / 1048576).toFixed(1)}MB > ${Math.round(maxBytes / 1048576)}MB，${attempt}）`)
      return size
    } catch (error) {
      lastError = error
      try { rmSync(dest, { force: true }) } catch {}
    }
  }
  const tried = urls.map((u) => (u === urls[0] ? `${u}（直连）` : u)).join('、')
  throw new Error(`GitHub 通道：下载失败（已尝试 ${urls.length} 条地址：${tried}）：${lastError?.message ?? '未知'}`)
}

/** 安装目标根（宿主插件特判）：本面板部署在宿主根层 node_modules，更新时覆盖根层而非 web profile
 * node_modules（包根本身由 paths.js 的 pluginRoot() 解析——全仓库只有那一处算包根）。
 * 返回 `<root>/<packageName>`。
 * ★ 特判的判据必须包含"自身确实住在某个 node_modules 里"（dirname 的 basename 为 node_modules）：
 * 旧判据只有 `existsSync(<pkg>/package.json)`，而任何**开发检出**（D:\dsh\dsh-plugin-hub-refactor 这种
 * 不在 node_modules 下的目录）都满足它 → 目标会被算成检出的**父目录**，release 通道装一次插件就往
 * `D:\dsh\<包名>` 写一份。生产布局不变：宿主根层 `<host>/node_modules/<pkg>` 仍然命中特判。 */
function releaseInstallTarget(profileDir, packageName) {
  let targetRoot = join(profileDir, 'node_modules')
  try {
    const selfDir = pluginRoot()
    const selfRoot = dirname(selfDir)
    if (selfRoot !== targetRoot && basename(selfRoot) === 'node_modules' && existsSync(join(selfDir, 'package.json'))) targetRoot = selfRoot
  } catch {}
  return join(targetRoot, packageName)
}

/** 从 GitHub Release 下载预构建 tgz 装配到 node_modules/<pkgName>（gh CLI 通道，含绝对路径候选）。
 * 这里保持"取第一个 tgz"的老语义（子包装配的 manifest 已指明 subRepo），不在本次 issue 范围内。 */
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

export {
  RELEASE_LIST_LIMIT, MAX_RELEASE_CANDIDATE_REPOS, RELEASE_SCAN_MAX_REPOS, RELEASE_CHANNEL_BUDGET_MS,
  RELEASE_SEARCH_REPOS, RELEASE_META_TIMEOUT_MS,
  MAX_RELEASE_ASSET_BYTES, RELEASE_REPO_CACHE_TTL, RELEASE_DOWNLOAD_MIRROR_PREFIXES, releaseRepoCache, clearReleaseSourceCache,
  remainingMs, budgetSignal,
  normalizeAssetName, releaseAssetStems, assetMatchInfo, compareAssetMatch, rankReleaseAssets,
  planReleaseInstall, releaseChannelFailureText, normalizeRepoSpec, encodeNpmName,
  repoFromNpmMetadata, reposFromGithubSearch, resolveReleaseCandidateRepos, fetchReleaseList,
  selectReleaseInstall, sourceTarballFallback, releaseDownloadUrls, downloadReleaseArtifact, releaseInstallTarget,
  installBundleFromRelease,
}
