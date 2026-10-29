// 门控面板：**真待适配**的计数 / 条目如实标注 / 删记录（两段式）（0.5.98 加法）
//
// 真机背景（用户 2026-10-28 实测）：`compat-pending.json` 里 20 条 adopted + 3 条 pending
// 但**补丁行早已不存在**（moduleName 也是 null）+ 1 条真 pending，面板却把整个 `pending` 数组长度
// 当"待适配"，用户看到"有 N 行待适配"，而实际一行都没有；也没有任何删除记录的入口。
//
// 本套把三件事钉成"渲染结果"层的行为（假 React **真渲染**主面板，桩 fetch 记录每一次请求，按钮真点）：
//   ① 计数：/state 给 actionableCount=1 / staleCount=3 ⇒ 面板显示 1（不是 24、也不是 4）；
//      **拿不到这两个字段时**（老服务端）按同一判据在客户端算 ⇒ 仍是 1，绝不退回数组长度。
//   ② 如实标注：`moduleName` 为 null 的条目显示「—」（不编造），行已不存在的条目明确标注；
//      零失效时**不显示**「清理无效记录」按钮（点了必然没反应的东西不许摆）。
//   ③ 删记录：单条与批量清理都是**两段式**（第一下零请求 → 确认才真发 → 成功后重拉 /state），
//      取消零请求；失败把服务端原文摆出来（不静默、不谎报成功）。
//
// 手法与 tests/test-safe-boot-ui.mjs 完全一致（同一套假 React / 同一套点击工具）。
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

// ── 假 React（hooks 真重渲染；与 test-safe-boot-ui.mjs 同款）──────────────────────────────
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

// ── 夹具：24 条记录（20 adopted + 3 条"行已消失"的 pending + 1 条真 pending）───────────────
const STALE_IDS = ['web-ui-describe-image', 'web-ui-doctor', 'web-ui-better-sidebar']
const REAL_ID = 'row-real'
const REAL_MODULE = '@fake/demo'
const rowOf = (rowId, over = {}) => ({
  rowId, name: rowId, shortName: rowId, moduleName: null, version: null, status: 'pending', check: 'unknown',
  note: '升级预扫判定不适配', source: 'preflight-disabled-before-upgrade', adoptedAt: null, forcedAt: 1790218032109,
  adoptedBy: null, enabled: null, verdict: null, adoptable: null, ...over,
})
const GATING = {
  version: '0.2.1-rc.2', upgradeFrom: '0.2.1-rc.1', quarantineAt: null, quarantineLines: [],
  pendingCount: 4, adoptedCount: 20,
  pending: [
    ...STALE_IDS.map((id) => rowOf(id, { rowMissing: true, actionable: false })),
    rowOf(REAL_ID, { moduleName: REAL_MODULE, rowMissing: false, actionable: true }),
  ],
  adopted: Array.from({ length: 20 }, (_, i) => rowOf(`adopted-row-${i}`, { status: 'adopted', name: `adopted-row-${i}`, adoptedAt: 1790000000000 + i, rowMissing: false, actionable: false })),
}
const COMPAT_PENDING = {
  frameworkVersion: '0.2.1-rc.2', upgradeFrom: '0.2.1-rc.1', verdictRefresh: null,
  pending: [
    ...STALE_IDS.map((id) => ({ rowId: id, moduleName: null, version: null, checkNote: '升级预扫判定不适配', check: 'unknown', riskyApprovedAt: null, adoptable: null, verdict: null })),
    { rowId: REAL_ID, moduleName: REAL_MODULE, version: null, checkNote: '升级预扫判定不适配', check: 'unknown', riskyApprovedAt: null, adoptable: null, verdict: null },
  ],
  actionableCount: 1, staleCount: 3,
}
const baseState = (over = {}) => ({
  ok: true,
  entries: [
    { entryId: 'include:demo', rowId: 'demo-row', moduleName: REAL_MODULE, enabled: true, extra: true, fiberPhase: 'ready', protected: false, disableSource: null, forcedNotLoaded: false, userDisabled: false, userForced: false, pendingCompat: false, compatRescinded: false, compatVerdict: null, adoptable: null, veto: null, version: '1.0.0', repository: null, installDate: null, toggleable: true },
  ],
  skippedBundles: { items: [], reliable: true, note: null },
  host: { hosted: false, kind: 'standalone', notice: null },
  health: { issues: 0, items: [] },
  patchPath: 'C:/dsh-home/profile/cordis.patch.yml',
  compat: { ok: true, supported: true, noticeVisible: false },
  installJobs: [], recentFailures: [], pendingRestart: [],
  github: { loggedIn: false, login: null },
  patch: { disables: [REAL_ID], forced: [], inserts: ['demo-row'] },
  framework: null, lockAutofix: null, patchHeal: null,
  gating: JSON.parse(JSON.stringify(GATING)),
  compatPending: JSON.parse(JSON.stringify(COMPAT_PENDING)),
  compatGate: { autoDisable: true, autoDetect: true },
  rollback: null, selfVersion: '0.5.98', components: [],
  ...over,
})

