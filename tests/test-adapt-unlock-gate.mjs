// 0.5.33 改错 ①-2：「已适配，立即解锁」按钮缺门控（文案自相矛盾 + 点了必 409）
//
// 现症：按钮只判 `entry.pendingCompat === true` 就渲染「已适配，立即解锁」，**不检查 `entry.adoptable`**；
// 而同一张卡片上方那行用的是正确判据（`entry.adoptable`）⇒ 卡片正文说"不适配"、按钮说"已适配"；
// 点下去 POST /adapt-unlock 必得 409（`checkPluginFrameworkCompat` 判 fail），补丁与行状态零变化
// ⇒ 用户观感"点不动"。服务端 409 当时也只有一句"适配校验未通过"，既没说清为什么、也没给出路。
//
// 本套钉死（全离线）：
//   ① 门控判据 `canAdaptUnlock`（真跑导出的函数）：adoptable 为 null/undefined/非对象 → false；
//      只有"待适配 + 服务端真的检测到可适配"才 true
//   ② 渲染点真的用了这个判据（按钮条件 = canAdaptUnlock(entry)），且那个只判 pendingCompat 的旧形状没了
//   ③ 不可适配时**如实展示原因**（沿用既有 checkNote/reason 位置与文案键），不新增常驻 UI
//   ④ 服务端 409 文案写清「为什么不行 + 出路」；且 409 时补丁与适配门清单**逐字节不变**
//   ⑤ 反向：可适配的行照旧 200 解锁（门禁没被修成"谁都不能解锁"）
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const HOME = join(ROOT, '.testdir', 'adapt-unlock-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })

const FW = '0.2.0-rc.2'
const profileDir = join(HOME, 'profiles', 'web')
const patchPath = join(profileDir, 'cordis.patch.yml')
const pendingFile = join(HOME, 'plugin-console', 'compat-pending.json')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

const writePkg = (name, version, source) => {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), source, 'utf8')
}
// 不适配：源码真的从 @deepseek-ai/dsh-settings 导入 0.1.2 起已删除的 API
writePkg('@fake/still-broken', '2.0.0', 'import { settingsNamespace } from "@deepseek-ai/dsh-settings"\nexport const x = settingsNamespace\n')
// 已适配：源码干净 + 版本已变化（detectAdoptablePending 会给 adoptable）
writePkg('@fake/now-fine', '2.0.0', 'export const ok = true\n')
// 框架版本夹具（state 路由的 currentFrameworkVersion 走 ctx.baseUrl 解析）
writePkg('@deepseek-ai/dsh', FW, 'export const ok = true\n')

writeFileSync(patchPath, ['# user patch', '- id: broken-row', '  disabled: true', '- id: fine-row', '  disabled: true', ''].join('\n'), 'utf8')
writeFileSync(pendingFile, JSON.stringify({
  frameworkVersion: FW,
  upgradeFrom: '0.1.5-rc.2',
  pending: [
    { rowId: 'broken-row', moduleName: '@fake/still-broken', version: '1.0.0', status: 'pending', check: 'fail', checkNote: '升级前预扫判定不适配，已自动禁用', source: 'preflight-disabled-before-upgrade' },
    { rowId: 'fine-row', moduleName: '@fake/now-fine', version: '1.0.0', status: 'pending', check: 'fail', checkNote: '升级前预扫判定不适配，已自动禁用', source: 'preflight-disabled-before-upgrade' },
  ],
}, null, 2), 'utf8')

const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      { id: 'include:broken-row', options: { name: '@fake/still-broken' }, disabled: true, fiber: undefined },
      { id: 'include:fine-row', options: { name: '@fake/now-fine' }, disabled: true, fiber: undefined },
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

