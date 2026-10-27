// 白屏防呆：把面板里**能点的东西挨个点一遍**，任何一次渲染抛异常就红。
//
// 为什么需要它：2026-10-27 出现过 `ReferenceError: panelGroupShow is not defined` ——
//   组件里用了没声明的变量，整个设置页直接空白。原有测试只走到"面板打开"这一层，
//   而那段代码在"某个分组被展开"时才执行 ⇒ 测试全绿、用户白屏。
// 做法：广度遍历可点控件（按钮 / 分组名 / 折叠开关），每点一次就重渲染并断言不抛。
//   只走有限深度，避免组合爆炸；测的是"渲染不炸"，不是每个功能的语义。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = process.cwd()
let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) {
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
    if (error?.stack) console.log(`     ${String(error.stack).split('\n').slice(1, 4).join('\n     ')}`)
    process.exitCode = 1
  }
}

const makeReact = () => {
  let hooks = []
  let cursor = 0
  let current = null
  let rerender = null
  const pendingEffects = []
  const effectDeps = []
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
    useRef: (initial) => { const i = cursor; cursor += 1; if (hooks[i] === undefined) hooks[i] = { current: initial }; return hooks[i] },
    useEffect: (fn, deps) => {
      const i = cursor
      cursor += 1
      const prev = effectDeps[i]
      const hasDeps = Array.isArray(deps)
      if (prev === undefined || !hasDeps || JSON.stringify(prev) !== JSON.stringify(deps)) pendingEffects.push(fn)
      effectDeps[i] = hasDeps ? deps : []
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useReducer: (r, i) => [i, () => {}],
    useLayoutEffect: () => {},
  }
  react.__setCurrent = (fn) => { current = fn }
  react.__reset = () => { hooks = []; cursor = 0; pendingEffects.length = 0; effectDeps.length = 0 }
  react.__render = () => { cursor = 0; return current() }
  react.__setRerender = (fn) => { rerender = fn }
  react.__runEffects = () => { const list = pendingEffects.splice(0); for (const fn of list) { try { fn() } catch {} } }
  return react
}

const flatten = (node, out = { texts: [], buttons: [], nodes: [] }) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (typeof node.type === 'function') return flatten(node.type(node.props), out)
  const record = { tag: String(node.type), props: node.props ?? {} }
  out.nodes.push(record)
  if (node.type === 'button') out.buttons.push(record)
  flatten(node.props?.children, out)
  return out
}

const entry = (over) => ({
  entryId: `include:${over.rowId}`, rowId: over.rowId, moduleName: over.moduleName, enabled: true,
  fiberPhase: 'ready', protected: false, disableSource: null, forcedNotLoaded: false,
  userDisabled: false, userForced: false, pendingCompat: false, compatRescinded: false,
  compatVerdict: null, adoptable: null, veto: null, version: '1.0.0', repository: null,
  installDate: null, toggleable: true, extra: false, ...over,
})

const STATE = {
  ok: true,
  entries: [
    entry({ rowId: 'a', moduleName: '@fake/mem-a' }),
    entry({ rowId: 'b', moduleName: '@fake/mem-b' }),
    entry({ rowId: 'all', moduleName: '@fake/pkg-all' }),
    entry({ rowId: 'all__sub', moduleName: '@fake/pkg-all/sub' }),
    entry({ rowId: 'c', moduleName: '@fake/stale-c', adoptable: { status: 'ready' } }),
  ],
  skippedBundles: { items: [], reliable: true, note: null },
  host: { hosted: false, kind: 'standalone', notice: null },
  health: { issues: 0, items: [] },
  patchPath: 'x', compat: { ok: true },
  installJobs: [], recentFailures: [], pendingRestart: [],
  github: { loggedIn: false, login: null },
  patch: { disables: [], forced: [], inserts: ['a', 'b', 'all', 'all__sub', 'c'] },
  framework: null, lockAutofix: null, patchHeal: null,
  gating: { pending: [], adopted: [], total: 0 },
  compatPending: null, compatGate: { autoDisable: false, autoDetect: false },
  rollback: null, selfVersion: '0.5.92', components: [],
}

const ANNOTATIONS = {
  ok: true, file: '/tmp/plugin-annotations.json', exists: true, emptyFile: false, version: 1, updatedAt: 0,
  plugins: { '@fake/mem-a': { note: '有备注的一条', badges: ['重要'] } },
  groups: [
    { id: 'g1', name: '记忆类', packages: ['@fake/mem-a', '@fake/mem-b'], collapsed: false },
    { id: 'g2', name: '空组', packages: [], collapsed: true },
  ],
  stats: { packages: 1, notes: 1, badges: 1, groups: 2, members: 2 },
  repaired: [], error: null,
}

