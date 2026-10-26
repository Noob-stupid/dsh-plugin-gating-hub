// L1 · domain —— update-batch.js（已安装插件「一键检测全部更新」的批量执行器；issue #22 ①）
// 分层分组：L1 · domain（tests/test-architecture-guard.mjs 断言边界；不认识 cordis ctx、不联网、不碰盘）
//
// ── 它解决什么 ────────────────────────────────────────────────────────────────
//   issue #22 ①：`familyCheckUpdate` 只覆盖全家桶内部，单独装的第三方插件要逐个点卡片上的「检测更新」。
//   批量检测 = 把 N 个包名丢给同一个探针（probe）跑一遍。风险只有一个，而且是**已经发生过的那一个**：
//
// ── 并发上限为什么必须在这里、而且是"进程一份" ─────────────────────────────────
//   0.5.84 的真机事故（domain/enrich-throttle.js 顶部有完整记录）：市场富化当时按"每条卡片各发自己的
//   请求"来写，worker 12 × 每条 9 通道 ≈ 100 个连接同时出去，网络被占满，安装作业（pnpm / clone）跟着卡死。
//   结论：限流器**不能每个调用点各写一份** —— 那样上限会随调用点数量相乘而失效。
//   这里因此分两层：
//     · `createBatchUpdater()` 造出来的是**进程级一份**实例（路由模块加载时造一次），并发上限与缓存在
//       所有调用点之间共享 → 用户连点两次「一键检测」也不会变成两份并发；
//     · 探针本身随请求变（它要用本次请求的 ctx），所以以 `run(names, { probe })` 的形式**每次传入**，
//       而不是在工厂里绑死 —— 即"闸门是共享的，被执行的活是每次的"。
//   上限取 4：与 enrich-throttle 的 ENRICH_CONCURRENCY 同一个实测结论（4 条就够快，更多只会打满网络）。
//
// ── 判据（版本比较）不在这里 ──────────────────────────────────────────────────
//   本模块**不做任何版本比较**：谁新谁旧由探针（probe）回答，而探针是 `routes/framework.js#probePackageUpdate`
//   —— 单卡「检测更新」用的**同一份**代码，末尾走 `dropStaleUpdateCandidates` + `pickUpdateTarget`，
//   也就是 `infra/semver.js` 里 `<<<update-pick>>>` 那块唯一判据（tests/test-update-version-pick.mjs 钉死）。
//   本模块只把结论归成三态（batchStatusOf），不参与"哪个版本更高"的判断。
//
// ── 三态语义（面板据此标注卡片；不猜）──────────────────────────────────────────
//   · 'update'  ：探针给出了严格更高的目标版本（target 非空）→ 卡片可以出现「更新」按钮；
//   · 'current' ：探针查到了候选，但没有比已装更高的（target 为空、错误为空）→ 「已最新」；
//   · 'unknown' ：探针**一个候选都没拿到**（npm/GitHub 都没答上来）→ 「未检测到」。绝不把它说成"已最新"：
//                 没查到 ≠ 没有新版。
//
// ── 缓存（60s TTL）为什么值得有 ────────────────────────────────────────────────
//   批量入口一次要问几十个包；用户点完一次再点一次（或换筛选后回来点）没有理由再打一遍网络。
//   TTL 内直接复用上轮结论，响应里 `cached: true` 如实标注这是复用而不是新查的。
//   `force: true` 越过缓存（面板将来若要"强制重查"就是这个开关）。
import { makeLimiter } from './enrich-throttle.js'

/** 并发上限（与域内富化闸同一实测结论：4 条够快，再多只会把网络打满）。 */
const BATCH_UPDATE_CONCURRENCY = 4
/** 结论缓存时长：同一批包在这段时间内重复点「一键检测」不再打网络。 */
const BATCH_UPDATE_TTL_MS = 60 * 1000
/** 单次批量最多接受多少个包名（防"把整个 registry 拉一遍"这种自伤用法）。 */
const BATCH_UPDATE_MAX = 200

/**
 * 把一次探针结论归成三态（纯函数；**不比较版本**，版本高低由探针/唯一判据给出）。
 * @param {{target?: string|null, latest?: string|null, next?: string|null, beta?: string|null, error?: string|null}|null|undefined} result
 * @returns {'update'|'current'|'unknown'}
 */
function batchStatusOf(result) {
  const src = result !== null && typeof result === 'object' ? result : {}
  const target = typeof src.target === 'string' ? src.target.trim() : ''
  if (target !== '') return 'update'
  const hasCandidate = [src.latest, src.next, src.beta].some((v) => typeof v === 'string' && v.trim() !== '')
  if (hasCandidate) return 'current'
  // 一个候选都没有：查得到结论（error 为空）才算"已最新"；查不到就是"未检测到"
  return typeof src.error === 'string' && src.error !== '' ? 'unknown' : 'current'
}

/**
 * 造一个批量更新检测器。**路由模块加载时造一次、进程内共享**（并发上限与缓存都是共享的）。
 *
 * @param {object} [opts]
 * @param {number} [opts.concurrency] 并发上限（默认 BATCH_UPDATE_CONCURRENCY=4）
 * @param {number} [opts.ttlMs]       结论缓存时长（默认 60s）
 * @param {number} [opts.max]         单次最多处理的包名数（默认 200）
 * @param {() => number} [opts.now]   时钟注入缝（单测判缓存过期用）
 */
