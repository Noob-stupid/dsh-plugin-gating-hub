// ① 超时杀整棵进程树，覆盖 pnpm 通道（2026-09-26）
//
// 背景：git 通道昨天已修（test-clone-kill-retry.mjs），但 pnpm 通道仍用
// `execFileAsync(..., { timeout })` —— 超时后**孙进程是否回收无证据**。pnpm 会派生
// git / tar / node-gyp / 子 pnpm，只 kill 父进程就会留下孤儿占着 node_modules 与 .git 里的文件。
//
// 本测试**真的启动进程**（不是打桩）：一个 node 假 runner 自己再派生一个孙进程，然后永久挂住；
// 用 1.5 秒超时打它，断言：
//   ① 超时会调 killProcessTree（记录到的 pid 就是假 runner 自己的 pid）
//   ② 报错文案说清"超时多少毫秒 + 已终止整棵进程树 + pid"（不再只有一句 Command failed）
//   ③ 父进程与**孙进程都真的没了**（process.kill(pid, 0) 探活）
//   ④ 经 runPnpmWithFallback 包装后仍保留 timedOut/pid 等结构性字段（上层才能定向重试）
//   ⑤ 成功路径与失败路径的既有语义（{stdout,stderr} / code / killed）没有被改坏
//   ⑥ repoland.js 的 killProcessTree 是同一份实现（re-export，不再各留一份拷贝）
//   ⑦ POSIX 分支（本机 Windows 用注入桩/模型跑；真 Linux 证据 = CI run 36246293996 的原始日志）
//
// 2026-09-26（本次改错）：CI（run 36246293996，Ubuntu）只红了一条 ——
// `FAIL runPnpmWithFallback 那条链路的父子进程同样已被回收 — {"parent":2759,"grandchild":2766}`。
// 查清真因**不是**"POSIX 没成组、孙进程没杀掉"（那种情况下同一个 run 里的 ① 链路 2744/2751
// 与 ③ 中断链路 2795/2802 也该红，而它们都是 PASS）：
//   · 该 run 日志里，① 链路的父子探活在超时后**约 120ms** 才判死（waitDead 的第一跳），
//   · 而 ④ 那条断言是**瞬时采样**：超时错误产生于 07.3133s，它在 07.3155s（+2.25ms）就判活了。
// POSIX 上 SIGKILL 的"投递 → 目标被调度死亡 → 被父进程/init 收割"是异步的，2ms 的瞬时采样必然抖动
// （直接子进程此时常常还是未被 node 收割的僵尸，孤儿孙进程则要等 init/subreaper 收割）。
// 所以：④ 改成与 ①③ 同一套**有界等待**（8s，父与孙都必须死，真残留照样 FAIL），
// 并补上 POSIX 分支的桩测（成组 / 成组失败后的 /proc 兜底 / 抖动回归），见 ⑦。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeDirVerifiedAsync } from '../lib/server/infra/fsx.js'
import { execFileWithKillTree, killProcessTree, posixDescendants, processAlive, runPnpmWithFallback } from '../lib/server/infra/exec.js'
import { killProcessTree as killProcessTreeFromRepoland } from '../lib/server/domain/repoland.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const DIR = mkdtempSync(join(tmpdir(), 'dsh-pnpm-kill-'))
const HANG = join(DIR, 'hang-runner.cjs')
const PID_FILE = join(DIR, 'pids.json')
const fakeProcDirs = [] // ⑦ 里造的假 /proc 目录（finally 里一起清）
// 假 runner：写一行 stderr（模拟 pnpm 的进度输出，好验证 withStderr 包装仍保真）→ 派生孙进程 →
// 把两个 pid 落盘 → 永久挂住（模拟 fetch 卡死、永不退出）
writeFileSync(HANG, `const { spawn } = require('node:child_process')
const fs = require('node:fs')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }))
process.stderr.write('pnpm: fetching left-pad from registry ...\\n')
setInterval(() => {}, 1000)
`, 'utf8')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => typeof pid === 'number' && pid > 0 && processAlive(pid)
/** 有界等待：predicate **先立刻判一次**，之后每 120ms 再判一次，直到超时。返回 {ok, ms}。
 * 为什么不能只判一次（本次 CI 事故的教训）：POSIX 上 SIGKILL 的投递 → 目标被调度死亡 →
 * 被父进程/init 收割是**异步**的；同一份代码同一个 run 里，2ms 判"还活着"、120ms 判"没了"。
 * 瞬时采样必然抖动，但"等不到就是没杀掉"仍然是硬断言（等不到 → ok:false → FAIL）。 */
