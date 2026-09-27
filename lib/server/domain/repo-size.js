// L1 · domain —— repo-size.js（仓库体积探测 + 「源码通道」放行判据；2026-09-27 加法，批次 D-①）
//
// 为什么要这个模块（真机事故，2026-09-27，用户实测 yjh051108/dsh-routing-suite「三件套只装到两件」）：
//   0.5.18 的批次 A-③ 为了治 zhu1090093659/dsh-web（429 MB）被白拉，写成
//   「**根包未发布（private）→ 禁用 git/archive 通道**」——判据挂在"根包 private"这一个布尔量上。
//   而 dsh-routing-suite 的根包恰好也是 private，于是它的源码通道被一并跳过：
//   `graded/`、`injector/` 有 release 产物（装上了），**`preset/`（= dsh-router-standard 预设）
//   只存在于仓库源码里** → npm 双 404、release 无资产 → 第三件永远装不上。
//   一刀切的错在于：真正的成本是**仓库体积**，不是"根包是否 private"。
//   本模块把判据换成按体积分档（小仓库放行 / 巨仓仍禁 / 探测不到时保守但不沉默）。
//
// 探测复用既有 http 多通道（githubJson 的官方+镜像+gh 竞速、curlJson 的 curl 快通道），
// 与 suite.js#fetchRepoMeta 同一套写法与同一个预算常量；结果按仓库缓存（默认 6 小时）。

import { GITHUB_API, META_BUDGET_MS, curlJson, githubJson } from '../infra/http.js'

/** 源码通道的体积上限（MB，可用 `DSH_GIT_MAX_REPO_MB` 配置，夹在 1 MB ~ 4096 MB）。
 * 20 MB 的取法：真机能装的最小聚合子包 @linxin666/dsh-web-all 是 5.97 MB，
 * 社区插件仓库实测中位数远小于 20 MB；而 dsh-web 的 429 MB 是它的 21 倍 —— 阈值落在两簇之间，
 * 不会因为"多几 MB 的文档/截图"把正常插件误杀，也不会放过巨仓。 */
const GIT_MAX_REPO_MB = 20
function gitMaxRepoMb(env = process.env) {
  const raw = Number.parseInt(String(env?.DSH_GIT_MAX_REPO_MB ?? ''), 10)
  if (!Number.isFinite(raw)) return GIT_MAX_REPO_MB
  return Math.min(4096, Math.max(1, raw))
}

/** KB → MB 可读写法（保留 1 位小数；只服务面板文案）。 */
function formatRepoSize(sizeKb) {
  const kb = Number(sizeKb)
  if (!Number.isFinite(kb) || kb < 0) return '未知'
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 源码通道判据（**纯函数**，边界矩阵单测覆盖）：探测结果 × 阈值 → { allow, note }。
 *   · state='known' 且 sizeKb ≤ 阈值 → 放行（note 说清体积与阈值，用户知道"为什么这次允许")
 *   · state='known' 且 sizeKb >  阈值 → **仍禁**，note 必须含体积、原因与出路（仓库落地 / 本地镜像）
 *   · state='unknown'（探测失败/超时/404）→ **保守但不沉默**：保持禁令 + note 说明"尺寸未知，已保守跳过"
 * 返回的 note 一律非空 —— 静默跳过正是这次事故的另一半（用户什么都看不到）。 */
function sourceChannelGate(options = {}, thresholdMb = GIT_MAX_REPO_MB) {
  // ⚠️ 这里**故意不用解构默认值**（旧代码是 `{ state = 'unknown', sizeKb = null } = {}`）：
  // 解构的 `= null` 会在"键存在但值是 undefined"时也填上 null，于是**原始值被抹掉**——
  // 而本次改错要判的恰恰是"读到的到底是什么"，note 里必须分得出 null / undefined / 空串 / false。
  const raw = options !== null && typeof options === 'object' ? options : {}
  const provided = Object.prototype.hasOwnProperty.call(raw, 'sizeKb')
  const state = raw.state === undefined ? 'unknown' : raw.state
  const rawSize = provided ? raw.sizeKb : null
  const sizeKb = rawSize
  const limit = Number.isFinite(Number(thresholdMb)) && Number(thresholdMb) >= 1 ? Number(thresholdMb) : GIT_MAX_REPO_MB
  const kb = Number(sizeKb)
  // 判据必须落在**原始值**上：旧代码写的是 `Number(sizeKb)` 之后再判有限性，于是
  // `sizeKb: null` → `Number(null) === 0` → 有限且 ≥ 0 → **被当成 0 MB 放行**（`undefined` 同理 → NaN→
  // 有限性为假，那条反倒是禁的；真正漏的是 null / '' / false / [] 这些"能转成 0"的值）。
  // 0 KB 只有在**真的是数字 0**时才是合法尺寸（空仓库；见边界断言），"读不到尺寸"绝不能伪装成 0。
  const numericSize = typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize >= 0
  const known = state === 'known' && numericSize
  if (!known) {
    // state='known' 但尺寸不是有限数 = 上游给了自相矛盾的结论（探测层不会这样产出）。
    // 这时必须**如实说清**并保守跳过；旧文案会把它说成"探测失败/超时/404"，与真实原因不符。
    const contradiction = state === 'known'
    const shown = provided ? String(rawSize) : 'undefined（未提供）'
    return {
      allow: false,
      state: 'unknown',
      sizeKb: null,
      limitMb: limit,
      note: contradiction
        ? `仓库体积读到的不是有效数字（state=known 但 sizeKb=${shown}）：已**保守跳过**源码通道（git / archive / 稀疏取源码）—— 尺寸读不出来时绝不能当成 0 MB 放行。请重试；或改用「仓库落地」把仓库克隆到本地目录后安装。`
        : '仓库体积未知（GitHub 元数据探测失败/超时/404）：已**保守跳过**源码通道（git / archive / 稀疏取源码），避免白拉一个可能几百 MB 的仓库。请重试；或改用「仓库落地」把仓库克隆到本地目录后安装。',
    }
  }
  if (kb <= limit * 1024) {
    return {
      allow: true,
      state: 'known',
      sizeKb: kb,
      limitMb: limit,
      note: `仓库体积 ${formatRepoSize(kb)}（上限 ${limit} MB）：已放行源码通道（git / archive / 稀疏取源码）`,
    }
  }
  return {
    allow: false,
    state: 'known',
    sizeKb: kb,
    limitMb: limit,
    // 同时给 MB 与 KB：刚好卡在阈值附近时（20481 KB vs 20480 KB）MB 会四舍五入成同一个数，
    // 只写 MB 会让用户看不出"到底超了多少"。
    note: `仓库过于庞大（${formatRepoSize(kb)}／${Math.round(kb)} KB，上限 ${limit} MB）：已跳过源码通道（git / archive / 稀疏取源码）——请用「仓库落地」把仓库克隆到本地目录，或改用本地镜像/子包（已发布到 npm 的聚合包优先）。`,
  }
}

