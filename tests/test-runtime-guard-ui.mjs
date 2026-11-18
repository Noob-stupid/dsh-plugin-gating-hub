// 客户端 WebSocket 空转哨兵（0.5.111 加法）
//
// 钉住：
//   ① 守卫装好、WebSocket 被替换，同源 URL 永远直连；
//   ② 「运行模式 = observer」时，同一非同源 URL 失败达到阈值 → 熔断，下一次返回不触网的占位 socket；
//   ③ 「运行模式 = managed」时只记录、不熔断（第 21 次仍是真实 socket）；
//   ④ 熔断事件上报 /runtime-health，body 含 url/count/windowMs/source；
//   ⑤ clear() 解除熔断后可重新直连；调试覆盖 enabled=false 也不熔断。
//
// 全离线：假 window / 假 WebSocket / 假 fetch；不启动浏览器。
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

class FakeWS extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  constructor(url, protocols) {
    super()
    this.url = String(url)
    this.protocols = protocols
    this.readyState = FakeWS.CONNECTING
    this.sent = []
    FakeWS.instances.push(this)
  }
  send(value) { this.sent.push(value) }
  close() { this.readyState = FakeWS.CLOSED }
  fail() {
    this.readyState = FakeWS.CLOSED
    this.dispatchEvent(new Event('error'))
    this.dispatchEvent(new Event('close'))
  }
  open() {
    this.readyState = FakeWS.OPEN
    this.dispatchEvent(new Event('open'))
  }
}
FakeWS.instances = []

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
}
const fetchCalls = []
function makeFetch() {
  return (url, options = {}) => {
    fetchCalls.push({ url: String(url), options })
    if (String(url).includes('/runtime-guard')) return Promise.resolve({ ok: false, json: async () => null })
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
  }
}
function fakeWindow() {
  return {
    __ModuleLoader__: { load: ({ factory }) => { globalThis.__guardExports = factory((name) => { if (name === 'react') return fakeReact; throw new Error(`unexpected require: ${name}`) }) } },
    location: { href: 'http://127.0.0.1:3080/plugins/@noob-stupid/dsh-plugin-console/client.js', host: '127.0.0.1:3080', hostname: '127.0.0.1', port: '3080' },
    WebSocket: FakeWS,
    fetch: makeFetch(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
  }
}

const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalFetch = globalThis.fetch
let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.stack ?? error}`); process.exitCode = 1 }
}
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.stack ?? error}`); process.exitCode = 1 }
}

try {
  globalThis.window = fakeWindow()
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }), head: { appendChild: () => {} } }
  globalThis.fetch = globalThis.window.fetch
  FakeWS.instances.length = 0
  fetchCalls.length = 0
  await import(`${pathToFileURL(join(REPO, 'lib', 'client.js')).href}?guard-test=${Date.now()}`)
  // 让启动时的 /runtime-guard 请求走完（返回 ok:false，模式保持未知）
  await new Promise((resolve) => setImmediate(resolve))

  const guard = globalThis.window.__dshPcRuntimeGuard
  check('① 守卫已安装且替换了 WebSocket', () => guard !== undefined && globalThis.window.WebSocket !== FakeWS)
  check('① 默认模式未知 → active=false', () => guard.status().active === false && guard.status().mode === null)

  // ② 同源 URL 永远直连（即使失败 100 次）
  check('② 同源 URL 直连、不参与统计', () => {
    const before = FakeWS.instances.length
    for (let i = 0; i < 100; i += 1) {
      const ws = new globalThis.window.WebSocket('ws://127.0.0.1:3080/ingest')
      ws.fail()
    }
    return FakeWS.instances.length === before + 100 && guard.status().urls.every((x) => !x.url.includes('3080'))
  })

  // ③ managed：只记录、不熔断
  await checkAsync('③ managed 模式：达到阈值也不熔断（第 21 次仍是真实 socket）', async () => {
    guard.clear()
    guard.setMode('managed')
    FakeWS.instances.length = 0
    fetchCalls.length = 0
    for (let i = 0; i < 20; i += 1) new globalThis.window.WebSocket('ws://127.0.0.1:9230/ingest').fail()
    const before = FakeWS.instances.length
    const next = new globalThis.window.WebSocket('ws://127.0.0.1:9230/ingest')
    assert.equal(next instanceof FakeWS, true, 'managed 下不应返回占位 socket')
    assert.equal(FakeWS.instances.length, before + 1)
    assert.equal(guard.status().tripped.length, 0)
    const reports = fetchCalls.filter((c) => c.url.includes('/runtime-health'))
    assert.equal(reports.length >= 1, true, 'managed 也要记录（上报）')
    const body = JSON.parse(reports[0].options.body)
    assert.equal(body.url, 'ws://127.0.0.1:9230/ingest')
    assert.equal(body.count >= 20, true)
    assert.equal(body.windowMs > 0, true)
    assert.equal(typeof body.source, 'string')
    next.fail()
  })

  // ④ observer：熔断
  await checkAsync('④ observer 模式：20 次后熔断，第 21 次返回占位 socket', async () => {
    guard.clear()
    guard.setMode('observer')
    FakeWS.instances.length = 0
    fetchCalls.length = 0
    for (let i = 0; i < 20; i += 1) new globalThis.window.WebSocket('ws://127.0.0.1:9230/ingest').fail()
    const before = FakeWS.instances.length
    const stub = new globalThis.window.WebSocket('ws://127.0.0.1:9230/ingest')
    assert.equal(FakeWS.instances.length, before, '熔断后不应再构造真实 socket')
    assert.equal(stub.readyState, 3)
    assert.equal(typeof stub.send, 'function')
    assert.equal(guard.status().tripped.length, 1)
    const reports = fetchCalls.filter((c) => c.url.includes('/runtime-health'))
    assert.equal(reports.length >= 1, true)
    const body = JSON.parse(reports[0].options.body)
    assert.equal(body.source.includes('client') || body.source.includes('test-runtime'), true, String(body.source))
  })

  // ⑤ clear 后恢复直连
  await checkAsync('⑤ clear() 解除熔断后重新直连', async () => {
    guard.clear()
    const before = FakeWS.instances.length
    const ws = new globalThis.window.WebSocket('ws://127.0.0.1:9230/ingest')
    assert.equal(ws instanceof FakeWS, true)
    assert.equal(FakeWS.instances.length, before + 1)
  })

  // ⑥ 调试覆盖 enabled=true：managed 下也强制熔断（仅调试用；面板不提供这个开关）
  await checkAsync('⑥ 调试覆盖 enabled=true 时 managed 也强制熔断', async () => {
    guard.clear()
    guard.setMode('managed')
    guard.setEnabled(true)
    FakeWS.instances.length = 0
    for (let i = 0; i < 20; i += 1) new globalThis.window.WebSocket('ws://127.0.0.1:9231/ingest').fail()
    const before = FakeWS.instances.length
    const ws = new globalThis.window.WebSocket('ws://127.0.0.1:9231/ingest')
    assert.equal(ws instanceof FakeWS, false)
    assert.equal(FakeWS.instances.length, before)
    guard.setEnabled(false)
  })
} finally {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  globalThis.fetch = originalFetch
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
