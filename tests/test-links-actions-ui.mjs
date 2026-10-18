// link 面板的**行为**判据：用假 React **真渲染**主面板，再把按钮真点一遍（0.5.87 加法）
//
// 为什么非要做真渲染：2026-10-18 一天之内连续踩的是同一类 —— **服务端有、界面点不到**：
//   ① `/dev-roots` / `/pin-dev-dir` 的 POST body 根本没到 handler（"钉住"必 403）；
//   ② 按钮在一处、判据在另一处（点下去必然 409）。
//   静态 regex 只能证明"代码里有这串字"，证明不了"点这个按钮会发生这件事"。
//
// 本套钉死（每条都能失败）：
//   ① 「浏览…」**只在宿主真的提供系统目录对话框时存在**（有桥 → 有按钮；没桥 → 按钮不存在，
//      不是灰掉、不是点了没反应）。web 端就是"没桥"这条负控。
//   ② 行内动作**按服务端结论出现**：缺依赖才有 [补齐依赖]、能造垫片才有 [造垫片]；
//      缺 peer 但补不了（shimmablePeers 空）⇒ **不出现**；什么都不缺的行只有 [取消钉住]。
//   ③ 钉住是**两段式**：点 [钉住] 只发只读计划（**不带 confirm**），计划（包名 + 步骤）先给人看；
//      点了 [确认钉住] 才发 confirm:true。前端拿不到"跳过确认"的路子。
//   ④ 取消钉住同样是两段式，且把服务端的 warnings（"它还在 bundles 里"）先摆出来。
//   ⑤ 行内动作真的发对了 kind（deps / shims）与包名，并把服务端 note 原话显示出来。
//   ⑥ 目标目录的改动时间：有就显示（本地化格式），拿不到就显示「—」（绝不编造）。
//   ⑦ [重新读取] 真的重新拉一次清单（不是本地重算）。
//
// 全离线：不发一次真实网络请求（fetch 全替身），不碰真实 DSH_HOME。
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
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

// ── 假 React：**真的** hooks 运行时（useState 真能重渲染，惰性初始值真的求值）──────────────
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
      // 惰性初始值必须**求值**（真 React 的语义）：主面板里大量 `useState(() => localStorage…)`，
      // 不求值就会把函数本身当状态用（探针期实测：installedQuery.trim is not a function）。
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const nextValue = typeof next === 'function' ? next(hooks[index]) : next
        hooks[index] = nextValue
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

/** 把元素树折成可断言的东西（文本 / 按钮 / 标签 / 输入框 / select）。 */
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

/** 一份"服务端说什么"的清单夹具（字段与 domain/link-inventory.js 逐项对齐）。 */
const LINKS = {
  ok: true, count: 3, readyCount: 1,
  items: [
    {
      packageName: 'lonely', spec: 'link:D:/dev/lonely', target: 'D:/dev/lonely', targetExists: true,
      targetMtime: '2026-10-18T06:03:00.000Z', version: '0.1.0', ready: false,
      missingDeps: ['left-pad'], missingPeers: ['@deepseek-ai/dsh-llm'], shimmablePeers: ['@deepseek-ai/dsh-llm'],
      unavailablePeers: [], foreignPeers: [], shims: null, persisted: { ok: true, missing: [] }, note: null, error: null,
    },
    {
      packageName: 'good', spec: 'link:D:/dev/good', target: 'D:/dev/good', targetExists: true,
      targetMtime: null, version: '1.0.0', ready: true,
      missingDeps: [], missingPeers: [], shimmablePeers: [], unavailablePeers: [], foreignPeers: [],
      shims: { count: 2, items: [], updatedAt: null, note: null }, persisted: { ok: true, missing: [] }, note: null, error: null,
    },
    {
      // ★ 缺 peer 但**补不了**（框架根里没有）⇒ 面板不许摆一个点了只会失败的 [造垫片]
      packageName: 'cannot', spec: 'link:D:/dev/cannot', target: 'D:/dev/cannot', targetExists: true,
      targetMtime: '2026-01-02T03:04:05.000Z', version: '2.0.0', ready: false,
      missingDeps: [], missingPeers: ['@deepseek-ai/dsh-nowhere'], shimmablePeers: [], unavailablePeers: ['@deepseek-ai/dsh-nowhere'],
      foreignPeers: [], shims: null, persisted: { ok: true, missing: [] }, note: null, error: null,
    },
  ],
}

