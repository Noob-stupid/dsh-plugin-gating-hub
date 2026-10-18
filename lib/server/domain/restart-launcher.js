// L1 · domain —— restart-launcher.js（独立实例的**detached 重拉**：只起新进程，绝不动老进程；0.5.84 加法）
// 分层分组：L1 · domain（不认识 cordis ctx；进程原语经 infra/egress.js 的 spawnDetached 出口）
//
// ── 为什么需要它（用户 2026-10 的第 5 项）────────────────────────────────────────
//   「重启服务」过去在全仓是**一律拒绝**的：`restartPathDecision` 硬编码 spawns:false / kill:false。
//   那条红线来自 2026-10-10 的真机事故 —— 但事故的成因是**桌面端托管**时自杀 + 与宿主争端口
//   （详见 domain/restart.js 顶部取证）。**独立 `dsh web` 实例**没有那个问题：它自己就是那个进程，
//   端口也归它；重启它只需要"起一个新进程 + 自己退出"。
//   ⇒ 所以本模块只服务非 shell 托管的那一半，且只做两件事：
//        ① 起一个 **detached** 的新实例（`node <bin.js> web [--port N]`）；
//        ② 老进程**自己优雅退出**（不 kill 自己、不建计划任务、不自删）—— 端口随之释放。
//
// ── 端口竞态（必须处理，否则新实例必然 EADDRINUSE）────────────────────────────────
//   父进程收到请求时端口还占着，而它要等响应发完才退出。所以新进程不能直接起 ——
//   由本模块起一个**极小的中间启动器**（`node -e <script>`，无临时文件）：
//        轮询 127.0.0.1:port，直到连接被拒绝（= 端口空了）再 spawn 真实例；
//        最多等 30s，等不到就自己退出（绝不无限挂着一个轮询进程）。
//   计划通过 `DSH_RELAUNCH_PLAN` 环境变量传给启动器（不走 argv —— `node -e` 下的 argv 位置不直观）。
//
// ── 红线（一条不减）────────────────────────────────────────────────────────────────
//   · 不 kill 任何进程（包括自己）：`kill:false`、`scheduledTask:false`、`selfDelete:false`；
//   · 只在 `host.hosted !== true` 时才会走到这里（判据在 domain/restart.js，唯一承担者）；
//   · 进程原语只经 infra/egress.js 的 `spawnDetached` 出口 ⇒ 单测注入替身后"一次真进程都没起"
//     是**可计数证明**的（tests/test-standalone-relaunch.mjs 就此断言）。
import { spawnDetached } from '../infra/egress.js'

/** 启动器最多等端口多久（毫秒）。 **有上限**：等不到就自己退出，不留悬挂轮询进程。 */
const PORT_WAIT_DEADLINE_MS = 30000
/** 轮询间隔（毫秒）。 */
const PORT_POLL_MS = 250

/**
 * 启动器脚本（**纯文本**，单测可断言它只做"等端口 → 起新进程"）。
 * 读 `DSH_RELAUNCH_PLAN`（JSON: { bin, args, cwd, port }）。
 */
function launcherScript() {
  return [
    "const net = require('node:net')",
    "const { spawn } = require('node:child_process')",
    "const plan = JSON.parse(process.env.DSH_RELAUNCH_PLAN || '{}')",
    'const port = Number(plan.port) || 0',
    'const deadline = Date.now() + Number(plan.deadlineMs) || 0',
    'const poll = Number(plan.pollMs) || 250',
    'const freeProbe = () => new Promise((resolve) => {',
    "  const socket = net.connect({ host: '127.0.0.1', port: port })",
    '  const settle = (free) => { try { socket.destroy() } catch { } ; resolve(free) }',
    '  socket.setTimeout(1000, () => settle(false))',
    '  socket.once(' + "'error'" + ', () => settle(true))',
    '  socket.once(' + "'connect'" + ', () => settle(false))',
    '})',
    'const start = () => {',
    '  const child = spawn(process.execPath, [plan.bin].concat(plan.args || []), { detached: true, stdio: ' + "'ignore'" + ', windowsHide: true, cwd: plan.cwd || undefined })',
    '  child.unref()',
    '  process.exit(0)',
    '}',
    'const tick = () => {',
    '  if (Number.isFinite(deadline) && deadline > 0 && Date.now() > deadline) process.exit(1)',
    '  freeProbe().then((free) => { if (free) start(); else setTimeout(tick, poll) })',
    '}',
    'tick()',
  ].join('\n')
}

/**
 * 规划一次 detached 重拉（**纯函数**）：argv 由调用方给（bin 路径由 routes 层按既有 `resolveDshBin` 解析）。
 * @returns {{ ok: boolean, reason: string|null, plan: object|null }}
 */
function planRelaunch({ binPath, args = [], port = null, cwd = null } = {}) {
  const bin = typeof binPath === 'string' ? binPath.trim() : ''
  if (bin === '') return { ok: false, reason: '找不到 DSH 的入口（bin.js），无法自动重启 —— 请手动重启这个 dsh web 进程', plan: null }
  const argv = (Array.isArray(args) ? args : []).filter((a) => typeof a === 'string')
  const numericPort = Number.isFinite(port) && port > 0 ? Math.floor(port) : null
  return {
    ok: true,
    reason: null,
    plan: {
      bin,
      args: argv,
      cwd: typeof cwd === 'string' && cwd !== '' ? cwd : null,
      port: numericPort,
      deadlineMs: PORT_WAIT_DEADLINE_MS,
      pollMs: PORT_POLL_MS,
    },
  }
}

/**
 * 真的起那个启动器（**detached + unref**，父进程退出后继续活）。
 * `deps.spawn` 只为单测注入（生产走 infra/egress.js 的 spawnDetached 出口）。
 * @returns {Promise<{ started: boolean, pid: number|null, error: string|null }>}
 */
async function relaunchDetached(plan, { spawn = spawnDetached, env = process.env } = {}) {
  if (plan === null || typeof plan !== 'object' || typeof plan.bin !== 'string' || plan.bin === '') {
    return { started: false, pid: null, error: '重拉计划无效（缺少 bin 路径），未起任何进程' }
  }
  if (typeof spawn !== 'function') return { started: false, pid: null, error: '进程出口不可用（spawnDetached 未接线）' }
  const payload = JSON.stringify({ bin: plan.bin, args: plan.args ?? [], cwd: plan.cwd ?? null, port: plan.port ?? null, deadlineMs: plan.deadlineMs ?? PORT_WAIT_DEADLINE_MS, pollMs: plan.pollMs ?? PORT_POLL_MS })
  try {
    const out = await spawn(process.execPath, ['-e', launcherScript()], {
      env: { ...env, DSH_RELAUNCH_PLAN: payload },
      cwd: plan.cwd ?? undefined,
      detached: true,
    })
    return { started: true, pid: out !== null && typeof out?.pid === 'number' ? out.pid : null, error: null }
  } catch (error) {
    return { started: false, pid: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export { PORT_POLL_MS, PORT_WAIT_DEADLINE_MS, launcherScript, planRelaunch, relaunchDetached }