const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

/**
 * 起一个主面板实例。
 * @param {string} cacheKey 模块 query（每个场景独立一份，否则 import 命中缓存、hooks 串味）
 * @param {{state?: object, onCompatGate?: (body) => any}} opts
 *        state 是**可变夹具**（refresh() 会重新拉一次 /state，读到的就是它当前的样子）；
 *        onCompatGate 决定 /compat-gate 怎么答；抛错 = 网络层错误。
 */
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
      if (gateCount > 16) return new Promise(() => {}) // 防"渲染里发请求"把本套拖成死循环（真实行为是一次动作一次请求）
      return (opts.onCompatGate ?? (() => reply({ ok: true, compatGate: { autoDisable: true, autoDetect: true } })))(body)
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
  const textsUnder = (node) => flatten(node).texts.join(' ')
  const rowNodes = () => nodesWith('data-gate-row')
  const rowNode = (rowId) => rowNodes().find((n) => n.props['data-gate-row'] === rowId) ?? null
  /** 打开门控模态（工具栏那枚「门控」按钮）。 */
  const openGate = async () => {
    await waitUntil(() => aria('gateBtn') !== undefined, '门控按钮渲染（/state 就绪）')
    clickAria('gateBtn')
    await settle(3)
    await waitUntil(() => nodesWith('data-gate-pending').length === 1, '门控模态里的待适配计数行')
  }
  return { view, rerender, settle, waitUntil, fetchLog, gateCalls, stateCalls, aria, clickAria, nodesWith, oneNode, textOfNode, textsUnder, rowNodes, rowNode, openGate, stateRef }
}

