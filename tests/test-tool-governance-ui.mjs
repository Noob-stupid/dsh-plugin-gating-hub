import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

const makeReact = () => {
  let hooks = []
  let cursor = 0
  let current = null
  let rerender = null
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
        if (rerender !== null) rerender()
      }
      return [hooks[index], set]
    },
    useRef: (initial) => { const index = cursor; cursor += 1; if (hooks[index] === undefined) hooks[index] = { current: initial }; return hooks[index] },
    useEffect: () => {}, useMemo: (fn) => fn(), useCallback: (fn) => fn, useReducer: (r, i) => [i, () => {}],
  }
  react.__setCurrent = (fn) => { current = fn }
  react.__reset = () => { hooks = []; cursor = 0 }
  react.__render = () => { cursor = 0; return current() }
  react.__setRerender = (fn) => { rerender = fn }
  return react
}

const flatten = (node, out = { texts: [], buttons: [], nodes: [] }) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (typeof node.type === 'function') return flatten(node.type(node.props), out)
  const record = { tag: String(node.type), props: node.props ?? {}, disabled: node.props?.disabled === true }
  out.nodes.push(record)
  if (node.type === 'button') out.buttons.push(record)
  flatten(node.props?.children, out)
  return out
}

const t = (key) => key === 'toolGovernLabel' ? '[tool govern]' : key
const state = {
  ok: true,
  enabled: true,
  status: 'running',
  error: null,
  conflicts: [],
  conflictCount: 0,
  config: { enabled: true, maxActiveTools: 12, baselineTools: [], pinnedTools: [], hiddenTools: [], optimizeDescriptions: true },
  catalogCount: 42,
  summary: { totalEvents: 10, toolCalls: 5, unknownCalls: 0, inactiveCalls: 1, failedCalls: 1, avgDurationMs: 12, lastSchemaBytes: 2048, lastActiveCount: 10 },
  agents: [],
}

function installHost() {
  const fetchLog = []
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    fetchLog.push({ path: String(path), body, method: options?.method ?? 'GET' })
    const reply = (data) => ({ ok: true, status: 200, json: async () => data })
    if (path === '/plugin-console/tool-governance/state') return reply(state)
    if (path === '/plugin-console/tool-governance/config') return reply({ ...state, enabled: body.enabled, config: { ...state.config, ...body } })
    return reply({ ok: true })
  }
  globalThis.localStorage = { getItem: (key) => (String(key).includes('toolbar-open') ? '1' : ''), setItem: () => {}, removeItem: () => {} }
  globalThis.window = {
    __ModuleLoader__: { load: () => {} },
    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0, location: { reload: () => {} }, innerWidth: 1280, innerHeight: 800,
  }
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }), head: { appendChild: () => {} } }
  return fetchLog
}

async function loadClient(cacheKey) {
  const react = makeReact()
  let exports = null
  globalThis.window.__ModuleLoader__.load = ({ factory }) => {
    exports = factory((name) => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`) })
  }
  await import(`${pathToFileURL(join(REPO, 'lib', 'client.js')).href}?${cacheKey}`)
  return { react, exports }
}

function mount(react, exports, component) {
  let tree = null
  react.__reset()
  react.__setRerender(() => { tree = react.__render() })
  react.__setCurrent(() => component({ t }))
  tree = react.__render()
  return {
    view: () => flatten(tree),
    click: (label) => {
      const button = flatten(tree).buttons.find((item) => String(item.props?.children ?? '') === label)
      if (button === undefined) throw new Error(`missing button ${label}`)
      button.props.onClick()
      return flatten(tree)
    },
  }
}

const fetchLog = installHost()
const client = await loadClient('tool-governance-ui')
const ctx = {
  effect: (fn) => { try { fn() } catch {} return () => {} },
  locale: { register: () => {}, bind: () => t },
  slots: { inject: () => {}, register: () => {} },
  logger: { debug: () => {} },
}
client.exports.apply(ctx)

await checkAsync('① 功能包菜单显示 [tool govern]，默认开启', async () => {
  const panel = mount(client.react, client.exports, client.exports.PluginConsoleTab)
  assert.ok(panel.view().buttons.some((button) => String(button.props?.children ?? '') === '[tool govern] ✓'))
})

await checkAsync('② 点击 [tool govern] 真的发送停用配置', async () => {
  const panel = mount(client.react, client.exports, client.exports.PluginConsoleTab)
  panel.click('[tool govern] ✓')
  await new Promise((resolve) => setImmediate(resolve))
  const call = fetchLog.find((item) => item.path === '/plugin-console/tool-governance/config')
  assert.ok(call, '没有调用工具治理配置路由')
  assert.deepEqual(call.body, { enabled: false })
})

await checkAsync('③ 原生配置区渲染设置并真的保存', async () => {
  const panel = mount(client.react, client.exports, client.exports.ToolGovernanceSection)
  const flat = panel.view()
  assert.ok(flat.texts.includes('[tool govern]'))
  assert.ok(flat.texts.includes('toolGovernSchemaTitle'))
  assert.ok(flat.texts.includes('toolGovernCompositeTitle'))
  assert.ok(flat.nodes.some((node) => node.tag === 'input' && node.props.type === 'number'))
  assert.ok(flat.nodes.some((node) => node.tag === 'textarea'))
  panel.click('toolGovernSave')
  await new Promise((resolve) => setImmediate(resolve))
  const call = [...fetchLog].reverse().find((item) => item.path === '/plugin-console/tool-governance/config')
  assert.ok(call, '保存按钮没有调用配置路由')
  assert.deepEqual(call.body, {
    enabled: true,
    maxActiveTools: 12,
    hiddenTools: [],
    pinnedTools: [],
    optimizeDescriptions: true,
  })
})

console.log(`\n${passed} passed`)
process.exit(process.exitCode ?? 0)