console.log('=== ① 门控判据 canAdaptUnlock（真跑 lib/client.js 导出的函数）===')
{
  // ── 假 React：client.js 只 require("react")；这里只要能把模块工厂跑起来拿到导出 ──
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {}, useMemo: (fn) => fn(), useCallback: (fn) => fn, useReducer: (r, i) => [i, () => {}],
  }
  let exports = null
  globalThis.window = {
    __ModuleLoader__: { load: ({ factory }) => { exports = factory((name) => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`) }) } },
    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0, location: { reload: () => {} },
  }
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }), head: { appendChild: () => {} } }
  await import(pathToFileURL(join(REPO, 'lib', 'client.js')).href)
  const canAdaptUnlock = exports?.canAdaptUnlock
  check('client.js 可离线加载并导出 canAdaptUnlock（供门控断言）', typeof canAdaptUnlock === 'function')
  if (typeof canAdaptUnlock === 'function') {
    const adoptable = { version: '2.0.0', check: 'pass', note: '源码扫描无已删除 API 引用' }
    check('① 待适配 + 服务端判定可适配 → true', canAdaptUnlock({ pendingCompat: true, adoptable }) === true)
    check('① ★ 待适配但 adoptable = null → **false**（本次修复的缺陷本体）', canAdaptUnlock({ pendingCompat: true, adoptable: null }) === false)
    check('① 待适配但 adoptable = undefined → false', canAdaptUnlock({ pendingCompat: true, adoptable: undefined }) === false)
    check('① 待适配但 adoptable 非对象（脏数据）→ false', canAdaptUnlock({ pendingCompat: true, adoptable: 'yes' }) === false)
    check('① 非待适配行（pendingCompat 非 true）→ false', canAdaptUnlock({ pendingCompat: false, adoptable }) === false && canAdaptUnlock({ adoptable }) === false)
    check('① null / 空对象不抛异常且为 false', canAdaptUnlock(null) === false && canAdaptUnlock({}) === false)
  }
}

console.log('\n=== ② 渲染点真的用了这个判据 + 不可适配时如实展示原因 ===')
{
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  check('② 「已适配，立即解锁」按钮的条件是 canAdaptUnlock(entry)',
    /canAdaptUnlock\(entry\)\s*\n?\s*\?\s*el\("button", \{/u.test(src))
  check('② 旧的"只判 pendingCompat 就出这个按钮"形状已消失',
    !/entry\.pendingCompat === true\s*\n?\s*\?\s*el\("button", \{\s*\n?\s*type: "button",\s*\n?\s*className: styles\.toggle,\s*\n?\s*"data-pending": "true"/u.test(src))
  check('② 按钮文案键未改（adaptUnlockBtn / adaptUnlockHint 仍在，不新增常驻 UI）',
    src.includes('adaptUnlockBtn:') && src.includes('adaptUnlockHint:'))
  check('② 不可适配时正文用**同一个**判据如实报原因（entry.adoptable ? … : pendingCompatHint + checkNote）',
    // 0.5.34：adoptable 那一支内部再按 basis 分两种文案（插件更新过 / 旧判据结论被撤回），
    // 但"正文判据 = entry.adoptable"这条不变量没变；不可适配时照旧回落 pendingCompatHint + checkNote。
    /entry\.adoptable\s*\n?\s*\?\s*\(/u.test(src) && /t\("adoptableDetected"\)/u.test(src) && /t\("pendingCompatHint"\)\s*\+\s*\(compatInfo && compatInfo\.checkNote/u.test(src))
  check('② 按钮只在既有 detail 面板里（没有新增顶层/常驻面板行）',
    src.includes('data-pending": entry.adoptable ? "false" : "true"'))
}

console.log('\n=== ④/⑤ 服务端：409 文案与"零改动"，以及可适配行照旧 200 ===')
{
  const mod = await import('../lib/index.js')
  mod.apply(ctx)
  const route = globalThis.__route
  if (!route) throw new Error('路由未注册')
  const call = async (method, path, body) => {
    const res = { status: 0, body: null }
    res.writeHead = (s) => { res.status = s }
    res.end = (p) => { res.body = p }
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    let i = 0
    const req = {
      method, url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
      signal: { aborted: false, addEventListener: () => {} },
      [Symbol.asyncIterator]() { return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) } },
    }
    await route.handler(req, res)
    return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
  }

  // 先看一眼 /state：不适配行的 adoptable 必须是 null（界面据此不出「已适配」按钮）
  const st = await call('GET', '/plugin-console/state')
  check('GET /state 200', st.status === 200, `status=${st.status}`)
  const broken = st.json?.entries?.find((e) => e.rowId === 'broken-row')
  const fine = st.json?.entries?.find((e) => e.rowId === 'fine-row')
  check('④ 仍不适配的行 adoptable = null（界面据此不出「已适配」按钮）', broken?.adoptable === null, JSON.stringify(broken?.adoptable))
  check('⑤ 已适配的行 adoptable 非空（界面据此出按钮）', fine?.adoptable !== null && fine?.adoptable !== undefined, JSON.stringify(fine?.adoptable))
  check('④ 两行的待适配标记都还在（pendingCompat）', broken?.pendingCompat === true && fine?.pendingCompat === true)

  const patchBefore = sha(patchPath)
  const pendingBefore = sha(pendingFile)
  const r = await call('POST', '/plugin-console/adapt-unlock', { rowId: 'broken-row' })
  check('④ 不适配行点解锁 → 409', r.status === 409, `status=${r.status}`)
  const msg = String(r.json?.error ?? '')
  check('④ 409 文案说清「为什么不行」（带校验原因）', /适配校验未通过：/u.test(msg) && /已删除的 dsh-settings API/u.test(msg), msg.slice(0, 160))
  check('④ 409 文案给出路（更新到兼容版本 / 不再需要则删掉该行）', /出路：/u.test(msg) && /更新到兼容当前框架/u.test(msg) && /删掉\/禁用这一行/u.test(msg))
  check('④ 409 文案写明"本次未改动"', /本次未改动补丁与适配门清单/u.test(msg))
  check('④ 409 时补丁逐字节不变', sha(patchPath) === patchBefore)
  check('④ 409 时适配门清单逐字节不变', sha(pendingFile) === pendingBefore)

  const ok = await call('POST', '/plugin-console/adapt-unlock', { rowId: 'fine-row' })
  check('⑤ 可适配行点解锁 → 200 且真解锁', ok.status === 200 && ok.json?.ok === true && ok.json?.adopted === true, `status=${ok.status} ${JSON.stringify(ok.json)?.slice(0, 140)}`)
  check('⑤ 补丁里 fine-row 的禁用块被移除', !/- id: fine-row/u.test(readFileSync(patchPath, 'utf8')))
  check('⑤ 不适配行的禁用块纹丝不动', /- id: broken-row\r?\n {2}disabled: true/u.test(readFileSync(patchPath, 'utf8')))
  const pend = JSON.parse(readFileSync(pendingFile, 'utf8'))
  check('⑤ 清单里 fine-row 记为 adopted、broken-row 仍是 pending',
    pend.pending.find((p) => p.rowId === 'fine-row')?.status === 'adopted' && pend.pending.find((p) => p.rowId === 'broken-row')?.status === 'pending')
  check('⑤ 清单文件确实还在（夹具自检）', existsSync(pendingFile))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
