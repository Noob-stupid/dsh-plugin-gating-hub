// 门控面板「按需检查」的界面接线（0.5.100 加法）
//
// 用户 2026-11-02：「我们一般情况下都不预检吧」——预检只在升级前跑，平时门控是空的，
// 而 0 条会被误读成"全部兼容"。本套钉的是**界面上的三件事**（假 React 真渲染主面板 + 真点）：
//   ① 有可检查的行 ⇒ 出现「检查当前是否适配」按钮；点它真的 POST `/compat-gate {action:'scan-current'}`，
//      拿到统计后有明确反馈、并重拉 /state；
//   ② **零行可查 ⇒ 不摆按钮**，改为一句说明（不许出现点了必然没反应的按钮）；
//   ③ 门控为空时给明确文案「本次没有裁决记录…」；有记录时不出现；
//      上次检查摘要（lastScan）有就显示；检查失败时把服务端原文摆出来（不静默）。
// **本套没有任何浏览器**：它证明的是行为接线，不是观感。
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

// ── 假 React（与 test-safe-boot-ui.mjs 同款）────────────────────────────────────────────
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

const entryOf = (rowId, moduleName) => ({
  entryId: `include:${rowId}`, rowId, moduleName, enabled: true, extra: true, fiberPhase: 'ready', protected: false,
  disableSource: null, forcedNotLoaded: false, userDisabled: false, userForced: false, pendingCompat: false,
  compatRescinded: false, compatVerdict: null, adoptable: null, veto: null, version: '1.0.0', repository: null,
  installDate: null, toggleable: true,
})
const baseState = (over = {}) => ({
  ok: true,
  entries: [entryOf('row-a', '@fake/a'), entryOf('row-b', '@fake/b'), entryOf('row-c', '@fake/c')],
  skippedBundles: { items: [], reliable: true, note: null },
  host: { hosted: false, kind: 'standalone', notice: null },
  health: { issues: 0, items: [] },
  patchPath: 'C:/dsh-home/profile/cordis.patch.yml',
  compat: { ok: true, supported: true, noticeVisible: false },
  installJobs: [], recentFailures: [], pendingRestart: [],
  github: { loggedIn: false, login: null },
  patch: { disables: [], forced: [], inserts: ['row-a', 'row-b', 'row-c'] },
  framework: null, lockAutofix: null, patchHeal: null,
  gating: { version: '0.2.1-rc.2', upgradeFrom: null, quarantineAt: null, quarantineLines: [], pendingCount: 0, adoptedCount: 0, pending: [], adopted: [] },
  compatPending: { frameworkVersion: '0.2.1-rc.2', upgradeFrom: null, pending: [], verdictRefresh: null, actionableCount: 0, staleCount: 0, lastScan: null },
  compatGate: { autoDisable: true, autoDetect: true },
  rollback: null, selfVersion: '0.5.99', components: [],
  ...over,
})

const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

/** 起一个主面板实例。`onGate(body)` 决定 `/compat-gate` 怎么答；抛错 = 网络层错误。 */
async function boot(cacheKey, opts = {}) {
  const stateRef = { current: opts.state ?? baseState() }
  const fetchLog = []
  let gateCount = 0
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    const method = options?.method ?? 'GET'
    fetchLog.push({ path: String(path), body, method })
    if (path === '/plugin-console/compat-gate') {
      gateCount += 1
      if (gateCount > 16) return new Promise(() => {})
      return (opts.onGate ?? (() => reply({ ok: true, compatGate: { autoDisable: true, autoDetect: true } })))(body)
    }
    if (path === '/plugin-console/state') return reply(stateRef.current)
    if (path === '/plugin-console/sources') return reply({ ok: true, sources: { registries: [], gitSources: [], archiveSources: [], searchSources: [], primary: null } })
    if (path === '/plugin-console/annotations' && body === null) return reply({ ok: true, exists: false, plugins: {}, groups: [], stats: {}, repaired: [], error: null })
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
  react.__setCurrent(() => exports.PluginConsoleTab({ t, section: null }))
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
  const gateCalls = () => fetchLog.filter((c) => c.path === '/plugin-console/compat-gate')
  const stateCalls = () => fetchLog.filter((c) => c.path === '/plugin-console/state')
  const aria = (label) => view().buttons.find((b) => b.props?.['aria-label'] === label)
  const clickAria = (label) => {
    const button = aria(label)
    if (button === undefined) throw new Error(`找不到 aria-label=${label} 的按钮；现有按钮：${view().buttons.map((b) => String(b.props?.['aria-label'] ?? b.props?.children ?? '')).slice(0, 40).join(' | ')}`)
    button.props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, key: 'x', currentTarget: {}, target: {} })
  }
  const nodesWith = (attr, value = true) => view().nodes.filter((n) => (value === true ? n.props?.[attr] !== undefined && n.props?.[attr] !== null : n.props?.[attr] === value))
  const oneNode = (attr) => { const list = nodesWith(attr); return list.length === 0 ? null : list[0] }
  const textOfNode = (attr) => { const n = oneNode(attr); return n === null ? null : flatten(n).texts.join(' ') }
  const openGate = async () => {
    await waitUntil(() => aria('gateBtn') !== undefined, '门控按钮渲染（/state 就绪）')
    clickAria('gateBtn')
    await settle(3)
    await waitUntil(() => nodesWith('data-gate-pending').length === 1, '门控模态')
  }
  return { view, rerender, settle, waitUntil, fetchLog, gateCalls, stateCalls, aria, clickAria, nodesWith, oneNode, textOfNode, openGate }
}

