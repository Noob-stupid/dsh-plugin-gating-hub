// 重启/重载路径的官方化改错（2026-10-10，用户红线）——正控 + **负控**（负控是用户点名的那条）。
//
// 用户原话：「桌面端重启必须走官方的那种不报错重启，如果你走手动拉起之类的等等很可能会出现那种
// 报错，这是一定不能的」＋「有时候控制台代理重启啥的会出现《应用无法启动或已意外停止》」。
//
// 元凶现场（<DSH_HOME>/plugin-console，2026-10-10 15:27–15:33，实测原文）：
//   console-restart.log：`[guard] 端口 3080 无监听，第 1..5 次拉起`
//                        `[guard] 已尝试 5 次仍拉不起来，放弃并自删（请手动启动，或看 fw-relaunch.log / console-restart.log）`
//   fw-relaunch.log：    `拉起(守护第 N 次): <npx 缓存>\@deepseek-ai\dsh\lib\bin.js`
// ⇒ 旧实现在 `/restart` 里生成自杀脚本 + 注册**每分钟跑一次**的 `DSH-RestartGuard-<pid>` 计划任务，
//   端口无监听就 `Start-Process node <bin.js> web` 手动拉起，第 6 次 `schtasks /delete` 自删任务。
//
// 本套断言（全离线、私有 DSH_HOME、**绝不真的 spawn 任何 dsh 进程**）：
//   ① 判据单元（domain/restart.js#restartPathDecision）：正控 hosted=true ⇒ channel 'desktop-client'
//      （官方路径被优先选中）；负控 hosted≠true ⇒ channel 'unavailable'（官方通道不可用 ⇒ 如实告知
//      手动重启）；两种情况红线四项 spawns / kill / scheduledTask / selfDelete **恒为 false**。
//   ② **真跑**两条路由（fake req/res）：正控（注入 hosted=true）与负控（注入 hosted=false）都是
//      409 + 文案 + **零子进程调用**。
//   ③ 「零 spawn / 零 kill」的**动态证据**（两条）：
//      · 进程内：先替换 child_process 的 execFile/exec/spawn/fork…为记录桩，**再**动态 import 路由
//        （Node 的 ESM 具名导入在 link 时读属性 ⇒ 先 patch 后 import 一定拦得住），并带**桩自校验**
//        （控制组必须被记到；否则本套响亮 SKIP，绝不假装 PASS）。
//      · **真机路径**：另起一个**普通 node 进程**（剥掉 ELECTRON_RUN_AS_NODE 等宿主标记）跑探针，
//        在那里对两条路由各发一次请求，回报真实 detectHostShape 判定 + 路由状态 + 子进程调用数。
//   ④ 零残渣：DSH_HOME/plugin-console 不出现 console-restart.log / restart-guard-*.count；
//      临时目录不出现 console-*.ps1。
//   ⑤ 静态：两条路由**去注释后**的可执行代码里 0 处 kill/spawn/计划任务；旧的自杀+守护脚本生成块、
//      旧的自删逻辑、旧的手动拉起命令都已从代码里消失（只在注释里作为事故证据被引用）。
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'restart-official-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

let pass = 0
let failed = 0
let skipped = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (cond) pass += 1
  else failed += 1
}
const skip = (label, reason) => { console.log(`SKIP ${label} — ${reason}`); skipped += 1 }

/** 去行注释（引号内的 `//` 不算）：禁词扫描必须只看**可执行代码** —— 改错的注释里正当地引用了那些旧名词作证据。 */
const codeOnly = (source) => source.split('\n').map((line) => {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quote !== null) {
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}).join('\n')

// ── ① 「零 spawn / 零 kill」的记录桩（必须在 import 任何 lib 模块**之前**装好）──────────
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
    // 记录 + 静默（不抛）：让路由该走完走完，断言看的是"有没有被调用过"这个事实
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
  skip('「零 spawn / 零 kill」动态证据', `child_process 记录桩未生效（记到 ${JSON.stringify(childCalls)}）——本进程的 ESM 具名导入绑定方式与预期不同`)
} else {
  check('桩自校验：动态 import 的具名 execFile 确实被拦到（动态证据可信）', true, childCalls[0])
}
childCalls.length = 0

// ── ② 判据单元（纯函数）────────────────────────────────────────────────────────
const { DESKTOP_CLIENT_RESTART_NOTICE, MANUAL_LAUNCH_REMOVED_NOTE, RESTART_CHANNEL, STANDALONE_RESTART_NOTICE, restartPathDecision } = await import('../lib/server/domain/restart.js')
const { detectHostShape } = await import('../lib/server/domain/framework.js')
const { routeRestart, routeFrameworkRelaunch } = await import('../lib/server/routes/framework.js')

