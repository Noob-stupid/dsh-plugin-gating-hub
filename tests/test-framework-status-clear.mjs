// 0.5.45 改错+加法（2026-10-11）：两件事各一套硬门槛（全离线、私有 DSH_HOME、不碰真实 profile、
// 绝不真的拉起任何 dsh 进程）。
//
// ① `/plugin-console/framework-status-clear` 的**静默失败**（既有真缺陷，用户点名）：
//    路由里用了 `rmSync` 与 `basename`，文件顶部却没有 import ⇒ 每轮都抛 ReferenceError，
//    被紧挨着的 `catch {}` 吞掉 ⇒ 路由照样回 `200 {"ok":true,"removed":[]}`，标记文件一个都没删。
//    现场复现原文（正控，修前）：
//      [before] state exists = true | hb exists = true
//      [route ] status = 200 | body = {"ok":true,"removed":[],"status":"idle","message":null}
//      [after ] state exists = true | hb exists = true          ← 「应当被删的标记文件仍在」
//    修法（最小）：补 import（`rmSync` / `basename`）+ 把空 catch 换成**如实上报**：
//      目标存在但删不掉 ⇒ `500 { ok:false, error:「清除升级记录失败：<文件>（<原因>）」, details:{removed,failed} }`；
//      全部删掉（或文件本就不在）⇒ `200 { ok:true, removed:[…], failed:[] }`。
//    判据：宁可红，也不报假的绿。
//    本套断言：静态（import 落地 + 不许再出现空 catch）+ 正控复现（现有两个文件必须真被删）
//      + 负控（注入删除器必失败 ⇒ 500 + 原因 + 文件仍在 + ok!==true）
//      + 负控（existsSync 自己抛 ⇒ 也算失败、也要报）
//      + 局部成功（只删掉一个 ⇒ 200 且 removed 如实只有一个）。
//
// ② 「一键升级 / 一键回滚」里那条 `Start-Process … cmd.exe /c node bin.js web` 残留
//    （domain/framework.js#relaunchPrelude，仅 framework-upgrade.js:268 与 routes/framework.js:380 两处调用）：
//    先判**可达性**再决定改法。本套把判据钉死：
//      · 两条入口的宿主守卫必须是**任何写盘/exec 之前的第一条动作**（静态接线断言）
//      · 托管形态下真跑两条路由 ⇒ 409 + 文案 + **零 exec/spawn**（child_process 记录桩 + 桩自校验）
//        + **零写盘**（profile 快照 / 预禁用 / 回滚记录 / 临时 ps1 前后一致）+ **零网络**（fetchJson 没被调）
//      · restart.js#restartPathDecision 的**唯一调用点**就是这两条路由（静态接线断言）
//      · 独立实例（hosted=false）里 `relaunchPrelude` 仍照旧产出 Start-Process（**不倒退**）；
//        托管形态下同一份生成器产出的脚本里 `Invoke-DshRelaunch` 第一句就是跳过（第二道防线）
//      · 另起一个**普通 node 进程**（剥掉宿主标记）真跑两条路由：确认它们在独立实例里**确实可达**
//        （回滚路由走到"没有可用回滚点"、升级路由走到真实副作用点），证明守卫拦掉的正是这条能力本身
//        —— 不是"路由本来就到不了"的假绿。
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const HOME = join(ROOT, '.testdir', 'status-clear-guard-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })

let pass = 0
let failed = 0
let skipped = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (cond) pass += 1
  else failed += 1
}
/** 响亮 SKIP：打印原因、计入汇总 —— 绝不假装 PASS。 */
const skip = (label, reason) => { console.log(`SKIP ${label} — ${reason}`); skipped += 1 }

// ── child_process 记录桩（必须在 import 路由**之前**装好：ESM 具名导入在 link 时读属性）──────
const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const realChildProcess = {}
for (const name of ['execFile', 'execFileSync', 'exec', 'execSync', 'spawn', 'spawnSync', 'fork']) realChildProcess[name] = cp[name]
const childCalls = []
const fakeChild = { on: () => fakeChild, once: () => fakeChild, stdout: null, stderr: null, kill: () => {}, unref: () => {} }
for (const name of Object.keys(realChildProcess)) {
  if (typeof realChildProcess[name] !== 'function') continue
  cp[name] = (...args) => {
    childCalls.push(`${name}(${typeof args[0] === 'string' ? args[0] : typeof args[0]})`)
    return name.endsWith('Sync') ? '' : fakeChild
  }
}
{
  const control = 'data:text/javascript,import { execFile } from "node:child_process";export const go = () => execFile("spy-self-check", [], () => {})'
  const mod = await import(control)
  mod.go()
}
const spyLive = childCalls.length === 1 && childCalls[0].startsWith('execFile(spy-self-check')
if (!spyLive) {
  skip('child_process 记录桩（「托管 ⇒ 零 spawn」的动态证据）', `记录桩未生效（记到 ${JSON.stringify(childCalls)}）——本进程的 ESM 具名导入绑定方式与预期不同`)
} else {
  check('桩自校验：动态 import 的具名 execFile 确实被拦到（动态证据可信）', true, childCalls[0])
}
childCalls.length = 0