// ═══ A. 可检查的行在 ⇒ 按钮出现，点它真的发 scan-current，且有结果反馈 + 重拉 /state ═══════
const A = await boot('gate-scan-A', {
  onGate: (body) => (body?.action === 'scan-current'
    ? reply({ ok: true, action: 'scan-current', checked: 3, pass: 1, fail: 1, unknown: 1, recorded: 1, added: ['row-a'], changed: true, skipped: [] })
    : reply({ ok: true, compatGate: { autoDisable: true, autoDetect: true } })),
})
{
  await A.settle()
  await A.openGate()
  check('① 有可检查的行 ⇒ 出现「检查当前是否适配」按钮', () => {
    assert.ok(A.aria('gateScanCurrent') !== undefined, '没有检查按钮')
  })
  await checkAsync('①-b 点它 → 真的 POST /compat-gate {action:"scan-current"}（只发一次），并重拉 /state', async () => {
    const before = A.gateCalls().length
    const stateBefore = A.stateCalls().length
    A.clickAria('gateScanCurrent')
    await A.waitUntil(() => A.gateCalls().slice(before).some((c) => c.body?.action === 'scan-current'), 'scan-current 请求')
    const sent = A.gateCalls().slice(before)
    assert.equal(sent.length, 1, `应当恰好一条检查请求：${JSON.stringify(sent)}`)
    assert.equal(sent[0].method, 'POST')
    assert.equal(sent[0].path, '/plugin-console/compat-gate', '检查必须走既有的 /compat-gate（不新开路由）')
    assert.deepEqual(sent[0].body, { action: 'scan-current' }, `载荷不对：${JSON.stringify(sent[0].body)}`)
    await A.waitUntil(() => A.stateCalls().length > stateBefore, '检查之后的 /state 刷新')
    await A.settle(3)
    const note = A.textOfNode('data-gate-scan-note')
    assert.ok(note !== null && note.trim() !== '', '检查完必须留下结果反馈（不许静默）')
    assert.ok(String(note).includes('gateScanDone'), `反馈文案键不对：${note}`)
  })
  check('③ 门控为空（没有裁决记录）⇒ 明确说明"本次没有裁决记录…"', () => {
    const hint = A.textOfNode('data-gate-empty-hint')
    assert.ok(hint !== null, '门控为空时没有那句说明（0 条会被误读成全绿）')
    assert.ok(String(hint).includes('gateNoRecordsHint'), `文案键不对：${hint}`)
  })
}

// ═══ B. 零行可查 ⇒ 不摆按钮，改为说明 ════════════════════════════════════════════════
{
  const B = await boot('gate-scan-B', { state: baseState({ entries: [] }) })
  await B.settle()
  await B.openGate()
  check('② 零行可查 ⇒ **不显示**检查按钮（不摆点了必无反应的按钮）', () => {
    assert.equal(B.aria('gateScanCurrent'), undefined, '零行可查却摆了检查按钮')
  })
  check('② 零行可查 ⇒ 显示"为什么没有这个按钮"的说明', () => {
    const node = B.textOfNode('data-gate-scan-none')
    assert.ok(node !== null, '没有说明文字（不许留白）')
    assert.ok(String(node).includes('gateScanNoTargets'), `文案键不对：${node}`)
  })
}