// ═══ A. 24 条记录（20 adopted + 3 行已消失 + 1 真待适配）：面板显示 1，不是 24/4 ═════════
const A = await boot('pending-ui-A')
{
  const { settle, openGate, nodesWith, oneNode, rowNodes, rowNode, textsUnder, aria, clickAria, gateCalls, stateCalls, waitUntil } = A
  await settle()
  await openGate()

  check('① 面板计数 = 1（真待适配），不是数组长度 4、更不是 24', () => {
    const node = oneNode('data-gate-pending')
    assert.ok(node !== null, '找不到待适配计数行')
    assert.equal(node.props['data-gate-pending'], '1', `面板显示的数字不对：${node.props['data-gate-pending']}`)
  })
  check('① 失效条数单独如实给出（data-gate-stale = 3）', () => {
    assert.equal(oneNode('data-gate-pending').props['data-gate-stale'], '3', '失效条数没有如实下发')
  })
  check('① 计数行仍按旧口径说话（>0 时用 gatePendingInfo；既有 data-pending 标记还在）', () => {
    const node = oneNode('data-gate-pending')
    assert.equal(node.props['data-pending'], 'true')
    assert.ok(String(textsUnder(node)).includes('gatePendingInfo'), `文案键变了：${textsUnder(node)}`)
  })
  check('② 失效记录逐条如实标注（data-row-missing / 「该行已不存在」），真待适配那条不标', () => {
    const stale = rowNode(STALE_IDS[0])
    assert.ok(stale !== null, '失效记录没渲染出来（藏着不显示才是骗人）')
    assert.equal(stale.props['data-row-missing'], 'true')
    assert.ok(textsUnder(stale).includes('gateRowMissing'), `失效能没被标出来：${textsUnder(stale)}`)
    assert.equal(rowNode(REAL_ID).props['data-row-missing'], 'false')
    assert.ok(!textsUnder(rowNode(REAL_ID)).includes('gateRowMissing'), '真待适配那条被误标成"行已不存在"')
  })
  check('② moduleName 为 null 的条目显示「—」（不编造），有模块名的照实显示', () => {
    const staleText = textsUnder(rowNode(STALE_IDS[0]))
    assert.ok(staleText.includes('gateRowModule'), `模块名那一行没了：${staleText}`)
    assert.ok(staleText.includes('—'), `moduleName 为 null 时必须显示「—」：${staleText}`)
    assert.ok(!/undefined|null/u.test(staleText), `不许把 undefined/null 印到界面上：${staleText}`)
    const realText = textsUnder(rowNode(REAL_ID))
    assert.ok(realText.includes(REAL_MODULE), `有模块名时必须照实显示：${realText}`)
  })
  check('② 4 条 pending 全部列出（失效的也在，只是被标注）', () => {
    assert.equal(rowNodes().length, 4, `应当 4 行，实际 ${rowNodes().length}`)
  })
  check('② 失效摘要行与「清理无效记录」按钮都在（有可清理的才摆）', () => {
    const line = oneNode('data-gate-stale-line')
    assert.ok(line !== null, '没有失效摘要行')
    assert.ok(String(flattenOf(line)).includes('gateStaleLine'), '摘要文案键不对')
    assert.ok(aria('gateForgetStale') !== undefined, '没有「清理无效记录」按钮')
  })

  // ③ 单条删除：两段式
  await checkAsync('③ 单条删除第一下：**零请求**，只上膛（文案写明只删记录、不动插件/补丁）', async () => {
    const before = gateCalls().length
    const node = rowNode(STALE_IDS[0])
    const btn = flatten(node).buttons.find((b) => b.props?.['aria-label'] === 'gateRowForget')
    assert.ok(btn !== undefined, '记录行里没有删除按钮')
    btn.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
    await settle(3)
    assert.equal(gateCalls().length, before, `上膛阶段一个请求都不许发：${JSON.stringify(gateCalls().slice(before))}`)
    const armed = oneNode('data-gate-forget-armed')
    assert.ok(armed !== null, '点了删除却没有上膛区')
    const text = textsUnder(armed)
    assert.ok(text.includes('gateForgetArmRow'), `上膛文案不对：${text}`)
    assert.ok(text.includes('gateForgetSafety'), `上膛文案必须写明"不动插件、不动补丁"：${text}`)
    assert.ok(aria('gateForgetConfirm') !== undefined && aria('gateForgetCancel') !== undefined, '上膛区缺确认/取消')
  })

  await checkAsync('③-b 取消：零请求，并回到未上膛（确认按钮一起消失）', async () => {
    const before = gateCalls().length
    clickAria('gateForgetCancel')
    await settle(3)
    assert.equal(gateCalls().length, before, `取消不许发任何请求：${JSON.stringify(gateCalls().slice(before))}`)
    assert.equal(A.nodesWith('data-gate-forget-armed').length, 0, '取消后上膛区必须消失')
    assert.equal(aria('gateForgetConfirm'), undefined, '取消后不该还留着确认按钮')
  })

  await checkAsync('③-c 确认后才真发（body 就是上膛那条 rowId），随后重拉 /state', async () => {
    const gateBefore = gateCalls().length
    const stateBefore = stateCalls().length
    const btn = flatten(rowNode(STALE_IDS[0])).buttons.find((b) => b.props?.['aria-label'] === 'gateRowForget')
    btn.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
    await settle(2)
    clickAria('gateForgetConfirm')
    await waitUntil(() => gateCalls().slice(gateBefore).some((c) => c.body?.action === 'forget'), 'forget 请求')
    const sent = gateCalls().slice(gateBefore)
    assert.equal(sent.length, 1, `应当恰好一条删除请求：${JSON.stringify(sent)}`)
    assert.equal(sent[0].method, 'POST')
    assert.equal(sent[0].path, '/plugin-console/compat-gate', '删除必须走既有的 /compat-gate（不新开路由）')
    assert.deepEqual(sent[0].body, { action: 'forget', rowId: STALE_IDS[0] }, `载荷不对：${JSON.stringify(sent[0].body)}`)
    await waitUntil(() => stateCalls().length > stateBefore, '删除之后的 /state 刷新')
    await settle(3)
    assert.equal(A.nodesWith('data-gate-forget-armed').length, 0, '发过请求之后上膛区必须收起（不留残影）')
    const note = A.textOfNode('data-gate-forget-note')
    assert.ok(note !== null && note.trim() !== '', '删除成功后必须有明确反馈')
  })

  // ④ 批量清理：两段式
  await checkAsync('④ 清理无效记录：第一下零请求 + 上膛文案写明"只删已不存在的记录"，确认后才发 forget-stale', async () => {
    const before = gateCalls().length
    clickAria('gateForgetStale')
    await settle(3)
    assert.equal(gateCalls().length, before, `上膛阶段一个请求都不许发：${JSON.stringify(gateCalls().slice(before))}`)
    const armed = oneNode('data-gate-forget-armed')
    assert.ok(armed !== null, '没有上膛区')
    const text = textsUnder(armed)
    assert.ok(text.includes('gateForgetArmStale'), `上膛文案不对：${text}`)
    assert.ok(text.includes('gateForgetSafety'), `上膛文案必须写明"不动插件、不动补丁"：${text}`)
    clickAria('gateForgetConfirm')
    await waitUntil(() => gateCalls().slice(before).some((c) => c.body?.action === 'forget-stale'), 'forget-stale 请求')
    const sent = gateCalls().slice(before)
    assert.equal(sent.length, 1, `应当恰好一条批量请求：${JSON.stringify(sent)}`)
    assert.deepEqual(sent[0].body, { action: 'forget-stale' }, `载荷不对：${JSON.stringify(sent[0].body)}`)
  })

  // ⑤ 失败：服务端拒绝 ⇒ 面板如实显示原文（不静默）
  check('⑤ 服务端拒绝时把原文摆出来（data-error 样式，不谎报成功）', () => {
    const note = A.oneNode('data-gate-forget-note')
    // 正常路径成功反馈已存在；这里只钉"失败样式由 level 决定"这条接线
    assert.ok(note === null || note.props['data-error'] === undefined, '成功反馈不该用错误样式')
  })
}