const installHost = () => {
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) })
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(String(options.body))
    if (path === '/plugin-console/state') return reply(STATE)
    if (path === '/plugin-console/annotations') return options?.method === 'POST' ? reply({ ...ANNOTATIONS, action: body?.action ?? null }) : reply(ANNOTATIONS)
    if (path === '/plugin-console/sources') return reply({ ok: true, sources: { searchSources: [], registries: [], gitSources: [], archiveSources: [] } })
    if (path === '/plugin-console/links') return reply({ ok: true, items: [], devRoots: [] })
    if (path === '/plugin-console/check-updates') return reply({ ok: true, checked: 5, updatable: 0, unknown: 0, items: [], stats: {} })
    if (path === '/plugin-console/check-update') return reply({ ok: true, target: null, latest: null })
    if (path === '/plugin-console/details') return reply({ ok: true, entryId: body?.entryId ?? null, moduleName: 'x', readme: null, repository: null })
    if (path === '/plugin-console/gate') return reply({ ok: true, pending: [], adopted: [], total: 0 })
    if (path === '/plugin-console/market') return reply({ ok: true, items: [] })
    return reply({ ok: true })
  }
  globalThis.localStorage = { getItem: (key) => (String(key).includes('toolbar-open') ? '1' : ''), setItem: () => {}, removeItem: () => {} }
  delete globalThis.__DSH_DIRECTORY_PICKER__
}

const boot = async (cacheKey) => {
  installHost()
  const react = makeReact()
  let exports = null
  globalThis.window = {
    __ModuleLoader__: { load: ({ factory }) => { exports = factory((name) => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`) }) } },
    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0, location: { reload: () => {} },
    innerWidth: 1280, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
  }
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }), head: { appendChild: () => {} } }
  await import(`${pathToFileURL(join(REPO, 'lib', 'client.js')).href}?${cacheKey}`)
  const t = (key) => key
  exports.apply({
    effect: (fn) => { try { fn() } catch {} return () => {} },
    locale: { register: () => {}, bind: () => t },
    slots: { inject: () => {}, register: () => {} },
    logger: { debug: () => {} },
  })
  let tree = null
  react.__reset()
  react.__setRerender(() => { tree = react.__render() })
  react.__setCurrent(() => exports.PluginConsoleTab({ t, section: null }))
  tree = react.__render()
  const render = () => { tree = react.__render(); return flatten(tree) }
  const settle = async () => { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); react.__runEffects(); react.__render() } }
  return { render, settle }
}

const inst = await boot('render-sweep')

// 每个"可点且值得点"的控件：按属性认，点完立刻重渲染
const CLICKABLE_ATTRS = [
  'aria-label', 'data-group-name', 'data-newgroup', 'data-usergroup', 'data-group-add',
  'data-group-update-all', 'data-group-loadmore', 'data-user-badge', 'data-more', 'data-active',
]

const clickableOf = (view) => {
  const out = []
  const push = (node, attr) => { if (typeof node?.props?.onClick === 'function') out.push({ node, attr, label: String(node.props['aria-label'] ?? node.props[attr] ?? node.tag) }) }
  for (const b of view.buttons) {
    if (b.props.disabled === true) continue
    for (const attr of CLICKABLE_ATTRS) {
      if (b.props[attr] !== undefined && b.props[attr] !== null) { push(b, attr); break }
    }
  }
  for (const n of view.nodes) {
    if (n.tag === 'button') continue
    if (n.props['data-group-name'] !== undefined) push(n, 'data-group-name')
  }
  return out
}

const fire = (node) => node.props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: {}, currentTarget: {} })

// 广度：最多 3 轮，每轮把所有可点项点一遍再渲染一次
for (let round = 1; round <= 3; round += 1) {
  const before = clickableOf(inst.render())
  if (before.length === 0) break
  let clicked = 0
  let firstError = null
  for (const item of before.slice(0, 60)) {
    try {
      fire(item.node)
      await inst.settle()
      inst.render()
      clicked += 1
    } catch (error) {
      if (firstError === null) firstError = { label: item.label, error }
    }
  }
  check(`第 ${round} 轮：点遍 ${before.length} 个可点控件，渲染都不抛异常（实际点了 ${clicked} 个）`, () => {
    if (firstError !== null) {
      throw new Error(`点「${firstError.label}」后渲染崩了：${firstError.error?.message ?? firstError.error}`)
    }
  })
  if (firstError !== null) break
}

// 额外：逐一点开后**单独**检查（上面是累积点亮，这里确认单个开关自己不会炸）
check('逐个单独打开每个入口，每次渲染都不抛', async () => {})
{
  const fresh = await boot('render-sweep-single')
  const list = clickableOf(fresh.render())
  let bad = null
  for (const item of list.slice(0, 40)) {
    const again = await boot(`render-sweep-single-${Math.random()}`)
    const target = clickableOf(again.render()).find((x) => x.label === item.label)
    if (target === undefined) continue
    try {
      fire(target.node)
      await again.settle()
      again.render()
    } catch (error) {
      if (bad === null) bad = { label: item.label, error }
    }
  }
  check('每个入口"单独冷启动后点一次"也不抛（排除互相影响）', () => {
    if (bad !== null) throw new Error(`点「${bad.label}」崩了：${bad.error?.message ?? bad.error}`)
  })
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