// ═══ C. 有记录时不再显示空态说明；lastScan 有就显示 ═══════════════════════════════════
{
  const state = baseState({
    gating: {
      version: '0.2.1-rc.2', upgradeFrom: null, quarantineAt: null, quarantineLines: [],
      pendingCount: 1, adoptedCount: 0,
      pending: [{ rowId: 'row-a', name: 'row-a', shortName: 'row-a', moduleName: '@fake/a', version: '1.0.0', status: 'pending', check: 'fail', note: '声明不满足', source: 'manual-scan', adoptedAt: null, forcedAt: 1790218032109, adoptedBy: null, enabled: true, verdict: null, adoptable: null, rowMissing: false, actionable: true }],
      adopted: [],
    },
    compatPending: {
      frameworkVersion: '0.2.1-rc.2', upgradeFrom: null, verdictRefresh: null, actionableCount: 1, staleCount: 0,
      pending: [{ rowId: 'row-a', moduleName: '@fake/a', version: '1.0.0', checkNote: '声明不满足', check: 'fail', riskyApprovedAt: null, adoptable: null, verdict: null }],
      lastScan: { at: Date.UTC(2026, 10, 2, 9, 30, 0), frameworkVersion: '0.2.1-rc.2', checked: 3, pass: 1, fail: 1, unknown: 1, skipped: 0, source: 'manual-scan' },
    },
  })
  const C = await boot('gate-scan-C', { state })
  await C.settle()
  await C.openGate()
  check('③ 有裁决记录时不显示"本次没有裁决记录"（不无病呻吟）', () => {
    assert.equal(C.nodesWith('data-gate-empty-hint').length, 0, '有记录时不该出现空态说明')
  })
  check('③ 上次检查摘要（lastScan）显示出来（0 条也不会像全绿）', () => {
    const node = C.textOfNode('data-gate-lastscan')
    assert.ok(node !== null, '没有显示上次检查摘要')
    assert.ok(String(node).includes('gateLastScan'), `文案键不对：${node}`)
  })
}

// ═══ D. 检查失败（坏记录文件 409）⇒ 错误原文摆在面板上，不静默 ═══════════════════════
{
  const D = await boot('gate-scan-D', {
    onGate: () => reply({ ok: false, error: 'compat-pending.json 读不出来（不是合法 JSON）；为保住你的数据，本次扫描结果**没有写盘**' }, 409),
  })
  await D.settle()
  await D.openGate()
  await checkAsync('⑤ 检查失败 ⇒ 面板显示服务端原文 + 错误样式（不谎报成功）', async () => {
    D.clickAria('gateScanCurrent')
    await D.waitUntil(() => D.textOfNode('data-gate-scan-note') !== null, '失败反馈')
    const note = D.textOfNode('data-gate-scan-note')
    assert.ok(String(note).includes('不是合法 JSON'), `必须显示服务端给的原文：${note}`)
    assert.ok(String(note).includes('gateScanFailed'), `失败反馈必须点名"检查失败"：${note}`)
    assert.equal(D.oneNode('data-gate-scan-note').props['data-error'], 'true', '失败反馈必须用错误样式')
  })
}

// ═══ E. 静态接线：i18n 两本字典都有新键；文案里说清"只记录、不禁用" ═════════════════════
{
  check('⑥ 新 i18n 键中英两本都在（各恰好 2 条：zh + en）', () => {
    const keys = [...new Set([...SRC.matchAll(/t\("(gate(?:Scan[A-Za-z]*|NoRecordsHint|LastScan))"\)/gu)].map((m) => m[1]))]
    assert.ok(keys.length >= 7, `提取到的新键太少（${keys.length}），检测器可能失效`)
    const missing = keys.filter((k) => (SRC.match(new RegExp(`^\\t{3}${k}:`, 'gmu')) ?? []).length !== 2)
    assert.deepEqual(missing, [], `这些键没有恰好 2 条（zh + en）：${missing.join(', ')}`)
  })
  check('⑥ 按钮文案里写明"只记录结论、不禁用任何行"（用户要知道它会做什么）', () => {
    const line = SRC.split('\n').find((l) => l.trimStart().startsWith('gateScanTitle:')) ?? ''
    assert.ok(/不禁用/u.test(line), `中文提示没说清边界：${line}`)
    const en = SRC.split('\n').find((l) => l.trimStart().startsWith('gateScanTitle:') && /disables nothing/u.test(l)) ?? ''
    assert.ok(en !== '', '英文提示没说清边界')
  })
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
