// issue #22 ①②③ 的**界面行为**钉子：用假 React **真渲染**主面板，再把按钮真点一遍。
//
// 为什么必须真渲染（不是静态 regex）：用户定的界面硬规则全是"渲染结果"层面的 ——
//   · 系统徽章一条都不能少、用户徽章**追加在后**（顺序错了视觉就错了）；
//   · 徽章放不下要收进 `+N`（**单行不换行**，不能撑破卡片），点开要能看到全部；
//   · 详情页顺序：用户备注/徽章在最前，动作按钮在最后。
// 静态扫源码只能证明"代码里有这串字"，证明不了"点这个按钮会发生这件事"。
//
// 本套钉死（每条都能失败）：
//   ① 表头「↑↑↑」纯图标按钮存在；点一下 → 真的 POST /check-updates（带全部包名）；
//      完成后出现「仅看可更新 · N」；卡片上出现可点的「更新 → vX」，点它 → POST /install 且**带上目标版本**。
//   ①-b 「仅看可更新」真的过滤（只留可更新的那张卡），再点一次还原。
//   ② 系统徽章一条不少 + 用户徽章在**它们之后**（顺序断言），用户徽章带 data-user-badge（虚线样式）。
//   ②-b 宽度**测得到**（宽卡）时用户徽章正常显示；宽度**测不到/太窄**时尾部收进 `+N`（保守默认 320px），
//      点 `+N` 能看到**全部**徽章（系统 + 用户）。两条各用一个实例跑，互不影响。
//   ③ 用户备注/徽章块在详情页**最前面**（先于版本行），动作按钮在**最后**。
//   ③-b 用户分组区块：官方 family 成员**不进**用户分组（官方 family 优先，用户拍定的规则）。
//   ③-c 「备注插件」面板：写备注回车 → 真的 POST /annotations {action:'note'}；没备注时只显示「＋ 加备注」。
//   ③-d 删分组是**两段式**（第一下只上膛、零写入），确认后才发 group-delete，并给「撤销删除」。
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

