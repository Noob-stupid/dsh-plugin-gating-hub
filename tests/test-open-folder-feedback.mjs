// 缺陷①：「打开文件夹」失败必须**如实反馈**（不许静默、也不许报假绿）—— 2026-10-13 用户实测报告。
//
// ── 现场（0.5.44/0.5.45 的真实现场，已用活体实例核实）──────────────────────────────────────
// 用户对 Fei2411/DeepSeek-Bot 用了「仓库落地」，点【打开文件夹】后"什么都没发生、也没有任何提示"。
// 核实到的事实链（证据，不是猜测）：
//   ① 活体实例探针（POST /plugin-console/repo-open，只发安全路径）：
//      `C:\Windows`            → 400 `路径不在仓库落地目录内`
//      `D:\dsh\repos\__x__`（不存在） → 404 `目录不存在：…`
//      ⇒ 路由可达、守卫根就是 `D:\dsh\repos`；用户那条路径**在守卫内且真实存在** ⇒ 处理函数走到了
//        `execFile('explorer.exe',[target],{windowsHide:true,detached:true}).unref()`。
//   ② 那行是**即发即忘**：没有 error 监听（spawn 失败是**异步** 'error' 事件，try/catch 抓不到），
//      立刻回 `{ok:true}` —— 失败也报成功；
//   ③ 客户端两处调用都是 `catch {}` / `.catch(() => {})`，且成功时**一个字都不显示**
//      ⇒ 无论成功还是失败，用户都是"点了没反应"。
//
// ── 本套的测试红线（上一批事故）──────────────────────────────────────────────────────────
// 上一批为了覆盖"成功路径"直接调真路由 ⇒ **真的起了 explorer.exe**，而夹具路径当时不存在
// ⇒ 用户桌面弹出 Windows「位置不可用」对话框。所以本套：
//   · 启动点用**注入桩**（`__setOpenFolderSpawn`）打掉，一次进程都不建（§⑧ 断言真实 spawn 调用数为 0）；
//   · 实现里另有一道保险丝 `DSH_OPEN_FOLDER_NO_SPAWN=1`（§⑧ 正控：默认路径被它拦下且零进程）；
//   · 计数器有**正控**（`__openFolderSelfCheck()` 真起一次 node -e ""，证明计数不是死的）。
//
// 本套断言：
//   ① 旧形态的缺陷机制（同一情形下"报假绿"）—— 用桩复现，零进程
//   ② 路由：不存在的路径 → 非 200 + **非空**错误（点名路径 + "不存在"）
//   ③ 路由：落地目录之外/根本身 → 400 + 写清"只能打开落地目录内的路径"（守卫保留，理由可见）
//   ④ 路由：读不到的路径 → 非 200 + 原因（且无副作用）
//   ⑤ 路由：launcher 失败（ENOENT）→ 500 + 系统原话 + 实际命令（"失败要给出原因"的正身）
//   ⑥ 路由：launcher 退出 → 200 + 结构化状态（ok/path/via/reason/durationMs/exitCode/note），
//      且文案不谎称"窗口已打开"（真机 explorer 委派后 exit 1，这是委派不是失败）
//   ⑦ openFolderVerified 的边界：'error'/'exit'/超时/同步抛，四种结局各自如实
//   ⑧ ★测试自身的守卫：真实 spawn 计数为 0 + 保险丝正控 + 计数器正控
//   ⑨ 静态：唯一进程创建点、保险丝在启动之前、客户端不再吞错、两处按钮共用入口
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'open-folder-home')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
// 保险丝默认**关着**：本套前面几段要走"生产路径"，靠注入桩保证不起进程；
// §⑧ 再打开它做正控（证明没有注入缝时也绝不会真的起文件管理器）。
delete process.env.DSH_OPEN_FOLDER_NO_SPAWN

const REPOS = join(HOME, 'repos')
const LANDED = join(REPOS, 'probe-org', 'landed-repo')
mkdirSync(LANDED, { recursive: true })
writeFileSync(join(LANDED, 'README.md'), '# fixture\n', 'utf8')
// 落地目录配置（routeRepoOpen 的守卫就是按它判的）
writeFileSync(join(HOME, 'plugin-console', 'repo-land.json'), JSON.stringify({ dir: REPOS }, null, 2), 'utf8')

