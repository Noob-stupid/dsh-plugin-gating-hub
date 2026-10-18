// 0.5.84 加法（用户第 5 项）：独立实例的 **detached 重拉**
//
// 背景：2026-10-10 的事故成因是「桌面端托管时自杀 + 与宿主争端口」，所以当时把「重启」一律关了。
// 独立 `dsh web` 没有这个问题（它自己就是那个进程、端口也归它）⇒ 给它一条真的重启路，但一条红线不松：
//   不 kill 任何进程（含自己）、不建计划任务、不自删；只用 detached spawn 起一个新进程，老进程自己优雅退出。
//
// 本套断言（全离线，**绝不真的起进程**）：
//   ① 判据：桌面端托管时**忽略**重拉计划（永远 spawns=false）；独立实例有计划才走 standalone-relaunch；
//   ② 启动器脚本的形状：只做「等端口空了 → 起新实例」，且**不含 kill**；
//   ③ 端口竞态由启动器解决（新进程不会在端口还占着时启动 → 不会 EADDRINUSE）；
//   ④ 进程原语走 infra/egress.js#spawnDetached ⇒ 计数与 tripwire 可证"没真起进程"；
//   ⑤ 计划无效（没有 bin）时**不动手**并如实说明。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const { PORT_POLL_MS, PORT_WAIT_DEADLINE_MS, launcherScript, planRelaunch, relaunchDetached } = await import('../lib/server/domain/restart-launcher.js')
const { RESTART_CHANNEL, restartPathDecision } = await import('../lib/server/domain/restart.js')
const { __setEgressStub, __resetEgressStats, egressStatsNow } = await import('../lib/server/infra/egress.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

console.log('=== ① 判据：桌面端托管忽略计划；独立实例有计划才重拉 ===')
{
  const plan = { ok: true, reason: null, plan: { bin: 'C:/fake/bin.js', args: ['web', '--port', '3080'], port: 3080, cwd: null } }
  const hosted = restartPathDecision({ hosted: true, relaunch: plan })
  check('① 桌面端托管 + 递进计划 ⇒ 仍然 spawns=false / status=409（红线：那一半一个字没动）',
    hosted.spawns === false && hosted.status === 409 && hosted.channel === RESTART_CHANNEL.desktopClient && hosted.details.scheduledTask === false,
    JSON.stringify({ spawns: hosted.spawns, status: hosted.status, channel: hosted.channel }))
  const standalone = restartPathDecision({ hosted: false, relaunch: plan })
  check('① 独立实例 + 可用计划 ⇒ standalone-relaunch、200、spawns=true',
    standalone.channel === RESTART_CHANNEL.standaloneRelaunch && standalone.ok === true && standalone.status === 200 && standalone.spawns === true)
  check('① 无论哪条路：kill / scheduledTask / selfDelete 恒为 false',
    [hosted, standalone].every((d) => d.details.kill === false && d.details.scheduledTask === false && d.details.selfDelete === false),
    JSON.stringify([hosted, standalone].map((d) => d.details.kill)))
  const noPlan = restartPathDecision({ hosted: false })
  check('① 独立实例但没有计划 ⇒ 回落 unavailable（如实告知手动重启）',
    noPlan.channel === RESTART_CHANNEL.unavailable && noPlan.status === 409 && noPlan.spawns === false)
}

console.log('\n=== ② 启动器脚本：只做「等端口空了 → 起新实例」，不含 kill ===')
{
  const script = launcherScript()
  check('② 等端口：先 net.connect 探测，连不上（端口空了）才启动', /net\.connect/u.test(script) && /freeProbe/u.test(script))
  check('② 新实例用 spawn(process.execPath, [bin, ...args]) + unref（父进程退出后继续跑）',
    /spawn\(process\.execPath/u.test(script) && /child\.unref\(\)/u.test(script))
  check('② 计划从环境变量 DSH_RELAUNCH_PLAN 读（不走 `node -e` 的 argv 位置 —— 那是不直观的坑）',
    /process\.env\.DSH_RELAUNCH_PLAN/u.test(script))
  check('② 等端口有**上限**（不会留一个无限轮询的僵尸进程）',
    /deadline/u.test(script) && /process\.exit\(1\)/u.test(script) && PORT_WAIT_DEADLINE_MS === 30000, String(PORT_WAIT_DEADLINE_MS))
  check('② 脚本里**没有任何 kill**（红线：只起新进程，不动老进程）',
    !/\.kill\(/u.test(script) && !/taskkill/iu.test(script) && !/Stop-Process/iu.test(script) && !/schtasks/iu.test(script))
  check('② 轮询间隔是常量（250ms，别把 CPU 打满）', PORT_POLL_MS === 250, String(PORT_POLL_MS))
}

console.log('\n=== ③ 计划：没有 bin 就不动手（不硬来）===')
{
  const missing = planRelaunch({ binPath: '', port: 3080 })
  check('③ 拿不到 bin ⇒ ok=false 且说明后果（请手动重启）', missing.ok === false && /找不到 DSH 的入口/u.test(String(missing.reason)) && missing.plan === null)
  const good = planRelaunch({ binPath: 'C:/x/bin.js', args: ['web', null, 1], port: 3080 })
  check('③ 正常计划：args 过滤非法项、端口归一成整数',
    good.ok === true && JSON.stringify(good.plan.args) === JSON.stringify(['web']) && good.plan.port === 3080, JSON.stringify(good.plan))
  const p = planRelaunch({ binPath: 'C:/x/bin.js', args: ['web'], port: 'abc' })
  check('③ 端口非法 → 记 null（不编造一个端口）', p.plan.port === null, String(p.plan.port))
}

console.log('\n=== ④ 起进程走 egress 出口：注入替身可证"一次都没真起" ===')
{
  __resetEgressStats()
  __setEgressStub({ spawnDetached: async (cmd, argv, opts) => ({ pid: 1234, detached: true, seen: { cmd, argvLen: argv.length, plan: opts?.env?.DSH_RELAUNCH_PLAN } }) })
  const plan = planRelaunch({ binPath: 'C:/x/bin.js', args: ['web', '--port', '3080'], port: 3080 }).plan
  const out = await relaunchDetached(plan)
  check('④ 派发成功并带回 pid', out.started === true && out.pid === 1234, JSON.stringify(out))
  check('④ 真的经 egress 出口（stubCalls 记到 1 次）', egressStatsNow().stubCalls >= 1, `stubCalls=${egressStatsNow().stubCalls}`)
  check('④ 一次真实进程都没起（realSpawn 仍是 0）', egressStatsNow().realSpawn === 0, `realSpawn=${egressStatsNow().realSpawn}`)
  __setEgressStub(null)
}

console.log('\n=== ⑤ 失败面：计划无效 / 出口抛错都要如实回，不静默 ===')
{
  const bad = await relaunchDetached(null)
  check('⑤ 计划无效 ⇒ started=false + 说明未起任何进程', bad.started === false && /计划无效/u.test(String(bad.error)), String(bad.error))
  const boom = await relaunchDetached({ bin: 'C:/x/bin.js', args: [] }, { spawn: async () => { throw new Error('模拟 EPERM') } })
  check('⑤ 出口抛错 ⇒ started=false + 原话带回（不吞）', boom.started === false && /EPERM/u.test(String(boom.error)), String(boom.error))
}

console.log('\n=== ⑥ 静态：进程原语只出现在 egress.js（全仓唯一出口）===')
{
  const launcherSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'restart-launcher.js'), 'utf8')
  check('⑥ restart-launcher.js 不直接 import node:child_process（走 infra/egress.js 的可注入出口）',
    !/from 'node:child_process'/u.test(launcherSrc) && /from '\.\.\/infra\/egress\.js'/u.test(launcherSrc))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