/** 装一份"假宿主"全局（window/document/localStorage/fetch），并记下每次请求与每次目录对话框调用。 */
function installHost({ withPicker }) {
  const fetchLog = []
  const picker = { calls: 0, value: 'D:/picked/from/dialog', pick: async () => { picker.calls += 1; return picker.value } }
  globalThis.fetch = async (path, options) => {
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    fetchLog.push({ path: String(path), body, method: options?.method ?? 'GET' })
    const reply = (data) => ({ ok: true, status: 200, json: async () => data })
    if (path === '/plugin-console/links') return reply(LINKS)
    if (path === '/plugin-console/dev-roots') return reply({ ok: true, roots: ['D:/dev', 'D:/plugin-src'], warnings: [], file: 'x' })
    if (path === '/plugin-console/pin-dev-dir') {
      return reply({
        ok: true, applied: body.confirm === true, packageName: 'demo', version: '0.1.0',
        spec: 'link:D:/dev/demo', current: null, marker: 'bundle', root: 'D:/dev',
        after: body.confirm === true ? 'link:D:/dev/demo' : null,
        sufficiency: body.confirm === true ? { ok: true, ready: true, note: '链接目标现已自足', created: 0 } : null,
        steps: ['把 demo 的来源写成 link:D:/dev/demo（清单 dependencies）', '跑一次 pnpm install --lockfile-only', '读回归属与 lock 复核'],
      })
    }
    if (path === '/plugin-console/unpin-dev-dir') {
      return reply(body.confirm === true
        ? { ok: true, applied: true, packageName: body.packageName, spec: 'link:D:/dev/x', target: 'D:/dev/x', inBundles: true, removed: { manifest: true, lock: true, nodeModules: true }, backup: 'x.bak', warnings: ['它仍在 dsh.profile.bundles 里'], note: '已从 profile 清单移除；开发目录与代码未被删除' }
        : { ok: true, applied: false, packageName: body.packageName, spec: 'link:D:/dev/x', target: 'D:/dev/x', targetExists: true, inBundles: true, bundles: ['x'], warnings: ['它仍在 dsh.profile.bundles 里：取消钉住后这个 bundle 会解析不到'], steps: ['备份 profile 清单', '执行 pnpm remove'] })
    }
    if (path === '/plugin-console/link-repair') {
      return reply({ ok: true, kind: body.kind, packageName: body.packageName, ready: false, changed: true, note: `服务端说：${body.kind} 补了 1 处` })
    }
    return reply({ ok: true })
  }
  globalThis.localStorage = { getItem: (key) => (String(key).includes('toolbar-open') ? '1' : ''), setItem: () => {}, removeItem: () => {} }
  if (withPicker) globalThis.__DSH_DIRECTORY_PICKER__ = picker
  else delete globalThis.__DSH_DIRECTORY_PICKER__
  return { fetchLog, picker }
}

