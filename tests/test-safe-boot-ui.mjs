// 「安全启动」界面行为的钉子（用户 2026-10-18 原话：「现在这能力藏得太深，只有命令行能用」）。
//
// 背景：后端 POST /plugin-console/safe-boot 早就有了（动作白名单 list / restore-last-good /
// disable-suspects / mark-good），命令行兜底 scripts/safe-boot.mjs 也有，但**界面上一个入口都没有**。
// 这次把四个动作接进门控面板（不新增工具栏按钮），本套钉的就是"点这个按钮会发生这件事"：
//
//   ① 位置：安全启动分区在**门控模态**里、门控正文之后；`safeBootPanel()` 全仓只有这一个调用点
//      （所以它不可能被顺手做成第二个工具栏按钮）。
//   ② 默认收起 → **零请求**；打开门控面板也不请求；点开那一下**真的 POST /safe-boot {action:'list'}**，
//      而且随后几帧不会重复请求（"每次渲染都请求"是这条要防的）。
//   ③ 快照清单：ID / 时间 / sha256 前几位 / last-good 标记；拿不到的字段显示「—」（不编造）。
//   ④ restore-last-good **两段式**：第一下零请求 + 上膛文案点出目标快照 ID 与会被覆盖的补丁文件；
//      「取消」零请求并回到未上膛；确认后才真发，且 body.id 就是文案里那份。
//   ⑤ disable-suspects **两段式** + 上膛中换动作 ⇒ 只发新动作的载荷（上一个动作的载荷绝不跟着发出去）。
//   ⑥ mark-good 一键，成功后**再拉一次 list**（断言恰好两条 list 请求，且顺序是 list → mark-good → list）。
//   ⑦ 失败态四连：{ok:false,error} / HTTP 500 / 网络抛错 / 写动作 409 —— 每种都必须有错误原文（不静默）。
//   ⑧ 「为什么没写快照」两类原因文案必须不同：`patch-not-yaml-valid`（结构校验没过）vs `not-yet`（时机未到）；
//      服务端说 written:true 时**一个字的抱怨都不许出现**（不编）。
//   ⑨ 没有可操作对象时**不显示**恢复/标记为良好/只禁可疑行按钮（点了必失败的按钮不许存在）。
//
// 手法与 tests/test-annotations-ui.mjs 完全一致：假 React **真渲染**主面板（hooks 真重渲染），
// 桩 fetch 记录每一次请求，按钮真点。**本套没有任何浏览器**，它证明的是行为接线，不是观感。
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
const PATCH_PATH = 'C:/dsh-home/profile/cordis.patch.yml'
const SNAP_NEW = { id: 'snap-2026-10-18T09-41-05-191Z', kind: 'auto', at: Date.UTC(2026, 9, 18, 9, 41, 5), frameworkVersion: '0.2.1-rc.2', patchSha256: 'a1b2c3d4e5f60718', patchBytes: 2048, enabledCount: 3, disabledCount: 1 }
const SNAP_MID = { id: 'snap-2026-10-18T03-12-00-004Z', kind: 'auto', at: Date.UTC(2026, 9, 18, 3, 12, 0), frameworkVersion: '0.2.1-rc.2', patchSha256: '0011aabbccddeeff', patchBytes: 2040, enabledCount: 3, disabledCount: 1 }
const SNAP_GOOD = { id: 'snap-2026-10-17T22-02-44-008Z', kind: 'good', at: Date.UTC(2026, 9, 17, 22, 2, 44), frameworkVersion: '0.2.1-rc.2', patchSha256: 'ffee001122334455', patchBytes: 2033, enabledCount: 4, disabledCount: 0 }
const SUSPECTS = ['demo-row-1', 'demo-row-2']
const COMMANDS = {
  list: 'node scripts/safe-boot.mjs --list',
  restore: 'node scripts/safe-boot.mjs --restore-last-good',
  disable: 'node scripts/safe-boot.mjs --disable-suspects',
  markGood: 'node scripts/safe-boot.mjs --mark-good',
  note: { zh: '服务打不开时在插件目录下执行', en: 'Run this in the plugin directory when the service cannot start' },
}
/** list 的正常响应（服务端 routes/safe-boot.js 的真实形状 + 一条 lastPlan 点名两行可疑）。 */
const LIST_OK = {
  ok: true, action: 'list', patchPath: PATCH_PATH,
  patch: { exists: true, check: { ok: true, problems: [] } },
  snapshots: [SNAP_NEW, SNAP_MID, SNAP_GOOD],
  lastGoodId: SNAP_GOOD.id, lastAutoId: SNAP_NEW.id, mode: 'observer',
  lastPlan: { at: Date.UTC(2026, 9, 18, 9, 30, 0), key: 'fp-key', state: 'done', suspects: SUSPECTS.slice(), affectedCount: 4, note: 'D1 自动预检的结论' },
  commands: COMMANDS, pluginVersion: '0.5.98',
}

