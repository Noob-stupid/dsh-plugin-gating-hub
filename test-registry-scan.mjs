// 软件源扫描接口验证（独立于运行中的服务）：桩 ctx 驱动真实路由处理逻辑。
// 隔离 DSH_HOME（.testdir/scan-home），配置两个真实源 + 一个不可达源：
//   1) 结构：ok / results 每条 id,name,url,primary,ok,ms
//   2) 不可达源：ok=false 且带 error（不抛异常，整体不 500）
//   3) 可达源：latest 为语义化版本、versions 计数、延迟为正（DSH_TEST_SKIP_NETWORK=1 时跳过网络断言）
//   4) 非 POST 方法：405（写接口门禁）
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'scan-home')
await mkdir(HOME, { recursive: true })
await writeFile(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
  registries: [
    { id: 'npmmirror', name: 'npmmirror（国内镜像）', url: 'https://registry.npmmirror.com', primary: true },
    { id: 'npmjs', name: 'npmjs（官方源）', url: 'https://registry.npmjs.org', primary: false },
    { id: 'dead', name: '不可达源', url: 'http://127.0.0.1:59998', primary: false },
  ],
}, null, 2), 'utf8')
process.env.DSH_HOME = HOME

// DSH_HOME 必须在 import 之前设置：SOURCES_FILE 是模块顶层常量
const mod = await import('./lib/index.js')

const ctx = {
  baseUrl: 'file:///' + HOME.replace(/\\/gu, '/'),
  loader: { entries: () => [] },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { fn() },
}
mod.apply(ctx)
const route = globalThis.__route
if (!route || route.path !== '/plugin-console') throw new Error('route not registered')

function fakeReq(method, pathname, body) {
  return {
    method,
    url: pathname,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    signal: { aborted: false, addEventListener: () => {} },
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
}
function fakeRes() {
  const res = { status: 0, body: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (payload) => { res.body = payload }
  return res
}
async function call(method, path, body) {
  const res = fakeRes()
  await route.handler(fakeReq(method, path, body), res)
  return { status: res.status, json: res.body === null || res.body === undefined ? null : JSON.parse(res.body) }
}

let failed = 0
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

let r = await call('POST', '/plugin-console/registry-scan', {})
check('scan 200', r.status === 200, `status=${r.status}`)
check('scan ok', r.json?.ok === true, JSON.stringify(r.json).slice(0, 120))
const results = Array.isArray(r.json?.results) ? r.json.results : []
check('results count matches config', results.length === 3, `count=${results.length}`)
check('primary flag preserved', results.find((x) => x.id === 'npmmirror')?.primary === true)
check('result shape', results.every((x) => typeof x.id === 'string' && typeof x.name === 'string' && typeof x.url === 'string' && typeof x.ok === 'boolean' && Number.isInteger(x.ms)))

const dead = results.find((x) => x.id === 'dead')
check('unreachable source flagged', dead?.ok === false && typeof dead?.error === 'string' && dead.error !== '', JSON.stringify(dead))
check('unreachable still measured latency', typeof dead?.ms === 'number' && dead.ms >= 0, String(dead?.ms))

const reachable = results.filter((x) => x.ok === true)
if (process.env.DSH_TEST_SKIP_NETWORK === '1') {
  console.log('SKIP 网络断言 — DSH_TEST_SKIP_NETWORK=1（CI 模式）')
} else {
  check('at least one reachable source', reachable.length >= 1, `reachable=${reachable.length}`)
  check('latest is semver', reachable.every((x) => typeof x.latest === 'string' && /^\d+\.\d+\.\d+/u.test(x.latest)), JSON.stringify(reachable.map((x) => [x.id, x.latest])))
  check('latency positive', reachable.every((x) => Number.isInteger(x.ms) && x.ms > 0), JSON.stringify(reachable.map((x) => [x.id, x.ms])))
  check('versions counted', reachable.every((x) => Number.isInteger(x.versions) && x.versions > 0), JSON.stringify(reachable.map((x) => [x.id, x.versions])))
}

r = await call('GET', '/plugin-console/registry-scan')
check('GET rejected 405', r.status === 405, `status=${r.status}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