// ── 静态检查（在任何动态 import 之前做，避免"用测试自己的 import 掩盖缺 import"）────────────
const ROUTES_FW = join(REPO, 'lib', 'server', 'routes', 'framework.js')
const ROUTES_UP = join(REPO, 'lib', 'server', 'routes', 'framework-upgrade.js')
const DOMAIN_FW = join(REPO, 'lib', 'server', 'domain', 'framework.js')
const ROUTES_INDEX = join(REPO, 'lib', 'server', 'routes', 'index.js')
const fwSrc = readFileSync(ROUTES_FW, 'utf8')
{
  const importLine = (mod) => fwSrc.split('\n').find((l) => l.startsWith(`import `) && l.includes(`from '${mod}'`)) ?? ''
  const fsImport = importLine('node:fs')
  const pathImport = importLine('node:path')
  check('静态①：（正控缺陷的根因）`rmSync` 已从 node:fs 具名导入 —— 不再抛 ReferenceError',
    /import\s*\{[^}]*\brmSync\b[^}]*\}\s*from\s*'node:fs'/u.test(fsImport), fsImport.trim())
  check('静态②：`basename` 已从 node:path 具名导入', /import\s*\{[^}]*\bbasename\b[^}]*\}\s*from\s*'node:path'/u.test(pathImport), pathImport.trim())
  // 「空 catch」= 无参数且函数体为空：`catch {}` / `catch { }`。带参数（catch (error) {…}）不算。
  // ⚠ 两个坑都踩过（本套第一版的假红）：① `catch\s*\{\s*\}` 会漏掉 `catch (error) {` 与注释里
  //   引用的 `catch {}` 两个字面量 —— 必须**先去注释**再扫；② 函数体切片要含全部 catch。
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//gu, '').split('\n').map((l) => l.replace(/\/\/.*$/u, '')).join('\n')
  const clearBody = (() => {
    const from = fwSrc.indexOf('async function routeFrameworkStatusClear(')
    if (from === -1) return ''
    // 注意：不能用 `indexOf('\n}\n')` 找函数尾 —— 它先命中 explainRemoveError 的结尾，
    // 切出来的是"半截正文"（本套第一版就这么把别的函数的 catch 数进来的，假红）。
    // 函数体在文件最尾部，所以切到文件末尾、再剔掉那条 export 行即可。
    return fwSrc.slice(from).replace(/\nexport \{[^\n]*\n?$/u, '')
  })()
  const clearCode = stripComments(clearBody)
  const staticCatches = (clearCode.match(/catch\b/gu) ?? []).length
  check('静态③（边界自校验）：真的切到了 status-clear 整个函数体（含两个 catch、不含别的函数）',
    clearBody.includes('routeFrameworkStatusClear') && clearBody.includes('explainRemoveError(error)') && staticCatches === 2
    && !clearBody.includes('function explainRemoveError'), `catch 数=${staticCatches} 长度=${clearBody.length}`)
  const emptyCatches = clearCode.match(/catch\s*(?!\()\{\s*\}/gu) ?? []
  check('静态③：status-clear 里不再有空 catch（去注释后扫：无参数且空体一律不许）—— 静默失败的红线',
    emptyCatches.length === 0, emptyCatches.join(' ') || `${(clearCode.match(/catch\b/gu) ?? []).length} 处 catch 全部带参数且都上报`)
  check('静态③′：两个 catch 各自都把原因推进 failed（探测失败 / 删除失败都不许吞）',
    (clearCode.match(/failed\.push\(/gu) ?? []).length === 2, `failed.push × ${(clearCode.match(/failed\.push\(/gu) ?? []).length}`)
  check('静态④：失败路径绝不回 ok:true（ok:false + 带原因），成功路径才 sendJson(200)',
    /ok:\s*false/u.test(clearBody) && clearBody.includes('清除升级记录失败') && /sendJson\(res, 200/u.test(clearBody) && clearBody.includes('failed'))
  // 托管守卫必须是两条入口的**第一条语句**（参数绑定之后立刻判断，任何写盘/exec 之前）
  const firstActionIndex = (src, fnName) => {
    const from = src.indexOf(`async function ${fnName}(`)
    if (from === -1) return null
    const body = src.slice(from)
    const marker = body.slice(0, 4000)
    return { guard: marker.indexOf('shellHostedRefusal()'), refuse: marker.indexOf('refuseWhenShellHosted(res)') }
  }
  const up = firstActionIndex(readFileSync(ROUTES_UP, 'utf8'), 'routeFrameworkUpgrade')
  check('静态⑤：升级入口在函数最前部就做宿主守卫（早于任何副作用）',
    up !== null && up.guard > 0 && up.guard < 600, up === null ? '找不到 routeFrameworkUpgrade' : `guard@${up.guard}`)
  const off = firstActionIndex(fwSrc, 'routeFrameworkRollback')
  check('静态⑥：回滚入口在函数最前部就做宿主守卫（早于任何副作用）',
    off !== null && off.refuse > 0 && off.refuse < 600, off === null ? '找不到 routeFrameworkRollback' : `guard@${off.refuse}`)
  check('静态⑥″：两条入口的守卫都是「拒绝即 return」（不是算出来又不用 —— 那种改法会静默放行）',
    /if \(refuseWhenShellHosted\(res\)\) return/u.test(fwSrc)
    && /const refusal = shellHostedRefusal\(\); if \(refusal !== null\) \{ sendError\(res, 409, refusal\.error, refusal\.details\); return \}/u.test(readFileSync(ROUTES_UP, 'utf8')))
  const upSrc = readFileSync(ROUTES_UP, 'utf8')
  const guardAt = upSrc.indexOf('shellHostedRefusal()')
  const firstWrite = ['writeFileSync(', 'mkdirSync(', 'writeFile(', "execFile('schtasks.exe'", 'backupProfileSnapshot(', 'preflightDisableIncompatible(']
    .map((t) => upSrc.indexOf(t)).filter((i) => i > 0).sort((a, b) => a - b)[0] ?? -1
  check('静态⑤′：守卫位置 < 升级路由里第一处写盘/exec 调用（顺序可证）',
    guardAt > 0 && firstWrite > 0 && guardAt < firstWrite, `guard=${guardAt} firstSideEffect=${firstWrite}`)
  const guardAt2 = fwSrc.indexOf('refuseWhenShellHosted(res)')
  const firstWrite2 = fwSrc.indexOf("execFile('schtasks.exe'")
  check('静态⑥′：守卫位置 < 回滚路由里第一处 exec（顺序可证）',
    guardAt2 > 0 && firstWrite2 > 0 && guardAt2 < firstWrite2, `guard=${guardAt2} firstExec=${firstWrite2}`)
  check('静态⑦（唯一调用点）：relaunchPrelude 的生成器调用只在升级/回滚两条入口（各 1 处）',
    [...fwSrc.matchAll(/relaunchPrelude\(\{/gu)].length === 1 && [...upSrc.matchAll(/relaunchPrelude\(\{/gu)].length === 1)
  check('静态⑧：domain/restart.js#restartPathDecision 的唯一调用点就是这两条路由（没有旁路）',
    (fwSrc.match(/restartPathDecision\(/gu) ?? []).length === 2
    && !readFileSync(ROUTES_INDEX, 'utf8').includes('restartPathDecision'))
  check('静态⑨：托管守卫的判据只有一份事实（shellHostedRefusal → detectHostShape），路由不另立判据',
    readFileSync(DOMAIN_FW, 'utf8').includes('function shellHostedRefusal(deps)') && fwSrc.includes('shellHostedRefusal()'))
}

// ── 动态加载（此时 import 已齐备）─────────────────────────────────────────────
const { SHELL_HOSTED_NOTICE, detectHostShape, relaunchPrelude } = await import('../lib/server/domain/framework.js')
// 拉起器的真实源码（2026-10-28 起服务由它 spawn，ps1 只负责起它）
const { relaunchLauncherSource } = await import('../lib/server/domain/framework-relaunch.js')
const { routeFrameworkStatusClear, routeFrameworkRollback } = await import('../lib/server/routes/framework.js')
const { routeFrameworkUpgrade } = await import('../lib/server/routes/framework-upgrade.js')

const fakeRes = () => {
  const r = { status: 0, body: null, headers: null }
  r.writeHead = (s, h) => { r.status = s; r.headers = h ?? null }
  r.end = (p) => { r.body = p }
  return r
}
const fakeReq = (pathname) => ({
  method: 'POST', url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
  signal: { aborted: false, addEventListener: () => {} },
  [Symbol.asyncIterator]() { let done = false; return { next: async () => (done ? { value: undefined, done: true } : ((done = true), { value: Buffer.from('{}'), done: false })) } },
})
const jsonOf = (res) => { try { return res.body === null ? null : JSON.parse(res.body) } catch { return null } }
const runRoute = async (handler, pathname, deps) => {
  const res = fakeRes();
  await handler(fakeReq(pathname), res, { url: new URL(pathname, 'http://127.0.0.1:3080'), pathname, method: 'POST', body: {}, deps: deps ?? {} })
  return { status: res.status, json: jsonOf(res) }
}
/** 托管注入：只改本进程的**环境事实**（detectHostShape 的四条判据之一），用完还原。 */
const HOSTED_ENV_KEY = 'ELECTRON_RUN_AS_NODE'
const withHostedShell = async (fn) => {
  const before = process.env[HOSTED_ENV_KEY]
  process.env[HOSTED_ENV_KEY] = '1'
  const shape = detectHostShape()
  try {
    if (shape.hosted !== true) return { injected: false, shape }
    return { injected: true, shape, value: await fn() }
  } finally {
    if (before === undefined) delete process.env[HOSTED_ENV_KEY]
    else process.env[HOSTED_ENV_KEY] = before
  }
}

// ── ① 状态清理：正控（真缺陷复现）+ 负控（失败必须如实上报）─────────────────────
const CONSOLE_DIR = join(HOME, 'plugin-console')
const STATE = join(CONSOLE_DIR, 'fw-upgrade-state.txt')
const HB = `${STATE}.hb`
const resetMarkers = (stateText = 'installing|升级框架…', hbText = '12345') => {
  rmSync(CONSOLE_DIR, { recursive: true, force: true })
  mkdirSync(CONSOLE_DIR, { recursive: true })
  if (stateText !== null) writeFileSync(STATE, stateText, 'utf8')
  if (hbText !== null) writeFileSync(HB, hbText, 'utf8')
}

{
  // 正控：修前这里是 ok:true + removed:[] + 文件仍在（见文件头现场原文）；修后必须真删干净。
  resetMarkers()
  const out = await runRoute(routeFrameworkStatusClear, '/plugin-console/framework-status-clear')
  check('正控（修后）：status-clear 真的把两个标记文件删掉了（不再静默不删）',
    !existsSync(STATE) && !existsSync(HB), `state=${existsSync(STATE)} hb=${existsSync(HB)}`)
  check('正控：200 + ok:true + removed 如实列出两个文件 + failed 为空',
    out.status === 200 && out.json?.ok === true
    && JSON.stringify(out.json?.removed) === JSON.stringify(['fw-upgrade-state.txt', 'fw-upgrade-state.txt.hb'])
    && Array.isArray(out.json?.failed) && out.json.failed.length === 0,
    `status=${out.status} body=${JSON.stringify(out.json)}`)
  check('正控：删完再点一次仍然 ok:true（幂等：没有目标 ≠ 失败）',
    (await runRoute(routeFrameworkStatusClear, '/plugin-console/framework-status-clear')).json?.ok === true)
}
{
  // 负控 A（用户点名：写权限失败等真实错误必须如实报出）：注入一个"永远删不掉"的删除器。
  resetMarkers()
  const fakeIo = {
    existsSync,
    rmSync: () => { const e = new Error(`EPERM: operation not permitted, unlink '${STATE}'`); e.code = 'EPERM'; throw e },
  }
  const out = await runRoute(routeFrameworkStatusClear, '/plugin-console/framework-status-clear', { fs: fakeIo })
  check('负控 A：删除失败 ⇒ 500（不是 200）且 ok !== true（宁可红，也不报假的绿）',
    out.status === 500 && out.json?.ok === false, `status=${out.status} ok=${String(out.json?.ok)}`)
  check('负控 A：错误文案点名文件 + 带系统原因（EPERM/系统原文）',
    typeof out.json?.error === 'string' && out.json.error.includes('清除升级记录失败')
    && out.json.error.includes('fw-upgrade-state.txt') && out.json.error.includes('EPERM'),
    String(out.json?.error).slice(0, 140))
  check('负控 A：顶层如实带 removed / failed 明细（failed[].file + failed[].reason；客户端不必猜）',
    Array.isArray(out.json?.failed) && out.json.failed.length === 2
    && out.json.failed.every((x) => typeof x.file === 'string' && typeof x.reason === 'string' && x.reason.includes('EPERM'))
    && Array.isArray(out.json?.removed) && out.json.removed.length === 0
    && out.json?.details === undefined,
    JSON.stringify({ removed: out.json?.removed, failed: out.json?.failed }).slice(0, 170))
  check('负控 A：文件**确实还在**（没删掉就是没删掉，绝不谎报清空）', existsSync(STATE) && existsSync(HB))
  check('负控 A：状态没被谎报成 idle（如实 status=clear-failed）', out.json?.status === 'clear-failed', String(out.json?.status))
  check('负控 A：**零子进程调用**（清理记录不该 spawn 任何东西）', childCalls.length === 0, childCalls.join(', ') || '0 次')
}
{
  // 负控 B：existsSync 自己抛（目录权限/句柄异常那类）也必须算失败、也必须报。
  resetMarkers()
  const fakeIo = {
    existsSync: () => { const e = new Error('EACCES: permission denied, access'); e.code = 'EACCES'; throw e },
    rmSync: () => { throw new Error('不该走到这里') },
  }
  const out = await runRoute(routeFrameworkStatusClear, '/plugin-console/framework-status-clear', { fs: fakeIo })
  check('负控 B：连探测都失败 ⇒ 500 + 原因（不吞异常、不假装清空）',
    out.status === 500 && out.json?.ok === false && typeof out.json?.error === 'string' && out.json.error.includes('EACCES'),
    `status=${out.status} err=${String(out.json?.error).slice(0, 100)}`)
  check('负控 B：删不掉 ⇒ removed 为空（不虚报）', Array.isArray(out.json?.removed) && out.json.removed.length === 0)
}
{
  // 局部成功：一次真删 + 一次真失败 ⇒ failed 与 removed 都得如实（不许只说"清掉了"）。
  // 注意：注入的删除器**必须真的去删**（第 1 次抛 EBUSY 是"注入失败"，之后放行真删），
  // 否则磁盘现场根本没变，断言就成了在验证桩自己 —— 这是本套第一版踩过的坑（假红）。
  resetMarkers()
  let nth = 0
  const fakeIo = {
    existsSync,
    rmSync: (p, o) => { nth += 1; if (nth === 1) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e } rmSync(p, o) },
  }
  const out = await runRoute(routeFrameworkStatusClear, '/plugin-console/framework-status-clear', { fs: fakeIo })
  check('局部成功：失败的进 failed、成功的进 removed，整体 500（不许只说"清掉了"）',
    out.status === 500 && JSON.stringify(out.json?.removed) === JSON.stringify(['fw-upgrade-state.txt.hb'])
    && out.json?.failed?.[0]?.file === 'fw-upgrade-state.txt',
    JSON.stringify({ removed: out.json?.removed, failed: out.json?.failed }).slice(0, 170))
  check('局部成功：没删掉的那个文件确实还在，删掉的确实没了（磁盘现场与响应逐项一致）',
    existsSync(STATE) && !existsSync(HB), `STATE=${existsSync(STATE)} HB=${existsSync(HB)} removed=${JSON.stringify(out.json?.removed)}`)
}

// ── ② 托管形态：两条入口必须被守死（零写盘 / 零 exec / 零网络）───────────────────
// 假 profile：让升级路由真的能解析到"当前框架版本"（否则它会在更早的分支就结束，测不到守卫后的能力）。
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.yml'), '# stub\n', 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2', main: 'index.js' }), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'index.js'), 'export const ok = true\n', 'utf8')
const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const fakeCtx = { baseUrl: cordisUrl, loader: { entries: () => [] }, webServer: { register: () => () => {} }, effect: (fn) => { try { fn() } catch {}; return () => {} } }
let fetchCalls = 0
const fetchJson = async () => { fetchCalls += 1; return { 'dist-tags': { latest: '0.1.7-rc.1' }, versions: { '0.1.5-rc.2': {}, '0.1.7-rc.1': {} } } }
let sideEffectCalls = []
const spy = (name) => (...args) => { sideEffectCalls.push(name); throw new Error(`不该被调用：${name}`) }
const deps = {
  fetchJson,
  backupProfileSnapshot: spy('backupProfileSnapshot'),
  preflightDisableIncompatible: spy('preflightDisableIncompatible'),
  webPort: () => 3080,
  listEntries: () => [],
}
const ps1Pattern = /^fw-(?:upgrade|rollback)-\d+\.ps1$/u
const ps1Before = new Set(readdirSync(tmpdir()).filter((n) => ps1Pattern.test(n)))
const snapshotTree = (dir) => {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const rel = relative(HOME, p).replace(/\\/gu, '/')
      if (e.isDirectory()) { out.push(`${rel}/`); walk(p) } else out.push(`${rel}:${statSync(p).size}:${statSync(p).mtimeMs}`)
    }
  }
  walk(dir)
  return out.sort()
}
let now = 0
const upcoming = join(CONSOLE_DIR, 'framework-rollback.json')
const tree = join(HOME, 'framework-tree')
mkdirSync(join(tree, '.pnpm'), { recursive: true })
const checkpointDir = join(CONSOLE_DIR, 'framework-backups', '0.1.5-rc.2', 'fw-tree')
mkdirSync(join(checkpointDir, '.pnpm'), { recursive: true })
writeFileSync(upcoming, JSON.stringify({ from: '0.1.5-rc.2', to: '0.1.7-rc.1', fwRoot: tree, checkpointDir, at: Date.now() }), 'utf8')
{
  const snapshotBefore = snapshotTree(HOME)
  fetchCalls = 0
  sideEffectCalls = []
  childCalls.length = 0
  const hostedRun = await withHostedShell(async () => ({
    upgrade: await runRoute(routeFrameworkUpgrade, '/plugin-console/framework-upgrade', { ...deps, ctx: fakeCtx }),
    rollback: await runRoute(routeFrameworkRollback, '/plugin-console/framework-rollback', { ...deps, ctx: fakeCtx }),
  }))
  if (!hostedRun.injected) {
    skip('托管形态：两条入口守死（409 + 零写盘 + 零 exec）', `本进程无法把 detectHostShape 注入成托管（${JSON.stringify(hostedRun.shape?.reasons ?? [])}）`)
  } else {
    const { upgrade, rollback } = hostedRun.value
    check('托管（注入自校验）：detectHostShape() 真的判成 hosted（判据命中，不是假注入）',
      hostedRun.shape.hosted === true, JSON.stringify(hostedRun.shape.reasons).slice(0, 120))
    check('托管：POST /framework-upgrade ⇒ 409 + 明确文案（请在桌面端内重启/更新）',
      upgrade.status === 409 && upgrade.json?.ok === false && upgrade.json?.error === SHELL_HOSTED_NOTICE,
      `status=${upgrade.status} err=${String(upgrade.json?.error).slice(0, 80)}`)
    check('托管：升级拒绝载荷带原因码 hosted-by-shell + 判据 evidence（可判因）',
      upgrade.json?.details?.code === 'hosted-by-shell' && upgrade.json?.details?.hostKind === 'desktop-shell'
      && Array.isArray(upgrade.json?.details?.reasons) && upgrade.json.details.reasons.length > 0)
    check('托管：POST /framework-rollback ⇒ 409 + 同一条文案（不是"没有可用回滚点"那条）',
      rollback.status === 409 && rollback.json?.error === SHELL_HOSTED_NOTICE && rollback.json?.ok === false,
      `status=${rollback.status} err=${String(rollback.json?.error).slice(0, 80)}`)
    check('托管：**零子进程调用**（execFile/exec/spawn/fork 全 0 次 —— Start-Process 那条通道够不着）',
      childCalls.length === 0, childCalls.join(', ') || '0 次')
    check('托管：**零网络**（registry 元数据都没去取 —— 守卫早于取版本那一步）', fetchCalls === 0, `fetchJson ${fetchCalls} 次`)
    check('托管：**零副作用函数被调用**（备份快照 / 预禁用一次都没进）', sideEffectCalls.length === 0, sideEffectCalls.join(', ') || '0 次')
    check('托管：**零写盘**（私有 DSH_HOME 整棵树逐项一致：回滚记录/状态/日志/目录都不许动）',
      JSON.stringify(snapshotTree(HOME)) === JSON.stringify(snapshotBefore),
      `${snapshotBefore.length} 项 → ${snapshotTree(HOME).length} 项`)
    const ps1New = readdirSync(tmpdir()).filter((n) => ps1Pattern.test(n) && !ps1Before.has(n))
    check('托管：临时目录**没有新增** fw-upgrade-*.ps1 / fw-rollback-*.ps1（脚本根本没被生成）',
      ps1New.length === 0, ps1New.join(', ') || `0 项（调用前已有 ${ps1Before.size} 项旧残骸，不计）`)
  }
}

// ── ③ 不倒退：同一份生成器在独立实例里照旧产出 Start-Process；托管形态下脚本自带第二道防线 ──
{
  const ps = (s) => JSON.stringify(String(s))
  const solo = relaunchPrelude({ nodePath: 'C:\\node\\node.exe', pluginDir: REPO, fwRoot: 'C:\\fw', target: '0.1.7-rc.1', ps, hosted: false })
  // 2026-10-28（第二轮，断言主题随改法更新 —— 不是放宽）：真机证明 `cmd /c call node … web > out 2> err`
  // 在 schtasks 里输出为零，所以拉起改由 **node 拉起器** `fw-launch.mjs` 负责（fd 重定向 + detached），
  // ps1 只 `Start-Process <node> "<拉起器>" "<node>" "<bin>" …-PassThru`。
  // 因此"cmd.exe / web 关键字"这两个**实现细节**不再断言；改成断言同一件事的**能力**：
  //   ① 独立实例里真的有 Start-Process + -PassThru（能起服务、能拿句柄）；
  //   ② 参数里带真实 bin.js 路径（拉起器拿它去 spawn `<bin> web`）；
  //   ③ 拉起器源代码里确实写着 `web`（否则服务根本不会启动）。
  check('不倒退：独立实例（hosted=false）仍产出 Start-Process + -PassThru + 拉起器 + 真实 bin.js（升级/回滚能力保留）',
    solo.includes('Start-Process') && solo.includes('-PassThru') && solo.includes('fw-launch.mjs')
    && solo.includes('bin.js') && relaunchLauncherSource().includes('"web"') && !solo.includes('DSH_HOSTED'), `${solo.split('\r\n').length} 行`)
  const hosted = relaunchPrelude({ nodePath: 'C:\\node\\node.exe', pluginDir: REPO, fwRoot: 'C:\\fw', target: '0.1.7-rc.1', ps, hosted: true })
  check('托管：同一份生成器的脚本里带上 `$script:DSH_HOSTED = $true`（第二道防线）',
    hosted.includes('$script:DSH_HOSTED = $true'))
  check('托管：`Invoke-DshRelaunch` 函数体**第一句**就是跳过（在 Resolve-DshBin / Start-Process 之前）',
    /function Invoke-DshRelaunch\(\$tag\) \{\r?\n\s+if \(\$script:DSH_HOSTED\)/u.test(hosted)
    && hosted.indexOf('DSH_HOSTED) { Log') < hosted.indexOf('$bin = Resolve-DshBin'),
    `guard@${hosted.indexOf('DSH_HOSTED) { Log')} resolve@${hosted.indexOf('$bin = Resolve-DshBin')}`)
  check('托管：跳过分支里点名「请在桌面端内重启/更新」并 `return $false`（既不拉起、也不谎报已拉起）',
    hosted.includes('请在桌面端内重启/更新') && hosted.includes('return $false'))
  check('未显式传 hosted 时生成器**自己判定**（自接线：调用方漏传也不会退化成"照旧拉起"）',
    relaunchPrelude({ nodePath: 'C:\\node\\node.exe', pluginDir: REPO, fwRoot: 'C:\\fw', target: '0.1.7-rc.1', ps, hosted: process.env.ELECTRON_RUN_AS_NODE === '1' })
      .includes(process.env.ELECTRON_RUN_AS_NODE === '1' ? '$script:DSH_HOSTED = $true' : 'Start-Process'))
}

// ── ④ 独立实例（普通 node 子进程）真跑：证明这两条能力**确实可达**，守卫拦掉的正是它本身 ────
// 为什么必须另起进程：本测试常常跑在桌面端宿主里（ELECTRON_RUN_AS_NODE=1 / process.resourcesPath 存在），
// 那种进程里两条路由**必然**被守死，进程内没法验证"独立实例里它们真能走到副作用点"。
{
  const probePath = join(ROOT, '.testdir', 'fw-entry-standalone-probe.mjs')
  const probeHome = join(ROOT, '.testdir', 'fw-entry-probe-home')
  const probe = `import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const HOME = ${JSON.stringify(probeHome)}
rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
// 一个"看起来可用"的回滚点：让回滚路由**过掉只读状态校验**，真的走到 exec 那一步（能证明它可达）
const fwRoot = join(HOME, 'framework-tree')
mkdirSync(join(fwRoot, '.pnpm'), { recursive: true })
const checkpointDir = join(HOME, 'plugin-console', 'framework-backups', '0.1.5-rc.2', 'fw-tree')
mkdirSync(join(checkpointDir, '.pnpm'), { recursive: true })
writeFileSync(join(HOME, 'plugin-console', 'framework-rollback.json'), JSON.stringify({ from: '0.1.5-rc.2', to: '0.1.7-rc.1', fwRoot, checkpointDir, at: Date.now() }), 'utf8')
const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const calls = []
const fake = { on: () => fake, once: () => fake, stdout: null, stderr: null, kill: () => {}, unref: () => {} }
for (const n of ['execFile', 'execFileSync', 'exec', 'execSync', 'spawn', 'spawnSync', 'fork']) {
  if (typeof cp[n] !== 'function') continue
  cp[n] = (...a) => { calls.push(n + '(' + String(a[0]) + ')'); return n.endsWith('Sync') ? '' : fake }
}
const { detectHostShape } = await import(${JSON.stringify(pathToFileURL(DOMAIN_FW).href)})
const { routeFrameworkRollback } = await import(${JSON.stringify(pathToFileURL(ROUTES_FW).href)})
const { routeFrameworkUpgrade } = await import(${JSON.stringify(pathToFileURL(ROUTES_UP).href)})
const ctx = { baseUrl: ${JSON.stringify(pathToFileURL(join(probeHome, 'profiles', 'web', 'cordis.yml')).href)}, loader: { entries: () => [] }, webServer: { register: () => () => {} }, effect: (fn) => { try { fn() } catch {}; return () => {} } }
const mk = () => { const r = { status: 0, body: null }; r.writeHead = (s) => { r.status = s }; r.end = (p) => { r.body = p }; return r }
const req = (p) => ({ method: 'POST', url: p, socket: {}, headers: {} })
const rc = (p) => ({ ctx, url: new URL('http://127.0.0.1:3080' + p), pathname: p, method: 'POST', body: {}, deps: { fetchJson: async () => { calls.push('fetchJson'); return { 'dist-tags': { latest: '0.1.5-rc.2' }, versions: { '0.1.5-rc.2': {} } } }, webPort: () => 3080, listEntries: () => [], backupProfileSnapshot: () => null, preflightDisableIncompatible: () => ({}) } })
const j = (r) => { try { return JSON.parse(r.body) } catch { return null } }
const r1 = mk(); await routeFrameworkRollback(req('/plugin-console/framework-rollback'), r1, rc('/plugin-console/framework-rollback'))
const r2 = mk(); await routeFrameworkUpgrade(req('/plugin-console/framework-upgrade'), r2, rc('/plugin-console/framework-upgrade'))
// 回滚路由把 execFile(ps1 计划任务) 放在 writeFile(ps1).then(…) 里 —— 必须**等微任务/定时器排空**
// 才能看到"它真的走到 exec 了"。不等就断言，会读到"0 次"而误判成"不可达"（本套第一版的假红）。
await new Promise((resolve) => setTimeout(resolve, 1500))
rmSync(HOME, { recursive: true, force: true })
console.log('PROBE_JSON ' + JSON.stringify({
  hosted: detectHostShape().hosted, reasons: detectHostShape().reasons,
  rollbackStatus: r1.status, rollbackError: j(r1)?.error ?? null,
  upgradeStatus: r2.status, upgradeError: j(r2)?.error ?? null,
  upgradeCode: j(r2)?.details?.code ?? null,
  upgradeEscapedGuard: j(r2)?.details?.code !== 'hosted-by-shell' && String(j(r2)?.error ?? '') !== ${JSON.stringify('本实例由桌面端外壳托管，请在桌面端内重启/更新')},
  calls,
}))
`
  writeFileSync(probePath, probe, 'utf8')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node'
  let parsed = null
  let why = ''
  try {
    const out = realChildProcess.execFileSync(nodeBin, [probePath], { encoding: 'utf8', env, timeout: 120000, windowsHide: true })
    const line = String(out).split(/\r?\n/u).filter((l) => l.startsWith('PROBE_JSON ')).pop()
    parsed = line === undefined ? null : JSON.parse(line.slice('PROBE_JSON '.length))
    if (parsed === null) why = '探针没有输出 PROBE_JSON 行'
  } catch (error) {
    why = `无法起普通 node 探针（${String(error.message).split('\n')[0].slice(0, 120)}）`
  }
  rmSync(probePath, { force: true })
  if (parsed === null) {
    skip('独立实例可达性（普通 node 进程真跑两条路由）', why)
  } else if (parsed.hosted !== false) {
    skip('独立实例可达性（普通 node 进程真跑两条路由）', `探针进程仍被判成外壳托管（reasons=${JSON.stringify(parsed.reasons)}）`)
  } else {
    check('可达性：独立实例（hosted=false）里回滚路由**确实过了宿主守卫**（错误不是"托管"；要么是它自己的业务/平台分支，要么直接 200 成功走到 exec 那一步）',
      (parsed.rollbackStatus === 200 && parsed.rollbackError === null)
      || (parsed.rollbackStatus !== 200 && !String(parsed.rollbackError).includes('外壳托管')
        && (String(parsed.rollbackError).includes('没有可用的框架全树回滚点') || String(parsed.rollbackError).includes('暂不支持'))),
      `status=${parsed.rollbackStatus} err=${String(parsed.rollbackError).slice(0, 90)}`)
    check('可达性：独立实例里升级路由也**过了宿主守卫**（错误码不是 hosted-by-shell，而是走到了取版本/平台/生成脚本那些分支）',
      parsed.upgradeEscapedGuard === true,
      `status=${parsed.upgradeStatus} code=${String(parsed.upgradeCode)} err=${String(parsed.upgradeError).slice(0, 70)}`)
    if (process.platform === 'win32') {
      check('可达性（win32）：守卫放行后回滚路由**真的走到 exec 那一步**（execFile 被记到 ⇒ 这条能力确实活着）',
        Array.isArray(parsed.calls) && parsed.calls.some((c) => c.startsWith('execFile(')),
        (parsed.calls ?? []).join(', ') || '0 次')
    } else {
      check('可达性（非 win32）：守卫放行后回滚路由受阻于**平台守卫**（501 而不是"托管"）—— 这是既有能力边界，不是本批改动',
        String(parsed.rollbackError).includes('暂不支持'), String(parsed.rollbackError).slice(0, 80))
    }
  }
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nPASS ${pass} / FAIL ${failed}${skipped > 0 ? ` / SKIP ${skipped}` : ''}`)
process.exit(failed === 0 ? 0 : 1)