async function waitUntil(predicate, timeoutMs = 8000) {
  const startedAt = Date.now()
  for (;;) {
    if (predicate()) return { ok: true, ms: Date.now() - startedAt }
    if (Date.now() - startedAt >= timeoutMs) return { ok: false, ms: Date.now() - startedAt }
    await sleep(120)
  }
}
/** 等进程真的消失（Windows 上 taskkill 同步返回后进程表偶尔还要一拍才刷新；
 * POSIX 上则是 SIGKILL 投递/收割的异步窗口，见 waitUntil）。 */
async function waitDead(pid, timeoutMs = 8000) {
  return (await waitUntil(() => !alive(pid), timeoutMs)).ok
}
const readPids = () => JSON.parse(readFileSync(PID_FILE, 'utf8'))
/** 模型（只给 ⑦ 的桩测用）：给定"谁是谁的孩子"和"被 kill 到的 pid 集合"，
 * 判断这棵树是不是**每个节点都死了** —— 与真机那两条父子探活断言同义。 */
const treeAllDead = (parents, killedPids) => Object.keys(parents).every((pid) => killedPids.has(Number(pid)))
/** 模型用的假 /proc：每个 pid 一个目录 + stat（进程名故意含空格与括号，考验解析）。 */
function makeFakeProc(tree) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fakeproc-'))
  const comm = { 3300: 'fake pnpm (v11.21.0)', 3310: 'git', 3311: 'tar', 4400: 'unrelated-daemon' }
  for (const [pid, ppid] of Object.entries(tree)) {
    mkdirSync(join(dir, pid))
    // 真实格式：`<pid> (<comm>) <state> <ppid> <pgrp> …`
    writeFileSync(join(dir, pid, 'stat'), `${pid} (${comm[pid] ?? 'x'}) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0\n`)
  }
  writeFileSync(join(dir, 'uptime'), '12345.67 89.01\n') // 非数字条目必须被跳过
  writeFileSync(join(dir, 'self'), 'x')
  return dir
}