// ── 假 React（hooks 真的能重渲染；useEffect 只跑**挂载那一次**，等价 [] 依赖）────────────
const makeReact = ({ badgeAreaWidth }) => {
  let hooks = []
  let cursor = 0
  let current = null
  let rerender = null
  const pendingEffects = []
  // 每个 effect 的上一轮依赖（按声明顺序记；顺序稳定，与真实 React 同约束）
  const effectDeps = []
  const react = {
    createElement: (type, props, ...children) => {
      const record = { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
      // 模拟宿主把真实 DOM 节点赋给 ref：组件靠 `ref.current.clientWidth` **实测**徽章区宽度。
      // 拿不到（ref.current === null）时组件用保守默认 320px —— 窄实例就是用来验证那条路径的。
      if (props !== null && typeof props === 'object' && props.ref !== null && typeof props.ref === 'object') {
        props.ref.current = badgeAreaWidth === null ? null : { clientWidth: badgeAreaWidth, addEventListener: () => {}, removeEventListener: () => {} }
      }
      return record
    },
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
    // ★ 依赖比较（真实 React 语义）：deps 数组变了才重跑；**没有 deps 的只跑一次**（保守，
    //   否则主面板里每次渲染都重新入队的 refresh() 会把 state 永远压在 loading —— 本轮实测踩到）。
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
  }
  react.__setCurrent = (fn) => { current = fn }
  react.__reset = () => { hooks = []; cursor = 0; pendingEffects.length = 0; effectDeps.length = 0 }
  react.__render = () => { cursor = 0; return current() }
  react.__setRerender = (fn) => { rerender = fn }
  react.__runEffects = () => { const list = pendingEffects.splice(0); for (const fn of list) { try { fn() } catch {} } }
  return react
}

/** 折成可断言的树（保留节点顺序 —— 徽章顺序断言全靠它）。 */
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
const entry = (over) => ({
  entryId: `include:${over.rowId}`, rowId: over.rowId, moduleName: over.moduleName, enabled: true, extra: true,
  fiberPhase: 'ready', protected: false, disableSource: null, forcedNotLoaded: false, userDisabled: false,
  userForced: false, pendingCompat: false, compatRescinded: false, compatVerdict: null, adoptable: null,
  veto: null, version: over.version ?? '1.0.0', repository: null, installDate: null, toggleable: true,
  ...over,
})
const ENTRIES = [
  entry({ rowId: 'mem', moduleName: '@openviking/dsh-memory-plugin', version: '1.0.0' }),
  entry({ rowId: 'search', moduleName: 'dsh-search-tools', version: '2.0.0' }),
  // 官方 family 两行（同根包 + 子路径 ⇒ client 会聚成 family 区块）
  entry({ rowId: 'web-all', moduleName: '@fake/dsh-web-all', version: '3.0.0' }),
  entry({ rowId: 'web-all__pm', moduleName: '@fake/dsh-web-all/plugin-manager', version: '3.0.0' }),
]
const STATE = {
  ok: true, entries: ENTRIES,
  skippedBundles: { items: [], reliable: true, note: null },
  host: { hosted: false, kind: 'standalone', notice: null },
  health: { issues: 0, items: [] },
  patchPath: 'x', compat: { ok: true },
  installJobs: [], recentFailures: [], pendingRestart: [],
  github: { loggedIn: false, login: null },
  patch: { disables: [], forced: [], inserts: ['mem', 'search', 'web-all', 'web-all__pm'] },
  framework: null, lockAutofix: null, patchHeal: null,
  gating: { pending: [], adopted: [], total: 0 },
  compatPending: null, compatGate: { autoDisable: false, autoDetect: false },
  rollback: null, selfVersion: '0.5.92', components: [],
}
// 注解夹具：mem 有备注 + 3 个用户徽章；两组（记忆类有 mem；界面类里故意放一个**官方 family 成员**）
const ANNOTATIONS = {
  ok: true, file: '/tmp/plugin-annotations.json', exists: true, emptyFile: false, version: 1, updatedAt: 0,
  // 6 个用户徽章：宽卡（520px，实测得到）放得下；窄卡（拿不到宽度 ⇒ 保守默认 320px）必然要收进 +N
  plugins: { '@openviking/dsh-memory-plugin': { note: '记忆插件：给助手长期记忆', badges: ['必装', '记忆类', '只看这个', '别删', '自用', '收藏'] } },
  groups: [
    { id: 'g1', name: '记忆类', packages: ['@openviking/dsh-memory-plugin'], collapsed: false },
    { id: 'g2', name: '界面类', packages: ['@fake/dsh-web-all/plugin-manager'], collapsed: false },
  ],
  stats: { packages: 1, notes: 1, badges: 6, groups: 2, members: 2 },
  repaired: [], error: null,
}
const CHECK_UPDATES = {
  ok: true, checked: 4, updatable: 1, unknown: 0,
  items: [
    { packageName: '@openviking/dsh-memory-plugin', installedVersion: '1.0.0', latest: '1.2.0', next: null, beta: null, target: '1.2.0', source: 'npm', error: null, depsOutdated: [], migrate: null, status: 'update', cached: false },
    { packageName: 'dsh-search-tools', installedVersion: '2.0.0', latest: '2.0.0', next: null, beta: null, target: null, source: 'npm', error: null, depsOutdated: [], migrate: null, status: 'current', cached: false },
    { packageName: '@fake/dsh-web-all', installedVersion: '3.0.0', latest: '3.0.0', next: null, beta: null, target: null, source: 'npm', error: null, depsOutdated: [], migrate: null, status: 'current', cached: false },
    { packageName: '@fake/dsh-web-all/plugin-manager', installedVersion: '3.0.0', latest: '3.0.0', next: null, beta: null, target: null, source: 'npm', error: null, depsOutdated: [], migrate: null, status: 'current', cached: false },
  ],
  stats: { concurrencyLimit: 4, ttlMs: 60000, maxPackages: 200 },
}

/** 取**某一张卡片**上的徽章文案（按渲染顺序）。跨卡片比较说明不了"谁排在谁前面"。 */
function cardBadgeLabels(view, title) {
  const cards = view().nodes.filter((n) => n.tag === 'li' && n.props.className === 'pc_row')
  for (const card of cards) {
    const inner = flatten(card)
    if (!inner.nodes.some((n) => n.tag === 'strong' && n.props.title === title)) continue
    return inner.nodes.filter((n) => n.tag === 'span' && n.props.className === 'pc_tag').map((n) => String(n.props.children ?? ''))
  }
  return null
}
const installHost = () => {
  const fetchLog = []
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    fetchLog.push({ path: String(path), body, method: options?.method ?? 'GET' })
    const reply = (data) => ({ ok: true, status: 200, json: async () => data })
    if (path === '/plugin-console/state') return reply(STATE)
    if (path === '/plugin-console/sources') return reply({ ok: true, sources: { registries: [], gitSources: [], archiveSources: [], searchSources: [], primary: null } })
    if (path === '/plugin-console/annotations' && body === null) return reply(ANNOTATIONS)
    if (path === '/plugin-console/annotations') {
      const next = { ...ANNOTATIONS, plugins: { ...ANNOTATIONS.plugins }, groups: ANNOTATIONS.groups.map((g) => ({ ...g, packages: [...g.packages] })) }
      if (body.action === 'note') {
        if (String(body.note ?? '').trim() === '') delete next.plugins[body.packageName]
        else next.plugins[body.packageName] = { ...(next.plugins[body.packageName] ?? {}), note: String(body.note).trim() }
      }
      if (body.action === 'group-delete') {
        const index = next.groups.findIndex((g) => g.id === body.id)
        const deleted = index >= 0 ? next.groups.splice(index, 1)[0] : null
        return reply({ ok: true, action: body.action, changed: true, error: null, backup: null, file: next.file, key: null, group: null, deleted: deleted === null ? null : { group: deleted, index }, index: null, movedFrom: null, removedFrom: null, plugins: next.plugins, groups: next.groups, stats: next.stats })
      }
      return reply({ ok: true, action: body.action, changed: true, error: null, backup: null, file: next.file, key: body.packageName ?? null, group: null, deleted: null, index: null, movedFrom: null, removedFrom: null, plugins: next.plugins, groups: next.groups, stats: next.stats })
    }
    if (path === '/plugin-console/check-updates') return reply(CHECK_UPDATES)
    if (path === '/plugin-console/install') return reply({ ok: true, jobId: 'job-1' })
    if (path === '/plugin-console/install-status') return reply({ ok: true, job: null })
    if (path === '/plugin-console/details') return reply({ ok: true, entryId: body.entryId, rowId: 'mem', moduleName: '@openviking/dsh-memory-plugin', meta: { version: '1.0.0', description: 'desc', repository: null, homepage: null }, readme: null })
    return reply({ ok: true })
  }
  // 工具栏默认收起（localStorage 记状态）：本套要断言工具栏入口，所以让它展开
  globalThis.localStorage = { getItem: (key) => (String(key).includes('toolbar-open') ? '1' : ''), setItem: () => {}, removeItem: () => {} }
  delete globalThis.__DSH_DIRECTORY_PICKER__
  return fetchLog
}

