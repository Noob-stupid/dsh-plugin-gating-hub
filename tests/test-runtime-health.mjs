// 运行期卡顿守护的服务端判据（0.5.111 加法）
//
// 覆盖：
//   ① 从调用栈/脚本 URL 认包名（/plugins/<pkg>/、/node_modules/<pkg>/）；
//   ② 没有栈时只在已装包里只读搜 URL/端口，返回 owner + 证据行号；
//   ③ 同一 url+source 的重复上报合并成一条（trips+1、count 取 max），不同 source 分开；
//   ④ ring 上限 50，新的在前；按 url 清空只清那一条；
//   ⑤ 配置白名单与坏值回落；`enabled` 默认 false（是否生效由运行模式决定，不由配置决定）；
//   ⑥ 事件循环采样：40ms 不记、600ms 记一次且 maxDriftMs=600；
//   ⑦ 路由：report / config / clear / 非法 url 的状态码与载荷。
//
// 全离线：私有 DSH_HOME、假包目录，不联网。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'runtime-health-home')
const PROFILE = join(HOME, 'profiles', 'web')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
mkdirSync(join(PROFILE, 'node_modules', '@fake', 'demo', 'lib'), { recursive: true })
process.env.DSH_HOME = HOME

writeFileSync(join(PROFILE, 'node_modules', '@fake', 'demo', 'package.json'), JSON.stringify({ name: '@fake/demo', version: '1.0.0' }), 'utf8')
writeFileSync(join(PROFILE, 'node_modules', '@fake', 'demo', 'lib', 'client.js'), [
  '// fake inspector client',
  'const endpoint = "ws://127.0.0.1:9230/ingest"',
  'export { endpoint }',
].join('\n'), 'utf8')

const domain = await import('../lib/server/domain/runtime-health.js')
const { routeRuntimeHealth } = await import('../lib/server/routes/runtime-health.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const fakeRes = () => {
  const captured = { status: null, json: null }
  return { captured, writeHead(status) { captured.status = status }, end(payload) { try { captured.json = JSON.parse(payload) } catch { captured.json = null } } }
}

// ── ① 调用栈/脚本 URL 归因 ─────────────────────────────────────────────────────
{
  const a = domain.attributeSourcePath('https://127.0.0.1:3080/plugins/@linxin666/dsh-web-all/client.js:3229')
  check('① 从 /plugins/@scope/pkg/ 认包名', a?.owner === '@linxin666/dsh-web-all' && a?.confidence === 'source-path', JSON.stringify(a))
  const b = domain.attributeSourcePath('file:///C:/x/node_modules/dshmarket/lib/client.js:12')
  check('① 从 /node_modules/pkg/ 认包名', b?.owner === 'dshmarket', JSON.stringify(b))
  check('① 没有可识别路径 → null（不猜）', domain.attributeSourcePath('https://example.com/app.js:1') === null)
}

// ── ② 无栈时只读扫已装包 ────────────────────────────────────────────────────────
{
  const hit = domain.attributeUrl('ws://127.0.0.1:9230/ingest', { source: null, profileDir: PROFILE })
  check('② 无栈时扫到 owner', hit.owner === '@fake/demo' && hit.confidence === 'source-scan', JSON.stringify(hit))
  check('② 证据带文件与行号', typeof hit.evidence === 'string' && /lib[\\/]client\.js:2$/u.test(hit.evidence), String(hit.evidence))
  const bySource = domain.attributeUrl('ws://127.0.0.1:9230/ingest', { source: 'https://x/plugins/@other/pkg/client.js:7', profileDir: PROFILE })
  check('② 有栈时栈优先于源码扫描', bySource.owner === '@other/pkg' && bySource.confidence === 'source-path', JSON.stringify(bySource))
  check('② 扫不到 → owner null（不猜）', domain.attributeUrl('ws://127.0.0.1:59999/nope', { source: null, profileDir: PROFILE }).owner === null)
}

// ── ③ 事件合并 ──────────────────────────────────────────────────────────────────
{
  const one = domain.recordClientIncident({ url: 'ws://127.0.0.1:9230/ingest', source: 'a.js:1', count: 5, windowMs: 30000, at: 1000, owner: 'test' }, { home: HOME })
  const two = domain.recordClientIncident({ url: 'ws://127.0.0.1:9230/ingest', source: 'a.js:1', count: 3, windowMs: 30000, at: 2000, owner: 'test' }, { home: HOME })
  check('③ 同 url+source 合并成一条', one.store.incidents.length === 1 && two.store.incidents.length === 1)
  check('③ trips 递增、count 取 max', two.incident.trips === 2 && two.incident.count === 5, JSON.stringify(two.incident))
  const three = domain.recordClientIncident({ url: 'ws://127.0.0.1:9230/ingest', source: 'b.js:2', count: 1, windowMs: 30000, at: 3000, owner: 'test' }, { home: HOME })
  check('③ 不同 source 分开记', three.store.incidents.length === 2)
  const bad = domain.recordClientIncident({ url: 'http://x/y', source: 'a', count: 1 }, { home: HOME })
  check('③ 非 ws/wss 拒绝且不写盘', bad.ok === false && bad.incident === null)
}