// ═══ B. 零待适配（全 adopted 且行都在）：不显示「清理」按钮 ══════════════════════════
{
  const clean = baseState({
    gating: {
      ...JSON.parse(JSON.stringify(GATING)),
      pending: [], pendingCount: 0, adoptedCount: 20,
      adopted: Array.from({ length: 20 }, (_, i) => rowOf(`adopted-row-${i}`, { status: 'adopted', name: `adopted-row-${i}`, rowMissing: false, actionable: false })),
    },
    compatPending: { frameworkVersion: '0.2.1-rc.2', upgradeFrom: '0.2.1-rc.1', verdictRefresh: null, pending: [], actionableCount: 0, staleCount: 0 },
  })
  const B = await boot('pending-ui-B', { state: clean })
  await B.settle()
  await B.openGate()
  check('② 零待适配：面板显示 0', () => {
    assert.equal(B.oneNode('data-gate-pending').props['data-gate-pending'], '0')
    assert.equal(B.oneNode('data-gate-pending').props['data-gate-stale'], '0')
  })
  check('② 零待适配 / 零失效：**不显示**「清理无效记录」按钮（不摆点了必无反应的按钮）', () => {
    assert.equal(B.aria('gateForgetStale'), undefined, '没有可清理的却摆了清理按钮')
    assert.equal(B.nodesWith('data-gate-stale-block').length, 0, '不该有失效摘要块')
  })
  await checkAsync('② 历史记录照旧可展开，且每条历史也有删除入口（仍是两段式，第一下零请求）', async () => {
    const historyBtn = B.view().buttons.find((b) => flatten(b).texts.join(' ').includes('gateHistoryShow'))
    assert.ok(historyBtn !== undefined, '没有「展开查看历史」按钮（既有能力被弄丢了）')
    historyBtn.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
    await B.settle(3)
    const forgets = B.nodesWith('data-gate-forget-row')
    assert.equal(forgets.length, 20, `历史里的删除入口数量不对：${forgets.length}`)
    const before = B.gateCalls().length
    forgets[0].props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
    await B.settle(3)
    assert.equal(B.gateCalls().length, before, `上膛阶段不许发请求：${JSON.stringify(B.gateCalls().slice(before))}`)
    assert.ok(B.oneNode('data-gate-forget-armed') !== null, '历史记录的删除没有上膛区')
  })
}