const {
  routeRepoOpen, openFolderBin, openFolderVerified,
  __setOpenFolderSpawn, __openFolderRealSpawnCalls, __openFolderSelfCheck,
} = await import('../lib/server/routes/components.js')
const { setReposDir, getReposDir } = await import('../lib/server/domain/repoland.js')
setReposDir(REPOS)

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
const makeRes = () => {
  const captured = { status: null, json: null, raw: null }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(payload) { captured.raw = payload; try { captured.json = JSON.parse(payload) } catch { captured.json = null } },
  }
}
/** 经真路由调用（deps 里可以放注入桩；不放就走生产实现）。 */
const callOpen = async (path, deps = {}) => {
  const res = makeRes()
  await routeRepoOpen({ method: 'POST', url: '/x' }, res, { ctx: {}, body: { path }, url: new URL('http://x/x'), pathname: '/x', method: 'POST', deps })
  return res.captured
}
/** 子进程桩：**不创建任何进程**，只按 Node 的真实语义发事件。
 * kind: 'error'（异步 'error'，如 ENOENT）/ 'exit' / 'hang'（什么都不发，走超时分支）/ 'throw'（同步抛）。 */
const makeSpawnStub = (kind, { code = 1, error = null, delayMs = 5 } = {}) => {
  const calls = []
  const emitted = []
  const stub = (bin, args, options) => {
    calls.push({ bin, args, options })
    if (kind === 'throw') throw new Error('stub: spawn 同步失败（EACCES）')
    const child = new EventEmitter()
    child.unref = () => {}
    stub.lastChild = child
    const emit = (event, ...rest) => { emitted.push(event); child.emit(event, ...rest) }
    if (kind === 'error') setTimeout(() => emit('error', error ?? Object.assign(new Error('spawn 桩 ENOENT'), { code: 'ENOENT' })), delayMs)
    if (kind === 'exit') setTimeout(() => emit('exit', code, null), delayMs)
    return child
  }
  stub.calls = calls
  stub.emitted = emitted
  stub.lastChild = null
  return stub
}

// ── ⑧⁰ 测试自身的守卫（**在跑任何段落之前**装好）：把生产默认启动点换成会抛的 tripwire ────────
// 为什么还要这一层（本套原状是"每段记得注入桩 + 事后核计数"）：事后计数只能**发现**
// ——窗口已经弹出来了才红，不满足"测试不许弹任何窗口"这条红线。所以先把 module 级默认启动点
// 换成会抛的 tripwire：哪一段漏了注入、真走到生产默认启动点，都会**在创建进程之前**当场抛
// （openFolderVerified 把它归成 spawn-throw），一个 explorer 窗口都弹不出来。
// 需要自己桩的段落（⑤/⑥）照旧用 __setOpenFolderSpawn(stub) 覆盖它；§⑧a 再显式装回它做变异验证。
const tripwire = () => {
  throw new Error('测试红线：生产默认启动点被触达 —— 本套禁止任何真实进程（explorer 一个都不许起）')
}
__setOpenFolderSpawn(tripwire)

const realSpawnCallsStart = __openFolderRealSpawnCalls()