/** 载入一份 client.js 实例（不同 query ⇒ 全新模块实例，各自有自己的 directoryPicker）。 */
async function loadClient(cacheKey) {
  const react = makeReact()
  let exports = null
  globalThis.window = {
    __ModuleLoader__: { load: ({ factory }) => { exports = factory((name) => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`) }) } },
    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0, location: { reload: () => {} }, innerWidth: 1280, innerHeight: 800,
  }
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }), head: { appendChild: () => {} } }
  await import(`${pathToFileURL(join(REPO, 'lib', 'client.js')).href}?${cacheKey}`)
  return { react, exports }
}

/** 渲染主面板并返回驱动句柄。 */
function mountPanel({ react, exports, t }) {
  let tree = null
  react.__reset()
  react.__setRerender(() => { tree = react.__render() })
  react.__setCurrent(() => exports.PluginConsoleTab({ t, section: null }))
  tree = react.__render()
  const view = () => flatten(tree)
  return {
    view,
    rerender: () => { tree = react.__render(); return flatten(tree) },
    /** 点一个按钮（按可见文案找）。找不到就是缺陷（"按钮不存在"同样要报出来）。 */
    click: (text) => {
      const flat = view()
      const button = flat.nodes.find((n) => n.tag === 'button' && String(n.props?.children ?? '') === text)
      if (button === undefined) throw new Error(`找不到按钮「${text}」；当前按钮：${flat.buttons.map((b) => String(b.props?.children ?? '')).join(' | ')}`)
      button.props.onClick()
      return view()
    },
    button: (text) => view().nodes.find((n) => n.tag === 'button' && String(n.props?.children ?? '') === text) ?? null,
    /** 该文案的按钮是否**存在**（"不显示"与"灰掉"是两件事，这里断言的是存在性）。 */
    hasButton: (text) => view().nodes.some((n) => n.tag === 'button' && String(n.props?.children ?? '') === text),
  }
}

const flushAsync = async (times = 6) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
const t = (key) => key

// ═══ A. 桌面端（宿主提供系统目录对话框）═══════════════════════════════════════
const host = installHost({ withPicker: true })
const fetchLog = host.fetchLog
const picker = host.picker
const desktop = await loadClient('desktop')
const ctx = {
  effect: (fn) => { try { fn() } catch {} return () => {} },
  locale: { register: () => {}, bind: () => t },
  slots: { inject: () => {}, register: () => {} },
  logger: { debug: () => {} },
}
desktop.exports.apply(ctx)
const panel = mountPanel({ react: desktop.react, exports: desktop.exports, t })

await checkAsync('① 打开 link 面板：真的拉清单 + 真的拉已登记开发区', async () => {
  assert.ok(panel.hasButton('linksBtn'), '工具栏里找不到 link 入口')
  panel.click('linksBtn')
  await flushAsync()
  const paths = fetchLog.map((c) => `${c.method} ${c.path}`)
  assert.ok(paths.includes('GET /plugin-console/links'), paths.join(', '))
  assert.ok(paths.includes('POST /plugin-console/dev-roots'), paths.join(', '))
  const rootsCall = fetchLog.find((c) => c.path === '/plugin-console/dev-roots')
  assert.deepEqual(rootsCall.body, { action: 'list' }, JSON.stringify(rootsCall.body))
})

check('① 桌面端（有桥）渲染「浏览…」；下拉与路径输入都在', () => {
  const flat = panel.view()
  assert.ok(flat.nodes.some((n) => n.tag === 'select'), '没有开发区下拉')
  assert.ok(flat.nodes.some((n) => n.tag === 'input' && n.props.placeholder === 'linksDirPlaceholder'), '没有路径输入框')
  assert.ok(panel.hasButton('linksBrowse'), '带目录对话框的宿主要显示「浏览…」')
})

await checkAsync('① ★ 点「浏览…」真的调用宿主对话框，并把选中的路径填进输入框（不是摆设）', async () => {
  assert.equal(picker.calls, 0, '还没点就调了对话框')
  panel.click('linksBrowse')
  await flushAsync()
  assert.equal(picker.calls, 1, '点了「浏览…」却没有调用宿主的目录对话框')
  const input = panel.view().nodes.find((n) => n.tag === 'input' && n.props.placeholder === 'linksDirPlaceholder')
  assert.equal(input.props.value, picker.value, `选中的路径没有填进输入框：${JSON.stringify(input.props.value)}`)
})

await checkAsync('① ★ 从下拉选开发区 ⇒ 路径补成草稿（根本身不能钉住，要接着写根里的插件目录）', async () => {
  const flat = panel.view()
  const select = flat.nodes.find((n) => n.tag === 'select')
  assert.ok(select, '没有开发区下拉')
  // 下拉里必须真的列出服务端给的根（不是空列表、不是写死的）
  const options = panel.view().nodes.filter((n) => n.tag === 'option').map((n) => String(n.props?.children ?? ''))
  assert.ok(options.includes('D:/dev') && options.includes('D:/plugin-src'), `下拉里没有服务端给的根：${options.join(' | ')}`)
  select.props.onChange({ currentTarget: { value: 'D:/dev' } })
  const input = panel.view().nodes.find((n) => n.tag === 'input' && n.props.placeholder === 'linksDirPlaceholder')
  assert.equal(input.props.value, 'D:/dev/', `选了根之后应是待续写的草稿：${JSON.stringify(input.props.value)}`)
  // 反斜杠风格也照原样补，不混用分隔符
  panel.view().nodes.find((n) => n.tag === 'select').props.onChange({ currentTarget: { value: 'C:\\my-dev' } })
  assert.equal(panel.view().nodes.find((n) => n.tag === 'input' && n.props.placeholder === 'linksDirPlaceholder').props.value, 'C:\\my-dev\\')
})

check('② ★ 行内动作按服务端结论出现：缺依赖→[补齐依赖]，能造垫片→[造垫片]', () => {
  const flat = panel.view()
  const labels = flat.buttons.map((b) => String(b.props?.children ?? ''))
  assert.equal(labels.filter((x) => x === 'linksRepairDeps').length, 1, `[补齐依赖] 只该出现在缺依赖那一行：${labels.join(' | ')}`)
  assert.equal(labels.filter((x) => x === 'linksRepairShims').length, 1, `[造垫片] 只该出现在可补垫片那一行：${labels.join(' | ')}`)
  // 三行都钉着 ⇒ 三个 [取消钉住]
  assert.equal(labels.filter((x) => x === 'linksUnpinBtn').length, 3, `每行都应有 [取消钉住]：${labels.join(' | ')}`)
})

check('② ★ 负控：缺 peer 但**补不了**（shimmablePeers 空）⇒ 不出现 [造垫片]（不摆点了必失败的按钮）', () => {
  const flat = panel.view()
  // cannot 行有缺 peer，但框架根里没有 ⇒ 面板不许给这个按钮；只有 lonely 那行给
  const shimButtons = flat.buttons.filter((b) => String(b.props?.children ?? '') === 'linksRepairShims')
  assert.equal(shimButtons.length, 1, '唯一那枚 [造垫片] 属于可补的那一行')
  const lonelyShim = flat.buttons.find((b) => String(b.props?.children ?? '') === 'linksRepairShims')
  assert.ok(String(lonelyShim.props.disabled) !== 'true', '[造垫片] 不该是灰的')
})

check('⑥ 目标目录的改动时间：有就显示（本地化），拿不到就显示「—」（不编造）', () => {
  const texts = panel.view().texts.join('\n')
  assert.ok(/linksMtime \d{4}[/-]\d{1,2}[/-]\d{1,2}/u.test(texts), `没显示改动时间：${texts.slice(0, 300)}`)
  assert.ok(texts.includes('linksMtime —'), `拿不到时间时该显示「—」：${texts.slice(0, 300)}`)
})

check('⑥ ★ 时间口径挂在行 tooltip 上（"直接下一层、不含 node_modules"这类误差要能查到）', () => {
  const rowNode = panel.view().nodes.find((n) => typeof n.props?.title === 'string' && n.props.title.includes('linksMtimeHint'))
  assert.ok(rowNode, '行的 title 里没有时间口径说明')
  // 面板里的 t 是键名直通，所以真文案去源文件里查（两种语言都要有，别只修一边）
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.ok(src.includes('不含 node_modules'), '中文口径说明里没有讲清 node_modules 被排除')
  assert.ok(src.includes('node_modules / .git excluded'), '英文口径说明缺失（只修了一边）')
})

await checkAsync('③ ★ 钉住是两段式：先只读计划（不带 confirm），计划里给出包名与步骤', async () => {
  const before = fetchLog.length
  const flat = panel.view()
  const input = flat.nodes.find((n) => n.tag === 'input' && n.props.placeholder === 'linksDirPlaceholder')
  input.props.onChange({ currentTarget: { value: 'D:/dev/demo' } })
  panel.rerender()
  panel.click('linksPinPlanBtn')
  await flushAsync()
  const calls = fetchLog.slice(before)
  assert.equal(calls.length, 1, `点一次 [钉住] 只该发一次请求：${JSON.stringify(calls)}`)
  assert.equal(calls[0].path, '/plugin-console/pin-dev-dir')
  assert.deepEqual(calls[0].body, { dir: 'D:/dev/demo' }, '第一段必须**不带** confirm（否则就是跳过确认直接写）')
  const texts = panel.view().texts.join('\n')
  assert.ok(texts.includes('linksPinPlanTitle'), '没渲染计划标题')
  assert.ok(texts.includes('把 demo 的来源写成 link:D:/dev/demo（清单 dependencies）'), '没渲染计划步骤')
  assert.ok(panel.hasButton('linksPinConfirmBtn'), '计划之后应出现「确认钉住」')
  assert.ok(panel.hasButton('linksCancel'), '计划之后应能取消')
})

await checkAsync('③ ★ 只有点了 [确认钉住] 才发 confirm:true（此前一次都没有）', async () => {
  const confirmed = fetchLog.filter((c) => c.path === '/plugin-console/pin-dev-dir' && c.body && c.body.confirm === true)
  assert.equal(confirmed.length, 0, '还没点确认就发了 confirm:true')
  const before = fetchLog.length
  panel.click('linksPinConfirmBtn')
  await flushAsync()
  const calls = fetchLog.slice(before)
  const pin = calls.filter((c) => c.path === '/plugin-console/pin-dev-dir')
  assert.equal(pin.length, 1, JSON.stringify(calls))
  assert.deepEqual(pin[0].body, { dir: 'D:/dev/demo', confirm: true })
  // 写完之后要重新读清单（否则界面还停在旧状态）
  assert.ok(calls.some((c) => c.path === '/plugin-console/links' && c.method === 'GET'), '钉住成功后没有重新读取清单')
  assert.ok(panel.view().texts.join('\n').includes('linksPinnedDone'), '钉住成功没有可见反馈')
})

await checkAsync('⑤ ★ [补齐依赖] 发 kind=deps、[造垫片] 发 kind=shims，且都带对的包名；结果显示服务端原话', async () => {
  for (const [label, kind] of [['linksRepairDeps', 'deps'], ['linksRepairShims', 'shims']]) {
    const before = fetchLog.length
    panel.click(label)
    await flushAsync()
    const calls = fetchLog.slice(before)
    const repair = calls.filter((c) => c.path === '/plugin-console/link-repair')
    assert.equal(repair.length, 1, `${label} 的请求：${JSON.stringify(calls)}`)
    assert.deepEqual(repair[0].body, { packageName: 'lonely', kind }, JSON.stringify(repair[0].body))
    assert.ok(calls.some((c) => c.path === '/plugin-console/links'), `${label} 之后没有重新读取清单`)
    assert.ok(panel.view().texts.join('\n').includes(`服务端说：${kind} 补了 1 处`), `${label} 的结果没显示服务端 note`)
  }
})

await checkAsync('④ ★ 取消钉住也是两段式：先只读计划（不带 confirm）并把 warnings 摆出来', async () => {
  const before = fetchLog.length
  panel.click('linksUnpinBtn')
  await flushAsync()
  const calls = fetchLog.slice(before)
  assert.equal(calls.length, 1, JSON.stringify(calls))
  assert.equal(calls[0].path, '/plugin-console/unpin-dev-dir')
  assert.deepEqual(calls[0].body, { packageName: 'lonely' }, '第一段必须不带 confirm')
  const texts = panel.view().texts.join('\n')
  assert.ok(texts.includes('· 备份 profile 清单'), `没渲染计划步骤：${texts.slice(0, 400)}`)
  assert.ok(texts.includes('! 它仍在 dsh.profile.bundles 里：取消钉住后这个 bundle 会解析不到'), '没把后果摆出来')
  assert.ok(panel.hasButton('linksUnpinConfirmBtn'), '计划之后应出现「确认取消钉住」')
})

await checkAsync('④ ★ 确认后才发 confirm:true，且成功后结果可见', async () => {
  const confirmedBefore = fetchLog.filter((c) => c.path === '/plugin-console/unpin-dev-dir' && c.body && c.body.confirm === true)
  assert.equal(confirmedBefore.length, 0, '还没点确认就发了 confirm:true')
  const before = fetchLog.length
  panel.click('linksUnpinConfirmBtn')
  await flushAsync()
  const calls = fetchLog.slice(before)
  const unpin = calls.filter((c) => c.path === '/plugin-console/unpin-dev-dir')
  assert.equal(unpin.length, 1, JSON.stringify(calls))
  assert.deepEqual(unpin[0].body, { packageName: 'lonely', confirm: true })
  assert.ok(calls.some((c) => c.path === '/plugin-console/links'), '取消钉住后没有重新读取清单')
  assert.ok(panel.view().texts.join('\n').includes('已从 profile 清单移除；开发目录与代码未被删除'), '结果没显示服务端 note')
})

await checkAsync('⑦ [重新读取] 真的再拉一次清单（不是本地重算）', async () => {
  const before = fetchLog.filter((c) => c.path === '/plugin-console/links').length
  panel.click('linksPanelReload')
  await flushAsync()
  const after = fetchLog.filter((c) => c.path === '/plugin-console/links').length
  assert.equal(after, before + 1, `[重新读取] 没有重新请求：${before} → ${after}`)
})

// ═══ B. web 端（宿主没有系统目录对话框）═══════════════════════════════════════
delete globalThis.__DSH_DIRECTORY_PICKER__
const web = await loadClient('web')
const webCtx = {
  effect: (fn) => { try { fn() } catch {} return () => {} },
  locale: { register: () => {}, bind: () => t },
  slots: { inject: () => {}, register: () => {} },
  logger: { debug: () => {} },
}
web.exports.apply(webCtx)
installHost({ withPicker: false })   // 确保桥真的不在
const webPanel = mountPanel({ react: web.react, exports: web.exports, t })

check('① ★ 探测本身：没有桥 ⇒ detectDirectoryPicker() 返回 null；有桥 ⇒ 返回函数', () => {
  assert.equal(web.exports.detectDirectoryPicker(), null, '没有桥时应返回 null')
  globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => 'x' }
  assert.equal(typeof desktop.exports.detectDirectoryPicker(), 'function', '有桥时应返回可调用的函数')
  delete globalThis.__DSH_DIRECTORY_PICKER__
})

await checkAsync('① ★ web 端（没桥）：打开面板照常有下拉 + 路径输入，但**没有**「浏览…」', async () => {
  webPanel.click('linksBtn')
  await flushAsync()
  const flat = webPanel.view()
  assert.ok(flat.nodes.some((n) => n.tag === 'select'), 'web 端也要有开发区下拉')
  assert.ok(flat.nodes.some((n) => n.tag === 'input' && n.props.placeholder === 'linksDirPlaceholder'), 'web 端要有路径输入')
  assert.equal(webPanel.hasButton('linksBrowse'), false, '没有目录对话框的宿主**不该**渲染「浏览…」（不是灰掉，是根本不存在）')
  // 其余动作照常（去掉浏览按钮不影响钉住）
  assert.ok(webPanel.hasButton('linksPinPlanBtn'), 'web 端仍要能钉住')
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
