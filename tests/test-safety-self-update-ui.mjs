// 「自更新／立即检查」两颗按钮**位置调整**的钉子（用户 2026-11-05 原话：
//   「然后自更新和立即检测，可移除功能包，将位置放在这（红笔在『AI 部署』之后）」，
//   并已确认：**从功能包移走，只在安全面板这排末尾出现**）。
//
// 背景：这两颗按钮原来长在「功能包」工具栏里（`PluginConsoleTab`），用户要求搬到
// 「升级安全」面板那一排跳转按钮的末尾。搬的时候**业务能力一行都不许丢**，所以本套钉的是：
//
//   ① 负控：功能包工具栏里**不再**有这两颗（静态区段 + 假 React 真渲染两道）。
//   ② 位置：安全面板跳转行里**有**这两颗，紧挨在「AI 部署」之后，且与同排按钮**同一个
//      className**（不引入新样式体系）。
//   ③ 点「自更新」⇒ 真的 `POST /plugin-console/self-auto-update {action:'toggle', enabled:<下一值>}`，
//      成功后按**服务端回读**翻转（开=带 ✓）。
//   ④ 点「立即检查」⇒ `{action:'check'}`，并把服务端给的结论原话显示出来。
//   ⑤ 请求期间 `disabled` + 进行中提示（不许"点了没反应"）；失败把服务端错误原文念出来（不许静默）。
//   ⑥ `/state.selfAutoUpdate` 缺失 ⇒ 按**开启**显示、时间/结果都是「—」、**一个写请求都不发**（不编造、不自作主张写回）。
//   ⑦ 整个 `PluginSafetyTab` 渲染一遍不抛错（本仓因"hooks 漏声明"整页白屏过两次）。
//
// 手法与 tests/test-safe-boot-ui.mjs 完全一致：假 React **真渲染**（hooks 真重渲染）+ 桩 fetch 记录每次请求
// + 按钮真点。**本套没有任何浏览器** —— 它证明的是行为接线，不是观感。
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SRC = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