// ═══ C. 老形状响应（没有 actionableCount/staleCount）：客户端按同一判据回退计算 ═══════════
{
  const legacy = baseState()
  // 老服务端：不带 actionableCount / staleCount；行上也没有 rowMissing / actionable；
  // 极端情形——`pending` 里把**全部 24 条**都塞进来（旧客户端就是这么数出 24 的）
  delete legacy.compatPending.actionableCount
  delete legacy.compatPending.staleCount
  legacy.compatPending.pending = [
    ...Array.from({ length: 20 }, (_, i) => ({ rowId: `adopted-row-${i}`, moduleName: null, version: null, status: 'adopted', checkNote: '已适配', check: 'unknown', riskyApprovedAt: null, adoptable: null, verdict: null })),
    ...STALE_IDS.map((id) => ({ rowId: id, moduleName: null, version: null, status: 'pending', checkNote: '升级预扫判定不适配', check: 'unknown', riskyApprovedAt: null, adoptable: null, verdict: null })),
    { rowId: REAL_ID, moduleName: REAL_MODULE, version: null, status: 'pending', checkNote: '升级预扫判定不适配', check: 'unknown', riskyApprovedAt: null, adoptable: null, verdict: null },
  ]
  const C = await boot('pending-ui-C', { state: legacy })
  await C.settle()
  await C.openGate()
  check('★ 拿不到 actionableCount 时按同一判据回退算 ⇒ 仍是 1（不是 24、不是 4）', () => {
    const node = C.oneNode('data-gate-pending')
    assert.equal(node.props['data-gate-pending'], '1', `回退算法的结果不对：${node.props['data-gate-pending']}`)
    assert.notEqual(node.props['data-gate-pending'], '24', '退回了数组长度（这正是要修的 bug）')
  })
  check('★ 拿不到 staleCount 时也回退算 ⇒ 3', () => {
    assert.equal(C.oneNode('data-gate-pending').props['data-gate-stale'], '3')
  })
  check('★ 行上也没有 rowMissing 时按同一判据（state.data.patch 的行清单）如实标注', () => {
    const stale = C.rowNode(STALE_IDS[0])
    assert.ok(stale !== null, '失效记录没渲染')
    assert.equal(stale.props['data-row-missing'], 'true', '老服务端下失效行没被标出来')
    assert.equal(C.rowNode(REAL_ID).props['data-row-missing'], 'false')
    assert.ok(C.textsUnder(stale).includes('gateRowMissing'))
  })
}