try {
  // ── ① 缺陷机制取证：旧形态（即发即忘）在同一情形下**报假绿**（用桩复现，零进程）────────────
  {
    const errStub = makeSpawnStub('error')
    // 旧实现的形状（0.5.45 components.js:172）：try 里 spawn 完就回 ok:true，没有 error 监听
    const oldStyle = () => {
      try {
        errStub('explorer.exe', [LANDED], { windowsHide: true, detached: true }).unref()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    }
    const immediate = oldStyle()
    const seen = []
    // 取证用的事后监听：旧代码里**没有人**监听（真实 ChildProcess 上没人监听时，这个 error 会变成
    // 未捕获异常 —— 见 ①′ 的真子进程取证）。这里补监听只为让本进程能观察到事件，不改变旧形态的结论。
    if (errStub.lastChild !== null) errStub.lastChild.on('error', (e) => seen.push(e.code))
    check('① 证：spawn 失败（ENOENT）在 try 块内**不抛** —— 旧实现据此回 {ok:true}（假绿）',
      immediate.ok === true && errStub.calls.length === 1 && seen.length === 0, JSON.stringify(immediate))
    await new Promise((r) => setTimeout(r, 30))
    check('① 证：失败只出现在**异步** error 事件里（旧实现没人监听 ⇒ 永远看不到），而假绿已经发出去了',
      seen.length === 1 && seen[0] === 'ENOENT' && immediate.ok === true, `seen=${seen.join(',')} 立刻返回=${JSON.stringify(immediate)}`)
    const honest = await openFolderVerified({ target: LANDED, bin: 'explorer.exe', spawnFn: errStub, launchWaitMs: 200 })
    check('★① 修好后的同一情形：**如实报失败** + 系统原话 + 结构化 reason（不再有假绿）',
      honest.ok === false && honest.reason === 'spawn-error' && honest.code === 'ENOENT' && /ENOENT/u.test(String(honest.error)),
      JSON.stringify(honest))
  }

  // ── ①′ 真子进程取证（零窗口、零文件管理器）：旧那一行在真 Node 下的实际表现 ────────────────────
  // 用一个**不存在的二进制名**（不是 explorer、不是任何会弹窗的程序）跑 0.5.45 那一行的形状：
  //   execFile(bin, [target], { windowsHide: true, detached: true }).unref()   // 没有回调、没有 error 监听
  // 实测（本机 Node v24）：execFile **不带回调**时自己挂了 1 个内部 'error' 监听 ⇒ spawn 失败被 Node
  // **静默吞掉**：try 不抛、进程不崩、没有任何输出 —— 调用方永远不知道该失败过。这正是用户看到的
  // "点了没反应"的机制（不是崩溃，是无声）。对照（负控）：同一个假二进制名换成 spawn（无监听）会
  // 以未捕获 'error' 直接退出 1 —— 证明"无声"是 execFile 内部吞掉的，不是"错误根本没发生"。
  {
    const oldShape = [
      "const { execFile } = require('node:child_process')",
      "try {",
      "  const c = execFile('definitely-not-a-real-launcher-xyz.exe', ['x'], { windowsHide: true, detached: true })",
      "  console.log('EXECFILE_ERROR_LISTENERS=' + c.listenerCount('error'))",
      "  c.unref()",
      "  console.log('TRY_DID_NOT_THROW')",
      "} catch (error) { console.log('TRY_THREW:' + error.code) }",
      "setTimeout(() => console.log('ALIVE_AFTER_ERROR'), 600)",
    ].join('\n')
    const r = spawnSync(process.execPath, ['-e', oldShape], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const out = `${r.stdout ?? ''}`
    check('★①′ 真 Node 取证：旧那一行在 try 块内不抛（所以旧实现照样回 {ok:true} —— 假绿）',
      out.includes('TRY_DID_NOT_THROW') && !out.includes('TRY_THREW'), out.trim().split('\n')[0] ?? '')
    check('★①′ 真 Node 取证：execFile 不带回调时自己挂了 1 个内部 error 监听 ⇒ 失败被**静默吞掉**（进程照旧活着、无任何输出）',
      out.includes('EXECFILE_ERROR_LISTENERS=1') && out.includes('ALIVE_AFTER_ERROR') && r.status === 0 && (r.stderr ?? '') === '',
      `exit=${r.status} stderr=${(r.stderr ?? '').trim().split('\n')[0] ?? '(空)'}`)

    const control = [
      "const { spawn } = require('node:child_process')",
      "spawn('definitely-not-a-real-launcher-xyz.exe', ['x'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()",
      "setTimeout(() => console.log('ALIVE_AFTER_ERROR'), 600)",
    ].join('\n')
    const rc = spawnSync(process.execPath, ['-e', control], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    check('★①′ 负控（桩自校验）：同一假二进制名换成 spawn（无监听）⇒ 未捕获 error 直接退出 1（证明"无声"确实是被吞掉，而不是错误没发生）',
      rc.status !== 0 && !`${rc.stdout ?? ''}`.includes('ALIVE_AFTER_ERROR') && /ENOENT/u.test(`${rc.stderr ?? ''}`),
      `exit=${rc.status}`)
    check('①′ 两个探针都只用假二进制名：全程没有 explorer / 文件管理器被调用（零弹窗、零 UI 副作用）',
      !/explorer/iu.test(oldShape) && !/explorer/iu.test(control), 'definitely-not-a-real-launcher-xyz.exe')
  }

  // ── ② 不存在的路径：必须红，且带原因（核心断言：不许 200-ok-无提示）────────────────────────
  {
    const missing = join(REPOS, 'probe-org', 'never-existed-repo')
    const got = await callOpen(missing)
    check('★② 路径不存在 → 不是 200（且不是"ok:true 无提示"）',
      got.status !== 200, `status=${got.status} body=${got.raw}`)
    check('★② 必须带**非空**错误信息，且点名路径与"不存在"',
      got.json !== null && got.json.ok === false && typeof got.json.error === 'string' && got.json.error.trim() !== ''
      && got.json.error.includes(missing) && /不存在/u.test(got.json.error), String(got.json?.error))
  }

  // ── ③ 守卫：落地目录之外/根本身 → 拒绝但必须说清理由（不许只回一句干巴巴的 400）────────────
  {
    const outside = join(HOME, 'outside-repo')
    mkdirSync(outside, { recursive: true })
    const got = await callOpen(outside)
    check('★③ 落地目录之外的路径仍被守卫拒绝（安全性没被"修 UX"牺牲掉）', got.status === 400, `status=${got.status} body=${got.raw}`)
    check('★③ 拒绝原因必须写清"只能打开仓库落地目录内的路径"并给出两个路径（用户才知道该怎么办）',
      typeof got.json?.error === 'string' && /只能打开仓库落地目录内的路径/u.test(got.json.error)
      && got.json.error.includes(outside) && got.json.error.includes(getReposDir()), String(got.json?.error))
    const rootItself = await callOpen(REPOS)
    check('③ 落地目录根本身也被拒（旧语义不变），但理由同样可见',
      rootItself.status === 400 && /只能打开仓库落地目录内的路径/u.test(String(rootItself.json?.error)), String(rootItself.json?.error))
    rmSync(outside, { recursive: true, force: true })
  }

  // ── ④ 路径读不到（父级是文件）→ 明确原因，且无副作用 ──────────────────────────────────────
  {
    const notDir = join(LANDED, 'README.md', 'inside-file')
    const got = await callOpen(notDir)
    check('④ 路径存在性判断失败（父级是文件）→ 非 200 且原因写"目录不存在/读不到该路径"',
      got.status !== 200 && typeof got.json?.error === 'string' && /目录不存在|读不到该路径/u.test(got.json.error), `${got.status} ${String(got.json?.error)}`)
    check('④ 该分支没有副作用（没有在盘上造出任何东西）', !existsSync(notDir))
  }

  // ── ⑤ launcher 必然失败 → 500 + 系统原话（经**生产路径**：注入桩 + 真路由）────────────────
  {
    const stub = makeSpawnStub('error')
    check('⑤ 注入缝真的生效（桩被装上）', __setOpenFolderSpawn(stub) === true)
    const got = await callOpen(LANDED)
    check('★⑤ 桩被调用，且参数就是 (文件管理器, [目标路径], windowsHide/detached/stdio:ignore)',
      stub.calls.length === 1 && stub.calls[0].bin === openFolderBin() && Array.isArray(stub.calls[0].args)
      && stub.calls[0].args[0] === LANDED && stub.calls[0].options?.windowsHide === true && stub.calls[0].options?.detached === true,
      JSON.stringify(stub.calls[0] ?? null))
    check('★⑤ launcher 起不来 → HTTP 500（**绝不是** 200-ok）', got.status === 500, `status=${got.status} body=${got.raw}`)
    check('★⑤ 错误信息非空、含"打开文件夹失败"与系统原话（ENOENT）+ 实际执行的命令',
      typeof got.json?.error === 'string' && got.json.error.includes('打开文件夹失败') && /ENOENT/u.test(got.json.error)
      && got.json.error.includes(openFolderBin()) && got.json.error.includes(LANDED), String(got.json?.error))
  }

  // ── ⑥ 退出 → 结构化状态（不谎称"窗口已打开"）─────────────────────────────────────────────
  {
    const stub = makeSpawnStub('exit', { code: 1 })
    __setOpenFolderSpawn(stub)
    const got = await callOpen(LANDED)
    check('★⑥ 200 + 结构化状态（ok/path/via/reason/durationMs/exitCode/note），不是光秃秃的 {ok:true}',
      got.status === 200 && got.json?.ok === true && got.json.path === LANDED && got.json.target === LANDED
      && got.json.action === 'open-folder' && got.json.via === openFolderBin()
      && got.json.reason === 'exited' && typeof got.json.durationMs === 'number' && got.json.durationMs >= 0
      && got.json.exitCode === 1 && typeof got.json.note === 'string' && got.json.note.includes('exit 1'),
      JSON.stringify(got.json))
    check('★⑥ 文案诚实：说"请求已交给系统文件管理器"，**不**声称"已在文件管理器中打开"',
      /请求已交给系统文件管理器/u.test(String(got.json?.note)) && !/已在文件管理器中打开/u.test(String(got.json?.note)), String(got.json?.note))
    const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
    check('★⑥ 客户端成功文案同样不越界（"已请求打开"而不是"已打开"）',
      client.includes('repoOpenDone: "已请求打开："') && client.includes('repoOpenDone: "Requested to open: "'))
    // deps 注入缝（第二条缝，生产 routeDeps 不带它）：文档化行为 = 优先于模块级实现
    const depsStub = async ({ target, bin }) => ({ ok: true, reason: 'exited', code: 0, durationMs: 1, note: `deps-stub ${bin}`, target })
    const viaDeps = await callOpen(LANDED, { openFolderLauncher: depsStub })
    check('⑥ rc.deps.openFolderLauncher 生效（注入缝优先级），且桩被调用一次',
      viaDeps.status === 200 && viaDeps.json?.reason === 'exited' && String(viaDeps.json?.note).startsWith('deps-stub'), JSON.stringify(viaDeps.json))
  }

  // ── ⑦ openFolderVerified 的四种结局各自如实 ───────────────────────────────────────────────
  {
    const hang = makeSpawnStub('hang')
    const launched = await openFolderVerified({ target: LANDED, bin: 'explorer.exe', spawnFn: hang, launchWaitMs: 40 })
    check('⑦ 超时未退出 → ok:true + reason=launched + note 注明"未退出"（不谎称窗口已开）',
      launched.ok === true && launched.reason === 'launched' && launched.exited === false && /未退出/u.test(String(launched.note)),
      JSON.stringify(launched))
    const thrower = makeSpawnStub('throw')
    const threw = await openFolderVerified({ target: LANDED, bin: 'explorer.exe', spawnFn: thrower, launchWaitMs: 40 })
    check('⑦ 同步抛（EACCES 一类）→ ok:false + reason=spawn-throw + 原话（旧实现 try/catch 只覆盖这一种）',
      threw.ok === false && threw.reason === 'spawn-throw' && /EACCES/u.test(String(threw.error)), JSON.stringify(threw))
    const strange = await openFolderVerified({ target: LANDED, bin: '', spawnFn: makeSpawnStub('exit', { code: 0 }), launchWaitMs: 40 })
    check('⑦ bin 为空时回落平台文件管理器（不会拿空串去 CreateProcess）',
      strange.ok === true && strange.reason === 'exited', JSON.stringify(strange))
  }

  // ── ⑧ ★红线守卫：本套跑完真实 spawn 次数必须为 0（保险丝/正控各自钉死）────────────────────
  {
    const before = __openFolderRealSpawnCalls()
    check('★⑧ 到目前为止：真实子进程创建次数 = 0（所有启动点都走了注入桩）', before === realSpawnCallsStart,
      `before=${before} start=${realSpawnCallsStart}`)

    // ⑧a **变异验证**（证明 tripwire 真在起作用，而不是摆设）：把默认启动点装回 tripwire，
    //    且**保险丝关着** ⇒ 走生产默认路径。若 tripwire 失效（= 旧形态），这一行会真的起 explorer；
    //    现在它必须在**创建进程之前**抛出来，被 openFolderVerified 归成 spawn-throw，真实计数不涨。
    __setOpenFolderSpawn(tripwire)
    const tripped = await openFolderVerified({ target: LANDED, bin: 'explorer.exe', launchWaitMs: 40 })
    check('★⑧a 变异验证：保险丝关着时，tripwire 在创建进程之前挡住生产默认路径（spawn-throw），真实 spawn 计数一个都没涨',
      tripped.ok === false && tripped.reason === 'spawn-throw' && /测试红线/u.test(String(tripped.error))
      && __openFolderRealSpawnCalls() === before,
      `${JSON.stringify(tripped)} realSpawn=${__openFolderRealSpawnCalls()}`)

    // ⑧b 保险丝正控（**保持 tripwire 装着，不还原成 null**）：保险丝必须先于启动点判定。
    //    这样即使哪天真把保险丝删了，被调用的是 tripwire ⇒ 断言红（拿到的是错的消息）**且依然零进程**
    //    —— 绝不以"先弹一个窗口再报错"为代价去取证。下一句的"消息不是 tripwire 的"正是这条证据。
    process.env.DSH_OPEN_FOLDER_NO_SPAWN = '1'
    const blocked = await callOpen(LANDED)
    const afterBlocked = __openFolderRealSpawnCalls()
    check('★⑧b 保险丝开：默认路径被拦下（500 + 写明原因），**且真实 spawn 仍为 0**',
      blocked.status === 500 && /测试红线/u.test(String(blocked.json?.error)) && /禁止真的启动文件管理器/u.test(String(blocked.json?.error))
      && afterBlocked === before,
      `status=${blocked.status} error=${String(blocked.json?.error)} realSpawn=${afterBlocked}`)
    check('★⑧b 拦下的确实是**保险丝**（消息不是 tripwire 的）⇒ 证明保险丝判定发生在启动点之前',
      !/生产默认启动点被触达/u.test(String(blocked.json?.error)), String(blocked.json?.error))
    const directBlocked = await openFolderVerified({ target: LANDED, bin: 'explorer.exe', spawnFn: () => { throw new Error('绝不该走到这里') }, launchWaitMs: 40 })
    check('★⑧ 保险丝在**启动之前**判定（连注入的 spawnFn 都不会被调用）',
      directBlocked.ok === false && directBlocked.reason === 'spawn-guard', JSON.stringify(directBlocked))
    delete process.env.DSH_OPEN_FOLDER_NO_SPAWN

    // ⑧c **默认安全正控**（第二次事故「位置不可用」弹窗的直接修复）：还原生产默认启动点
    //     （无注入桩）、保险丝**关着**、且**不给任何 opt-in** ⇒ 必须**被拒绝**（spawn-guard），
    //     真实 spawn 计数一个都不涨。这一条证明：谁忘了注入桩，默认结局是"被拒/红"，
    //     而不是在用户桌面弹一个「位置不可用」—— 旧语义（默认真 spawn，靠外部环境变量才拦住）
    //     正是那次事故的根因。
    __setOpenFolderSpawn(null)
    delete process.env.DSH_OPEN_FOLDER_ALLOW_REAL_SPAWN
    const noOptIn = await openFolderVerified({ target: LANDED, bin: 'explorer.exe', launchWaitMs: 40 })
    check('★★⑧c 默认安全：无注入桩 + 无 opt-in + 保险丝关 ⇒ **被拒绝**（spawn-guard），真实 spawn 计数不涨',
      noOptIn.ok === false && noOptIn.reason === 'spawn-guard' && /opt-in/u.test(String(noOptIn.error))
      && __openFolderRealSpawnCalls() === before,
      `${JSON.stringify(noOptIn)} realSpawn=${__openFolderRealSpawnCalls()}`)
    __setOpenFolderSpawn(tripwire)
    const injectedAgain = await openFolderVerified({ target: LANDED, bin: 'explorer.exe', launchWaitMs: 40 })
    check('★⑧c A/B 对照：同一调用只把注入桩装回来 ⇒ 立刻走到启动点（spawn-throw，不再是 spawn-guard）⇒ 上一条的"被拒"确实来自 opt-in 缺失，不是别的原因',
      injectedAgain.ok === false && injectedAgain.reason === 'spawn-throw' && __openFolderRealSpawnCalls() === before,
      `${JSON.stringify(injectedAgain)} realSpawn=${__openFolderRealSpawnCalls()}`)
    __setOpenFolderSpawn(null)
    // 如实声明边界：**"给了 opt-in 之后真的起 explorer"这条路径本套故意不验证** —— 验证它就必须
    // 真弹一个窗口，那正是我们要杜绝的。它的正确性由 ⑨ 的静态断言（opt-in 判定先于 defaultSpawn 回落、
    // 且 routeRepoOpen 是唯一 opt-in 调用方）+ 生产实测共同保证。

    // 计数器正控（桩自校验）：真的起一次 node -e ""（无窗口、非文件管理器），证明计数不是死的
    const selfCheck = await __openFolderSelfCheck()
    check('★⑧ 计数器正控：__openFolderSelfCheck() 真的创建了一次进程并被记到（否则"0"就是假绿）',
      selfCheck.ok === true && selfCheck.counted === 1, JSON.stringify(selfCheck))
    check('★⑧ 于是本套的"真实 spawn"总数 = 1，且这 1 次就是自检（**零次文件管理器**）',
      __openFolderRealSpawnCalls() === before + 1, `realSpawn=${__openFolderRealSpawnCalls()}`)
  }

  // ── ⑨ 静态：唯一进程创建点 / 保险丝位置 / 客户端不再吞错 ──────────────────────────────────
  {
    const src = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'components.js'), 'utf8')
    const srcCode = src.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n')
    check('★⑨ 服务端不再有即发即忘的 `execFile(...).unref()`（旧静默失败源头）',
      !/execFile\(/u.test(srcCode), '非注释代码里已无 execFile')
    const verified = src.slice(src.indexOf('function openFolderVerified('), src.indexOf('async function routeRepoOpen('))
    check('★⑨ 保险丝判定在启动调用**之前**（顺序反了就等于没拦）',
      verified.indexOf('DSH_OPEN_FOLDER_NO_SPAWN') > 0 && verified.indexOf('DSH_OPEN_FOLDER_NO_SPAWN') < verified.indexOf('launch(command'),
      'spawn-guard 先于 launch()')
    // ★⑨ 默认安全（第二次事故的直接修复）：真 spawn 必须显式 opt-in，且 opt-in 判定要**先于**
    // 回落到 defaultSpawn —— 只靠外部环境变量的旧语义正是那次弹窗的根因。
    check('★★⑨ 真 spawn 需显式 opt-in，且判定先于 `injected ?? defaultSpawn` 回落（默认拒绝，不是默认放行）',
      verified.includes('realSpawnOptIn(allowRealSpawn)') && verified.includes('injected ?? defaultSpawn')
      && verified.indexOf('realSpawnOptIn(allowRealSpawn)') < verified.indexOf('injected ?? defaultSpawn')
      && srcCode.includes('function realSpawnOptIn(')
      && /DSH_OPEN_FOLDER_ALLOW_REAL_SPAWN/u.test(srcCode),
      'opt-in 判定先于 defaultSpawn 回落')
    check('★★⑨ 旧的"默认放行"形态已不存在（不许再有 `injectedSpawn ?? defaultSpawn` 无门槛回落）',
      !/injectedSpawn \?\? defaultSpawn/u.test(verified))
    check('★⑨ 生产唯一的 opt-in 调用方是 routeRepoOpen（它代表"用户点了按钮"）',
      /const result = await launch\(\{ target, bin: openFolderBin\(\), allowRealSpawn: true \}\)/u.test(src))
    check('⑨ 失败一律走结构化错误 + 原因（存在 sendError 且带"打开文件夹失败"；两类事件都监听）',
      src.includes('打开文件夹失败') && /child\.on\('error'/u.test(src) && /child\.on\('exit'/u.test(src) && /child\.on\('error'[\s\S]*?child\.on\('exit'/u.test(src))
    check('⑨ 唯一进程创建点收在 defaultSpawn 里（非注释代码里 `spawn(` 只此一处 + 正控自检复用同一函数）',
      (srcCode.match(/\bspawn\(/gu) ?? []).length === 1 && srcCode.includes('function defaultSpawn(') && srcCode.includes('return spawn(bin, args, options)'),
      String((srcCode.match(/\bspawn\(/gu) ?? []).length))

    const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
    check('★⑨ 客户端不再吞错（两条旧吞错点都已消失）',
      !client.includes('call("/plugin-console/repo-open", { path: item.path }).catch(() => {})')
      && !/try \{ await call\("\/plugin-console\/repo-open", \{ path: repoLandResult\.path \}\); \} catch \{\}/u.test(client))
    check('⑨ 客户端两条路径（刚落地按钮 / 已落地列表）都走同一个 repoLandOpenFolder(path) —— 行为不许分叉',
      client.includes('onClick: () => repoLandOpenFolder(repoLandResult.path)')
      && client.includes('onClick: () => repoLandOpenFolder(item.path)')
      && client.includes('repoOpenFailed'), '两处按钮都改成共用入口 + 都会显示失败原因')
  }
} finally {
  delete process.env.DSH_OPEN_FOLDER_NO_SPAWN
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