// ── 假 React（hooks 真的能重渲染；useEffect 按依赖比较，没 deps 的只跑一次）──────────────────
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
    useRef: (initial) => { const index = cursor; cursor += 1; if (hooks[index] === undefined) hooks[index] = { current: initial }; return hooks[index] },
    useEffect: (fn, deps) => {
      const index = cursor
      cursor += 1
      const prev = effectDeps[index]
      const hasDeps = Array.isArray(deps)
      const changed = prev === undefined || !hasDeps || JSON.stringify(prev) !== JSON.stringify(deps)
      effectDeps[index] = hasDeps ? deps : []
      if (changed && pendingEffects.length < 400) pendingEffects.push(fn)
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

/** 折成可断言的树（保留节点顺序；函数组件就地展开）。 */
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

// ── 夹具 ─────────────────────────────────────────────────────────────────────
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

const entry = (over) => ({
  entryId: `include:${over.rowId}`, rowId: over.rowId, moduleName: over.moduleName, enabled: true, extra: true,
  fiberPhase: 'ready', protected: false, disableSource: null, forcedNotLoaded: false, userDisabled: false,
  userForced: false, pendingCompat: false, compatRescinded: false, compatVerdict: null, adoptable: null,
  veto: null, version: '1.0.0', repository: null, installDate: null, toggleable: true,
  ...over,
})
/** `/state` 夹具（主面板渲染用，与 tests/test-safe-boot-ui.mjs 同一份形状）。 */
const STATE = {
  ok: true,
  entries: [entry({ rowId: 'mem', moduleName: '@openviking/dsh-memory-plugin' })],
  skippedBundles: { items: [], reliable: true, note: null },
  host: { hosted: false, kind: 'standalone', notice: null },
  health: { issues: 0, items: [] },
  patchPath: 'C:/dsh-home/profile/cordis.patch.yml', compat: { ok: true, supported: true, noticeVisible: false },
  installJobs: [], recentFailures: [], pendingRestart: [],
  github: { loggedIn: false, login: null },
  patch: { disables: [], forced: [], inserts: ['mem'] },
  framework: null, lockAutofix: null, patchHeal: null,
  gating: { pending: [], adopted: [], pendingCount: 0, adoptedCount: 0, total: 0 },
  compatPending: null, compatGate: { autoDisable: false, autoDetect: false },
  rollback: null, selfVersion: '0.5.109', components: [],
}
/** 「上次检查」用一份固定时刻（断言的是"服务端有值就照念"，不是格式化细节）。 */
const LAST_AT = Date.UTC(2026, 10, 4, 9, 41, 5)
const SELF_ON = { enabled: true, intervalHours: 6, lastCheckAt: LAST_AT, lastResult: { skipped: 'up-to-date', ok: true, reason: '已是最新' }, currentVersion: '0.5.109' }
const SELF_OFF = { ...SELF_ON, enabled: false }
/** 安全面板其它接口的空回复（本套只关心自更新那一段）。 */
const COMPAT_STATUS = { ok: true, mode: 'observer', fingerprint: { changed: false, reasons: [] }, rollback: { applicable: false, from: null, to: null, reason: null }, frameworkVersion: '0.2.1-rc.2' }

/**
 * 起一个实例。
 * @param {object} o
 * @param {'safety'|'console'} o.target 渲染哪个组件（PluginSafetyTab / PluginConsoleTab）
 * @param {any} o.stateBody 安全面板场景下 `/plugin-console/state` 的回复体
 * @param {(ctx: {body: any, count: number}) => any} [o.selfUpdate] `/self-auto-update` 怎么答（返回值 = 响应体；抛错 = 网络层错误）
 */
async function boot(o) {
  const { target, stateBody, selfUpdate, cacheKey } = o
  const fetchLog = []
  let selfUpdateCount = 0
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    const method = options?.method ?? 'GET'
    fetchLog.push({ path: String(path), body, method })
    if (path === '/plugin-console/state') return reply(target === 'safety' ? stateBody : STATE)
    if (path === '/plugin-console/self-auto-update') {
      selfUpdateCount += 1
      // ★ 防"渲染里发请求"的实现把本套拖成死循环：真实行为是点一次一条请求，超过 24 次说明
      //   面板在渲染路径里反复发请求 —— 这时**永不给响应**（异步链停在这里，事件循环才走得动），
      //   紧接着的请求数断言自然变红：是断言失败，不是挂死。
      if (selfUpdateCount > 24) return new Promise(() => {})
      return selfUpdate({ body, count: selfUpdateCount })
    }
    if (path === '/plugin-console/links') return reply({ ok: true, count: 0, readyCount: 0, items: [] })
    if (path === '/plugin-console/dev-roots') return reply({ ok: true, roots: [] })
    if (path === '/plugin-console/compat-status') return reply(COMPAT_STATUS)
    if (path === '/plugin-console/declare-installed') return reply({ ok: true, count: 0, note: null })
    if (path === '/plugin-console/annotations' && body === null) return reply({ ok: true, exists: false, plugins: {}, groups: [], stats: {}, repaired: [], error: null })
    if (path === '/plugin-console/sources') return reply({ ok: true, sources: { registries: [], gitSources: [], archiveSources: [], searchSources: [], primary: null } })
    if (path === '/plugin-console/check-updates') return reply({ ok: true, checked: 0, updatable: 0, unknown: 0, items: [], stats: {} })
    return reply({ ok: true })
  }
  globalThis.localStorage = { getItem: (key) => (String(key).includes('toolbar-open') ? '1' : ''), setItem: () => {}, removeItem: () => {} }
  delete globalThis.__DSH_DIRECTORY_PICKER__
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
  react.__setCurrent(() => (target === 'safety' ? exports.PluginSafetyTab({ t }) : exports.PluginConsoleTab({ t, section: null })))
  tree = react.__render()
  const view = () => flatten(tree)
  const rerender = () => { react.__runEffects(); tree = react.__render(); return flatten(tree) }
  const settle = async (times = 12) => {
    for (let i = 0; i < times; i += 1) { await new Promise((resolve) => setImmediate(resolve)); rerender() }
  }
  const waitUntil = async (predicate, label, rounds = 80) => {
    for (let i = 0; i < rounds; i += 1) {
      if (predicate()) return true
      await new Promise((resolve) => setImmediate(resolve))
      rerender()
    }
    throw new Error(`等待超时：${label}；按钮=${view().buttons.map((b) => String(b.props?.['aria-label'] ?? b.props?.children ?? '')).slice(0, 40).join(' | ')}；请求=${fetchLog.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`).join(' , ')}`)
  }
  const selfUpdateCalls = () => fetchLog.filter((c) => c.path === '/plugin-console/self-auto-update')
  const aria = (label) => view().buttons.find((b) => b.props?.['aria-label'] === label)
  const btnText = (b) => flatten(b).texts.join(' ')
  const fire = (button) => button.props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, key: 'x', currentTarget: {}, target: {} })
  const clickAria = (label) => {
    const button = aria(label)
    if (button === undefined) throw new Error(`找不到 aria-label=${label} 的按钮；现有按钮：${view().buttons.map((b) => String(b.props?.['aria-label'] ?? b.props?.children ?? '')).slice(0, 40).join(' | ')}`)
    fire(button)
  }
  /** 安全面板的触发条（唯一那个带 aria-expanded 且没有 aria-label 的按钮）。 */
  const openPanel = async () => {
    const trigger = view().buttons.find((b) => b.props?.['aria-expanded'] !== undefined)
    if (trigger === undefined) throw new Error('找不到「升级安全」触发条')
    fire(trigger)
    await settle(3)
  }
  return { view, rerender, settle, waitUntil, fetchLog, selfUpdateCalls, aria, clickAria, btnText, fire, openPanel }
}

const between = (from, to, hay = SRC) => {
  const a = hay.indexOf(from)
  if (a < 0) return null
  const b = hay.indexOf(to, a + from.length)
  if (b < 0) return null
  return hay.slice(a, b)
}

console.log('=== ① 负控：功能包工具栏里已经没有这两颗 ===')
{
  check('① 静态：`PluginConsoleTab` 区段里再没有 selfUpdateAria / selfUpdateCheckHint / self-auto-update', () => {
    const seg = between('function PluginConsoleTab({', 'function PluginSafetyTab({')
    assert.ok(seg !== null && seg.length > 1000, '定位不到主面板区段')
    for (const needle of ['selfUpdateAria', 'selfUpdateCheckHint', 'self-auto-update']) {
      assert.equal(seg.includes(needle), false, `主面板区段里还留着 ${needle}`)
    }
  })

  const C = await boot({ target: 'console', cacheKey: 'safety-self-update-ui-console' })
  await C.settle()
  await checkAsync('①-b 假 React 真渲染功能包面板：没有任何按钮的 aria-label 是这两把键', async () => {
    const labels = C.view().buttons.map((b) => String(b.props?.['aria-label'] ?? ''))
    assert.ok(labels.length > 0, '主面板一个按钮都没渲染出来（夹具或渲染坏了）')
    assert.equal(labels.includes('selfUpdateAria'), false, `工具栏里还有「自更新」：${labels.join(' | ')}`)
    assert.equal(labels.includes('selfUpdateCheckHint'), false, `工具栏里还有「立即检查」：${labels.join(' | ')}`)
    await C.settle()
    assert.deepEqual(C.selfUpdateCalls(), [], `只是渲染主面板就发了自更新请求：${JSON.stringify(C.selfUpdateCalls())}`)
  })
}

console.log('=== ② 位置：安全面板跳转行末尾、紧跟「AI 部署」 ===')
const A = await boot({ target: 'safety', cacheKey: 'safety-self-update-ui-A', stateBody: { ok: true, selfAutoUpdate: SELF_ON }, selfUpdate: ({ body }) => reply({ ok: true, selfAutoUpdate: body?.action === 'toggle' ? (body.enabled === true ? SELF_ON : SELF_OFF) : SELF_ON, check: { skipped: 'up-to-date', ok: true }, note: null }) })
await A.settle()
await A.openPanel()

check('⑦ 整个「升级安全」面板渲染一遍不抛错（触发条 + 面板都在）', () => {
  const view = A.view()
  assert.ok(view.buttons.length >= 8, `面板按钮太少（${view.buttons.length}），可能整块没渲染出来`)
  assert.ok(view.texts.some((x) => x.includes('safetyJumpAi')), '跳转行没渲染出来')
})

await checkAsync('② 跳转行里有这两颗，且顺序在「AI 部署」之后（紧邻）', async () => {
  const buttons = A.view().buttons
  const jumpAi = buttons.findIndex((b) => A.btnText(b).includes('safetyJumpAi'))
  const on = buttons.findIndex((b) => b.props?.['aria-label'] === 'selfUpdateAria')
  const checkBtn = buttons.findIndex((b) => b.props?.['aria-label'] === 'selfUpdateCheckHint')
  assert.ok(jumpAi >= 0, `找不到「AI 部署」跳转按钮：${buttons.map((b) => A.btnText(b)).join(' | ')}`)
  assert.ok(on > jumpAi, `「自更新」不在「AI 部署」之后（jumpAi=${jumpAi}, on=${on}）`)
  assert.ok(checkBtn > on, `「立即检查」不在「自更新」之后（on=${on}, check=${checkBtn}）`)
  assert.equal(on, jumpAi + 1, `「自更新」必须紧挨「AI 部署」（jumpAi=${jumpAi}, on=${on}）`)
  assert.equal(checkBtn, jumpAi + 2, `「立即检查」必须紧跟其后（check=${checkBtn}）`)
})

check('②-b 与同排跳转按钮**同一个 className**（不引入新样式体系）', () => {
  const buttons = A.view().buttons
  const jumpMarket = buttons.find((b) => A.btnText(b).includes('safetyJumpMarket'))
  const on = A.aria('selfUpdateAria')
  const checkBtn = A.aria('selfUpdateCheckHint')
  assert.ok(jumpMarket !== undefined, '找不到同排的跳转按钮')
  assert.equal(on.props.className, jumpMarket.props.className, '「自更新」的 className 与同排不一致')
  assert.equal(checkBtn.props.className, jumpMarket.props.className, '「立即检查」的 className 与同排不一致')
})

console.log('=== ③ 点「自更新」⇒ 真的 POST toggle，成功后按服务端回读翻转 ===')
await checkAsync('③ 初始按 /state 显示为开（带 ✓），点一下发 {action:"toggle", enabled:false}', async () => {
  const before = A.aria('selfUpdateAria')
  assert.equal(before.props['data-active'], 'true', '服务端说开着，按钮却不是激活态')
  assert.ok(A.btnText(before).includes('✓'), `开着必须带 ✓：${A.btnText(before)}`)
  const idx = A.selfUpdateCalls().length
  A.clickAria('selfUpdateAria')
  await A.waitUntil(() => A.selfUpdateCalls().length > idx, 'toggle 请求')
  const call = A.selfUpdateCalls()[idx]
  assert.equal(call.method, 'POST', '必须是 POST（服务端只登记了 POST）')
  assert.deepEqual(call.body, { action: 'toggle', enabled: false }, `请求体不对：${JSON.stringify(call.body)}`)
  await A.settle(6)
})

await checkAsync('③-b 成功后状态真的翻转（按服务端回读，不拿自己的猜测冒充结果）', async () => {
  const after = A.aria('selfUpdateAria')
  assert.equal(after.props['data-active'], 'false', '服务端回了 enabled:false，按钮却还是激活态')
  assert.equal(A.btnText(after).includes('✓'), false, `关掉之后不许再显示 ✓：${A.btnText(after)}`)
  assert.ok(A.view().texts.some((x) => x.includes('selfUpdateOff')), `关掉之后必须有结果反馈：${A.view().texts.slice(-12).join(' | ')}`)
})

console.log('=== ④ 点「立即检查」⇒ {action:"check"}，并显示服务端结论 ===')
await checkAsync('④ 发 {action:"check"}，并把服务端给的结论原话显示出来', async () => {
  const idx = A.selfUpdateCalls().length
  A.clickAria('selfUpdateCheckHint')
  await A.waitUntil(() => A.selfUpdateCalls().length > idx, 'check 请求')
  const call = A.selfUpdateCalls()[idx]
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.body, { action: 'check' }, `请求体不对：${JSON.stringify(call.body)}`)
  await A.settle(6)
  assert.equal(A.selfUpdateCalls().length, idx + 1, `点一次只该发一条请求：${JSON.stringify(A.selfUpdateCalls().slice(idx))}`)
  assert.ok(A.view().texts.some((x) => x.includes('selfUpdateUpToDate')), `必须把服务端结论显示出来：${A.view().texts.slice(-12).join(' | ')}`)
})

console.log('=== ⑤ 请求期间 disabled + 进行中提示；失败念服务端原文 ===')
{
  let release = null
  const D = await boot({
    target: 'safety', cacheKey: 'safety-self-update-ui-D', stateBody: { ok: true, selfAutoUpdate: SELF_ON },
    selfUpdate: () => new Promise((resolve) => { release = () => resolve(reply({ ok: true, selfAutoUpdate: SELF_OFF, check: null, note: null })) }),
  })
  await D.settle()
  await D.openPanel()

  await checkAsync('⑤-a 点下去立刻进入进行中：两颗都 disabled，且有「进行中」提示（不许点了没反应）', async () => {
    D.clickAria('selfUpdateAria')
    // 立刻看（请求还没回来）
    const on = D.aria('selfUpdateAria')
    const checkBtn = D.aria('selfUpdateCheckHint')
    assert.equal(on.props.disabled, true, '写请求期间「自更新」必须 disabled')
    assert.equal(checkBtn.props.disabled, true, '写请求期间「立即检查」也必须 disabled（服务端单飞，别叠第二条）')
    assert.equal(on.props['data-busy'], 'true', '进行中必须标 data-busy（视觉上也看得出来）')
    assert.ok(D.btnText(on).includes('…'), `进行中按钮上要有省略号：${D.btnText(on)}`)
    assert.ok(D.view().texts.some((x) => x.includes('selfUpdateSaving')), `进行中必须有一句提示：${D.view().texts.slice(-12).join(' | ')}`)
    assert.equal(D.selfUpdateCalls().length, 1, `应当恰好 1 条请求：${JSON.stringify(D.selfUpdateCalls())}`)
  })

  await checkAsync('⑤-b 回来之后恢复可点，且显示结果', async () => {
    release()
    await D.waitUntil(() => D.aria('selfUpdateAria').props.disabled !== true, '请求返回后解除禁用')
    assert.equal(D.selfUpdateCalls().length, 1, `返回后不该再补发请求：${JSON.stringify(D.selfUpdateCalls())}`)
    assert.equal(D.aria('selfUpdateAria').props['data-active'], 'false', '服务端回了关，界面没跟上')
  })
}

{
  const E = await boot({
    target: 'safety', cacheKey: 'safety-self-update-ui-E', stateBody: { ok: true, selfAutoUpdate: SELF_ON },
    selfUpdate: () => reply({ ok: false, error: '写自更新配置失败：EACCES（C:/dsh-home/plugin-console/self-auto-update.json）' }, 500),
  })
  await E.settle()
  await E.openPanel()
  await checkAsync('⑤-c 失败 ⇒ 显示服务端错误原文（不静默、不谎报成功），按钮恢复可点', async () => {
    E.clickAria('selfUpdateAria')
    await E.waitUntil(() => E.view().texts.some((x) => x.includes('EACCES')), '错误原文')
    const texts = E.view().texts.join(' | ')
    assert.ok(texts.includes('EACCES'), `必须显示服务端给的原文：${texts.slice(-200)}`)
    assert.ok(texts.includes('safetySwitchFailed'), `失败反馈必须点名"操作失败"：${texts.slice(-200)}`)
    await E.waitUntil(() => E.aria('selfUpdateAria').props.disabled !== true, '失败返回后解除禁用（不能卡死在禁用态）')
    assert.equal(E.aria('selfUpdateAria').props['data-active'], 'true', '写失败时界面不许自己翻转成"已关闭"（那是谎报成功）')
    assert.equal(E.selfUpdateCalls().length, 1, `失败后不该自动重发：${JSON.stringify(E.selfUpdateCalls())}`)
  })
}

console.log('=== ⑥ /state.selfAutoUpdate 缺失：按开启显示、时间是「—」、零写请求 ===')
{
  const F = await boot({ target: 'safety', cacheKey: 'safety-self-update-ui-F', stateBody: { ok: true }, selfUpdate: () => reply({ ok: true }) })
  await F.settle()
  await F.openPanel()
  await checkAsync('⑥-a 字段缺失 ⇒ 按**开启**显示（带 ✓），上次检查/上次结果都是「—」（不编造）', async () => {
    const on = F.aria('selfUpdateAria')
    assert.ok(on !== undefined, '字段缺失时按钮就该没了 —— 它必须还在（按默认开启显示）')
    assert.equal(on.props['data-active'], 'true', '字段缺失要按"默认开启"显示')
    assert.ok(F.btnText(on).includes('✓'), `默认开启要带 ✓：${F.btnText(on)}`)
    const title = String(on.props.title)
    assert.ok(title.includes('selfUpdateLastCheck'), `title 里要有"上次检查"：${title}`)
    assert.ok(title.includes('selfUpdateLastResult'), `title 里要有"上次结果"：${title}`)
    assert.equal((title.match(/—/gu) ?? []).length, 2, `拿不到的时间和结果都必须显示「—」：${title}`)
    const checkTitle = String(F.aria('selfUpdateCheckHint').props.title)
    assert.equal((checkTitle.match(/—/gu) ?? []).length, 2, `「立即检查」的 title 也要如实写「—」：${checkTitle}`)
  })
  await checkAsync('⑥-b 字段缺失**不**导致任何写请求（读完 /state 就停手，绝不自作主张写回）', async () => {
    await F.settle()
    assert.deepEqual(F.selfUpdateCalls(), [], `只是打开面板就发了写请求：${JSON.stringify(F.selfUpdateCalls())}`)
    assert.ok(F.fetchLog.some((c) => c.path === '/plugin-console/state'), '没读过 /state（那「—」就是编出来的）')
  })
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