const RED_LINE_KEYS = ['spawns', 'kill', 'scheduledTask', 'selfDelete']
const redLinesAllFalse = (d) => RED_LINE_KEYS.every((k) => d.details[k] === false) && d.spawns === false && d.kill === false
// 临时目录里 console-*.ps1 的**调用前快照**：本机 %TEMP% 里可能还躺着旧实现的事故残骸
// （实测 console-restart-23688.ps1 / console-restart-guard-34732.ps1 —— 正是旧路径的证据），
// 所以"零残渣"断言的是**调用前后没有新增**，不是"全局不存在"。
const ps1Pattern = /^console-(?:restart|relaunch)-.*\.ps1$/u
const ps1Before = new Set(readdirSync(tmpdir()).filter((n) => ps1Pattern.test(n)))
{
  const on = restartPathDecision({ hosted: true })
  check('正控（判据）：桌面端托管 ⇒ 官方路径被优先选中（channel=desktop-client、official=true）',
    on.channel === RESTART_CHANNEL.desktopClient && on.official === true, `channel=${on.channel} official=${String(on.official)}`)
  check('正控（判据）：文案 = 请在桌面端客户端里重启（桌面端 app.relaunch 那条官方路）',
    on.message.includes('请在桌面端客户端里重启') && on.message.includes('已意外停止'))
  check('正控（判据）：给出路（guide 非空、点名客户端重启）',
    Array.isArray(on.details.guide) && on.details.guide.length > 0 && on.details.guide.some((g) => g.includes('重启')))
  check('正控（判据）：绝不自称成功（ok=false —— 插件没有可调用的官方重启通道，不许假装重启了）', on.ok === false)

  const off = restartPathDecision({ hosted: false })
  check('负控（判据）：官方通道不可用 ⇒ channel=unavailable、official=false',
    off.channel === RESTART_CHANNEL.unavailable && off.official === false, `channel=${off.channel} official=${String(off.official)}`)
  check('负控（判据）：如实告知手动重启（不静默、不假装成功、给出路）',
    off.ok === false && off.message.includes('请手动重启这个 dsh web 进程') && off.details.guide.length > 0)
  const undef = restartPathDecision({})
  check('负控（判据）：判不出托管时也按"不可用"处理（保守 —— 任何分支都不 spawn）',
    undef.channel === RESTART_CHANNEL.unavailable && undef.official === false)

  for (const [name, d] of [['正控', on], ['负控', off], ['缺省', undef]]) {
    check(`${name}（判据）：红线四项恒为 false（spawns / kill / scheduledTask / selfDelete）`, redLinesAllFalse(d),
      RED_LINE_KEYS.map((k) => `${k}=${String(d.details[k])}`).join(' '))
    check(`${name}（判据）：状态是 409 拒绝（不是 200 假成功）`, d.status === 409 && d.ok === false)
  }
  const rel = restartPathDecision({ hosted: true, intent: 'relaunch' })
  check('「手动拉起」按钮：同一判据 + 明确说明该路径已下线',
    rel.channel === RESTART_CHANNEL.desktopClient && rel.message.startsWith(MANUAL_LAUNCH_REMOVED_NOTE) && rel.details.manualLaunch === 'removed')
  check('文案常量与判据一致（同一个承担者，不各写一份）',
    DESKTOP_CLIENT_RESTART_NOTICE.includes('请在桌面端客户端里重启') && STANDALONE_RESTART_NOTICE.includes('请手动重启这个 dsh web 进程'))
}

// ── ③ 真跑路由（正控 / 负控，进程内）────────────────────────────────────────────
const fakeReq = (pathname) => ({ method: 'POST', url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } })
const fakeRes = () => {
  const r = { status: 0, body: null }
  r.writeHead = (s) => { r.status = s }
  r.end = (p) => { r.body = p }
  return r
}
const run = async (handler, pathname, deps) => {
  const res = fakeRes()
  await handler(fakeReq(pathname), res, {
    url: new URL(pathname, 'http://127.0.0.1:3080'), pathname, method: 'POST', body: {},
    deps,
  })
  let json = null
  try { json = res.body === undefined || res.body === null ? null : JSON.parse(res.body) } catch {}
  return { status: res.status, json }
}

