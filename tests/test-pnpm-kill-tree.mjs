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
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeDirVerifiedAsync } from '../lib/server/infra/fsx.js'
import { execFileWithKillTree, killProcessTree, processAlive, runPnpmWithFallback } from '../lib/server/infra/exec.js'
import { killProcessTree as killProcessTreeFromRepoland } from '../lib/server/domain/repoland.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const DIR = mkdtempSync(join(tmpdir(), 'dsh-pnpm-kill-'))
const HANG = join(DIR, 'hang-runner.cjs')
const PID_FILE = join(DIR, 'pids.json')
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
/** 等进程真的消失（Windows 上 taskkill 同步返回后进程表偶尔还要一拍才刷新）。 */
async function waitDead(pid, timeoutMs = 8000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!alive(pid)) return true
    await sleep(120)
  }
  return !alive(pid)
}
const readPids = () => JSON.parse(readFileSync(PID_FILE, 'utf8'))

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
  if (existsSync(`${PID_FILE}.2`)) {
    const second = JSON.parse(readFileSync(`${PID_FILE}.2`, 'utf8'))
    check('runPnpmWithFallback 那条链路的父子进程同样已被回收',
      !alive(second.parent) && !alive(second.grandchild), JSON.stringify(second))
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
  } catch {}
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