const entry = (over) => ({
  entryId: `include:${over.rowId}`, rowId: over.rowId, moduleName: over.moduleName, enabled: true, extra: true,
  fiberPhase: 'ready', protected: false, disableSource: null, forcedNotLoaded: false, userDisabled: false,
  userForced: false, pendingCompat: false, compatRescinded: false, compatVerdict: null, adoptable: null,
  veto: null, version: over.version ?? '1.0.0', repository: null, installDate: null, toggleable: true,
  ...over,
})
const STATE = {
  ok: true,
  entries: [entry({ rowId: 'mem', moduleName: '@openviking/dsh-memory-plugin' }), entry({ rowId: 'search', moduleName: 'dsh-search-tools' })],
  skippedBundles: { items: [], reliable: true, note: null },
  host: { hosted: false, kind: 'standalone', notice: null },
  health: { issues: 0, items: [] },
  patchPath: PATCH_PATH, compat: { ok: true, supported: true, noticeVisible: false },
  installJobs: [], recentFailures: [], pendingRestart: [],
  github: { loggedIn: false, login: null },
  patch: { disables: [], forced: [], inserts: ['mem', 'search'] },
  framework: null, lockAutofix: null, patchHeal: null,
  gating: { pending: [], adopted: [], pendingCount: 0, adoptedCount: 0, total: 0 },
  compatPending: null, compatGate: { autoDisable: false, autoDetect: false },
  rollback: null, selfVersion: '0.5.98', components: [],
}

const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

/**
 * 起一个主面板实例。
 * @param {string} cacheKey 模块 query（每个场景都要独立一份，否则 import 命中缓存、hooks 串味）
 * @param {(call: {body: object|null, method: string}) => any} safeBootReply 决定 /safe-boot 怎么答；
 *        返回值 = 响应体；抛错 = 网络层错误（用来测"网络/HTTP 抛错也要有可见错误"）。
 */
async function boot(cacheKey, safeBootReply) {
  const fetchLog = []
  let safeBootCount = 0
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    const method = options?.method ?? 'GET'
    fetchLog.push({ path: String(path), body, method })
    if (path === '/plugin-console/safe-boot') {
      // ★ 防"渲染里发请求"的实现把本套拖成死循环：真实行为是一个动作一次请求，超过 24 次说明
      //   面板在渲染路径里反复发请求 —— 这时**永不给响应**（异步链停在这里，事件循环才走得动），
      //   紧接着的请求数断言自然变红：是断言失败，不是挂死。
      safeBootCount += 1
      if (safeBootCount > 24) return new Promise(() => {})
      return safeBootReply({ body, method })
    }
    if (path === '/plugin-console/state') return reply(STATE)
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
  const sbCalls = () => fetchLog.filter((c) => c.path === '/plugin-console/safe-boot')
  const listCalls = () => sbCalls().filter((c) => c.body?.action === 'list')
  const aria = (label) => view().buttons.find((b) => b.props?.['aria-label'] === label)
  const clickAria = (label) => {
    const button = aria(label)
    if (button === undefined) throw new Error(`找不到 aria-label=${label} 的按钮；现有按钮：${view().buttons.map((b) => String(b.props?.['aria-label'] ?? b.props?.children ?? '')).slice(0, 40).join(' | ')}`)
    button.props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, key: 'x', currentTarget: {}, target: {} })
  }
  /** 所有带某个 data-* 属性的节点。 */
  const nodesWith = (attr, value = true) => view().nodes.filter((n) => (value === true ? n.props?.[attr] !== undefined && n.props?.[attr] !== null : n.props?.[attr] === value))
  const textsUnder = (node) => flatten(node).texts.join(' ')
  const rowNodes = () => nodesWith('data-safeboot-row')
  const armedNodes = () => nodesWith('data-safeboot-armed')
  const oneNode = (attr) => { const list = nodesWith(attr); return list.length === 0 ? null : list[0] }
  const textOfNode = (attr) => { const n = oneNode(attr); return n === null ? null : textsUnder(n) }
  /** 打开门控模态（工具栏那枚「门控」按钮）。 */
  const openGate = async () => {
    await waitUntil(() => aria('gateBtn') !== undefined, '门控按钮渲染（/state 就绪）')
    clickAria('gateBtn')
    await settle(3)
    await waitUntil(() => nodesWith('data-safeboot-toggle').length === 1, '门控模态里的安全启动入口')
  }
  /** 打开安全启动分区，并等 list 落地。 */
  const openSafeBoot = async () => {
    await openGate()
    const before = listCalls().length
    clickAria('safeBootToggle')
    await waitUntil(() => listCalls().length > before, '展开后的 list 请求')
    await settle(4)
  }
  return { view, rerender, settle, waitUntil, fetchLog, sbCalls, listCalls, aria, clickAria, nodesWith, textsUnder, rowNodes, armedNodes, textOfNode, openGate, openSafeBoot }
}