let evidence = null
try {
  // ── ①②③：execFileWithKillTree 真超时 → 真杀树 ─────────────────────────────
  const kills = []
  const timeoutError = await execFileWithKillTree(process.execPath, [HANG, PID_FILE], { timeout: 1500, windowsHide: true }, {
    killTree: (pid) => { kills.push(pid); return killProcessTree(pid) },
  }).then(() => null, (error) => error)

  check('真超时：确实抛错（不是挂死）', timeoutError !== null)
  check('超时：错误标记 timedOut=true 且 killed=true', timeoutError?.timedOut === true && timeoutError?.killed === true)
  check('超时：报错文案含「超时 1500ms」与「已终止整棵进程树」',
    /超时 1500ms/u.test(timeoutError?.message ?? '') && /已终止整棵进程树 pid=/u.test(timeoutError?.message ?? ''),
    (timeoutError?.message ?? '').split('\n').slice(-1)[0])
  check('超时：把 pnpm 的 stderr 带回来了（不是只有 Command failed）',
    /fetching left-pad/u.test(timeoutError?.message ?? ''))

  for (let i = 0; i < 40 && !existsSync(PID_FILE); i += 1) await sleep(100) // 假 runner 落盘 pid
  evidence = existsSync(PID_FILE) ? readPids() : null
  check('假 runner 已启动并记录了父子 pid', evidence !== null && evidence.parent > 0 && evidence.grandchild > 0, JSON.stringify(evidence))
  check('超时调用了 killTree，且 pid 正是假 runner 自己', kills.length === 1 && kills[0] === evidence?.parent, `kills=${kills.join(',')} parent=${evidence?.parent}`)

  const parentDead = await waitDead(evidence?.parent)
  const grandchildDead = await waitDead(evidence?.grandchild)
  check('超时后父进程（假 runner）确实没了', parentDead === true, `pid=${evidence?.parent} alive=${alive(evidence?.parent)}`)
  check('超时后**孙进程**也没了（整棵树被杀，不是只杀父进程）', grandchildDead === true, `pid=${evidence?.grandchild} alive=${alive(evidence?.grandchild)}`)

  // ── ④：runPnpmWithFallback 包装后仍保真 ──────────────────────────────────
  const fakeRunner = { kind: 'fake-hang', note: '假 runner（挂住不退出的 node 脚本）', run: () => ({ bin: process.execPath, argv: [HANG, `${PID_FILE}.2`] }) }
  const wrapped = await runPnpmWithFallback(['add', 'left-pad'], {
    runners: [fakeRunner],
    execOpts: { timeout: 1200, windowsHide: true },
  }).then(() => null, (error) => error)
  check('runPnpmWithFallback：超时错误照旧抛出（不静默重试下一个执行方式）',
    wrapped !== null && /Command failed/u.test(wrapped?.message ?? ''))
  check('runPnpmWithFallback：包装后仍保留 timedOut / pid / timeoutMs（定向重试靠它判定）',
    wrapped?.timedOut === true && typeof wrapped?.pid === 'number' && wrapped?.timeoutMs === 1200,
    `timedOut=${wrapped?.timedOut} pid=${wrapped?.pid} timeoutMs=${wrapped?.timeoutMs}`)
  check('runPnpmWithFallback：包装后仍带上 pnpm 原始 stderr',
    /｜真实输出：.*fetching left-pad/u.test(wrapped?.message ?? ''))
  // 2026-09-26（本次改错）：这里以前是**瞬时采样**（`!alive(parent) && !alive(grandchild)`），
  // CI run 36246293996 就红在这一条：超时错误产生于 07.3133s、它在 07.3155s（+2.25ms）判活，
  // 而同一 run 的 ① 链路用有界等待时父子都在约 120ms 内判死 —— 真因是探活抢跑，不是没杀掉。
  // 现在：同样**必须两个都死**才算过（真残留照样 FAIL），但给它 8s 的有界等待（与 ①③ 一致），
  // 并把实测等待时长打出来，下次真出问题能一眼看出是"慢"还是"永远不死"。
  const pidFile2 = `${PID_FILE}.2`
  const hasSecond = existsSync(pidFile2)
  check('runPnpmWithFallback 链路：假 runner 也落了盘（缺文件要 FAIL，不能靠 if 静默跳过）', hasSecond === true)
  if (hasSecond) {
    const second = JSON.parse(readFileSync(pidFile2, 'utf8'))
    const parentWait = await waitUntil(() => !alive(second.parent))
    const grandchildWait = await waitUntil(() => !alive(second.grandchild))
    check('runPnpmWithFallback 那条链路的父子进程同样已被回收',
      parentWait.ok && grandchildWait.ok,
      `${JSON.stringify(second)} 父等=${parentWait.ms}ms 孙等=${grandchildWait.ms}ms alive=${alive(second.parent)}/${alive(second.grandchild)}`)
  }

  // ── ⑤：成功路径 / 普通失败路径的既有语义不变 ──────────────────────────────
  const ok = await execFileWithKillTree(process.execPath, ['-e', 'process.stdout.write("hello")'], { timeout: 20000, windowsHide: true })
  check('成功路径：resolve {stdout,stderr} 且内容正确', ok.stdout === 'hello' && ok.stderr === '', JSON.stringify(ok))
  const nonzero = await execFileWithKillTree(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)'], { timeout: 20000, windowsHide: true }).then(() => null, (error) => error)
  check('普通失败：错误带 code（退出码）与 stderr，且 killed=false（与 execFile 语义一致）',
    nonzero?.code === 3 && /boom/u.test(nonzero?.stderr ?? '') && nonzero?.killed === false, `code=${nonzero?.code}`)
  const spawnErr = await execFileWithKillTree('definitely-not-a-real-binary-xyz', [], { timeout: 20000 }).then(() => null, (error) => error)
  check('命令不存在：ENOENT 消息保留（runPnpmWithFallback 靠它换下一个执行方式）',
    /ENOENT/u.test(spawnErr?.message ?? ''), spawnErr?.message?.slice(0, 60))
  const noTimeout = await execFileWithKillTree(process.execPath, ['-e', 'process.stdout.write("quick")'], { windowsHide: true })
  check('不传 timeout：正常跑完（默认无超时，不改变既有调用语义）', noTimeout.stdout === 'quick')

  // ── ⑤b：AbortSignal 中断也要杀树（安装竞速里另一条通道成功后要 abort 这条）──
  const controller = new AbortController()
  const abortKills = []
  const aborted = execFileWithKillTree(process.execPath, [HANG, `${PID_FILE}.3`], { timeout: 60000, windowsHide: true, signal: controller.signal }, {
    killTree: (pid) => { abortKills.push(pid); return killProcessTree(pid) },
  }).then(() => null, (error) => error)
  for (let i = 0; i < 40 && !existsSync(`${PID_FILE}.3`); i += 1) await sleep(100)
  controller.abort()
  const abortError = await aborted
  const third = existsSync(`${PID_FILE}.3`) ? JSON.parse(readFileSync(`${PID_FILE}.3`, 'utf8')) : null
  check('中断（AbortSignal）：错误标记 aborted 且调用了 killTree',
    abortError?.killed === true && abortKills.length === 1, `kills=${abortKills.join(',')}`)
  check('中断后整棵树也没了', third !== null && (await waitDead(third.parent)) && (await waitDead(third.grandchild)), JSON.stringify(third))

  // ── ⑥：killProcessTree 只有一份实现（repoland re-export 同一个函数）────────
  check('repoland.js 的 killProcessTree 与 infra 的是同一个函数（re-export，不再拷贝）',
    killProcessTreeFromRepoland === killProcessTree)
  check('killProcessTree 对非法 pid 返回 false（不抛）',
    killProcessTree(0) === false && killProcessTree(undefined) === false && killProcessTree(-1) === false)

  // ── ⑦：POSIX 分支（本机是 Windows：这一节用**注入桩/模型**把 Linux 那条路走一遍）────────
  // 覆盖三件在 Windows 上永远跑不到、却正是 CI（Ubuntu）失败面的决策：
  //   ⑦a POSIX spawn 必须 detached（自成进程组）—— `-pid` 有没有对象可杀全看它
  //   ⑦b 成组成功 → 只发一次 kill(-pid)
  //   ⑦c 成组失败（子进程没成组 / 已 setsid）→ 按 /proc 的 ppid 链把**孙进程也**杀掉，
  //      无关进程不碰；并用负向对照证明"只杀父进程"会被这组断言判死
  //   ⑦d 抖动回归：SIGKILL 后的探活可见延迟 → 瞬时采样必挂、有界等待才过（CI 那次 FAIL 的形态）

  // ⑦a：用 stub spawnFn 截住 opts，分别按 linux / win32 跑一遍（不真的起进程）
  const spawnOptsFor = (platform) => new Promise((resolve) => {
    const listeners = {}
    const child = {
      pid: 424242,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, handler) => { listeners[event] = handler; return child },
    }
    let seen = null
    execFileWithKillTree('fake-pnpm', ['add', 'x'], { timeout: 20000 }, {
      platform,
      spawnFn: (bin, argv, opts) => { seen = opts; return child },
      killTree: () => true,
    }).then(() => resolve(seen), () => resolve(seen))
    setImmediate(() => listeners.close?.(0))
  })
  const posixSpawnOpts = await spawnOptsFor('linux')
  check('POSIX：spawn 时 detached=true（自成进程组，kill(-pid) 才有对象可杀）',
    posixSpawnOpts?.detached === true, `detached=${posixSpawnOpts?.detached}`)
  const winSpawnOpts = await spawnOptsFor('win32')
  check('Windows：spawn 时 detached=false（杀树靠 taskkill /F /T，语义不变、不弹新控制台窗口）',
    winSpawnOpts?.detached === false, `detached=${winSpawnOpts?.detached}`)

  // ⑦b：成组杀得掉 → 只发 kill(-pid)，不退化去扫 /proc
  const groupCalls = []
  const groupOk = killProcessTree(3300, {
    platform: 'linux',
    kill: (target, signal) => { groupCalls.push(`${target}/${signal}`); if (target > 0) throw new Error('不该逐个杀') },
  })
  check('POSIX：进程组存在时只发一次 kill(-pid) SIGKILL（不做多余的事）',
    groupOk === true && groupCalls.join(',') === '-3300/SIGKILL', `ok=${groupOk} calls=${groupCalls.join(',')}`)

  // ⑦c：成组失败 → /proc 兜底把整棵树杀掉（假 /proc：3300 假 pnpm ← 3310 git ← 3311 tar；4400 无关）
  const fakeProc = makeFakeProc({ 3300: 1, 3310: 3300, 3311: 3310, 4400: 1 })
  fakeProcDirs.push(fakeProc)
  const parsed = posixDescendants(3300, { procDir: fakeProc })
  check('POSIX：/proc 解析能列出全部后代（进程名含空格/括号、非数字目录都跳过、无关分支不牵连）',
    JSON.stringify([...parsed].sort((a, b) => a - b)) === JSON.stringify([3310, 3311]), JSON.stringify(parsed))
  check('POSIX：没有 /proc（macOS）时返回 []、不抛（退化为只杀直接子进程，不比旧行为差）',
    Array.isArray(posixDescendants(1, { procDir: `${fakeProc}-not-there` })) && posixDescendants(1, { procDir: `${fakeProc}-not-there` }).length === 0)

  const fallbackKills = []
  const fallbackOk = killProcessTree(3300, {
    platform: 'linux',
    procDir: fakeProc,
    kill: (target) => {
      fallbackKills.push(target)
      if (target === -3300) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }) // 进程组不存在：线上/CI 的真实形态
      if (target === 4400) throw new Error('不该碰无关进程')
    },
  })
  check('POSIX 兜底：成组失败时不再只杀父进程 —— 孙/重孙都逐个 SIGKILL，父最后杀',
    fallbackOk === true && fallbackKills.join(',') === '-3300,3311,3310,3300', `ok=${fallbackOk} kills=${fallbackKills.join(',')}`)
  check('POSIX 兜底：无关进程没被误杀（只按 ppid 链走）', !fallbackKills.includes(4400), fallbackKills.join(','))
  check('POSIX 兜底：一个都杀不掉时才返回 false（返回值语义与旧代码一致）',
    killProcessTree(3300, { platform: 'linux', procDir: fakeProc, kill: () => { throw new Error('EPERM') } }) === false)
  const tree = { 3300: 1, 3310: 3300, 3311: 3310 }
  check('负向对照：旧实现（只 kill(pid)）在这棵树上必须判"没杀干净" —— 断言不放过孙进程',
    treeAllDead(tree, new Set([3300])) === false
    && treeAllDead(tree, new Set(fallbackKills.filter((p) => p > 0))) === true)

  // ⑦d：抖动回归 —— 把 CI 那条 FAIL 的形态在模型里原样复现：进程表在信号后 250ms 才"看不见"
  const OBSERVE_LAG_MS = 250
  const signalAt = Date.now()
  const table = new Map([[5500, true], [5510, true], [9900, true]]) // 5500 父 / 5510 孙 / 9900 永远杀不掉的残留
  const modelAlive = (pid) => table.get(pid) === true && Date.now() - signalAt < OBSERVE_LAG_MS
  check('抖动回归：即时采样必然判"父子都还活着"（CI 那次 FAIL 的形态，不是没杀掉）',
    (!modelAlive(5500) && !modelAlive(5510)) === false)
  const bounded = await waitUntil(() => !modelAlive(5500) && !modelAlive(5510), 5000)
  check('抖动回归：同一个进程表用有界等待判"整棵树都没了"（结论不变，只是不再抢跑）',
    bounded.ok === true, `等待 ${bounded.ms}ms`)
  const residue = await waitUntil(() => !modelAlive(9900) && table.get(9900) !== true, 400)
  check('抖动回归：真残留（模型里永远不死）有界等待后照样判死不成 → FAIL（没有放宽断言）',
    residue.ok === false, `等待 ${residue.ms}ms`)
} finally {
  // 兜底：万一断言中途炸了，别把测试进程/孙进程留在机器上
  try {
    if (evidence !== null) { killProcessTree(evidence.parent); killProcessTree(evidence.grandchild) }
    for (const f of [`${PID_FILE}.2`, `${PID_FILE}.3`]) {
      if (existsSync(f)) { const p = JSON.parse(readFileSync(f, 'utf8')); killProcessTree(p.parent); killProcessTree(p.grandchild) }
    }
  } catch {}
  // 清理临时目录：本机实测 `rmSync` 会**静默落空**（目录仍在、不抛错，与 fsx.js 注释里那台机器的表现一致），
  // 所以走仓库自己的"删除 + 核实 + 外部兜底"助手，删不掉就如实打印
  try {
    const cleaned = await removeDirVerifiedAsync(DIR, { attempts: 1, pollMs: 400 })
    if (cleaned.ok !== true) console.log(`（提示：临时目录未能删除：${DIR} — ${cleaned.error ?? '未知'}）`)
    for (const dir of fakeProcDirs) await removeDirVerifiedAsync(dir, { attempts: 1, pollMs: 400 })
  } catch {}
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