/** 起一个主面板实例；badgeAreaWidth=null 表示"拿不到宽度"（组件走保守默认 320px 那条路）。 */
async function bootPanel({ badgeAreaWidth, cacheKey }) {
  const fetchLog = installHost()
  const react = makeReact({ badgeAreaWidth })
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
  const panel = {
    fetchLog, view, rerender,
    hasButton: (text) => view().buttons.some((b) => String(b.props?.children ?? '') === text),
    clickText: (text) => {
      const button = view().buttons.find((b) => String(b.props?.children ?? '') === text)
      if (button === undefined) throw new Error(`找不到按钮「${text}」；现有按钮：${view().buttons.map((b) => String(b.props?.children ?? '')).slice(0, 30).join(' | ')}`)
      button.props.onClick({ preventDefault: () => {}, key: 'x', currentTarget: {}, target: {} })
      return view()
    },
  }
  return { panel, view, rerender, fetchLog }
}

const flushAsync = async (times = 8) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

// ═══ A. 宽卡（宽度测得到）═══ ① / ①-b / ② / ③ / ③-b / ③-c / ③-d 全在这里跑
const A = await bootPanel({ badgeAreaWidth: 520, cacheKey: 'annotations-wide' })
{
  const { panel, view, rerender, fetchLog } = A
  const waitUntil = async (predicate, label, rounds = 60) => {
    for (let i = 0; i < rounds; i += 1) {
      if (predicate()) return true
      await new Promise((resolve) => setImmediate(resolve))
      rerender()
    }
    const flat = view()
    throw new Error(`等待超时：${label}；按钮：${flat.buttons.map((b) => String(b.props?.children ?? b.props?.['aria-label'] ?? '')).slice(0, 24).join(' | ')}；请求：${[...new Set(fetchLog.map((c) => `${c.method} ${c.path}`))].join(' , ')}`)
  }
  await flushAsync()
  rerender()
  await waitUntil(() => { const btn = view().buttons.find((b) => b.props?.['aria-label'] === 'checkAllUpdates'); return btn !== undefined && btn.disabled === false }, '/state 就绪')
  await waitUntil(() => view().nodes.some((n) => String(n.props?.children ?? '').includes('必装')), '注解加载（用户徽章出现在卡片上）')

  await checkAsync('① 表头有「↑↑↑」纯图标按钮（aria-label = checkAllUpdates，可见内容不是文字）', async () => {
    const btn = view().buttons.find((b) => b.props?.['aria-label'] === 'checkAllUpdates')
    assert.ok(btn, '找不到检测全部更新的图标按钮')
    assert.equal(typeof btn.props.children, 'object', `这个按钮应当是纯图标：${String(btn.props.children)}`)
    assert.ok(String(btn.props.title).includes('checkAllUpdates'), `title 缺失：${btn.props.title}`)
    assert.equal(btn.disabled, false, '未检测时按钮不该禁用')
  })

  await checkAsync('① 点它 → 真的 POST /check-updates，且带上全部包名', async () => {
    const before = fetchLog.length
    view().buttons.find((b) => b.props?.['aria-label'] === 'checkAllUpdates').props.onClick()
    await waitUntil(() => fetchLog.slice(before).some((c) => c.path === '/plugin-console/check-updates'), '/check-updates 请求')
    const call = fetchLog.slice(before).find((c) => c.path === '/plugin-console/check-updates')
    assert.deepEqual([...call.body.packageNames].sort(), ENTRIES.map((e) => e.moduleName).sort())
  })

  await checkAsync('① 完成后：出现「仅看可更新 · 1」，卡片上出现可点的「更新 → v1.2.0」', async () => {
    await waitUntil(() => panel.hasButton('batchUpdateOnly · 1'), '可更新筛选按钮')
    const updateBtn = view().buttons.find((b) => String(b.props?.children ?? '').startsWith('update → v'))
    assert.ok(updateBtn, '可更新的卡片上没有「更新」按钮')
    assert.ok(String(updateBtn.props.children).includes('1.2.0'), `更新按钮应点名目标版本：${updateBtn.props.children}`)
  })

  await checkAsync('① 点「更新 → v1.2.0」→ POST /install 且带上目标版本（与单卡更新同一条路）', async () => {
    const before = fetchLog.length
    view().buttons.find((b) => String(b.props?.children ?? '').startsWith('update → v')).props.onClick()
    await waitUntil(() => fetchLog.slice(before).some((c) => c.path === '/plugin-console/install'), '/install 请求')
    const call = fetchLog.slice(before).find((c) => c.path === '/plugin-console/install')
    assert.equal(call.body.packageName, '@openviking/dsh-memory-plugin', JSON.stringify(call.body))
    assert.equal(call.body.update, true, '应当是更新（update:true）')
    assert.equal(call.body.version, '1.2.0', `更新必须点名目标版本：${JSON.stringify(call.body.version)}`)
  })

  await checkAsync('①-b 点「仅看可更新」→ 只留可更新的那张卡；再点一次还原', async () => {
    const titlesOf = () => view().nodes.filter((n) => n.tag === 'strong' && n.props.className === 'pc_name' && n.props.title !== undefined).map((n) => String(n.props.title))
    const before = titlesOf()
    view().buttons.find((b) => String(b.props?.children ?? '').startsWith('batchUpdateOnly')).props.onClick()
    const filtered = titlesOf()
    assert.ok(filtered.length < before.length, `过滤后卡片应减少：${before.length} → ${filtered.length}`)
    assert.equal(filtered.filter((t2) => t2.includes('@openviking/dsh-memory-plugin')).length, 1, `可更新的那张应保留：${filtered.join(' | ')}`)
    assert.equal(filtered.filter((t2) => t2.includes('dsh-search-tools')).length, 0, `已最新的卡不该留下：${filtered.join(' | ')}`)
    view().buttons.find((b) => String(b.props?.children ?? '').startsWith('batchUpdateOnly')).props.onClick()
    assert.equal(titlesOf().length, before.length, '再点一次应还原')
  })

  check('② 同一张卡片上：系统徽章一条不少，且都排在用户徽章**之前**（追加，不替换/不合并）', () => {
    // ★ 变异验证抓到的**假绿**：原先在**全局**徽章列表里比顺序，于是"把用户徽章排到系统徽章前面"照样绿
    //   （别的卡片的系统徽章先出现在全局列表里）。必须**锁定同一张卡片**比。
    const labels = cardBadgeLabels(view, '@openviking/dsh-memory-plugin')
    assert.ok(labels !== null, '找不到 @openviking/dsh-memory-plugin 那张卡片')
    const iEnabled = labels.indexOf('enabledTag')
    const iExtra = labels.indexOf('extraTag')
    const iUser = labels.findIndex((label) => label.includes('必装') || label.includes('记忆类'))
    assert.ok(iEnabled >= 0, `系统徽章「已启用」不见了：${labels.join(' | ')}`)
    assert.ok(iExtra >= 0, `系统徽章「第三方」不见了：${labels.join(' | ')}`)
    assert.ok(iUser > iEnabled && iUser > iExtra, `用户徽章必须排在系统徽章之后（system=${iEnabled},${iExtra} user=${iUser}）：${labels.join(' | ')}`)
    const card = view().nodes.filter((n) => n.tag === 'li' && n.props.className === 'pc_row').find((li) => flatten(li).nodes.some((n) => n.tag === 'strong' && n.props.title === '@openviking/dsh-memory-plugin'))
    const userTag = flatten(card).nodes.find((n) => n.tag === 'span' && n.props.className === 'pc_tag' && String(n.props.children ?? '').includes('必装'))
    assert.equal(userTag.props['data-user-badge'], 'true', '用户徽章没有区分样式（data-user-badge）')
    const row = view().nodes.find((n) => n.tag === 'div' && n.props.className === 'pc_badgeRow')
    assert.ok(row, '没有徽章行容器（pc_badgeRow）')
  })

  await checkAsync('③ 详情页：用户备注/徽章块在最前面，动作按钮在最后', async () => {
    const detailBtn = view().buttons.find((b) => String(b.props?.children ?? '') === 'details')
    assert.ok(detailBtn, '没有「详情」按钮')
    detailBtn.props.onClick()
    await waitUntil(() => view().nodes.some((n) => n.props['data-annot'] === 'true'), '详情页用户注解块')
    const flat = view()
    const indexOf = (predicate) => flat.nodes.findIndex(predicate)
    const iAnnot = indexOf((n) => n.props['data-annot'] === 'true')
    const iVersion = indexOf((n) => n.tag === 'p' && String(n.props.children ?? '').startsWith('versionLabel'))
    const iCheck = indexOf((n) => n.tag === 'button' && String(n.props.children ?? '') === 'checkUpdate')
    assert.ok(iAnnot >= 0, '详情页里没有用户备注/徽章块（data-annot）')
    assert.ok(iVersion > iAnnot, `用户块必须在版本行之前（annot=${iAnnot} version=${iVersion}）`)
    assert.ok(iCheck > iVersion, `动作按钮必须在版本/说明之后（check=${iCheck} version=${iVersion}）`)
  })

  check('③-b 用户分组区块：官方 family 成员**不进**用户分组（官方 family 优先）', () => {
    const flat = view()
    const titles = flat.nodes.filter((n) => n.tag === 'strong' && n.props.title !== undefined).map((n) => String(n.props.title))
    assert.ok(titles.includes('记忆类'), `没有「记忆类」用户分组区块：${titles.join(' | ')}`)
    assert.ok(!titles.includes('界面类'), `「界面类」只含官方 family 成员 ⇒ 不该出现用户分组区块：${titles.join(' | ')}`)
    assert.ok(titles.includes('@fake/dsh-web-all'), `官方 family 区块不见了：${titles.join(' | ')}`)
  })

  await checkAsync('③-c 「备注插件」面板：写备注回车 → 真的 POST /annotations（action=note）', async () => {
    const before = fetchLog.length
    const openBtn = view().buttons.find((b) => b.props?.['aria-label'] === 'annotationsBtn')
    assert.ok(openBtn, '工具栏里没有「备注插件」入口（annotationsBtn）')
    openBtn.props.onClick()
    await waitUntil(() => panel.hasButton('noteEdit') || panel.hasButton('noteEmpty'), '备注插件面板渲染')
    const edit = view().buttons.find((b) => String(b.props?.children ?? '') === 'noteEdit')
    assert.ok(edit, `找不到「改备注」按钮：${view().buttons.map((b) => String(b.props?.children ?? '')).slice(0, 30).join(' | ')}`)
    edit.props.onClick()
    const area = view().nodes.find((n) => n.tag === 'textarea')
    assert.ok(area, '点「改备注」后没有出现就地编辑框')
    area.props.onChange({ currentTarget: { value: '  新的备注  ' }, target: { value: '  新的备注  ' } })
    view().nodes.find((n) => n.tag === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => {} })
    await waitUntil(() => fetchLog.slice(before).some((c) => c.path === '/plugin-console/annotations' && c.body?.action === 'note'), '备注写入请求')
    const call = fetchLog.slice(before).find((c) => c.path === '/plugin-console/annotations' && c.body?.action === 'note')
    assert.equal(call.body.packageName, '@openviking/dsh-memory-plugin', JSON.stringify(call.body))
    assert.equal(call.body.note, '  新的备注  ', '备注原文应交给服务端（trim/校验在服务端）')
  })

  await checkAsync('③-d 删分组是两段式：第一下零写入，确认后才发 group-delete，并给「撤销删除」', async () => {
    const before = fetchLog.length
    const trash = view().buttons.find((b) => b.props?.['aria-label'] === 'groupRemove')
    assert.ok(trash, '找不到删除分组按钮')
    trash.props.onClick()
    await flushAsync(4)
    assert.equal(fetchLog.slice(before).filter((c) => c.body?.action === 'group-delete').length, 0, '第一下就写入文件了（必须两段式）')
    await waitUntil(() => panel.hasButton('confirmDelete'), '确认删除按钮')
    view().buttons.find((b) => String(b.props?.children ?? '') === 'confirmDelete').props.onClick()
    await waitUntil(() => fetchLog.slice(before).some((c) => c.body?.action === 'group-delete'), 'group-delete 请求')
    assert.equal(fetchLog.slice(before).find((c) => c.body?.action === 'group-delete').body.id, 'g1')
    await waitUntil(() => panel.hasButton('groupRestore'), '「撤销删除」入口')
  })
}