const between = (from, to, hay = SRC) => {
  const a = hay.indexOf(from)
  if (a < 0) return null
  const b = hay.indexOf(to, a + from.length)
  if (b < 0) return null
  return hay.slice(a, b)
}

console.log('=== ① 位置：门控模态里的一个分区（不新增工具栏按钮）===')
{
  check('① 安全启动分区在**门控卡片**里（不是新建的工具栏按钮 / 不是别的模态）', () => {
    const seg = between('styles.modalCard, style: { maxWidth: 520 }', 'aiOpen')
    assert.ok(seg !== null, '定位不到门控卡片那一段')
    assert.ok(seg.includes('gateModalTitle'), '定位到的不是门控卡片')
    assert.ok(seg.includes('safeBootPanel()'), '门控卡片里没有安全启动分区')
  })
  check('① `safeBootPanel()` 全仓只有 1 个调用点（不可能顺手做成第二个工具栏按钮）', () => {
    const calls = (SRC.match(/safeBootPanel\(\)/gu) ?? []).length
    assert.equal(calls, 1, `调用点数量=${calls}`)
  })
  check('① 分区默认收起（useState(false)），且没有把它塞进工具栏（工具栏里没有 safeBoot 的 aria-label）', () => {
    assert.match(SRC, /const \[safeBootOpen, setSafeBootOpen\] = react\.useState\(false\)/u, 'safeBootOpen 的默认值变了（必须默认收起）')
    const toolbarSeg = between('styles.toolbarGroup', 'styles.toolbarMain')
    assert.ok(!/safeBoot/u.test(toolbarSeg ?? ''), '工具栏区段里出现了 safeBoot —— 用户明确不许再加工具栏按钮')
  })
  check('① 新增的中英文案键两边都在（每个 t("safeBoot…") 恰好 2 条：zh + en）', () => {
    const keys = [...new Set([...SRC.matchAll(/t\("(safeBoot[A-Za-z0-9_]*)"\)/gu)].map((m) => m[1]))]
    assert.ok(keys.length >= 20, `提取到的 safeBoot 键太少（${keys.length}），检测器可能失效`)
    const missing = keys.filter((k) => (SRC.match(new RegExp(`^\\t{3}${k}:`, 'gmu')) ?? []).length !== 2)
    assert.deepEqual(missing, [], `这些键没有恰好 2 条（zh + en）：${missing.join(', ')}`)
  })
}