{
  const at = childCalls.length
  const out = await run(routeRestart, '/plugin-console/restart', { hosted: true })
  check('正控（路由）：POST /restart 桌面端托管 ⇒ 409 + 官方客户端重启文案',
    out.status === 409 && out.json?.ok === false && out.json?.error === DESKTOP_CLIENT_RESTART_NOTICE, `status=${out.status}`)
  check('正控（路由）：details 带 channel/official/红线四项（前端与日志可判因）',
    out.json?.details?.channel === RESTART_CHANNEL.desktopClient && out.json?.details?.official === true
    && RED_LINE_KEYS.every((k) => out.json?.details?.[k] === false))
  check('正控（路由）：**零子进程调用**（桌面端托管时连"尝试拉起"都不存在）', childCalls.length === at, childCalls.slice(at).join(', ') || '0 次')
}
{
  // 负控（用户点名的那条）：官方不可用 ⇒ 绝不发生任何 spawn/kill，只出提示
  const at = childCalls.length
  const out = await run(routeRestart, '/plugin-console/restart', { hosted: false })
  check('负控（路由）：POST /restart 官方不可用 ⇒ 409 + 手动重启出路（不静默、不假成功）',
    out.status === 409 && out.json?.ok === false && out.json?.error === STANDALONE_RESTART_NOTICE
    && String(out.json?.error).includes('请手动重启这个 dsh web 进程'), `status=${out.status}`)
  check('负控（路由）：**官方不可用时【不发生】任何 spawn/kill**（execFile/spawn/exec/fork 全 0 次）',
    childCalls.length === at, childCalls.slice(at).join(', ') || '0 次')
  check('负控（路由）：红线四项恒 false（spawns/kill/scheduledTask/selfDelete）',
    RED_LINE_KEYS.every((k) => out.json?.details?.[k] === false))

  const at2 = childCalls.length
  const rel = await run(routeFrameworkRelaunch, '/plugin-console/framework-relaunch', { hosted: false })
  check('负控（路由）：POST /framework-relaunch（原「手动拉起」）⇒ 409 + 同一条出路 + **零 spawn/kill**',
    rel.status === 409 && String(rel.json?.error).startsWith(MANUAL_LAUNCH_REMOVED_NOTE)
    && String(rel.json?.error).includes('请手动重启这个 dsh web 进程') && childCalls.length === at2,
    `status=${rel.status} calls=${childCalls.length - at2}`)
  const relOn = await run(routeFrameworkRelaunch, '/plugin-console/framework-relaunch', { hosted: true })
  check('正控（路由）：POST /framework-relaunch 桌面端托管 ⇒ 官方路径文案 + 零 spawn/kill',
    relOn.status === 409 && String(relOn.json?.error).includes('请在桌面端客户端里重启') && childCalls.length === at2)
}

// ── ④ 真机路径负控：另起一个**普通 node 进程**（剥掉宿主标记）跑探针 ────────────────────
// 为什么必须另起进程：本测试常常跑在**桌面端宿主**里（ELECTRON_RUN_AS_NODE=1 /
// process.resourcesPath 存在），detectHostShape() 在那里必然判 hosted=true，进程内没法验证
// "独立实例 ⇒ 官方不可用 ⇒ 零 spawn"这条真实路径。探针里对两条路由各发一次请求。
{
  const probePath = join(ROOT, '.testdir', 'restart-standalone-probe.mjs')
  const probe = `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const calls = []
const fake = { on: () => fake, once: () => fake, stdout: null, stderr: null, kill: () => {}, unref: () => {} }
for (const n of ['execFile', 'execFileSync', 'exec', 'execSync', 'spawn', 'spawnSync', 'fork']) {
  if (typeof cp[n] !== 'function') continue
  cp[n] = (...a) => { calls.push(n + '(' + String(a[0]) + ')'); return n.endsWith('Sync') ? '' : fake }
}
const { detectHostShape } = await import(${JSON.stringify(pathToFileURL(join(ROOT, '..', 'lib', 'server', 'domain', 'framework.js')).href)})
const { routeRestart, routeFrameworkRelaunch } = await import(${JSON.stringify(pathToFileURL(join(ROOT, '..', 'lib', 'server', 'routes', 'framework.js')).href)})
const shape = detectHostShape()
const mk = () => { const r = { status: 0, body: null }; r.writeHead = (s) => { r.status = s }; r.end = (p) => { r.body = p }; return r }
const req = (p) => ({ method: 'POST', url: p, socket: {}, headers: {} })
const rc = (p) => ({ url: new URL('http://127.0.0.1:3080' + p), pathname: p, method: 'POST', body: {}, deps: {} })
const j = (r) => { try { return JSON.parse(r.body) } catch { return null } }
const r1 = mk(); await routeRestart(req('/plugin-console/restart'), r1, rc('/plugin-console/restart'))
const r2 = mk(); await routeFrameworkRelaunch(req('/plugin-console/framework-relaunch'), r2, rc('/plugin-console/framework-relaunch'))
console.log('PROBE_JSON ' + JSON.stringify({ hosted: shape.hosted, reasons: shape.reasons, restartStatus: r1.status, restartChannel: j(r1)?.details?.channel, relaunchStatus: r2.status, relaunchChannel: j(r2)?.details?.channel, childCalls: calls }))
`
  writeFileSync(probePath, probe, 'utf8')
  // 剥掉宿主标记：探针要以"用户在终端里跑 dsh web"的那台普通 node 的身份起
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
    skip('真机路径负控（普通 node 进程 = 独立实例）', why)
  } else if (parsed.hosted !== false) {
    skip('真机路径负控（普通 node 进程 = 独立实例）', `探针进程仍被判成外壳托管（reasons=${JSON.stringify(parsed.reasons)}）`)
  } else {
    check('真机路径负控：普通 node 进程被真实 detectHostShape 判为**独立实例**（hosted=false）', true, JSON.stringify(parsed.reasons))
    check('真机路径负控：POST /restart ⇒ 409 + channel=unavailable（官方通道不可用，如实告知）',
      parsed.restartStatus === 409 && parsed.restartChannel === RESTART_CHANNEL.unavailable, `status=${parsed.restartStatus} channel=${String(parsed.restartChannel)}`)
    check('真机路径负控：POST /framework-relaunch ⇒ 409 + channel=unavailable', parsed.relaunchStatus === 409 && parsed.relaunchChannel === RESTART_CHANNEL.unavailable)
    check('真机路径负控：两条路由在那台进程里**零子进程调用**（真 spawn 探针，不是桩）',
      Array.isArray(parsed.childCalls) && parsed.childCalls.length === 0, (parsed.childCalls ?? []).join(', ') || '0 次')
  }
}
{
  const consoleDir = join(HOME, 'plugin-console')
  const strays = existsSync(consoleDir) ? readdirSync(consoleDir).filter((n) => /^console-restart\.log$|^restart-guard-\d+\.count$/u.test(n)) : []
  check('零残渣：DSH_HOME/plugin-console 下无 console-restart.log / restart-guard-*.count', strays.length === 0, strays.join(', ') || '0 项')
  const ps1New = readdirSync(tmpdir()).filter((n) => ps1Pattern.test(n) && !ps1Before.has(n))
  check('零残渣：临时目录**没有新增** console-restart-*.ps1 / console-relaunch-*.ps1（调用前已存在的旧事故残骸不计）',
    ps1New.length === 0, ps1New.join(', ') || `0 项（调用前已有 ${String(ps1Before.size)} 项旧残骸）`)
}