// ═══ D. 删除被服务端拒绝（409）：错误原文照摆，不静默 ═════════════════════════════
{
  const D = await boot('pending-ui-D', {
    onCompatGate: (body) => (body?.action === 'forget'
      ? reply({ ok: false, error: '文件读不出来（不是合法 JSON）；为保住你的数据，本动作已停止' }, 409)
      : reply({ ok: true, compatGate: { autoDisable: true, autoDetect: true } })),
  })
  await D.settle()
  await D.openGate()
  await checkAsync('⑤ 删除失败（409）→ 面板显示服务端原文 + 错误样式', async () => {
    const btn = flatten(D.rowNode(REAL_ID)).buttons.find((b) => b.props?.['aria-label'] === 'gateRowForget')
    btn.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
    await D.settle(2)
    D.clickAria('gateForgetConfirm')
    await D.waitUntil(() => D.textOfNode('data-gate-forget-note') !== null, '失败反馈')
    const note = D.textOfNode('data-gate-forget-note')
    assert.ok(note.includes('文件读不出来'), `必须显示服务端给的原文：${note}`)
    assert.ok(note.includes('gateForgetFailed'), `失败反馈必须点名"删除失败"：${note}`)
    assert.equal(D.oneNode('data-gate-forget-note').props['data-error'], 'true', '失败反馈必须用错误样式（不许伪装成成功）')
  })
}

// ═══ E. 静态接线：删除只走既有的 /compat-gate，且 i18n 两本字典都有新键 ═══════════════
{
  check('⑥ 客户端删记录走 `/plugin-console/compat-gate`（新增 action，不新开路由）', () => {
    assert.ok(SRC.includes('call("/plugin-console/compat-gate", body)'), '删除请求的接线不见了')
    const bodyLine = SRC.slice(SRC.indexOf('const body = armed.kind === "stale"'), SRC.indexOf('const body = armed.kind === "stale"') + 220)
    assert.ok(bodyLine.includes('forget-stale') && bodyLine.includes('action: "forget"'), `载荷构造不对：${bodyLine}`)
  })
  check('⑥ 新 i18n 键中英两本都在（各恰好 2 条：zh + en）', () => {
    const keys = [...new Set([...SRC.matchAll(/t\("(gate(?:RowModule|RowMissing|StaleLine|Forget[A-Za-z]*))"\)/gu)].map((m) => m[1]))]
    assert.ok(keys.length >= 10, `提取到的新键太少（${keys.length}），检测器可能失效`)
    const missing = keys.filter((k) => (SRC.match(new RegExp(`^\\t{3}${k}:`, 'gmu')) ?? []).length !== 2)
    assert.deepEqual(missing, [], `这些键没有恰好 2 条（zh + en）：${missing.join(', ')}`)
  })
  check('⑥ 英文文案里 0 个中日韩字符（英文界面不许露中文）', () => {
    const enBlock = SRC.slice(SRC.indexOf('const en = {'), SRC.indexOf('const en = {') + 60000)
    const bad = ['gateRowMissing', 'gateStaleLine', 'gateForgetRow', 'gateForgetStale', 'gateForgetSafety', 'gateForgetConfirm', 'gateForgetCancel', 'gateForgetDoneRow', 'gateForgetNone']
      .filter((k) => {
        const line = enBlock.split('\n').find((l) => l.trimStart().startsWith(`${k}:`)) ?? ''
        return /[\u4e00-\u9fff]/u.test(line)
      })
    assert.deepEqual(bad, [], `这些英文键里有中文：${bad.join(', ')}`)
  })
}

function flattenOf(node) { return flatten(node).texts.join(' ') }

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
