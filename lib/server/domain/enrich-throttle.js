// L1 · domain —— enrich-throttle.js（市场卡片「富化请求」的**唯一出口闸**；0.5.84 加法）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言；不认识 cordis ctx）
//
// ── 为什么要有这一层（真机症状）──────────────────────────────────────────────────
//   一次打开市场面板，服务端会对**每一条**卡片发出下面这些请求（domain/market.js#enrichItemOne）：
//     · package.json：curl 直连 + ghproxy 镜像（Promise.any 两条同时发）
//     · SKILL.md    ：curl 直连 + ghproxy + jsDelivr（三条同时发，见 domain/skills.js#detectSkillRepo）
//     · .gitmodules ：rawTextFetch 的四条通道竞速（https / gh / curl / jsDelivr）
//   ⇒ 单条卡片最坏 ≈ 9 个并发请求，而 enrichItems 的 worker 数是 12 ⇒ 面板一打开就是 ≈100 个连接
//     同时抢出去；raw.githubusercontent 在这个量级下几乎全部 ERR_TIMED_OUT / 404，
//     网络被占满，安装作业（pnpm / clone）跟着卡 —— 用户看到的是「市场一直在转圈」。
//
// ── 这一层干什么（四条，缺一条都还会打满网络）────────────────────────────────────
//   ① **并发上限**：所有富化请求共用**一个** limiter（默认 4）。不是每个调用点各写一份
//      Promise.all —— 那样上限会随调用点数量相乘而失效。
//   ② **单飞（single-flight）**：同一个 URL 同时只发一次。市场面板 + 详情卡片 + 搜索并发打开时，
//      它们问的是同一批 URL，重复发没有意义。
//   ③ **负缓存（短期记忆）**：失败的 URL 10 分钟内**不再发请求**，直接短路失败。
//      这就是"不要反复重试同一个失败 URL"——黑洞期里重试只会继续吃掉并发额度。
//   ④ **短缓存**：成功结果缓存 5 分钟（富化判定本身另有 24h/1h 缓存，见 market.js）。
//      短缓存只解决"同一批卡片在几分钟内被反复打开"。
//   另：**单次超时不许长**。富化是"锦上添花"的判定，不该占用 10s 的抓取预算（那 10s 是给
//   安装路径上"必须读到清单"的场景的）；本模块把富化探针的预算统一压到 4s。
//
// ── 语义边界（重要）──────────────────────────────────────────────────────────────
//   · 本模块**只做闸门与记忆**，不做判定：成功/失败/404 的解释权仍在各通道自己手里。
//   · `throttledCurlText` / `throttledCurlJson` **失败仍然抛错**（与裸实现一致）—— 上游用
//     `Promise.any` / `allSettled` 写的分支逻辑一个字都不用改；负缓存命中时也抛（只是不发请求）。
//   · `throttledRawText` **失败仍然返回 null**（与 rawTextWithFallback 一致）。
//   · 生产不注入任何东西就是真实现（默认值直接来自 infra/http.js，与全仓出网单点同一套）。
import { FETCH_OK, curlJson, curlText, rawTextFetch } from '../infra/http.js'

/** 并发上限（真机结论：4 条就够快，更多只会把网络打满）。 */
const ENRICH_CONCURRENCY = 4
/** 失败记忆窗口：这段时间内同一个 key 不再发请求。 */
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000
/** 成功短缓存：同一批卡片在几分钟内重复打开不再打网络。 */
const SHORT_CACHE_TTL_MS = 5 * 60 * 1000
/** 富化探针的单次预算上限（"不要把单次超时设得太长"）。 */
const ENRICH_TIMEOUT_MS = 4000
/** 记忆表上限（防止长时间运行后无限增长；满了淘汰最旧的一批）。 */
const MEMORY_LIMIT = 4000

/** 计数限流器：`run(fn)` 在有空位时才真正执行 fn（队列 FIFO，绝不丢弃）。 */
function makeLimiter(max) {
  const size = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1
  let active = 0
  let peak = 0
  const queue = []
  const pump = () => {
    while (active < size && queue.length > 0) {
      const job = queue.shift()
      active += 1
      if (active > peak) peak = active
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .then(() => { active -= 1; pump() }, () => { active -= 1; pump() })
    }
  }
  return {
    run(fn) {
      return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump() })
    },
    stats() { return { max: size, active, queued: queue.length, peak } },
  }
}