// ── ⑤ 静态：禁词只允许出现在注释里；旧路径的代码已彻底消失 ─────────────────────────
{
  const src = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'framework.js'), 'utf8').replace(/\r\n/gu, '\n')
  const code = codeOnly(src)
  check('旧的自杀/守护脚本生成块已从代码里消失（mainLines / guardLines / scheduleFor）',
    !code.includes('const mainLines = [') && !code.includes('const guardLines = [') && !code.includes('const scheduleFor ='))
  check('旧的自删逻辑已从代码里消失（不再建 DSH-RestartGuard-*、不再写 restart-guard-*.count、不再"放弃并自删"）',
    !code.includes('DSH-RestartGuard-') && !code.includes('restart-guard-') && !code.includes('放弃并自删') && !code.includes('console-restart.log'))
  check('旧的手动拉起命令已从代码里消失（不再写 console-relaunch-*.ps1、不再 Start-Process node bin.js web）',
    !code.includes('console-relaunch-') && !code.includes('已发起手动拉起') && !code.includes('Start-Process'))
  const bodyOf = (name) => {
    const from = code.indexOf(`async function ${name}(`)
    if (from === -1) return ''
    const end = code.indexOf('\n}', from)
    return end === -1 ? code.slice(from) : code.slice(from, end + 2)
  }
  for (const name of ['routeRestart', 'routeFrameworkRelaunch']) {
    const body = bodyOf(name)
    const hits = ['Start-Process', 'Stop-Process', 'schtasks', 'execFile', 'spawn(', 'kill'].filter((t) => body.includes(t))
    check(`${name}：可执行代码里 0 处 kill/spawn/计划任务（去注释后扫 6 个禁词）`, hits.length === 0, hits.join(', ') || '0 处')
    check(`${name}：真的接到了唯一判据 restartPathDecision`, body.includes('restartPathDecision('))
  }
  check('既有清残留能力保留（cleanupStaleFwTasks 仍被调用）',
    readFileSync(join(ROOT, '..', 'lib', 'index.js'), 'utf8').includes('cleanupStaleFwTasks()'))
  const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  check('客户端只显示服务端原话（重启按钮不再吞掉拒绝原因、不再拼"拉起"说法）',
    client.includes('call("/plugin-console/restart", {})') && !client.includes('node bin.js web') && !client.includes('已发起手动拉起'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nPASS ${pass} / FAIL ${failed}${skipped > 0 ? ` / SKIP ${skipped}` : ''}`)
process.exit(failed === 0 ? 0 : 1)
