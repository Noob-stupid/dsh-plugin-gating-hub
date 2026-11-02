// 门控面板「加载失败的行」分区（0.5.101 加法）
//
// 真机现场（2026-11-02）：`experimental-inspector` 因 `@deepseek-ai/cordis` 解析失败而**挂载失败**
// （`fiberPhase === 'failed'`），而门控**完全看不到它** —— 这条失败不经过预扫/隔离链。
// 本套钉的是四件事（假 React 真渲染主面板 + 真点，**没有任何浏览器**）：
//   ① `fiberPhase='failed'` 的行 ⇒ 门控里出现「加载失败的行」分区并逐条列出（moduleName/版本/相位）；
//   ② 「停用」是**两段式**：第一下零请求，确认后才走**既有** `/toggle`（enabled:false）；
//   ③ 这类失败**不写** compat-pending.json（分区只是视图，不污染适配裁决记录）；
//   ④ 零失败行时整个分区**不出现**（不摆空壳）。
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

const rowOf = (rowId, moduleName, fiberPhase = 'ready') => ({
  entryId: `include:${rowId}`, rowId, moduleName, enabled: true, extra: true, fiberPhase, protected: false,
  disableSource: null, forcedNotLoaded: false, userDisabled: false, userForced: false, pendingCompat: false,
  compatRescinded: false, compatVerdict: null, adoptable: null, veto: null, version: '0.3.4', repository: null,
  installDate: null, toggleable: true,
})
/** 加载失败的两行（真机同款：一个第三方插件 + 一个框架包）。 */
const FAILED = [
  { rowId: 'experimental-inspector', moduleName: '@linxin/dsh-experimental-inspector', version: '0.3.4', fiberPhase: 'failed', enabled: true },
  { rowId: 'web-ui-better-sidebar', moduleName: 'dsh-web-ui-better-sidebar', version: '1.2.0', fiberPhase: 'failed', enabled: true },
]
const baseState = (over = {}) => ({
  ok: true,
  entries: [
    rowOf('experimental-inspector', '@linxin/dsh-experimental-inspector', 'failed'),
    rowOf('web-ui-better-sidebar', 'dsh-web-ui-better-sidebar', 'failed'),
    rowOf('row-ok', '@fake/ok'),
  ],
  skippedBundles: { items: [], reliable: true, note: null },
  host: { hosted: false, kind: 'standalone', notice: null },
  health: { issues: 0, items: [] },
  patchPath: 'C:/dsh-home/profile/cordis.patch.yml',
  compat: { ok: true, supported: true, noticeVisible: false },
  installJobs: [], recentFailures: [], pendingRestart: [],
  github: { loggedIn: false, login: null },
  patch: { disables: [], forced: [], inserts: ['experimental-inspector', 'web-ui-better-sidebar', 'row-ok'] },
  framework: null, lockAutofix: null, patchHeal: null,
  gating: {
    version: '0.2.1-rc.2', upgradeFrom: null, quarantineAt: null, quarantineLines: [],
    pendingCount: 0, adoptedCount: 0, pending: [], adopted: [],
    loadFailed: FAILED, loadFailedCount: FAILED.length,
  },
  compatPending: { frameworkVersion: '0.2.1-rc.2', upgradeFrom: null, pending: [], verdictRefresh: null, actionableCount: 0, staleCount: 0, lastScan: null },
  compatGate: { autoDisable: true, autoDetect: true },
  rollback: null, selfVersion: '0.5.100', components: [],
  ...over,
})

const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