// ═══ A. 正常场景：3 份快照（1 份 last-good）、点名 2 行可疑 ═══════════════════════════
const A = await boot('safe-boot-ui-A', () => reply(LIST_OK))
{
  const { view, settle, waitUntil, sbCalls, listCalls, aria, clickAria, nodesWith, textsUnder, rowNodes, armedNodes, textOfNode, openGate, openSafeBoot } = A
  await settle()

  await checkAsync('② 面板收起时：零 safe-boot 请求（打开门控面板也不请求）', async () => {
    assert.deepEqual(sbCalls(), [], `收起状态下不该有任何 safe-boot 请求：${JSON.stringify(sbCalls())}`)
    assert.equal(aria('safeBootToggle'), undefined, '安全启动入口不该在工具栏/列表里（它属于门控面板）')
    await openGate()
    const toggle = nodesWith('data-safeboot-toggle')[0]
    assert.equal(toggle.props['data-open'], 'false', '门控面板打开时，安全启动分区必须仍是收起的')
    assert.deepEqual(sbCalls(), [], `打开门控面板时不该发 safe-boot 请求（只有展开分区才发）：${JSON.stringify(sbCalls())}`)
  })

  await checkAsync('②-b 点开分区 → 真的 POST /safe-boot {action:"list"}，且只发一次（不是每次渲染都发）', async () => {
    clickAria('safeBootToggle')
    await waitUntil(() => listCalls().length >= 1, 'list 请求')
    assert.equal(sbCalls().length, 1, `应当只有 1 条请求：${JSON.stringify(sbCalls())}`)
    assert.equal(sbCalls()[0].method, 'POST', '必须是 POST（服务端只登记了 POST）')
    assert.deepEqual(sbCalls()[0].body, { action: 'list' }, `请求体不对：${JSON.stringify(sbCalls()[0].body)}`)
    await settle(10)
    assert.equal(sbCalls().length, 1, `展开后多渲染几帧不该重复请求：${JSON.stringify(sbCalls())}`)
    assert.equal(rowNodes().length, 3, `应当列出 3 行快照，实际 ${rowNodes().length}`)
  })

  check('③ 快照清单：ID / 时间 / sha256 前几位 / last-good 标记都在', () => {
    const rows = rowNodes()
    assert.deepEqual(rows.map((r) => r.props['data-snapshot-id']), [SNAP_NEW.id, SNAP_MID.id, SNAP_GOOD.id], '顺序必须是新→旧')
    const first = textsUnder(rows[0])
    assert.ok(first.includes(SNAP_NEW.id), `行里没有快照 ID：${first}`)
    assert.ok(first.includes('a1b2c3d4e5'), `行里没有 sha256 前几位：${first}`)
    assert.ok(!/safeBootRowAt —/u.test(first), `时间显示成了「—」（不编造，但这条有真实 at 就该显示）：${first}`)
    const marked = rows.filter((r) => flatten(r).nodes.some((n) => n.props?.['data-lastgood'] === 'true'))
    assert.equal(marked.length, 1, `last-good 标记应当只有 1 行，实际 ${marked.length} 行`)
    assert.equal(marked[0].props['data-snapshot-id'], SNAP_GOOD.id, '标错行了：last-good 不是 lastGoodId 指的那份')
    const count = textOfNode('data-safeboot-count')
    assert.ok(count !== null && count.includes(SNAP_GOOD.id), `计数行里没有 lastGoodId：${count}`)
    // 份数：`t()` 在测试里是哨兵（返回键名，不含 {n}），所以断言"组件算出来的份数"这条真实数据，
    // 而不是去界面上找那个数字（文件里 data-count 就是这个份数本身）。
    const countNode = nodesWith('data-safeboot-count')[0]
    assert.equal(countNode.props['data-count'], '3', `计数行拿到的份数不对：${countNode.props['data-count']}`)
  })

  check('③-b 服务端说这次{written:true} 时，__不__出现「没写快照」的抱怨行（不编）', () => {
    // LIST_OK 里没有 snapshot 字段 + 有快照 + 校验通过 ⇒ 按推导不该有"为什么没写"这一行
    assert.equal(nodesWith('data-safeboot-reason').length, 0, `不该有 reason 行：${textOfNode('data-safeboot-reason')}`)
    assert.equal(nodesWith('data-safeboot-empty').length, 0, '有 3 份快照时不该出现空态文案')
  })

  await checkAsync('④ 恢复：第一下只上膛（零请求），文案点出目标快照 ID 与会被覆盖的补丁文件', async () => {
    const before = sbCalls().length
    clickAria('safeBootRestore')
    await settle(3)
    assert.equal(sbCalls().length, before, `上膛阶段一个请求都不许发：${JSON.stringify(sbCalls().slice(before))}`)
    assert.equal(armedNodes().length, 1, '点了「恢复」却没有出现上膛/确认区')
    const armed = textsUnder(armedNodes()[0])
    assert.ok(armed.includes(SNAP_GOOD.id), `上膛文案必须点出要恢复到哪份快照（${SNAP_GOOD.id}）：${armed}`)
    assert.ok(armed.includes(PATCH_PATH), `上膛文案必须写明会覆盖哪个补丁文件（${PATCH_PATH}）：${armed}`)
    assert.ok(armed.includes('ffee001122'), `上膛文案该带上那份快照的 sha256 前缀：${armed}`)
  })

  await checkAsync('④-b 取消：零请求，且回到未上膛（确认按钮也一起消失）', async () => {
    const before = sbCalls().length
    clickAria('safeBootCancel')
    await settle(3)
    assert.equal(sbCalls().length, before, `取消不许发任何请求：${JSON.stringify(sbCalls().slice(before))}`)
    assert.equal(armedNodes().length, 0, '取消后上膛区必须消失')
    assert.equal(aria('safeBootConfirm'), undefined, '取消后不该还留着「确认执行」按钮')
  })

  await checkAsync('④-c 确认后才真发 restore-last-good（body.id = 文案里那份），随后再拉一次 list', async () => {
    const before = sbCalls().length
    clickAria('safeBootRestore')
    await settle(3)
    assert.equal(armedNodes().length, 1, '重新上膛失败')
    clickAria('safeBootConfirm')
    await waitUntil(() => sbCalls().slice(before).some((c) => c.body?.action === 'restore-last-good'), 'restore-last-good 请求')
    const after = sbCalls().slice(before)
    const restore = after.filter((c) => c.body?.action === 'restore-last-good')
    assert.equal(restore.length, 1, `应当恰好 1 条恢复请求：${JSON.stringify(after)}`)
    assert.equal(restore[0].body.id, SNAP_GOOD.id, `恢复的 id 必须就是上膛文案里那份：${JSON.stringify(restore[0].body)}`)
    assert.equal(restore[0].method, 'POST')
    await waitUntil(() => sbCalls().slice(before).some((c) => c.body?.action === 'list'), '写动作之后的 list 刷新')
    await settle(3)
    assert.equal(armedNodes().length, 0, '发过请求之后上膛区必须收起（不留"看着像待确认"的残影）')
    const note = textOfNode('data-safeboot-note')
    assert.ok(note !== null && note.trim() !== '', '恢复后必须留下结果反馈（不许静默）')
  })

  await checkAsync('⑤ 只禁可疑行：两段式；上膛中换动作 ⇒ 只发新动作的载荷（旧载荷绝不发出去）', async () => {
    const before = sbCalls().length
    // 先上膛「恢复」，再改点「只禁可疑行」—— 第一下的载荷必须被丢弃
    clickAria('safeBootRestore')
    await settle(2)
    assert.equal(armedNodes().length, 1, '第一步上膛失败')
    clickAria('safeBootDisable')
    await settle(2)
    assert.equal(sbCalls().length, before, `两次上膛都不许发请求：${JSON.stringify(sbCalls().slice(before))}`)
    assert.equal(armedNodes().length, 1, '换动作后应当只有**一个**上膛区')
    const armed = textsUnder(armedNodes()[0])
    assert.ok(SUSPECTS.every((row) => armed.includes(row)), `上膛文案要点名那两行可疑：${armed}`)
    assert.ok(armed.includes('safeBootArmDisableNote'), `上膛文案必须写明"不删任何行、不做整树回滚"（t 为哨兵时以键名出现）：${armed}`)
    clickAria('safeBootConfirm')
    await waitUntil(() => sbCalls().slice(before).some((c) => c.body?.action === 'disable-suspects'), 'disable-suspects 请求')
    const after = sbCalls().slice(before)
    const disable = after.filter((c) => c.body?.action === 'disable-suspects')
    assert.equal(disable.length, 1, `应当恰好 1 条 disable 请求：${JSON.stringify(after)}`)
    assert.deepEqual(disable[0].body.rowIds, SUSPECTS, `发给服务端的 rowIds 必须就是文案里那两行：${JSON.stringify(disable[0].body)}`)
    assert.equal(after.filter((c) => c.body?.action === 'restore-last-good').length, 0,
      `上膛被换掉后，前一个动作（恢复）的载荷绝不许发出去：${JSON.stringify(after)}`)
  })

  check('⑤-b 有可疑行时清单下面写明"点了哪些行"（用户要知道会发生什么）', () => {
    const suspects = textOfNode('data-safeboot-suspects')
    assert.ok(suspects !== null && SUSPECTS.every((row) => suspects.includes(row)), `可疑行说明缺失：${suspects}`)
  })
}