/** 记忆表：`Map` + 上限淘汰（只清最旧的一批，不整体清空 —— 否则上限一到就等于没有记忆）。 */
function boundedSet(map, key, value) {
  if (map.size >= MEMORY_LIMIT) {
    const drop = Math.max(1, Math.floor(MEMORY_LIMIT / 4))
    let n = 0
    for (const k of map.keys()) { map.delete(k); if (++n >= drop) break }
  }
  map.set(key, value)
}

// ── 模块级状态（一个进程一份闸门；`__resetEnrichThrottle()` 供单测还原）─────────────
const state = {
  limiter: makeLimiter(ENRICH_CONCURRENCY),
  inflight: new Map(),   // key → Promise（单飞）
  okCache: new Map(),    // key → { at, value }
  failCache: new Map(),  // key → at（负缓存）
  skipped: 0,            // 被负缓存短路掉的请求数（面板诊断用）
  ran: 0,                // 真的发出去的请求数
}

/** 出网实现的注入缝（默认 = infra/http.js 的真实现；单测换成 tripwire 即可证明"一个请求都没发"）。 */
let impl = null
/** 单测注入出口实现：传对象 = 打桩（缺项回落真实现）；传 null = 还原。返回是否已注入。 */
function __setEnrichThrottleImpl(next) {
  impl = next !== null && typeof next === 'object' ? next : null
  return impl !== null
}

/** 清空全部记忆与在途记录（单测 & 诊断用；已在途的请求不会被取消）。 */
function __resetEnrichThrottle() {
  state.limiter = makeLimiter(ENRICH_CONCURRENCY)
  state.inflight.clear()
  state.okCache.clear()
  state.failCache.clear()
  state.skipped = 0
  state.ran = 0
}

/** 闸门现状（面板诊断 / 单测断言"并发确实被压住"用）。 */
function enrichThrottleStats() {
  return {
    ...state.limiter.stats(),
    inflight: state.inflight.size,
    okCacheSize: state.okCache.size,
    failCacheSize: state.failCache.size,
    skipped: state.skipped,
    ran: state.ran,
    concurrencyLimit: ENRICH_CONCURRENCY,
    failureCooldownMs: FAILURE_COOLDOWN_MS,
    shortCacheTtlMs: SHORT_CACHE_TTL_MS,
    timeoutMs: ENRICH_TIMEOUT_MS,
  }
}

/** 占位错误：负缓存命中时用它短路（带上原因，别让上游以为是"文件不存在"）。 */
function coolingDownError(key, waitMs) {
  const error = new Error(`富化请求在冷却期（${Math.max(1, Math.round(waitMs / 1000))}s 内不再重试）：${key}`)
  error.code = 'ENRICH_COOLING_DOWN'
  return error
}

/**
 * 过闸执行一次富化请求（**唯一入口**）。
 * @param {string} key  记忆键（同一份内容必须给出同一个 key）
 * @param {() => Promise<any>} run 真请求（抛错 = 失败；返回值由 accept 判定算不算"读到了"）
 * @param {object} [opts]
 * @param {(v:any) => boolean} [opts.accept] 什么算成功（默认"非空字符串"）
 * @param {number} [opts.okTtlMs]   成功短缓存时长
 * @param {number} [opts.failTtlMs] 失败记忆时长
 * @returns {Promise<any>} 成功值；冷却命中/失败由调用方包装成各自的语义
 */
