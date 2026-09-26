// 批次 A-② 的真实验收（2026-09-27）：**git 通道在预算内结束，后续候选照旧被尝试**。
//
// 为什么必须有这一条：真机（本机 hosts 被加速器改过）github.com 直连不可达、api.github.com 也不可达，
// 于是"private 根包 → 展开子包"这条链路的判据只能靠注入的探测结果提供；但 **git 通道本身必须是真的**
// —— 预算到底有没有管住 pnpm+git 那棵树，只有真跑一遍才算。
//
// 场景（"两个源都不可用 + 大仓"）：
//   · 软件源里只有一个 git 源：本机"只连不传"的 TCP 桩源（连得上、一个字节都不发）＝最坏情况的镜像；
//   · 作业预算 30 秒、git 通道预算 15 秒（DSH_GIT_CHANNEL_BUDGET_MS=15000）；
//   · 候选链：pkg-missing（registry 404）→ 自动展开出 @probe/agg → 该候选也 404 → 走 AI 兜底（用注入的
//     短超时立刻结束，不让用例干等 10 分钟）。
// 断言：git 规格只真跑 1 次就因预算停手（不会把 3 个规格挨个试满）、
//       展开出来的下一个候选在 git 之后**确实被尝试过**、全程耗时 < 作业预算。
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInstallJob } from '../lib/server/domain/install-job.js'
import { pnpmInstall } from '../lib/server/domain/install.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = join(tmpdir(), `dsh-git-budget-real-${process.pid}`)
const PROFILE = join(HOME, 'profiles', 'web')
disposeDir(HOME)
mkdirSync(PROFILE, { recursive: true })
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# real-git-budget\n', 'utf8')
writeFileSync(join(PROFILE, 'cordis.yml'), 'plugins: []\n', 'utf8')
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

// 桩源：接受 TCP 连接后一个字节都不发（模拟"连得上、传不动"的镜像）
const sockets = []
const server = createServer((socket) => {
  // 杀树时对端会 RST：桩源必须自己吞掉 socket 错误，否则测试进程会被未处理的 'error' 事件带走
  socket.on('error', () => {})
  sockets.push(socket)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const stallPort = server.address().port

const savedHome = process.env.DSH_HOME
const savedBudget = process.env.DSH_GIT_CHANNEL_BUDGET_MS
process.env.DSH_HOME = HOME
process.env.DSH_GIT_CHANNEL_BUDGET_MS = '15000'

const calls = []
const installChannels = {
  raceInstallChannels: async () => { calls.push('race'); return null },
  pnpmInstall: async (dir, spec, registry, timeoutMs) => {
    const s = String(spec)
    if (s.startsWith('git+') || s.startsWith('github:')) {
      calls.push(`git:${s}:${timeoutMs}`)
      // ★ 只有 git 规格走**真实** pnpm（含真实 git 子树与杀树等待）；其余一律桩失败
      return pnpmInstall(dir, s, registry, timeoutMs)
    }
    calls.push(`pnpm:${s}`)
    throw new Error(`桩：registry 没有 ${s}（404）`)
  },
  curlManualInstall: async (dir, name) => { calls.push(`curl:${name}`); throw new Error('桩：curl 404') },
  githubReleaseInstall: async (dir, repo, name) => { calls.push(`release:${name}`); throw new Error('桩：release 没命中') },
  backfillMissingDeps: async () => [],
}
const ports = {
  baseUrl: pathToFileURL(join(PROFILE, 'cordis.yml')).href,
  loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(PROFILE, 'cordis.yml')).href } } }] },
  get: (name) => (name === 'installChannels' ? installChannels : undefined),
}

// 隔离 DSH_HOME 里的「软件源」：唯一 git 源就是那个桩源
writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
  registries: [{ id: 'npmmirror', name: 'npmmirror', url: 'https://registry.npmmirror.com', primary: true }],
  gitSources: [{ id: 'stall', name: '只连不传的桩源', urlTemplate: `http://127.0.0.1:${stallPort}/{owner}/{repo}.git`, primary: true }],
}, null, 2), 'utf8')

const job = {
  id: 'job-real-budget', repo: 'probe-org/big-repo', source: 'github', packageName: 'pkg-missing',
  status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
  entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
}

const t = Date.now()
let thrown = null
try {
  await runInstallJob(job, ports, {
    jobBudgetMs: 30000,
    aiConsentTimeoutMs: 400, // 不让用例干等 10 分钟（生产恒为 10 分钟）
    marketProbes: {
      fetchRepoPackage: async () => null,               // 根包探测不到 → 不做 subpackageMode
      fetchRepoPackageEx: async () => ({ pkg: null, reason: 'not-found' }),
      fetchSubpackageNames: async () => [{ name: '@probe/agg' }], // 自动展开出一个新候选
      subpackageCandidates: async () => [],
    },
  })
} catch (error) { thrown = error }
const ms = Date.now() - t

for (const s of sockets) { try { s.destroy() } catch {} }
await new Promise((resolve) => server.close(resolve))
if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
if (savedBudget === undefined) delete process.env.DSH_GIT_CHANNEL_BUDGET_MS
else process.env.DSH_GIT_CHANNEL_BUDGET_MS = savedBudget

console.log(`INFO 通道调用顺序：${calls.join(' → ')}`)
console.log(`INFO 总耗时 ${(ms / 1000).toFixed(1)} 秒；job.channelNotes=${JSON.stringify(job.channelNotes ?? [])}`)
console.log(`INFO job.status=${job.status} error=${String(job.error ?? '').slice(0, 120)}`)

const gitCalls = calls.filter((c) => c.startsWith('git:'))
const aggIdx = calls.findIndex((c) => c === 'pnpm:@probe/agg')
check('没有异常逃逸（作业自己收尾）', thrown === null, thrown === null ? 'ok' : String(thrown?.message).slice(0, 160))
check('★ git 规格只真跑了 1 次就因预算停手（不再把 3 个规格挨个试满）', gitCalls.length === 1, gitCalls.join(' | '))
check('★ git 规格拿到的超时 ≤ git 通道预算 15 秒（不会变成 pnpm 默认的 60 秒）',
  gitCalls.length === 1 && Number(gitCalls[0].split(':').pop()) <= 15000, gitCalls[0] ?? '（没有 git 调用）')
check('★ 自动展开的候选在 git 之后**确实被尝试过**（"后续候选不被 git 吃光"）',
  aggIdx > calls.findIndex((c) => c.startsWith('git:')), `agg 在第 ${aggIdx + 1} 步 / ${calls.length} 步`)
check('★ 面板可见的原因：git 通道预算已用尽，剩余 git 源不再尝试',
  (job.channelNotes ?? []).some((n) => n.includes('git 通道预算') && n.includes('已用尽')), JSON.stringify(job.channelNotes ?? []))
check('★ 全程耗时在作业预算内（30 秒）结束，而不是挂到 pnpm/curl 的默认超时',
  ms < 30000, `${(ms / 1000).toFixed(1)} 秒`)
check('作业如实收尾为 failed（AI 兜底未获授权 → 不假装成功）',
  job.status === 'failed' && /AI 兜底/u.test(String(job.error ?? '')), `${job.status} / ${String(job.error ?? '').slice(0, 80)}`)

disposeDir(HOME)
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