// ═══ B. mark-good：轻动作一键，但成功后必须重新拉一次 list ═══════════════════════════
{
  const B = await boot('safe-boot-ui-B', ({ body }) => (body?.action === 'mark-good'
    ? reply({ ok: true, action: 'mark-good', snapshot: { ...SNAP_NEW, kind: 'good' }, note: { zh: '已标记为良好', en: 'Marked as good' }, commands: COMMANDS })
    : reply({ ...LIST_OK, snapshot: { written: true, reason: null } })))
  await B.settle()
  await checkAsync('⑥ mark-good 一键即发 → 成功后再拉一次 list（顺序 list → mark-good → list）', async () => {
    await B.openSafeBoot()
    assert.equal(B.listCalls().length, 1, `展开后应当只有 1 条 list：${JSON.stringify(B.listCalls())}`)
    assert.equal(B.aria('safeBootMarkGood') !== undefined, true, '没有「标记当前为好的状态」按钮')
    B.clickAria('safeBootMarkGood')
    await B.waitUntil(() => B.listCalls().length >= 2, 'mark-good 之后的第二次 list')
    await B.settle(4)
    assert.deepEqual(B.sbCalls().map((c) => c.body?.action), ['list', 'mark-good', 'list'],
      `请求序列不对（必须 mark-good 成功后刷新列表）：${JSON.stringify(B.sbCalls().map((c) => c.body))}`)
    assert.equal(B.sbCalls().filter((c) => c.body?.action === 'list').length, 2, `list 必须恰好两条：${JSON.stringify(B.sbCalls().map((c) => c.body))}`)
    const mark = B.sbCalls().find((c) => c.body?.action === 'mark-good')
    assert.equal(mark.body.id, SNAP_NEW.id, `标记的应当是最新那份快照：${JSON.stringify(mark.body)}`)
    const note = B.textOfNode('data-safeboot-note')
    assert.ok(note !== null && note.trim() !== '', '标记成功后必须留下结果反馈')
  })
}