// ═══ B. 窄卡 / 宽度拿不到（ref.current = null ⇒ 保守默认 320px）═══ ②-b 溢出收起
const B = await bootPanel({ badgeAreaWidth: null, cacheKey: 'annotations-narrow' })
{
  const { view, rerender, fetchLog } = B
  const waitUntil = async (predicate, label, rounds = 60) => {
    for (let i = 0; i < rounds; i += 1) {
      if (predicate()) return true
      await new Promise((resolve) => setImmediate(resolve))
      rerender()
    }
    throw new Error(`等待超时：${label}；按钮：${view().buttons.map((b) => String(b.props?.children ?? '')).slice(0, 24).join(' | ')}；请求：${[...new Set(fetchLog.map((c) => `${c.method} ${c.path}`))].join(' , ')}`)
  }
  await flushAsync()
  rerender()
  await waitUntil(() => view().buttons.some((b) => b.props?.['aria-label'] === 'checkAllUpdates' && b.disabled === false), '/state 就绪')
  await waitUntil(() => view().nodes.some((n) => n.tag === 'div' && n.props.className === 'pc_badgeRow'), '徽章行渲染')

  check('②-b 宽度拿不到 ⇒ 用保守默认 320px：放不下的尾部收进「+N」（单行不换行）', () => {
    const card = view().nodes.filter((n) => n.tag === 'li' && n.props.className === 'pc_row').find((li) => flatten(li).nodes.some((n) => n.tag === 'strong' && n.props.title === '@openviking/dsh-memory-plugin'))
    assert.ok(card, '找不到 mem 卡片')
    const cardButtons = flatten(card).buttons
    const overflow = cardButtons.find((b) => String(b.props?.children ?? '').startsWith('+'))
    assert.ok(overflow, `mem 卡片上没出现 +N 收起按钮：${cardButtons.map((b) => String(b.props?.children ?? '')).join(' | ')}`)
    const hidden = Number(String(overflow.props.children).slice(1))
    assert.ok(hidden >= 1, `+N 的 N 应 ≥1：${overflow.props.children}`)
    // 收起发生在尾部 ⇒ 系统徽章优先保留
    const labels = cardBadgeLabels(view, '@openviking/dsh-memory-plugin')
    assert.ok(labels.includes('enabledTag'), `收起后仍应保留系统徽章：${labels.join(' | ')}`)
  })

  check('②-b 点「+N」→ 全部徽章都看得到（系统 + 用户，用户带虚线样式）', () => {
    const card0 = view().nodes.filter((n) => n.tag === 'li' && n.props.className === 'pc_row').find((li) => flatten(li).nodes.some((n) => n.tag === 'strong' && n.props.title === '@openviking/dsh-memory-plugin'))
    flatten(card0).buttons.find((b) => String(b.props?.children ?? '').startsWith('+')).props.onClick()
    const labels = cardBadgeLabels(view, '@openviking/dsh-memory-plugin') ?? []
    for (const want of ['enabledTag', 'extraTag', '必装', '记忆类', '只看这个', '别删', '自用', '收藏']) {
      assert.ok(labels.some((label) => label.includes(want)), `展开后缺徽章「${want}」：${labels.join(' | ')}`)
    }
    const card1 = view().nodes.filter((n) => n.tag === 'li' && n.props.className === 'pc_row').find((li) => flatten(li).nodes.some((n) => n.tag === 'strong' && n.props.title === '@openviking/dsh-memory-plugin'))
    const userTag = flatten(card1).nodes.find((n) => n.tag === 'span' && n.props.className === 'pc_tag' && String(n.props.children ?? '').includes('必装'))
    assert.equal(userTag.props['user-badge'] ?? userTag.props['data-user-badge'], 'true', '用户徽章缺少区分样式')
  })
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