function createBatchUpdater({ concurrency = BATCH_UPDATE_CONCURRENCY, ttlMs = BATCH_UPDATE_TTL_MS, max = BATCH_UPDATE_MAX, now = Date.now } = {}) {
  const limit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : BATCH_UPDATE_CONCURRENCY
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : BATCH_UPDATE_TTL_MS
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : BATCH_UPDATE_MAX
  // ★ 进程一份闸门（不是每次 run 一份）：连点两次也共用同一个上限
  const limiter = makeLimiter(limit)
  /** packageName → { at, result }（结论缓存；失败也缓存，避免黑洞期反复打同一个包） */
  const cache = new Map()
  const counters = { runs: 0, probed: 0, cacheHits: 0, failures: 0 }

  /**
   * 跑一次批量检测。
   * @param {string[]} packageNames 包名（调用方已校验；这里仍会去重/截断，但**不**放宽校验）
   * @param {object} io
   * @param {(packageName: string) => Promise<object>} io.probe 探针（单包结论）
   * @param {(packageName: string) => (string|null)} [io.installedOf] 已装版本（只作展示，不参与判据）
   * @param {boolean} [io.force] 越过缓存
   * @returns {Promise<{ items: Array<object>, checked: number, updatable: number, unknown: number, stats: object }>}
   */
  async function run(packageNames, io = {}) {
    const probe = typeof io.probe === 'function' ? io.probe : null
    const installedOf = typeof io.installedOf === 'function' ? io.installedOf : null
    const force = io.force === true
    const list = []
    const seen = new Set()
    for (const raw of Array.isArray(packageNames) ? packageNames : []) {
      const name = typeof raw === 'string' ? raw.trim() : ''
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      list.push(name)
      if (list.length >= cap) break
    }
    counters.runs += 1
    if (probe === null) {
      // 没有探针就是接线错了 —— 如实报，不假装"都没有更新"
      return { items: [], checked: 0, updatable: 0, unknown: 0, error: '没有提供探针（probe），拒绝把"查不到"说成"已最新"', stats: statsOf() }
    }
    // ① 缓存命中判定（同步做，保持结果顺序与请求顺序一致）
    const slots = list.map((packageName) => {
      const hit = force ? undefined : cache.get(packageName)
      const fresh = hit !== undefined && now() - hit.at < ttl
      if (fresh) counters.cacheHits += 1
      return { packageName, cached: fresh ? hit : null, fromCache: fresh }
    })
    // ② 未命中的并发查（**全部**经同一个 limiter；队列 FIFO，绝不丢弃）
    await Promise.all(slots.map(async (slot) => {
      if (slot.cached !== null) return
      let result
      try {
        counters.probed += 1
        result = await limiter.run(() => probe(slot.packageName))
        if (result === null || typeof result !== 'object') {
          result = { latest: null, next: null, beta: null, target: null, error: '探针没有返回结论', source: 'npm', depsOutdated: [], migrate: null }
          counters.failures += 1
        }
      } catch (error) {
        // 单包失败**只影响自己**：批量里一个包炸掉不许拖垮其余（如实带上原因）
        counters.failures += 1
        result = { latest: null, next: null, beta: null, target: null, error: error instanceof Error ? error.message : String(error), source: 'npm', depsOutdated: [], migrate: null }
      }
      cache.set(slot.packageName, { at: now(), result })
      slot.cached = { at: now(), result }
    }))
    // ③ 组装（顺序 = 请求顺序；每项都带 status 与 cached，前端无需自己推）
    const items = slots.map((slot) => {
      const result = slot.cached !== null && typeof slot.cached === 'object' ? slot.cached.result : {}
      return {
        packageName: slot.packageName,
        installedVersion: installedOf === null ? null : installedOf(slot.packageName),
        latest: result.latest ?? null,
        next: result.next ?? null,
        beta: result.beta ?? null,
        target: result.target ?? null,
        source: result.source ?? 'npm',
        error: result.error ?? null,
        depsOutdated: Array.isArray(result.depsOutdated) ? result.depsOutdated : [],
        migrate: result.migrate ?? null,
        status: batchStatusOf(result),
        // 如实标注这一项是"本轮新查的"还是"复用 TTL 内的缓存"
        cached: slot.fromCache === true,
      }
    })
    return {
      items,
      checked: items.length,
      updatable: items.filter((i) => i.status === 'update').length,
      unknown: items.filter((i) => i.status === 'unknown').length,
      stats: statsOf(),
    }
  }

  function statsOf() {
    const limiterStats = limiter.stats()
    // 注意：limiter.stats() 也有一个 `max`（= 并发上限）。这里把它摊平改名，避免与本模块的
    // `maxPackages`（单次最多多少个包）撞名 —— 两个"上限"含义完全不同，撞名会读错诊断。
    return {
      concurrencyLimit: limit,
      ttlMs: ttl,
      maxPackages: cap,
      cacheSize: cache.size,
      cacheHits: counters.cacheHits,
      probed: counters.probed,
      runs: counters.runs,
      failures: counters.failures,
      active: limiterStats.active,
      queued: limiterStats.queued,
      peak: limiterStats.peak,
    }
  }

  return { run, stats: statsOf, clearCache: () => cache.clear() }
}

export { BATCH_UPDATE_CONCURRENCY, BATCH_UPDATE_TTL_MS, BATCH_UPDATE_MAX, batchStatusOf, createBatchUpdater }