// ═══ C. 服务端直给 snapshot{written:false,reason}：两类原因文案必须不同 ═════════════════
{
  // C1：结构校验没过（spec 里点名的那种形状）
  const C1 = await boot('safe-boot-ui-C1', () => reply({ ...LIST_OK, snapshots: [], lastGoodId: null, snapshot: { written: false, reason: 'patch-not-yaml-valid', problems: ['第 12 行：未闭合引号'] } }))
  await C1.settle()
  await checkAsync('⑦-a {written:false, reason:"patch-not-yaml-valid"} → 界面显示**结构校验没过**，并原样带上原因', async () => {
    await C1.openSafeBoot()
    const reason = C1.textOfNode('data-safeboot-reason')
    assert.ok(reason !== null, '没有「为什么没写快照」这一行')
    assert.ok(reason.includes('patch-not-yaml-valid'), `必须原样显示服务端给的 reason：${reason}`)
    assert.ok(reason.includes('safeBootReasonPatchInvalid'), `必须显示"结构校验没过"的文案：${reason}`)
    assert.ok(!reason.includes('safeBootReasonNotYet'), `不许显示成"还没到该写的时机"：${reason}`)
    const empty = C1.textOfNode('data-safeboot-empty')
    assert.ok(empty !== null && empty.includes('patch-not-yaml-valid'), `空态也要如实说出原因：${empty}`)
  })

  // C2：还没有到该写的时机（补丁没问题，但一份快照都没有）
  const C2 = await boot('safe-boot-ui-C2', () => reply({ ...LIST_OK, snapshots: [], lastGoodId: null }))
  await C2.settle()
  await checkAsync('⑦-b 没有快照（补丁校验通过）→ 显示**还没到该写的时机**，与 ⑦-a 是两套文案', async () => {
    await C2.openSafeBoot()
    const reason = C2.textOfNode('data-safeboot-reason')
    assert.ok(reason !== null, '没有「为什么没写快照」这一行')
    assert.ok(reason.includes('not-yet'), `应当给出"时机未到"的原因标识：${reason}`)
    assert.ok(reason.includes('safeBootReasonNotYet'), `应当给出"时机未到"的文案：${reason}`)
    assert.ok(!reason.includes('safeBootReasonPatchInvalid'), `不许把"时机未到"说成"结构校验没过"：${reason}`)
    assert.ok(!reason.includes('patch-not-yaml-valid'), `不许凭空冒出结构校验失败的原因：${reason}`)
  })

  // C3：服务端当场跑出的 patch.check 结论（list 真实形状）也能分出结构校验这一类
  const C3 = await boot('safe-boot-ui-C3', () => reply({ ...LIST_OK, snapshots: [], lastGoodId: null, patch: { exists: true, check: { ok: false, problems: ['第 3 行：缩进不对'] } } }))
  await C3.settle()
  await checkAsync('⑦-c list 只给 patch.check{ok:false} 时也判成「结构校验没过」，并把问题原文摆出来', async () => {
    await C3.openSafeBoot()
    const reason = C3.textOfNode('data-safeboot-reason')
    assert.ok(reason !== null, '没有「为什么没写快照」这一行')
    assert.ok(reason.includes('patch-not-yaml-valid'), `应当判成结构校验没过：${reason}`)
    assert.ok(reason.includes('第 3 行：缩进不对'), `必须把校验问题原文摆出来：${reason}`)
    assert.ok(!reason.includes('safeBootReasonNotYet'), `不许说成"时机未到"：${reason}`)
  })

  // C4：written:true（服务端这次真写了）⇒ 一个字的抱怨都不许有
  const C4 = await boot('safe-boot-ui-C4', () => reply({ ...LIST_OK, snapshot: { written: true, reason: null } }))
  await C4.settle()
  await checkAsync('⑦-d {written:true} → 不出现任何「没写快照」的文案（不编造抱怨）', async () => {
    await C4.openSafeBoot()
    assert.equal(C4.nodesWith('data-safeboot-reason').length, 0, `written:true 时不该有 reason 行：${C4.textOfNode('data-safeboot-reason')}`)
  })
}