async function boot(cacheKey, opts = {}) {
  const stateRef = { current: opts.state ?? baseState() }
  const fetchLog = []
  let toggleCount = 0
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    const method = options?.method ?? 'GET'
    fetchLog.push({ path: String(path), body, method })
    if (path === '/plugin-console/toggle') {
      toggleCount += 1
      if (toggleCount > 8) return new Promise(() => {})
      return (opts.onToggle ?? (() => reply({ ok: true, entryId: body?.entryId ?? null, enabled: body?.enabled === true, changed: true })))(body)
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
  const toggleCalls = () => fetchLog.filter((c) => c.path === '/plugin-console/toggle')
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
  return { view, rerender, settle, waitUntil, fetchLog, toggleCalls, stateCalls, aria, clickAria, nodesWith, oneNode, textOfNode, openGate, stateRef }
}

// ═══ A. 两行加载失败 ⇒ 分区出现、逐条列出、两段式停用 ═══════════════════════════════════
const A = await boot('gate-load-A')
{
  await A.settle()
  await A.openGate()
  check('① 有加载失败的行 ⇒ 出现「加载失败的行」分区（门控终于看得见它）', () => {
    assert.ok(A.oneNode('data-gate-loadfailed') !== null, '没有加载失败分区')
  })
  check('① 分区逐条列出这些行（moduleName / 版本 / 相位都在）', () => {
    const rows = A.nodesWith('data-gate-loadfailed-row')
    assert.equal(rows.length, 2, `应当列出 2 行，实际 ${rows.length}`)
    const text = A.view().nodes.filter((n) => n.props?.['data-gate-loadfailed-row'] !== undefined).map((n) => flatten(n).texts.join(' ')).join(' | ')
    assert.ok(text.includes('@linxin/dsh-experimental-inspector'), `没列出行 1：${text}`)
    assert.ok(text.includes('web-ui-better-sidebar'), `没列出行 2：${text}`)
    assert.ok(text.includes('failed'), `没写明相位（运行期加载失败）：${text}`)
  })
  check('① 分区标题带行数（{n} 行），并说明这是"运行期加载失败、不是适配裁决"', () => {
    const text = flatten(A.oneNode('data-gate-loadfailed')).texts.join(' ')
    assert.ok(text.includes('gateLoadFailedTitle'), `标题键不对：${text}`)
    assert.ok(text.includes('gateLoadFailedHint'), `缺少"不是适配裁决"的说明：${text}`)
  })

  await checkAsync('② 停用是两段式：第一下**零请求**，只上膛并写清会发生什么', async () => {
    const before = A.toggleCalls().length
    const btn = A.view().nodes.find((n) => n.props?.['data-gate-load-disable'] === 'experimental-inspector')
    assert.ok(btn !== undefined, '没有「停用」按钮')
    assert.equal(btn.props['aria-label'], 'gateLoadDisable')
    btn.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
    await A.settle(3)
    assert.equal(A.toggleCalls().length, before, `上膛阶段一个请求都不许发：${JSON.stringify(A.toggleCalls().slice(before))}`)
    const armed = A.oneNode('data-gate-load-armed')
    assert.ok(armed !== null, '点了「停用」却没有上膛区')
    const text = flatten(armed).texts.join(' ')
    assert.ok(text.includes('gateLoadArmRow') && text.includes('gateLoadSafety'), `上膛文案不对：${text}`)
    assert.ok(A.aria('gateLoadConfirm') !== undefined && A.aria('gateLoadCancel') !== undefined, '上膛区缺确认/取消')
  })

  await checkAsync('②-b 取消：零请求，回到未上膛', async () => {
    const before = A.toggleCalls().length
    A.clickAria('gateLoadCancel')
    await A.settle(3)
    assert.equal(A.toggleCalls().length, before, `取消不许发请求：${JSON.stringify(A.toggleCalls().slice(before))}`)
    assert.equal(A.nodesWith('data-gate-load-armed').length, 0, '取消后上膛区必须消失')
  })

  await checkAsync('②-c 确认后才真发：走**既有** /toggle（enabled:false），随后重拉 /state', async () => {
    const before = A.toggleCalls().length
    const stateBefore = A.stateCalls().length
    A.view().nodes.find((n) => n.props?.['data-gate-load-disable'] === 'experimental-inspector')
      .props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
    await A.settle(2)
    A.clickAria('gateLoadConfirm')
    await A.waitUntil(() => A.toggleCalls().length > before, 'toggle 请求')
    const sent = A.toggleCalls().slice(before)
    assert.equal(sent.length, 1, `应当恰好一条停用请求：${JSON.stringify(sent)}`)
    assert.equal(sent[0].method, 'POST')
    assert.equal(sent[0].path, '/plugin-console/toggle', '停用必须走既有的 /toggle（不新开路由）')
    assert.deepEqual(sent[0].body, { entryId: 'include:experimental-inspector', enabled: false }, `载荷不对：${JSON.stringify(sent[0].body)}`)
    await A.waitUntil(() => A.stateCalls().length > stateBefore, '停用之后的 /state 刷新')
    await A.settle(3)
    const note = A.textOfNode('data-gate-load-note')
    assert.ok(note !== null && note.trim() !== '', '停用后必须有结果反馈（不许静默）')
  })

  check('③ 这类失败**不写**适配记录：面板没有把它当成"待适配"（分区只是视图）', () => {
    // 夹具里 compatPending.pending 为空；若客户端把 loadFailed 混进适配列表，这里会变红
    assert.equal(A.oneNode('data-gate-pending').props['data-gate-pending'], '0', '加载失败被算成了"待适配"')
    assert.equal(A.nodesWith('data-gate-row').length, 0, '加载失败的行被塞进了适配记录列表')
  })
}

// ═══ B. 零失败行 ⇒ 整个分区不出现（不摆空壳）═══════════════════════════════════════
{
  const clean = baseState({
    entries: [rowOf('row-ok', '@fake/ok')],
    gating: { version: '0.2.1-rc.2', upgradeFrom: null, quarantineAt: null, quarantineLines: [], pendingCount: 0, adoptedCount: 0, pending: [], adopted: [], loadFailed: [], loadFailedCount: 0 },
  })
  const B = await boot('gate-load-B', { state: clean })
  await B.settle()
  await B.openGate()
  check('④ 零失败行 ⇒ 分区**不出现**（不摆空壳）', () => {
    assert.equal(B.nodesWith('data-gate-loadfailed').length, 0, '没有失败行却出现了分区')
    assert.equal(B.aria('gateLoadDisable'), undefined, '没有失败行却出现了「停用」按钮')
  })
}

// ═══ C. 停用被服务端拒绝 ⇒ 错误原文照摆（不静默、不谎报成功）═══════════════════════════
{
  const C = await boot('gate-load-C', { onToggle: () => reply({ ok: false, error: '启用前冒烟检查未通过：模块加载失败（Cannot find package cordis）' }, 409) })
  await C.settle()
  await C.openGate()
  await checkAsync('⑤ 停用失败（409）⇒ 面板显示服务端原文 + 错误样式', async () => {
    C.view().nodes.find((n) => n.props?.['data-gate-load-disable'] === 'experimental-inspector')
      .props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
    await C.settle(2)
    C.clickAria('gateLoadConfirm')
    await C.waitUntil(() => C.textOfNode('data-gate-load-note') !== null, '失败反馈')
    const note = C.textOfNode('data-gate-load-note')
    assert.ok(String(note).includes('Cannot find package cordis'), `必须显示服务端原文：${note}`)
    assert.ok(String(note).includes('gateLoadFailedFailed'), `失败反馈必须点名"停用失败"：${note}`)
    assert.equal(C.oneNode('data-gate-load-note').props['data-error'], 'true', '失败反馈必须用错误样式')
  })
}

// ═══ D. 静态接线：新 i18n 键两本都在；文案写清"不是适配裁决 / 不写适配记录" ═══════════════
{
  check('⑥ 新 i18n 键中英两本都在（各恰好 2 条：zh + en）', () => {
    const keys = [...new Set([...SRC.matchAll(/t\("(gate(?:Load[A-Za-z]*|RowModule))"\)/gu)].map((m) => m[1]))]
    assert.ok(keys.length >= 8, `提取到的新键太少（${keys.length}），检测器可能失效`)
    const missing = keys.filter((k) => (SRC.match(new RegExp(`^\\t{3}${k}:`, 'gmu')) ?? []).length !== 2)
    assert.deepEqual(missing, [], `这些键没有恰好 2 条（zh + en）：${missing.join(', ')}`)
  })
  check('⑥ 分区说明里写明"不是适配裁决、也不写进适配记录"（边界要让人看得见）', () => {
    const line = SRC.split('\n').find((l) => l.trimStart().startsWith('gateLoadFailedHint:')) ?? ''
    assert.ok(/不是适配裁决/u.test(line), `中文说明没说清边界：${line}`)
    assert.ok(/不会写进适配记录/u.test(line), `中文说明没写清不会写记录：${line}`)
  })
  check('⑥ 客户端从不把加载失败写进 compat-pending（停用走既有 /toggle，且不碰那个文件）', () => {
    const start = SRC.indexOf('const gateLoadDisable = (armed) => {')
    assert.ok(start > 0, '找不到停用实现（gateLoadDisable）')
    const seg = SRC.slice(start, start + 1200)
    assert.ok(!/compat-pending/u.test(seg), '停用路径里出现 compat-pending 字样')
    assert.ok(seg.includes('/plugin-console/toggle'), '停用没有走既有 /toggle')
  })
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
