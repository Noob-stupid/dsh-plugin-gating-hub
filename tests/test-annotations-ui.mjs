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
//   ②-b **行为变更（0.5.93，用户定稿）**：卡片上不再出现「+N」——放不下的徽章直接看不见、不给任何
//      "还有 N 个"的提示（与这个功能上线前一致），截断交给**纯 CSS**（固定高度 + overflow:hidden +
//      white-space:nowrap），且客户端**不许再做宽度测量**（ResizeObserver 正是"徽章挤压变化"的源头）；
//      全部徽章（系统 + 用户）在**详情页**里一次看全。
//      → 旧断言「宽度测不到 ⇒ 收进 +N」「点 +N 看全部」随行为变更**有意识重写**（不是删除，理由写在
//        commit message 与本段注释里）。
//   ③ 用户备注/徽章块在详情页**最前面**（先于版本行），动作按钮在**最后**。
//   ③-b 用户分组区块：官方 family 成员**不进**用户分组（官方 family 优先，用户拍定的规则）。
//   ③-c 「备注插件」面板：写备注回车 → 真的 POST /annotations {action:'note'}；没备注时只显示「＋ 加备注」。
//   ③-d 删分组是**两段式**（第一下只上膛、零写入），确认后才发 group-delete，并给「撤销删除」。
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
  // 假服务端里的**可写副本**：写动作之间要能看到彼此的效果（建分组 → 加成员 → 改名 → 删），
  // 但 GET（面板打开/重开）仍返回**静态夹具** ANNOTATIONS —— 两个作用刻意分开：
  //   · ② 的"重新打开面板"断言依赖 GET 拿到夹具；
  //   · ③ 的"建完立刻同步 / 框内增删 / 改名"依赖写动作之间共享同一份可变状态。
  const live = { plugins: { ...ANNOTATIONS.plugins }, groups: ANNOTATIONS.groups.map((g) => ({ ...g, packages: [...g.packages] })) }
  const annReply = (extra) => ({ ok: true, status: 200, json: async () => ({ ok: true, action: null, changed: true, error: null, backup: null, file: ANNOTATIONS.file, key: null, group: null, deleted: null, index: null, movedFrom: null, removedFrom: null, plugins: live.plugins, groups: live.groups, stats: ANNOTATIONS.stats, ...extra }) })
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    fetchLog.push({ path: String(path), body, method: options?.method ?? 'GET' })
    const reply = (data) => ({ ok: true, status: 200, json: async () => data })
    if (path === '/plugin-console/state') return reply(STATE)
    if (path === '/plugin-console/sources') return reply({ ok: true, sources: { registries: [], gitSources: [], archiveSources: [], searchSources: [], primary: null } })
    if (path === '/plugin-console/annotations' && body === null) return reply(ANNOTATIONS)
    if (path === '/plugin-console/annotations') {
      if (body.action === 'note') {
        if (String(body.note ?? '').trim() === '') delete live.plugins[body.packageName]
        else live.plugins[body.packageName] = { ...(live.plugins[body.packageName] ?? {}), note: String(body.note).trim() }
      }
      if (body.action === 'group-create') {
        const group = { id: 'gnew' + String(live.groups.length + 1), name: String(body.name ?? '').trim(), packages: [], collapsed: false }
        live.groups.push(group)
        return annReply({ action: body.action, group })
      }
      if (body.action === 'group-assign') {
        const group = live.groups.find((g) => g.id === body.id)
        if (group !== undefined) {
          if (body.member === false) group.packages = group.packages.filter((p) => p !== body.packageName)
          else if (!group.packages.includes(body.packageName)) group.packages.push(body.packageName)
        }
        return annReply({ action: body.action, key: body.packageName ?? null })
      }
      if (body.action === 'group-rename') {
        const group = live.groups.find((g) => g.id === body.id)
        if (group !== undefined) group.name = String(body.name ?? '')
        return annReply({ action: body.action, group: group ?? null })
      }
      if (body.action === 'group-delete') {
        const index = live.groups.findIndex((g) => g.id === body.id)
        const deleted = index >= 0 ? live.groups.splice(index, 1)[0] : null
        return annReply({ action: body.action, deleted: deleted === null ? null : { group: deleted, index } })
      }
      return annReply({ action: body.action, key: body.packageName ?? null })
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

  await checkAsync('②-b 详情页：全部徽章一次看全（系统徽章 + 用户徽章都在，卡片上放不下的也在这）', async () => {
    // ★ 必须点**有用户徽章的那张卡**（mem）的「详情」：它被归进用户分组区块 ⇒ 不是列表里的第一张，
    //   上面 ③ 点的"第一个详情按钮"其实是 search 那张卡（没有用户徽章）—— 拿它断言会假绿。
    const memCard = view().nodes.filter((n) => n.tag === 'li' && n.props.className === 'pc_row')
      .find((li) => flatten(li).nodes.some((n) => n.tag === 'strong' && n.props.title === '@openviking/dsh-memory-plugin'))
    assert.ok(memCard, '找不到 mem 卡片')
    const detailBtn = flatten(memCard).buttons.find((b) => String(b.props?.children ?? '') === 'details')
    assert.ok(detailBtn, 'mem 卡片上没有「详情」按钮')
    detailBtn.props.onClick()
    const rowLabels = () => {
      const row = view().nodes.find((n) => n.props?.['data-allbadges'] === 'true')
      return row === undefined ? null : flatten(row).nodes.filter((n) => n.tag === 'span' && n.props.className === 'pc_tag').map((n) => String(n.props.children ?? ''))
    }
    await waitUntil(() => (rowLabels() ?? []).some((label) => label.includes('必装')), 'mem 详情页的「全部徽章」行')
    const labels = rowLabels()
    assert.ok(labels !== null, '详情页里没有「全部徽章」行（data-allbadges）')
    for (const want of ['enabledTag', 'extraTag', '必装', '记忆类', '只看这个', '别删', '自用', '收藏']) {
      assert.ok(labels.some((label) => label.includes(want)), `详情页"全部徽章"缺「${want}」：${labels.join(' | ')}`)
    }
    // 顺序与卡片一致：系统徽章在前、用户徽章在后
    const iEnabled = labels.indexOf('enabledTag')
    const iUser = labels.findIndex((label) => label.includes('必装'))
    assert.ok(iEnabled >= 0 && iUser > iEnabled, `详情页徽章顺序不对（system=${iEnabled} user=${iUser}）：${labels.join(' | ')}`)
  })

  check('③-b 用户分组区块：官方 family 成员**不进**用户分组（官方 family 优先）', () => {
    const flat = view()
    const titles = flat.nodes.filter((n) => n.tag === 'strong' && n.props.title !== undefined).map((n) => String(n.props.title))
    assert.ok(titles.includes('记忆类'), `没有「记忆类」用户分组区块：${titles.join(' | ')}`)
    assert.ok(!titles.includes('界面类'), `「界面类」只含官方 family 成员 ⇒ 不该出现用户分组区块：${titles.join(' | ')}`)
    assert.ok(titles.includes('@fake/dsh-web-all'), `官方 family 区块不见了：${titles.join(' | ')}`)
  })

  await checkAsync('③-c「备注插件」面板：列表默认收起 → 点开 → 写备注回车 → 真的 POST /annotations（action=note）', async () => {
    const before = fetchLog.length
    const openBtn = view().buttons.find((b) => b.props?.['aria-label'] === 'annotationsBtn')
    assert.ok(openBtn, '工具栏里没有「备注插件」入口（annotationsBtn）')
    openBtn.props.onClick()
    // ★ 0.5.93 行为变更：面板打开时插件列表**收起** ⇒ 得先点开列表，才谈得上"改备注"。
    //   旧断言假定打开面板就有 noteEdit/noteEmpty，随行为变更**有意识**改（理由见 commit message）。
    await waitUntil(() => view().buttons.some((b) => b.props?.['aria-label'] === 'annotationsListToggle'), '备注插件面板渲染（列表摘要行）')
    view().buttons.find((b) => b.props?.['aria-label'] === 'annotationsListToggle').props.onClick()
    await waitUntil(() => panel.hasButton('noteEdit') || panel.hasButton('noteEmpty'), '展开后插件行渲染')
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

  // ── ② 收口：插件列表默认收起 + 可搜索（每一条都能失败）────────────────────────────
  const listToggle = () => view().buttons.find((b) => b.props?.['aria-label'] === 'annotationsListToggle')
  const searchBox = () => view().nodes.find((n) => n.props?.['aria-label'] === 'annotationsSearch')
  /** 面板里那份插件行的包名（只数 data-annotlist 这一棵子树，别和主列表的卡片混起来）。 */
  const panelRowNames = () => {
    const ul = view().nodes.find((n) => n.props?.['data-annotlist'] === 'true')
    if (ul === undefined) return null
    return flatten(ul).nodes.filter((n) => n.tag === 'li').map((li) => String(flatten(li).nodes.find((x) => x.tag === 'strong')?.props?.title ?? ''))
  }
  /** 面板卡片内部（`pc_modalCard`）的「改备注」按钮数 —— 不能算上主列表里展开着的详情页。 */
  const panelNoteEditCount = () => {
    const card = view().nodes.find((n) => n.props?.className === 'pc_modalCard')
    return card === undefined ? -1 : flatten(card).buttons.filter((b) => String(b.props?.children ?? '') === 'noteEdit').length
  }

  check('② 列表可展开/收起：摘要行给「插件列表（N）· 点此展开」，收起时插件行与搜索框都不渲染', () => {
    const toggle = listToggle()
    assert.ok(toggle, '面板里没有列表开关（annotationsListToggle）')
    assert.equal(String(toggle.props.children), 'annotationsListHide', `展开时摘要该说"点此收起"：${String(toggle.props.children)}`)
    assert.ok(panelRowNames() !== null, '展开时没有插件列表（data-annotlist）')
    toggle.props.onClick()
    const collapsed = listToggle()
    assert.equal(String(collapsed.props.children), 'annotationsListShow', `收起时摘要该说"点此展开"：${String(collapsed.props.children)}`)
    assert.equal(panelRowNames(), null, '收起时仍在渲染插件列表')
    assert.equal(searchBox(), undefined, '收起时不该有搜索框')
    assert.equal(panelNoteEditCount(), 0, `收起时面板里仍在渲染插件行的备注按钮（${panelNoteEditCount()} 个）`)
    collapsed.props.onClick()
    assert.ok(panelRowNames() !== null, '再点一次应重新展开')
  })

  await checkAsync('② 每次打开面板都回到**收起**状态（不残留上次的展开/查询）', async () => {
    // 先把查询框填上字，再关掉面板重新打开 —— 重新打开必须是"收起 + 空查询"
    searchBox().props.onChange({ target: { value: 'search' } })
    assert.equal(searchBox().props.value, 'search', '搜索框该是受控的')
    view().buttons.find((b) => b.props?.['aria-label'] === 'annotationsBtn').props.onClick() // 关
    await flushAsync(2)
    view().buttons.find((b) => b.props?.['aria-label'] === 'annotationsBtn').props.onClick() // 开
    await waitUntil(() => listToggle() !== undefined, '重新打开后的列表摘要行')
    assert.equal(String(listToggle().props.children), 'annotationsListShow', '重新打开面板时列表应回到收起')
    listToggle().props.onClick()
    assert.equal(searchBox().props.value, '', '重新打开面板时查询词应清空')
  })

  check('② 搜索按**备注内容**即时过滤（边打边筛，不用点按钮）；过滤不清掉正在输入的内容', () => {
    // 备注夹具：'记忆插件：给助手长期记忆'（重新打开面板会重读 GET /annotations，拿到的是这份夹具）
    searchBox().props.onChange({ target: { value: '长期记忆' } })
    assert.equal(searchBox().props.value, '长期记忆', '过滤把用户正在输入的内容清掉了')
    const names = panelRowNames()
    assert.ok(names !== null, '按备注过滤后把整份列表都滤掉了（应当只剩 mem 那一行）')
    assert.equal(names.length, 1, `按备注过滤后应只剩 mem 那一行：${names.join(' | ')}`)
    assert.ok(names[0].includes('@openviking/dsh-memory-plugin'), `过滤结果不对：${names.join(' | ')}`)
  })

  check('② 搜索按**包名 / rowId** 过滤（同一套即时过滤）', () => {
    searchBox().props.onChange({ target: { value: 'dsh-search-tools' } })
    assert.deepEqual(panelRowNames(), ['dsh-search-tools'], `按包名过滤结果不对：${panelRowNames()?.join(' | ')}`)
    searchBox().props.onChange({ target: { value: 'web-all__pm' } })
    assert.deepEqual(panelRowNames(), ['@fake/dsh-web-all/plugin-manager'], `按 rowId 过滤结果不对：${panelRowNames()?.join(' | ')}`)
  })

  check('② 无匹配要有文字（「没有匹配的插件」），不能空白；清空查询后恢复全部', () => {
    searchBox().props.onChange({ target: { value: 'zzz-not-a-plugin' } })
    assert.equal(panelRowNames(), null, '无匹配时不该还在渲染插件列表')
    const texts = view().texts
    assert.ok(texts.includes('annotationsNoMatch'), `无匹配时没有文字提示：${texts.slice(-12).join(' | ')}`)
    assert.equal(searchBox().props.value, 'zzz-not-a-plugin', '无匹配时输入框里的字被清掉了')
    searchBox().props.onChange({ target: { value: '' } })
    assert.equal(panelRowNames().length, ENTRIES.length, `清空查询后应恢复全部 ${ENTRIES.length} 行：${panelRowNames()?.join(' | ')}`)
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

  // ── ③ 收口：新建分组 = 回车触发 + 入场动画 + 家族式横框 + 框内增删 + 主列表立刻同步 ───────────
  const groupCreateInput = () => view().nodes.find((n) => n.tag === 'input' && n.props?.placeholder === 'groupCreatePlaceholder')
  const groupFrames = () => view().nodes.filter((n) => n.props?.['data-usergroup'] === 'true')
  const frameNamed = (name) => groupFrames().find((f) => flatten(f).nodes.some((n) => n.tag === 'strong' && n.props.title === name))

  await checkAsync('③ 新建分组只认**回车**：打字期间一次请求都不发，回车才 POST group-create', async () => {
    const before = fetchLog.length
    assert.ok(groupCreateInput(), '面板里没有「新建分组」输入框')
    for (const text of ['新', '新组', '新组A']) {
      groupCreateInput().props.onChange({ target: { value: text } })
      await flushAsync(3)
      assert.equal(fetchLog.slice(before).filter((c) => c.body?.action === 'group-create').length, 0,
        `打到「${text}」就发建组请求了（必须回车这个明确动作才建）`)
    }
    assert.equal(groupCreateInput().props.value, '新组A', '输入框该是受控的')
    groupCreateInput().props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    await waitUntil(() => fetchLog.slice(before).some((c) => c.body?.action === 'group-create' && c.body.name === '新组A'), 'group-create 请求')
    assert.equal(groupCreateInput().props.value, '', '建完该把输入框清空')
  })

  await checkAsync('③ 主列表**立刻**出现新分组的横框：标题行 + 折叠箭头 + 与官方 family 同一套视觉语言', async () => {
    // 写动作的响应是异步落的（setAnnotations 用服务端全量状态覆盖）⇒ 等它真的落到界面上再断言，
    // 不然断言到的是"还没同步"的中间态（本轮实测踩到：frame 有了但动画标记还没到）。
    await waitUntil(() => frameNamed('新组A') !== undefined && frameNamed('新组A').props['data-new-group'] === 'true', '带动画标记的新分组横框')
    const frame = frameNamed('新组A')
    assert.ok(frame, `主列表里没有新分组的横框：${groupFrames().map((f) => String(f.props['data-group-id'])).join(' | ')}`)
    const flat = flatten(frame)
    // 容器：与官方 family 区块同一个 .pc_detail 容器 + 同一条边框（"家族式"就在这里）
    assert.ok(String(frame.props.className).includes('pc_detail'), `横框容器不是 family 那套：${frame.props.className}`)
    assert.equal(String(frame.props.style?.border), '1px solid var(--dsw-alias-state-business-primary)',
      `横框边框与官方 family 不一致：${JSON.stringify(frame.props.style?.border)}`)
    // 标题行 + 折叠箭头（▾/▸ + 既有 familyCollapse/familyExpand 文案）
    assert.ok(flat.nodes.some((n) => n.tag === 'strong' && n.props.title === '新组A'), '横框没有标题行')
    const arrow = flat.buttons.find((b) => /^[▾▸]/u.test(String(b.props?.children ?? '')))
    assert.ok(arrow, `横框没有折叠箭头：${flat.buttons.map((b) => String(b.props?.children ?? '')).join(' | ')}`)
    // 新建出来的那个带动画标记
    assert.equal(frame.props['data-new-group'], 'true', '新建的横框没有入场动画标记（data-new-group）')
  })

  check('③ 入场动画：150–300ms 纯 CSS，且 prefers-reduced-motion 下不播', () => {
    const rule = /\.pc_groupNew\{([^}]*)\}/u.exec(SRC)
    assert.ok(rule !== null, '样式里没有 .pc_groupNew（新建横框的入场动画）')
    const ms = /(\d+)ms/u.exec(rule[1])
    assert.ok(ms !== null, `.pc_groupNew 没写时长：${rule[1]}`)
    const duration = Number(ms[1])
    assert.ok(duration >= 150 && duration <= 300, `动画时长该在 150–300ms：${duration}ms`)
    assert.ok(/animation:pcGroupIn/u.test(rule[1]), `动画名不是 pcGroupIn：${rule[1]}`)
    assert.ok(/@keyframes pcGroupIn\{/u.test(SRC), '没有 pcGroupIn 关键帧')
    assert.ok(/@media \(prefers-reduced-motion:reduce\)\{\.pc_groupNew\{animation:none\}\}/u.test(SRC),
      '缺少 prefers-reduced-motion 的分支（系统开了减少动效就必须不播）')
  })

  await checkAsync('③ 横框里可以直接加入 / 移出插件（group-assign，加入后立刻在框里）', async () => {
    const groupId = String(frameNamed('新组A')?.props['data-group-id'] ?? '')
    assert.ok(groupId !== '', '拿不到新分组的 id')
    const add = flatten(frameNamed('新组A')).nodes.find((n) => n.tag === 'select' && n.props?.['aria-label'] === 'groupMemberAdd')
    assert.ok(add, '横框里没有「加进分组」的下拉')
    const options = flatten(frameNamed('新组A')).nodes.filter((n) => n.tag === 'option').map((n) => String(n.props?.children ?? ''))
    assert.ok(options.includes('dsh-search-tools'), `下拉里没有候选插件：${options.join(' | ')}`)
    const before = fetchLog.length
    add.props.onChange({ target: { value: 'dsh-search-tools' } })
    await waitUntil(() => fetchLog.slice(before).some((c) => c.body?.action === 'group-assign'), 'group-assign（加入）请求')
    const call = fetchLog.slice(before).find((c) => c.body?.action === 'group-assign')
    assert.equal(call.body.packageName, 'dsh-search-tools', JSON.stringify(call.body))
    assert.equal(call.body.id, groupId, `加入请求的分组 id 不对：${JSON.stringify(call.body)}`)
    assert.notEqual(call.body.member, false, '加入请求不该带 member:false')
    // 加进去之后：成员 chip 的 × 能直接移出（只解除归属）
    await waitUntil(() => flatten(frameNamed('新组A') ?? { props: {} }).nodes.some((n) => n.props?.['aria-label'] === 'groupMemberRemove') ||
      (frameNamed('新组A') !== undefined && flatten(frameNamed('新组A')).nodes.some((n) => n.props?.['aria-label'] === 'groupMemberRemove')), '成员 chip')
    const frameNow = frameNamed('新组A')
    assert.ok(frameNow, '加入成员后横框不见了')
    const removeBtn = flatten(frameNow).nodes.find((n) => n.props?.['aria-label'] === 'groupMemberRemove')
    assert.ok(removeBtn, '横框里没有移出成员（×）的入口')
    const before2 = fetchLog.length
    removeBtn.props.onClick()
    await waitUntil(() => fetchLog.slice(before2).some((c) => c.body?.action === 'group-assign' && c.body.member === false), 'group-assign（移出）请求')
    assert.equal(fetchLog.slice(before2).find((c) => c.body?.action === 'group-assign').body.packageName, 'dsh-search-tools')
  })

  await checkAsync('③ 重命名不退化：面板里就地编辑、**回车才写** group-rename，主列表跟着改', async () => {
    const row = view().nodes.filter((n) => n.tag === 'li' && n.props.className === 'pc_row')
      .find((li) => flatten(li).nodes.some((n) => n.tag === 'strong' && String(n.props.children ?? '') === '新组A'))
    assert.ok(row, '面板的分组列表里找不到「新组A」那一行')
    const renameBtn = flatten(row).buttons.find((b) => String(b.props?.children ?? '') === 'groupRename')
    assert.ok(renameBtn, '找不到「重命名」按钮')
    renameBtn.props.onClick()
    const renameInput = view().nodes.find((n) => n.tag === 'input' && n.props?.['aria-label'] === 'groupRename')
    assert.ok(renameInput, '点「重命名」后没有出现就地编辑框')
    assert.equal(renameInput.props.value, '新组A', '编辑框该带出原名')
    const before = fetchLog.length
    renameInput.props.onChange({ target: { value: '新组B' } })
    await flushAsync(3)
    assert.equal(fetchLog.slice(before).filter((c) => c.body?.action === 'group-rename').length, 0, '打字期间就改名了（必须回车）')
    view().nodes.find((n) => n.tag === 'input' && n.props?.['aria-label'] === 'groupRename').props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    await waitUntil(() => fetchLog.slice(before).some((c) => c.body?.action === 'group-rename' && c.body.name === '新组B'), 'group-rename 请求')
    await waitUntil(() => frameNamed('新组B') !== undefined, '主列表的横框跟着改名')
  })
}

// ═══ B. 0.5.93 行为变更：卡片上**不再收 +N**，放不下由纯 CSS 截断、全部徽章看详情页 ═══
// 第二个实例刻意让"宽度拿不到"（ref.current === null）：旧实现会走保守默认 320px 那条路，
// 新实现**根本不读宽度**，所以两个实例的卡片徽章必须**逐条相同**（这条就是我想要的反向钉子）。
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

  check('②-b 卡片上没有「+N」收起按钮（放不下就不显示，不给"还有几个"的提示）', () => {
    const card = view().nodes.filter((n) => n.tag === 'li' && n.props.className === 'pc_row').find((li) => flatten(li).nodes.some((n) => n.tag === 'strong' && n.props.title === '@openviking/dsh-memory-plugin'))
    assert.ok(card, '找不到 mem 卡片')
    const cardButtons = flatten(card).buttons
    const overflow = cardButtons.filter((b) => /^\+\d+/u.test(String(b.props?.children ?? '')))
    assert.equal(overflow.length, 0, `卡片上仍有 +N 收起按钮：${cardButtons.map((b) => String(b.props?.children ?? '')).join(' | ')}`)
    // 整个面板都不许再出现"还有 N 个"的入口（按钮或徽章）
    const anyMore = view().nodes.filter((n) => String(n.props?.['aria-label'] ?? '').startsWith('badgeOverflowTip'))
    assert.equal(anyMore.length, 0, '面板里仍出现 badgeOverflowTip 提示')
  })

  check('②-b 徽章一条不少地渲染在卡片上（截断由 CSS 完成，不是"少渲染"）', () => {
    const labels = cardBadgeLabels(view, '@openviking/dsh-memory-plugin') ?? []
    for (const want of ['enabledTag', 'extraTag', '必装', '记忆类', '只看这个', '别删', '自用', '收藏']) {
      assert.ok(labels.some((label) => label.includes(want)), `卡片上缺徽章「${want}」：${labels.join(' | ')}`)
    }
  })

  check('②-b 徽章行：固定高度 + 单行不换行 + overflow:hidden（纯 CSS 截断），客户端**零宽度测量**', () => {
    const rule = /\.pc_badgeRow\{([^}]*)\}/u.exec(SRC)
    assert.ok(rule !== null, '找不到 .pc_badgeRow 的样式规则')
    const body = rule[1]
    for (const want of ['overflow:hidden', 'white-space:nowrap', 'flex-wrap:nowrap', 'height:20px']) {
      assert.ok(body.includes(want), `.pc_badgeRow 缺「${want}」：${body}`)
    }
    // 先把注释剔掉再查 —— 注释里**提到**这些名字是说明，不是实现（假绿/假红都躲开）
    const CODE = SRC.split('\n').map((line) => (/^\s*\/\//u.test(line) ? '' : line)).join('\n')
    // 「不许做宽度测量」的钉子是**硬的**：代码里出现任何测量/观察都算复发
    assert.equal(/ResizeObserver/u.test(CODE), false, '客户端代码里又出现了 ResizeObserver（宽度测量正是徽章抖动的来源）')
    assert.equal(/clientWidth/u.test(CODE), false, '客户端代码里又出现了 clientWidth 宽度测量')
    assert.equal(/fitBadgeList|fitBadgeChunks|badgeChipWidthOf/u.test(CODE), false, '徽章宽度估算函数又回来了（= 又在按测量值决定显示几个）')
  })
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