// ═══ D. 没有可操作对象：按钮不显示（不许出现"点了必失败"的按钮）+ 「—」如实显示 ═════════
{
  const D = await boot('safe-boot-ui-D', () => reply({ ...LIST_OK, snapshots: [], lastGoodId: null, patch: { exists: true, check: { ok: true, problems: [] } }, lastPlan: null }))
  await D.settle()
  await checkAsync('⑧ 零快照：恢复/标记为良好**不显示**，只给一句为什么（不显示点了必失败的按钮）', async () => {
    await D.openSafeBoot()
    assert.equal(D.aria('safeBootRestore'), undefined, '没有快照时不该显示「恢复」按钮')
    assert.equal(D.aria('safeBootMarkGood'), undefined, '没有快照时不该显示「标记为良好」按钮')
    const noaction = D.textOfNode('data-safeboot-noaction')
    assert.ok(noaction !== null && noaction.trim() !== '', '按钮不显示时必须给出文字说明（不许留白）')
    assert.equal(D.rowNodes().length, 0, '零快照时不该有清单行')
    assert.equal(D.nodesWith('data-safeboot-reason').length, 1, '零快照必须说明原因')
  })

  const D2 = await boot('safe-boot-ui-D2', () => reply({ ...LIST_OK, lastPlan: null }))
  await D2.settle()
  await checkAsync('⑧-b 自动预检没点名可疑行：**不显示**「只禁可疑行」按钮，并说明为什么', async () => {
    await D2.openSafeBoot()
    assert.equal(D2.aria('safeBootDisable'), undefined, '没有点名行时不该显示「只禁可疑行」按钮')
    const suspects = D2.textOfNode('data-safeboot-suspects')
    assert.ok(suspects !== null && suspects.includes('safeBootSuspectsNone'), `必须说明为什么没有这个按钮：${suspects}`)
  })

  const D3 = await boot('safe-boot-ui-D3', () => reply({
    ...LIST_OK,
    snapshot: { written: true, reason: null },
    snapshots: [{ id: 'snap-thin-no-meta', kind: 'auto', at: null, patchSha256: null }, SNAP_NEW],
  }))
  await D3.settle()
  await checkAsync('⑧-c 字段缺失时如实显示「—」（时间 / sha256 都没有，不编造）', async () => {
    await D3.openSafeBoot()
    const rows = D3.rowNodes()
    assert.equal(rows.length, 2, `应当 2 行：${rows.length}`)
    const thin = rows.find((r) => r.props['data-snapshot-id'] === 'snap-thin-no-meta')
    assert.ok(thin !== undefined, '缺字段那份快照没渲染出来')
    const text = D3.textsUnder(thin)
    assert.ok(text.includes('—'), `拿不到的时间/sha256 必须显示「—」：${text}`)
    assert.ok(!/undefined|null/u.test(text), `不许把 undefined/null 印到界面上：${text}`)
  })
}