async function throughGate(key, run, opts = {}) {
  const accept = typeof opts.accept === 'function' ? opts.accept : (v) => typeof v === 'string' && v.trim() !== ''
  const okTtlMs = Number.isFinite(opts.okTtlMs) ? opts.okTtlMs : SHORT_CACHE_TTL_MS
  const failTtlMs = Number.isFinite(opts.failTtlMs) ? opts.failTtlMs : FAILURE_COOLDOWN_MS
  const now = Date.now()
  // ④ 短缓存命中
  const cached = state.okCache.get(key)
  if (cached !== undefined) {
    if (now - cached.at < okTtlMs) return cached.value
    state.okCache.delete(key)
  }
  // ③ 负缓存命中 → **不发请求**，直接按"这次也不会有"短路
  const failedAt = state.failCache.get(key)
  if (failedAt !== undefined) {
    if (now - failedAt < failTtlMs) {
      state.skipped += 1
      throw coolingDownError(key, failTtlMs - (now - failedAt))
    }
    state.failCache.delete(key)
  }
  // ② 单飞：同一 key 的并发调用共用同一个 Promise
  const running = state.inflight.get(key)
  if (running !== undefined) return running
  const task = state.limiter
    .run(() => { state.ran += 1; return run() })
    .then((value) => {
      if (accept(value)) {
        boundedSet(state.okCache, key, { at: Date.now(), value })
        state.failCache.delete(key)
        return value
      }
      boundedSet(state.failCache, key, Date.now())
      throw new Error('富化请求未读到内容')
    }, (error) => {
      boundedSet(state.failCache, key, Date.now())
      throw error
    })
    .finally(() => { state.inflight.delete(key) })
  state.inflight.set(key, task)
  return task
}

/** 预算归一：富化探针一律压到 ENRICH_TIMEOUT_MS 以内。 */
function budgetOf(timeoutMs) {
  const wanted = Number.isFinite(timeoutMs) ? timeoutMs : ENRICH_TIMEOUT_MS
  return Math.min(Math.max(wanted, 800), ENRICH_TIMEOUT_MS)
}

/**
 * 过闸的 `curlText`（**失败仍然抛错**，与裸实现同语义）。
 * @param {string} url
 * @param {number} [timeoutMs] 超过 ENRICH_TIMEOUT_MS 会被压到上限
 */
async function throttledCurlText(url, timeoutMs = ENRICH_TIMEOUT_MS, opts = {}) {
  const real = typeof impl?.curlText === 'function' ? impl.curlText : curlText
  return await throughGate(`text:${url}`, () => real(url, budgetOf(timeoutMs), opts.curlOpts ?? {}), opts)
}

/** 过闸的 `curlJson`（**失败仍然抛错**）。 */
async function throttledCurlJson(url, timeoutMs = ENRICH_TIMEOUT_MS, opts = {}) {
  const real = typeof impl?.curlJson === 'function' ? impl.curlJson : curlJson
  return await throughGate(
    `json:${url}`,
    () => real(url, budgetOf(timeoutMs), opts.headers ?? {}),
    { ...opts, accept: opts.accept ?? ((v) => v !== null && typeof v === 'object') },
  )
}

/**
 * 过闸的 raw 抓取（**失败仍然返回 null**，与 rawTextWithFallback 同语义）。
 * 通道竞速仍在 infra/http.js（四条通道一条不删），只是**预算由这里压到 ENRICH_TIMEOUT_MS 以内**
 * 并共用同一个闸门 —— 富化探针绝不允许占用安装路径那 10s 的抓取预算。
 */
async function throttledRawText(repo, branch, path, opts = {}) {
  const real = typeof impl?.rawTextFetch === 'function' ? impl.rawTextFetch : rawTextFetch
  const budget = budgetOf(opts.budgetMs)
  try {
    const text = await throughGate(`raw:${repo}@${branch}/${path}`, async () => {
      const { state: st, body } = await real(repo, branch, path, budget)
      return st === FETCH_OK ? body : null
    }, opts)
    return typeof text === 'string' ? text : null
  } catch {
    // 冷却期 / 抓取失败 / 404 → 都是"这次没读到"，与 rawTextWithFallback 的 null 同义
    return null
  }
}

export {
  ENRICH_CONCURRENCY,
  ENRICH_TIMEOUT_MS,
  FAILURE_COOLDOWN_MS,
  SHORT_CACHE_TTL_MS,
  MEMORY_LIMIT,
  makeLimiter,
  throughGate,
  throttledCurlText,
  throttledCurlJson,
  throttledRawText,
  enrichThrottleStats,
  __resetEnrichThrottle,
  __setEnrichThrottleImpl,
}
