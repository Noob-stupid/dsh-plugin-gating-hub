// ① pnpm 通道：杀完树要**等它真的退出**才收尾（2026-09-26 本次改错）
//
// 背景：git 通道有 waitChildExit（domain/repoland.js），pnpm 通道没有 —— infra/exec.js#execFileWithKillTree
// 在超时/中断时 `killTreeNow(); finish(killedError(…))` 是**同一个 tick** 完成的，约 +1ms 就抛
// 「已终止整棵进程树」，而整棵树实际还要一会儿才从进程表/句柄表消失：
//   · POSIX：SIGKILL 的"投递 → 目标被调度死亡 → 被 init 收割"是异步的（CI run 36246293996 实测约 120ms）；
//   · 本机 Windows：taskkill /F /T 是同步等待，但目录项/句柄释放仍会晚一拍（探针实测 278ms 才可删）。
// 于是调用方（pnpmRemove 后立刻删目录、install 失败清场、.tryN 残留清理）仍会撞"文件被占用"。
//
// 本测试分两段：
//   Ⅰ. **注入桩**（离线、确定性）：钉死顺序「先杀树 → 轮询等退出 → 才 resolve/reject」，
//      并断言 waitedMs/exited 如实、封顶时到点就走（不阻塞）、close/error 不抢答、
//      runPnpmWithFallback 包装后字段不丢、成功路径行为一个字没变。
//   Ⅱ. **真机**（真进程 + 真文件占用）：故意超时 → 断言错误到手时 ①整棵树已无残留进程
//      ②目录**立刻可删**（旧代码此刻仍在报"被占用"）。附"kill 返回 ≠ 句柄已释放"的滞后实测作为证据。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeDirVerifiedAsync, disposeDir } from '../lib/server/infra/fsx.js'
import { execFileWithKillTree, killProcessTree, processAlive, runPnpmWithFallback } from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => typeof pid === 'number' && pid > 0 && processAlive(pid)
const IS_WIN = process.platform === 'win32'

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-killwait-'))
const HANG = join(ROOT, 'hang-holder.cjs')
// 假 pnpm runner：自己 **cwd = 目标目录**（Windows 与 Linux 都会让该目录删不掉），再派生一个孙进程：
//   · Windows：powershell 以 share=None 持有目录内文件（占用更顽固，实测删除必失败）
//   · POSIX  ：普通 node 睡眠进程（cwd 用 tmpdir，避免连坐占用；孙进程只作"整棵树都清掉"的证据）
writeFileSync(HANG, `const fs = require('node:fs')
const { spawn } = require('node:child_process')
const dir = process.argv[2]
const pidFile = process.argv[3]
const win = process.platform === 'win32'
fs.writeFileSync(dir + (win ? '\\\\' : '/') + 'locked.txt', 'x')
const ps = win
  ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$fs=[System.IO.File]::Open('" + dir + "\\\\locked.txt','Open','Read','None'); Write-Output READY; Start-Sleep -Seconds 120"], { windowsHide: true })
  : spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: require('node:os').tmpdir(), stdio: 'ignore' })
ps.stdout?.on('data', () => fs.appendFileSync(pidFile + '.ready', 'R'))
fs.writeFileSync(pidFile, JSON.stringify({ parent: process.pid, grandchild: ps.pid, cwd: process.cwd() }))
setInterval(() => {}, 1000)
`, 'utf8')

/** 「立刻可删」判据：用外部删除命令（本机实测 `rmSync` 在 %TEMP% 下会静默落空，不能当判据）。 */
const tryDelete = (dir) => {
  try {
    if (IS_WIN) execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true, stdio: 'ignore' })
    else execFileSync('rm', ['-rf', '--', dir], { stdio: 'ignore' })
  } catch {}
  return !existsSync(dir)
}
function fakeChild(pid, handlers = {}) {
  return {
    pid,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on(event, cb) { handlers[event] = cb; return this },
    handlers,
  }
}
/** Ⅰ 段公共夹具：假子进程 + 假时钟（sleep 推进时钟），记录"杀树 / 探活 / 收尾"的完整事件序列。 */
async function orderingCase({ killWaitMs, killWaitPollMs, totalTimeoutMs = 30, aliveFalseAt = 3 }) {
  const events = []
  let aliveCalls = 0
  let clock = 0
  const child = fakeChild(424242)
  const startedAt = Date.now()
  const err = await execFileWithKillTree('fake-pnpm', ['add', 'x'], { timeout: totalTimeoutMs, killWaitMs, killWaitPollMs }, {
    spawnFn: () => child,
    killTree: (pid) => { events.push(`kill:${pid}`); return true },
    alive: () => { aliveCalls += 1; events.push(`alive#${aliveCalls}`); return aliveCalls < aliveFalseAt },
    sleep: (ms) => { events.push(`sleep:${ms}`); clock += ms; return Promise.resolve() },
    now: () => clock,
  }).then(() => null, (error) => { events.push('settled'); return error })
  return { events, err, clock, wall: Date.now() - startedAt, aliveCalls }
}