// ═══ E. 失败态：四种都要有错误原文（不静默、不留空白）══════════════════════════════════
{
  // E1：HTTP 200 + {ok:false, error}（call() 会抛成 Error(message)）
  const E1 = await boot('safe-boot-ui-E1', () => reply({ ok: false, error: '读不到快照目录（EACCES）：C:/dsh-home/plugin-console/safe-boot/snapshots' }))
  await E1.settle()
  await checkAsync('⑨-a list 回 {ok:false,error} → 界面显示错误原文（不是空面板）', async () => {
    await E1.openGate()
    E1.clickAria('safeBootToggle')
    await E1.waitUntil(() => E1.textOfNode('data-safeboot-error') !== null, '错误行渲染')
    const error = E1.textOfNode('data-safeboot-error')
    assert.ok(error.includes('EACCES'), `必须显示服务端给的原文：${error}`)
    assert.ok(error.includes('safeBootListFailed'), `错误行必须带上"读取快照失败"的前缀：${error}`)
    // 失败也要留一条有反馈的出路（重新读取），点它必须真的再发一次请求
    const before = E1.listCalls().length
    assert.ok(E1.aria('safeBootReload') !== undefined, '读取失败时没有「重新读取」按钮（用户没有出路）')
    E1.clickAria('safeBootReload')
    await E1.waitUntil(() => E1.listCalls().length > before, '重新读取真的再发一次')
  })

  // E2：网络层抛错（fetch reject）
  const E2 = await boot('safe-boot-ui-E2', () => { throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:56914') })
  await E2.settle()
  await checkAsync('⑨-b 网络/HTTP 抛错 → 也有可见错误（不许静默、不许空白）', async () => {
    await E2.openGate()
    E2.clickAria('safeBootToggle')
    await E2.waitUntil(() => E2.textOfNode('data-safeboot-error') !== null, '网络错误的错误行')
    const error = E2.textOfNode('data-safeboot-error')
    assert.ok(error.includes('ECONNREFUSED'), `网络错误原文必须显示出来：${error}`)
  })

  // E3：HTTP 500
  const E3 = await boot('safe-boot-ui-E3', () => reply({ ok: false, error: '内部错误：snapshot dir unreadable' }, 500))
  await E3.settle()
  await checkAsync('⑨-c HTTP 500 → 错误原文照样显示（不当成"没有快照"）', async () => {
    await E3.openGate()
    E3.clickAria('safeBootToggle')
    await E3.waitUntil(() => E3.textOfNode('data-safeboot-error') !== null, '500 的错误行')
    const error = E3.textOfNode('data-safeboot-error')
    assert.ok(error.includes('snapshot dir unreadable'), `必须显示 500 的原文：${error}`)
    assert.equal(E3.nodesWith('data-safeboot-empty').length, 0, '失败时不许伪装成"还没有快照"')
  })

  // E4：写动作 409（恢复目标没了）
  const E4 = await boot('safe-boot-ui-E4', ({ body }) => (body?.action === 'restore-last-good'
    ? reply({ ok: false, error: `找不到快照 ${SNAP_GOOD.id}` }, 409)
    : reply(LIST_OK)))
  await E4.settle()
  await checkAsync('⑨-d 恢复被服务端拒绝（409）→ 面板显示错误原文，且不谎报成功', async () => {
    await E4.openSafeBoot()
    E4.clickAria('safeBootRestore')
    await E4.settle(2)
    E4.clickAria('safeBootConfirm')
    await E4.waitUntil(() => E4.textOfNode('data-safeboot-note') !== null, '写动作的失败反馈')
    const note = E4.textOfNode('data-safeboot-note')
    assert.ok(note.includes(`找不到快照 ${SNAP_GOOD.id}`), `必须显示服务端给的失败原文：${note}`)
    assert.ok(note.includes('safeBootFailed'), `失败反馈必须点名"操作失败"：${note}`)
    const noteNode = E4.nodesWith('data-safeboot-note')[0]
    assert.equal(noteNode.props['data-error'], 'true', '失败反馈必须用错误样式（视觉上可区分，不许伪装成成功）')
  })
}

// ═══ F. 幂等/重复点：上膛后再点同一个动作 = 仍然零请求 ═══════════════════════════════════
{
  const F = await boot('safe-boot-ui-F', () => reply(LIST_OK))
  await F.settle()
  await checkAsync('⑩ 重复点「恢复」：仍然是零请求，且上膛区不会变成两个', async () => {
    await F.openSafeBoot()
    const before = F.sbCalls().length
    F.clickAria('safeBootRestore')
    await F.settle(2)
    F.clickAria('safeBootRestore')
    await F.settle(2)
    F.clickAria('safeBootRestore')
    await F.settle(2)
    assert.equal(F.sbCalls().length, before, `反复上膛都不许发请求：${JSON.stringify(F.sbCalls().slice(before))}`)
    assert.equal(F.armedNodes().length, 1, `上膛区必须只有一个（幂等），实际 ${F.armedNodes().length}`)
  })

  await checkAsync('⑩-b 收起分区：上膛状态被清掉（不留一个悬着的危险动作）', async () => {
    F.clickAria('safeBootToggle')
    await F.settle(3)
    assert.equal(F.armedNodes().length, 0, '收起后不该还留着上膛区')
    // 再展开 = 重新读一次列表（这是唯一的"刷新"路径之一，必须有）
    const before = F.listCalls().length
    F.clickAria('safeBootToggle')
    await F.waitUntil(() => F.listCalls().length > before, '再次展开时的 list')
  })
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
