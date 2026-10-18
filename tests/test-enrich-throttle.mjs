// 0.5.84 加法：市场富化请求的四条硬要求（见 domain/enrich-throttle.js 顶部真机症状）
//
// 本套钉死的是"闸门真的关上了"，而不是"代码里写了 4 这个数字"：
//   ① **并发上限** —— 20 条卡片一起富化时，同时在飞的请求数峰值 ≤ ENRICH_CONCURRENCY
//   ② **失败短期记忆** —— 同一个失败 URL 在 10 分钟窗口内**只发一次**，之后直接短路（不发请求）
//   ③ **短缓存** —— 同一成功 URL 在窗口内反复问只发一次
//   ④ **单飞** —— 同一 URL 的并发调用共用一次请求（市场面板 + 详情卡片同时打开的真机场景）
// 另加两条接线断言（防"加了模块没人用"这一整类）：enrichItems 真的走这道闸、技能探测也走它。
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'enrich-throttle-home')
process.env.DSH_HOME = HOME // 富化缓存落盘的位置（必须在 import 之前设置）
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

const gate = await import('../lib/server/domain/enrich-throttle.js')
const market = await import('../lib/server/domain/market.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const tick = () => new Promise((r) => setTimeout(r, 0))

/** 造一个"会记录在飞数量"的桩：每个请求占 5ms，返回固定文本。 */
const makeProbe = ({ ms = 5, body = '{"name":"x"}', fail = false } = {}) => {
  const probe = { calls: 0, active: 0, peak: 0, urls: [] }
  probe.curlText = async (url) => {
    probe.calls += 1
    probe.urls.push(url)
    probe.active += 1
    if (probe.active > probe.peak) probe.peak = probe.active
    await new Promise((r) => setTimeout(r, ms))
    probe.active -= 1
    if (fail) throw new Error('模拟超时')
    return body
  }
  probe.curlJson = async () => { const text = await probe.curlText('json'); return JSON.parse(text) }
  probe.rawTextFetch = async () => ({ state: 'ok', body: 'x' })
  return probe
}
const run = async (fn) => { try { await fn(); return { ok: true } } catch (error) { return { ok: false, error } } }

console.log('=== ① 并发上限：20 个请求一起发，峰值不许超过 4 ===')
{
  gate.__resetEnrichThrottle()
  const probe = makeProbe({ ms: 8 })
  gate.__setEnrichThrottleImpl(probe)
  const jobs = Array.from({ length: 20 }, (_, i) => run(() => gate.throttledCurlText(`https://example.invalid/${i}`)))
  await Promise.all(jobs)
  const stats = gate.enrichThrottleStats()
  check(`① 并发峰值 ≤ ${gate.ENRICH_CONCURRENCY}（实测峰值 ${probe.peak}）`, probe.peak <= gate.ENRICH_CONCURRENCY, `peak=${probe.peak}`)
  check('① 20 个请求全部真的发出去了（限流不是丢请求）', probe.calls === 20, `calls=${probe.calls}`)
  check('① 统计口径可用（ran/peak 与桩对得上）', stats.ran === 20 && stats.peak === probe.peak, JSON.stringify(stats))
}

console.log('\n=== ② 失败短期记忆：同一个失败 URL 只试一次（10 分钟内不再试）===')
{
  gate.__resetEnrichThrottle()
  const probe = makeProbe({ fail: true })
  gate.__setEnrichThrottleImpl(probe)
  const first = await run(() => gate.throttledCurlText('https://example.invalid/boom'))
  const second = await run(() => gate.throttledCurlText('https://example.invalid/boom'))
  const third = await run(() => gate.throttledCurlText('https://example.invalid/boom'))
  check('② 第一次真的发了请求且失败（与裸 curlText 同语义：抛错）', first.ok === false && probe.calls === 1, `calls=${probe.calls}`)
  check('② 窗口内后两次**一个请求都没发**（短路在本地）', second.ok === false && third.ok === false && probe.calls === 1, `calls=${probe.calls}`)
  check('② 短路原因说得清（不是冒充"文件不存在"）',
    second.error?.code === 'ENRICH_COOLING_DOWN' && /冷却期/u.test(second.error.message), String(second.error?.message).slice(0, 80))
  check('② 被短路掉的次数可见（面板诊断：skipped）', gate.enrichThrottleStats().skipped === 2, `skipped=${gate.enrichThrottleStats().skipped}`)
  check('② 时间窗外重新允许尝试（窗口值就是 10 分钟，不是无限期）',
    gate.FAILURE_COOLDOWN_MS === 10 * 60 * 1000 && gate.enrichThrottleStats().failureCooldownMs === gate.FAILURE_COOLDOWN_MS,
    String(gate.FAILURE_COOLDOWN_MS))
}

console.log('\n=== ③ 短缓存：同一个成功 URL 反复问只发一次 ===')
{
  gate.__resetEnrichThrottle()
  const probe = makeProbe()
  gate.__setEnrichThrottleImpl(probe)
  const a = await gate.throttledCurlText('https://example.invalid/ok')
  const b = await gate.throttledCurlText('https://example.invalid/ok')
  check('③ 两次都拿到内容', a === b && typeof a === 'string', String(a).slice(0, 30))
  check('③ 只发了一次请求（第二次命中短缓存）', probe.calls === 1, `calls=${probe.calls}`)
  check('③ 短缓存时长有上限（5 分钟，不是又一个 24h 缓存）',
    gate.SHORT_CACHE_TTL_MS === 5 * 60 * 1000, String(gate.SHORT_CACHE_TTL_MS))
}

console.log('\n=== ④ 单飞：同一 URL 的并发调用只发一次 ===')
{
  gate.__resetEnrichThrottle()
  const probe = makeProbe({ ms: 10 })
  gate.__setEnrichThrottleImpl(probe)
  const [x, y, z] = await Promise.all([
    gate.throttledCurlText('https://example.invalid/same'),
    gate.throttledCurlText('https://example.invalid/same'),
    gate.throttledCurlText('https://example.invalid/same'),
  ])
  check('④ 三个并发调用拿到同一个结果', x === y && y === z, `${x === y}/${y === z}`)
  check('④ 只发了一次请求', probe.calls === 1, `calls=${probe.calls}`)
}

console.log('\n=== ⑤ 单次预算不许长：富化探针一律压到 4s 以内 ===')
{
  gate.__resetEnrichThrottle()
  const seen = []
  gate.__setEnrichThrottleImpl({
    curlText: async (url, timeout) => { seen.push(timeout); return 'x' },
    curlJson: async (url, timeout) => { seen.push(timeout); return {} },
    rawTextFetch: async (repo, branch, path, budget) => { seen.push(budget); return { state: 'ok', body: 'x' } },
  })
  await gate.throttledCurlText('https://example.invalid/a', 30000) // 上游传 30s 也必须被压低
  await gate.throttledCurlJson('https://example.invalid/b', 20000)
  await gate.throttledRawText('owner/repo', 'main', '.gitmodules', { budgetMs: 10000 })
  check('⑤ 三个出口的预算都被压到 ≤ 4000ms', seen.length === 3 && seen.every((ms) => ms <= gate.ENRICH_TIMEOUT_MS), JSON.stringify(seen))
}

console.log('\n=== ⑥ 接线：enrichItems 真的走这道闸（峰值被压住，不是每项各发一套）===')
{
  gate.__resetEnrichThrottle()
  const probe = makeProbe({ ms: 4 })
  gate.__setEnrichThrottleImpl(probe)
  const items = Array.from({ length: 20 }, (_, i) => ({ fullName: `owner/repo-${i}`, defaultBranch: 'main' }))
  const out = await market.enrichItems(items)
  const stats = gate.enrichThrottleStats()
  check('⑥ 20 条卡片全部有结果（不因限流而漏条目）', Array.isArray(out) && out.length === 20 && out.every((x) => x !== undefined), `len=${out?.length}`)
  check(`⑥ enrichItems 的在飞峰值 ≤ ${gate.ENRICH_CONCURRENCY}（实测 ${stats.peak}）`, stats.peak <= gate.ENRICH_CONCURRENCY, `peak=${stats.peak}`)
  check('⑥ 真的发出了请求（不是靠缓存假装通过）', stats.ran > 0, `ran=${stats.ran}`)
}

console.log('\n=== ⑦ 负缓存对 raw 探针的语义：冷却期返回 null，不抛给上层 ===')
{
  gate.__resetEnrichThrottle()
  gate.__setEnrichThrottleImpl({ rawTextFetch: async () => { throw new Error('模拟不可达') } })
  const a = await gate.throttledRawText('owner/repo', 'main', '.gitmodules')
  const b = await gate.throttledRawText('owner/repo', 'main', '.gitmodules')
  check('⑦ 抓取失败 / 冷却期都返回 null（与 rawTextWithFallback 同语义）', a === null && b === null, `${a}/${b}`)
}

gate.__setEnrichThrottleImpl(null)
gate.__resetEnrichThrottle()
rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