// ── ③-b 轮询空转（无 url，按调用栈归因）────────────────────────────────────────
{
  const poll = domain.recordClientIncident({
    kind: 'polling-storm',
    source: 'https://x/plugins/@fake/demo/client.js:9',
    count: 300,
    windowMs: 60000,
    detail: { delayMs: 50, ticks: 300 },
    at: 3500,
  }, { home: HOME })
  check('③-b 轮询事件不需要 url，按栈归因', poll.ok === true && poll.incident?.url === null && poll.incident?.owner === '@fake/demo', JSON.stringify(poll.incident))
  check('③-b 轮询 detail 落盘', poll.incident?.detail?.delayMs === 50 && poll.incident?.detail?.ticks === 300, JSON.stringify(poll.incident?.detail))
  const bad = domain.recordClientIncident({ kind: 'polling-storm', count: 300 }, { home: HOME })
  check('③-b 轮询缺 source 拒绝且不写盘', bad.ok === false && bad.incident === null, JSON.stringify(bad))
}

// ── ④ ring 上限与按 url 清 ──────────────────────────────────────────────────────
{
  for (let i = 0; i < 60; i += 1) {
    domain.recordClientIncident({ url: `wss://x.test/${i}`, source: null, count: 1, at: 10000 + i, owner: 'test' }, { home: HOME })
  }
  const store = domain.readRuntimeHealthStore({ home: HOME })
  check('④ ring 只留 50 条', store.incidents.length === 50, String(store.incidents.length))
  check('④ 新的在前', store.incidents[0].url === 'wss://x.test/59', store.incidents[0]?.url)
  const cleared = domain.clearClientIncidents({ url: 'wss://x.test/59', home: HOME })
  check('④ 按 url 只清那一条', cleared.ok === true && cleared.removed === 1 && !domain.readRuntimeHealthStore({ home: HOME }).incidents.some((x) => x.url === 'wss://x.test/59'))
}

// ── ⑤ 配置白名单与坏值回落 ──────────────────────────────────────────────────────
{
  const d = domain.readRuntimeGuardConfig({ home: HOME })
  check('⑤ 默认 enabled=false（是否生效由运行模式决定）', d.config.enabled === false, JSON.stringify(d.config))
  const w = domain.writeRuntimeGuardConfig({ enabled: true, maxFails: 5, windowMs: 1234, cooldownMs: 60000 }, { home: HOME })
  check('⑤ 写白名单字段并读回', w.ok === true && w.config.enabled === true && w.config.maxFails === 5 && w.config.windowMs === 1234)
  const clamp = domain.writeRuntimeGuardConfig({ maxFails: 1, windowMs: -1 }, { home: HOME })
  check('⑤ 坏值被夹到合法区间', clamp.config.maxFails === 3 && clamp.config.windowMs >= 1000, JSON.stringify(clamp.config))
}

// ── ⑥ 事件循环采样 ──────────────────────────────────────────────────────────────
{
  const base = { maxDriftMs: 0, lastDriftAt: null, stalls: 0, samples: 0, startedAt: 1 }
  const a = domain.sampleEventLoop(base, 40, 10)
  check('⑥ 40ms 不记卡顿', a.stalls === 0 && a.samples === 1 && a.maxDriftMs === 0, JSON.stringify(a))
  const b = domain.sampleEventLoop(a, 600, 20)
  check('⑥ 600ms 记一次且 max=600', b.stalls === 1 && b.maxDriftMs === 600 && b.lastDriftAt === 20, JSON.stringify(b))
}

// ── ⑦ 路由 ──────────────────────────────────────────────────────────────────────
{
  const rc = { ctx: {}, body: { url: 'wss://route.test/ingest', source: 'https://x/plugins/@fake/demo/client.js:3', count: 4, windowMs: 30000 }, deps: {} }
  const res = fakeRes()
  await routeRuntimeHealth({}, res, rc)
  check('⑦ report 200 且归因 owner', res.captured.status === 200 && res.captured.json?.ok === true && res.captured.json?.incident?.owner === '@fake/demo', JSON.stringify(res.captured.json))
  const badRes = fakeRes()
  await routeRuntimeHealth({}, badRes, { ctx: {}, body: { url: 'http://bad/x' }, deps: {} })
  check('⑦ 非法 url 400', badRes.captured.status === 400 && /ws:\/\//u.test(String(badRes.captured.json?.error)), JSON.stringify(badRes.captured.json))
  const cfgRes = fakeRes()
  await routeRuntimeHealth({}, cfgRes, { ctx: {}, body: { action: 'config', enabled: true }, deps: {} })
  check('⑦ config 200 并回配置', cfgRes.captured.status === 200 && cfgRes.captured.json?.config?.enabled === true, JSON.stringify(cfgRes.captured.json?.config))
  const clearRes = fakeRes()
  await routeRuntimeHealth({}, clearRes, { ctx: {}, body: { action: 'clear' }, deps: {} })
  check('⑦ clear 200 且 removed>0', clearRes.captured.status === 200 && (clearRes.captured.json?.removed ?? 0) > 0, JSON.stringify(clearRes.captured.json))
  const pollRes = fakeRes()
  await routeRuntimeHealth({}, pollRes, { ctx: {}, body: { kind: 'polling-storm', source: 'https://x/plugins/@fake/demo/client.js:3', count: 300, detail: { delayMs: 50 } }, deps: {} })
  check('⑦ 轮询 report 200 且归因 owner', pollRes.captured.status === 200 && pollRes.captured.json?.incident?.owner === '@fake/demo' && pollRes.captured.json?.incident?.kind === 'polling-storm', JSON.stringify(pollRes.captured.json))
  const pollBad = fakeRes()
  await routeRuntimeHealth({}, pollBad, { ctx: {}, body: { kind: 'polling-storm', count: 300 }, deps: {} })
  check('⑦ 轮询缺 source 400', pollBad.captured.status === 400, JSON.stringify(pollBad.captured.json))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