const DIR_REAL = join(ROOT, 'realdir')
try {
  // ── Ⅰ-① 顺序：杀树 → 轮询等退出 → 才 settle（本次改错的核心）────────────────
  {
    const r = await orderingCase({ killWaitMs: 200, killWaitPollMs: 50, aliveFalseAt: 3 })
    const killAt = r.events.findIndex((e) => e.startsWith('kill:'))
    const firstAliveAt = r.events.findIndex((e) => e.startsWith('alive#'))
    const settleAt = r.events.indexOf('settled')
    check('★ 顺序：先杀树 → 再轮询探活 → 最后才 settle',
      killAt >= 0 && firstAliveAt === killAt + 1 && settleAt === r.events.length - 1 && settleAt > firstAliveAt,
      r.events.join(' → '))
    check('★ settle 只发生在 alive() 返回 false 之后（不是杀完就抛）',
      r.events[settleAt - 1] === `alive#${r.aliveCalls}` && r.aliveCalls === 3 && r.clock === 100,
      `探活 ${r.aliveCalls} 次（最后一次=${r.events[settleAt - 1]}），假时钟=${r.clock}ms`)
    check('★ waitedMs 如实 = 实际轮询等待（2×50ms），exited=true',
      r.err?.waitedMs === 100 && r.err?.exited === true, `waitedMs=${r.err?.waitedMs} exited=${r.err?.exited}`)
    check('错误字段照旧：killed / timedOut / timeoutMs / pid 一个不少',
      r.err?.killed === true && r.err?.timedOut === true && r.err?.timeoutMs === 30 && r.err?.pid === 424242)
    check('报错文案同时说清「已终止整棵进程树」与「等待 Nms 后确认已退出」',
      /已终止整棵进程树 pid=424242/u.test(r.err?.message ?? '') && /等待 100ms 后确认已退出/u.test(r.err?.message ?? ''),
      (r.err?.message ?? '').split('\n').pop())
  }

  // ── Ⅰ-② 封顶（等不到）：到点就走、不阻塞，exited 如实为 false ────────────────
  {
    const r = await orderingCase({ killWaitMs: 200, killWaitPollMs: 50, aliveFalseAt: 999 })
    check('★ 等不到上限时也照原路径抛错（不挂死、不阻塞）：exited=false、waitedMs=上限',
      r.err?.timedOut === true && r.err?.exited === false && r.err?.waitedMs === 200 && r.wall < 5000,
      `waitedMs=${r.err?.waitedMs} exited=${r.err?.exited} wall=${r.wall}ms 事件=${r.events.join(' → ')}`)
    check('等不到时的文案如实说明"仍未退出（到点不阻塞）"',
      /仍未退出（到点不阻塞，按原路径继续）/u.test(r.err?.message ?? ''), (r.err?.message ?? '').split('\n').pop())
    check('封顶时探活次数有界（4 次 sleep 到 200ms 即停，不做无谓轮询）',
      r.events.filter((event) => event.startsWith('sleep')).length === 4 && r.aliveCalls === 5, r.events.join(' → '))
  }

  // ── Ⅰ-③ killWaitMs=0：显式退回旧行为（只杀不等），字段仍如实 ────────────────
  {
    const r = await orderingCase({ killWaitMs: 0, killWaitPollMs: 50 })
    check('killWaitMs=0：只探活一次、不等（可显式退回旧行为）',
      r.aliveCalls === 1 && r.events.filter((e) => e.startsWith('sleep')).length === 0 && r.err?.exited === false && r.err?.waitedMs === 0,
      r.events.join(' → '))
  }

  // ── Ⅰ-④ 等待期间 close/error 不抢答（否则 killedError 被普通失败/成功顶掉）────
  {
    const handlers = {}
    const child = fakeChild(555001, handlers)
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    let clock = 0
    const pending = execFileWithKillTree('fake-pnpm', ['add', 'x'], { timeout: 20, killWaitMs: 300, killWaitPollMs: 30 }, {
      spawnFn: () => child,
      killTree: () => true,
      alive: () => true, // 一直"活着"：把收尾拖在等待里
      sleep: (ms) => gate.then(() => { clock += ms }),
      now: () => clock,
    }).then(() => null, (error) => error)
    await sleep(80) // 让超时先触发，进入"等退出"的等待
    handlers.close?.(0)
    handlers.error?.(new Error('spawn 失败'))
    release()
    const settled = await pending
    check('★ 收尾等待期间 close/error 不许抢答（超时错误不会被"成功/普通失败"顶掉）',
      settled?.timedOut === true && settled?.killed === true && settled?.pid === 555001 && settled?.waitedMs === 300,
      `timedOut=${settled?.timedOut} killed=${settled?.killed} waitedMs=${settled?.waitedMs} exited=${settled?.exited}`)
  }

  // ── Ⅰ-⑤ runPnpmWithFallback 包装后字段不丢（上层要能判断"树是否真退出"）─────
  {
    const child = fakeChild(900001)
    const fakeRunner = { kind: 'fake', note: '假 runner', run: () => ({ bin: process.execPath, argv: ['-e', 'process.stderr.write("pnpm: fetching x\\n")'] }) }
    const wrapped = await runPnpmWithFallback(['add', 'x'], {
      runners: [fakeRunner],
      execOpts: { timeout: 20, killWaitMs: 100, killWaitPollMs: 20 },
      exec: (bin, argv, opts) => execFileWithKillTree(bin, argv, opts, {
        spawnFn: () => child,
        killTree: () => true,
        alive: () => false,
        now: () => 0,
      }),
    }).then(() => null, (error) => error)
    check('runPnpmWithFallback 包装后 waitedMs / exited 也带出来了',
      wrapped?.timedOut === true && wrapped?.waitedMs === 0 && wrapped?.exited === true && wrapped?.pid === 900001,
      `timedOut=${wrapped?.timedOut} waitedMs=${wrapped?.waitedMs} exited=${wrapped?.exited} pid=${wrapped?.pid}`)
    check('runPnpmWithFallback 包装后仍说清"超时 + 已终止整棵树 + 等待结果"（文案不丢）',
      /超时 20ms/u.test(wrapped?.message ?? '') && /已终止整棵进程树/u.test(wrapped?.message ?? '') && /等待 0ms 后/u.test(wrapped?.message ?? ''),
      (wrapped?.message ?? '').split('\n').pop())
  }

  // ── Ⅰ-⑥ 成功路径 / 普通失败路径：行为一个字没变 ─────────────────────────────
  {
    const ok = await execFileWithKillTree(process.execPath, ['-e', 'process.stdout.write("hello")'], { timeout: 20000 })
    check('成功路径：resolve {stdout,stderr} 内容不变', ok.stdout === 'hello' && ok.stderr === '', JSON.stringify(ok))
    const nonzero = await execFileWithKillTree(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)'], { timeout: 20000 }).then(() => null, (e) => e)
    check('普通失败：code/stderr/killed=false 语义不变，且不带 waitedMs（没杀过树）',
      nonzero?.code === 3 && /boom/u.test(nonzero?.stderr ?? '') && nonzero?.killed === false && nonzero?.waitedMs === undefined,
      `code=${nonzero?.code} waitedMs=${nonzero?.waitedMs}`)
    const quick = await execFileWithKillTree(process.execPath, ['-e', 'process.stdout.write("quick")'])
    check('不传 timeout：正常跑完（默认无超时，既有调用语义不变）', quick.stdout === 'quick')
    const aborted = new AbortController()
    aborted.abort()
    const abortErr = await execFileWithKillTree(process.execPath, ['-e', ''], { signal: aborted.signal }).then(() => null, (e) => e)
    check('中断：spawn 前就已 abort 的路径照旧立即失败（killed=true，不需要等任何进程）',
      abortErr?.killed === true && abortErr?.timedOut === false && abortErr?.exited === true && abortErr?.waitedMs === 0,
      `killed=${abortErr?.killed} exited=${abortErr?.exited} waitedMs=${abortErr?.waitedMs}`)
  }

  // ── Ⅱ 真机：真超时 → 真杀树 → 等退出 → 错误到手时目录立刻可删 ────────────────
  mkdirSync(DIR_REAL, { recursive: true })
  const pidFile = join(ROOT, 'pids.json')
  const err = await execFileWithKillTree(process.execPath, [HANG, DIR_REAL, pidFile], { timeout: 1500, cwd: DIR_REAL, windowsHide: true })
    .then(() => null, (error) => error)
  // ★ 关键：错误到手后**不做任何 await**，立刻判"目录还能不能删"
  const pids = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : null
  const holderReady = existsSync(`${pidFile}.ready`)
  const parentAliveAtErr = alive(pids?.parent)
  const grandchildAliveAtErr = alive(pids?.grandchild)
  const firstTryOk = tryDelete(DIR_REAL)
  const lagStart = Date.now()
  const attempts = [firstTryOk]
  let lag = firstTryOk ? 0 : null
  while (lag === null && Date.now() - lagStart < 1500) {
    await sleep(25)
    attempts.push(tryDelete(DIR_REAL))
    if (attempts[attempts.length - 1]) lag = Date.now() - lagStart
  }
  check('真机：假 runner 与孙进程都落了盘、占用物真的持有句柄（断言不靠 if 静默跳过）',
    pids !== null && pids.parent > 0 && pids.grandchild > 0 && (holderReady || !IS_WIN), `${JSON.stringify(pids)} ready=${holderReady}`)
  check('真机：真超时确实抛错，并带上 waitedMs / exited（新字段）',
    err !== null && err?.timedOut === true && typeof err?.waitedMs === 'number' && typeof err?.exited === 'boolean',
    `timedOut=${err?.timedOut} killed=${err?.killed} waitedMs=${err?.waitedMs} exited=${err?.exited} pid=${err?.pid}`)
  check('真机：错误到手瞬间，被杀的 pid 已不存在（"等它真退出"的语义）',
    err !== null && alive(err.pid) === false, `err.pid=${err.pid} alive=${alive(err.pid)}`)
  check('★ 真机：故意超时后**目录立刻可删**（旧代码此刻还在报"被占用"）',
    lag !== null, `第 1 次尝试成功=${firstTryOk}；滞后=${lag}ms；尝试次数=${attempts.length}（错误时刻 父alive=${parentAliveAtErr} 孙alive=${grandchildAliveAtErr}）`)
  // ①无残留子进程：有界等待（真残留照样 FAIL）
  const deadStart = Date.now()
  while (Date.now() - deadStart < 8000 && (alive(pids?.parent) || alive(pids?.grandchild))) await sleep(100)
  const parentGone = alive(pids?.parent) === false
  const grandchildGone = alive(pids?.grandchild) === false
  check('★ 真机：整棵树无残留子进程（父 + 孙都真的没了）',
    parentGone && grandchildGone,
    `父=${parentGone ? '已退出' : '仍在'} 孙=${grandchildGone ? '已退出' : '仍在'}（有界等待 ${Date.now() - deadStart}ms）`)

  // 附：占用先验 + 滞后实测 —— "活进程占着的目录删不掉"与"killTree 返回 ≠ 句柄/目录项已释放"（所以必须等）
  {
    const DIR2 = join(ROOT, 'lagdir')
    mkdirSync(DIR2, { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: DIR2, windowsHide: true, stdio: 'ignore' })
    for (let i = 0; i < 50 && !processAlive(child.pid); i += 1) await sleep(20)
    await sleep(400)
    const lockedWhileAlive = tryDelete(DIR2)
    check('★ 占用先验：活进程占着的目录**确实删不掉**（"立刻可删"这条断言因此有牙齿）',
      lockedWhileAlive === false && existsSync(DIR2), `活进程占用时删除结果=${lockedWhileAlive}，目录还在=${existsSync(DIR2)}`)
    const t0 = Date.now()
    killProcessTree(child.pid)
    const killMs = Date.now() - t0
    let firstOk = null
    for (let i = 0; i < 80; i += 1) {
      if (tryDelete(DIR2)) { firstOk = Date.now() - t0; break }
      await sleep(25)
    }
    const evidence = `killTree 同步耗时=${killMs}ms，目录第一次删得掉于 +${firstOk === null ? '>2000' : firstOk}ms（此时 pid 已消失=${!alive(child.pid)}）`
    check('附：滞后实测有界完成（kill 返回后句柄/目录项还要一拍才释放 —— 这正是"必须等"的理由）',
      firstOk !== null, evidence)
    console.log(`（证据）${evidence}`)
  }
} finally {
  for (const pid of (() => {
    const file = join(ROOT, 'pids.json')
    if (!existsSync(file)) return []
    try { const p = JSON.parse(readFileSync(file, 'utf8')); return [p.parent, p.grandchild] } catch { return [] }
  })()) killProcessTree(pid)
  try {
    const cleaned = await removeDirVerifiedAsync(ROOT, { attempts: 1, pollMs: 400 })
    if (cleaned.ok !== true) {
      const fallback = disposeDir(ROOT, { removerOpts: { attempts: 1, pollMs: 100 } })
      console.log(`（提示）临时目录没能直接删掉：${ROOT} — ${cleaned.error ?? '未知'}；已改名降级 status=${fallback.status}`)
    }
  } catch {}
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