/** 探测结果缓存（默认 6 小时）：同一个作业里 git 通道与预设源码通道会各问一次，
 * 跨作业也会反复问（市场卡片重试）。缓存键是 owner/repo（大小写不敏感）。
 * 只缓存**成功**结果：探测失败不落缓存，下次重试有机会拿到尺寸（免得一次网络抖动把仓库
 * 永久钉在"尺寸未知"上）。 */
const SIZE_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const sizeCache = new Map()

/** 仓库体积探测：`GET /repos/{owner}/{repo}` 的 `size`（KB）。
 * 走既有 http 多通道（githubJson 官方+镜像竞速，且带 gh CLI 兜底；curlJson 走系统网络栈），
 * 与 META_BUDGET_MS 同一个外层预算（黑洞期不卡 40 秒）。
 * 返回 { state: 'known'|'unknown', sizeKb, note, cached }。**绝不抛**（探测失败是正常结局）。 */
async function fetchRepoSize(repo, deps = {}) {
  const full = String(repo ?? '').trim().replace(/\.git$/u, '')
  if (full === '' || !full.includes('/')) return { state: 'unknown', sizeKb: null, note: '仓库名无效', cached: false }
  const key = full.toLowerCase()
  const now = deps.now ?? Date.now
  const cache = deps.cache ?? sizeCache
  const ttl = Number.isFinite(deps.ttlMs) ? deps.ttlMs : SIZE_CACHE_TTL_MS
  const hit = cache.get(key)
  if (hit !== undefined && now() - hit.at < ttl) return { ...hit.value, cached: true }
  const race = deps.race ?? (async () => Promise.race([
    Promise.any([
      githubJson(`${GITHUB_API}/repos/${full}`, undefined, deps.token ?? null),
      curlJson(`${GITHUB_API}/repos/${full}`, 12000, {}, { ipv4: true }),
    ]),
    new Promise((resolve) => setTimeout(() => resolve(null), Number.isFinite(deps.budgetMs) ? deps.budgetMs : META_BUDGET_MS)),
  ]).catch(() => null))
  let meta = null
  try { meta = await race() } catch { meta = null }
  const sizeKb = Number(meta?.size)
  if (meta !== null && meta !== undefined && Number.isFinite(sizeKb) && sizeKb >= 0) {
    const value = { state: 'known', sizeKb, note: '', cached: false }
    try { cache.set(key, { at: now(), value }) } catch {}
    return value
  }
  return { state: 'unknown', sizeKb: null, note: '未能读到仓库体积（元数据探测失败/超时/404）', cached: false }
}

/** 一次算完「这个仓库的源码通道能不能走」：探测 → 纯判据。deps.probe 只为单测注入。 */
async function evaluateSourceChannel(repo, deps = {}) {
  const probe = typeof deps.probe === 'function' ? deps.probe : fetchRepoSize
  let result = null
  try { result = await probe(repo, deps) } catch { result = null }
  const state = result?.state === 'known' ? 'known' : 'unknown'
  const gate = sourceChannelGate({ state, sizeKb: result?.sizeKb ?? null }, deps.thresholdMb ?? gitMaxRepoMb(deps.env ?? process.env))
  return { ...gate, cached: result?.cached === true }
}

/** 把判据落到 job 上（唯一入口，install-job 的两处 private 根分支共用）：
 * 写 job.privateRoot / job.repoSize / job.gitChannelBlocked / job.sourceChannelBlocked，并把 note 交给调用方记档。
 * 返回值同 evaluateSourceChannel（调用方若要给更细的下一步文案可直接用 note）。 */
async function gatePrivateRoot(job, note, deps = {}) {
  const gate = await evaluateSourceChannel(job?.repo, deps)
  if (job !== null && job !== undefined) {
    job.privateRoot = true
    job.repoSize = { state: gate.state, sizeKb: gate.sizeKb, limitMb: gate.limitMb }
    job.gitChannelBlocked = gate.allow !== true
    job.sourceChannelBlocked = gate.allow !== true
  }
  if (typeof note === 'function') note(job, gate.note)
  return gate
}

export { GIT_MAX_REPO_MB, SIZE_CACHE_TTL_MS, sizeCache, gitMaxRepoMb, formatRepoSize, sourceChannelGate, fetchRepoSize, evaluateSourceChannel, gatePrivateRoot }
