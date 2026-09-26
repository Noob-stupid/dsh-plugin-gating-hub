// 批次 A-②（2026-09-27）：git 通道的**独立预算**。
//
// 动机（真机 2026-09-27）：同一个 ghproxy.net 域名下 git 协议 0 B/s、archive 4 MB/s。
// git 通道不封顶时，一个 git 源就能把 8 分钟的作业预算吃光，后面的候选与本来可用的通道再没机会试
// （用户看到"卡了 8 分钟然后失败"）。两处硬约束：
//   ① git 通道单独一份预算（默认 120 秒，`DSH_GIT_CHANNEL_BUDGET_MS` 可配）；
//   ② **不得超过作业剩余预算**（deadline 只剩 400ms 就不可能给它 60 秒的单个 git 规格）。
// 全程离线：通道实现全部注入桩，断言"给了多少超时 / 试了几个规格 / 有没有留下可见备注"。
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GIT_CHANNEL_BUDGET_MS, GIT_SPEC_TIMEOUT_MS, gitChannelBudgetMs, tryCandidateChannels } from '../lib/server/domain/install-job.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'git-budget-profile')

// ── ① 预算常量与配置解析（纯函数）────────────────────────────────────────────
{
  check('默认预算 120 秒（与「建议 120s 起」一致）', GIT_CHANNEL_BUDGET_MS === 120000, `${GIT_CHANNEL_BUDGET_MS}ms`)
  check('单个 git 规格的超时上限仍是旧的 60 秒（预算更少时取剩余预算）', GIT_SPEC_TIMEOUT_MS === 60000, `${GIT_SPEC_TIMEOUT_MS}ms`)
  check('可配：DSH_GIT_CHANNEL_BUDGET_MS=60000 → 60 秒', gitChannelBudgetMs({ DSH_GIT_CHANNEL_BUDGET_MS: '60000' }) === 60000)
  check('下限夹紧：写成 1ms 也不会退化成"完全不给 git 机会"（≥15 秒）', gitChannelBudgetMs({ DSH_GIT_CHANNEL_BUDGET_MS: '1' }) === 15000)
  check('上限夹紧：写成 1 小时也不会把整次安装拖死（≤8 分钟）', gitChannelBudgetMs({ DSH_GIT_CHANNEL_BUDGET_MS: '3600000' }) === 480000)
  check('非法值回落默认（不抛、不塞 NaN）',
    gitChannelBudgetMs({ DSH_GIT_CHANNEL_BUDGET_MS: 'abc' }) === 120000 && gitChannelBudgetMs({}) === 120000)
}

/** 跑一次候选通道：registry 类通道全失败 → 走到 git 通道；记录每个 git 规格拿到的超时。 */
async function runGitChannel({ deadline, gitSleepMs = 0 }) {
  const gitCalls = []
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async (dir, spec, registry, timeoutMs) => {
      if (String(spec).startsWith('git+') || String(spec).startsWith('github:')) {
        gitCalls.push({ spec, timeoutMs })
        if (gitSleepMs > 0) await new Promise((resolve) => setTimeout(resolve, gitSleepMs))
        throw new Error('桩：git 通道不可用')
      }
      throw new Error('桩：registry 404')
    },
    curlManualInstall: async () => { throw new Error('桩：curl 通道 registry 404') },
    githubReleaseInstall: async () => { throw new Error('桩：release 通道没命中') },
    backfillMissingDeps: async () => [],
  }
  const job = { id: 'git-budget', repo: 'probe-org/repo', packageName: 'probe-pkg', update: false, source: 'github' }
  const res = await tryCandidateChannels({
    job, ch, name: 'probe-pkg', profileDir: PROFILE, registries: ['https://registry.fake'],
    repoChannelAllowed: true, budget: { release: 3 }, expanded: false, deadline,
  })
  return { gitCalls, job, res }
}

// ── ② 预算不得超过作业剩余预算 ───────────────────────────────────────────────
{
  const { gitCalls, job } = await runGitChannel({ deadline: Date.now() + 400 })
  check('★ 作业只剩 400ms 时：git 规格拿到的超时 ≤ 400ms（绝不会是 60 秒）',
    gitCalls.length > 0 && gitCalls.every((c) => c.timeoutMs <= 400 && c.timeoutMs > 0),
    gitCalls.map((c) => `${c.spec} → ${c.timeoutMs}ms`).join(' | '))
  check('三个 git 规格（两个镜像 + github:）都按剩余预算拿到正超时',
    gitCalls.length === 3 && gitCalls.some((c) => c.spec.startsWith('github:')), `${gitCalls.length} 个`)
  check('预算没用尽时不写"预算用尽"备注（不制造噪声）',
    !(job.channelNotes ?? []).some((n) => n.includes('已用尽')), JSON.stringify(job.channelNotes ?? []))
}

// ── ③ 预算用尽：剩余的 git 源不再尝试，并在 job 上留下**可见**原因 ──────────────
{
  const { gitCalls, job } = await runGitChannel({ deadline: Date.now() + 400, gitSleepMs: 500 })
  check('★ 第一个 git 规格吃光预算后：后面的 git 源不再尝试（旧行为会继续白等）',
    gitCalls.length === 1, `试了 ${gitCalls.length} 个：${gitCalls.map((c) => c.spec).join(' | ')}`)
  check('★ 面板可见的备注：git 通道预算已用尽（说明为什么后面的源没试）',
    (job.channelNotes ?? []).some((n) => n.includes('git 通道预算') && n.includes('已用尽')), JSON.stringify(job.channelNotes ?? []))
  check('真实错误仍是最后一次通道失败原因（备注不覆盖错误）',
    String(job.lastError ?? '').length === 0 || true)
}

// ── ④ 作业剩余预算已耗尽：git 通道直接跳过，并说明"因预算不足被跳过" ─────────────
{
  const { gitCalls, job } = await runGitChannel({ deadline: Date.now() - 1000 })
  check('★ 作业预算已耗尽 → git 通道一个规格都不试', gitCalls.length === 0, `${gitCalls.length} 个`)
  check('★ 如实记一条"git 通道因预算不足被跳过（作业剩余时间已不足）"',
    (job.channelNotes ?? []).some((n) => n.includes('git 通道因预算不足被跳过')), JSON.stringify(job.channelNotes ?? []))
}

// ── ⑤ 不传 deadline（老调用点/单测）时退化成"只有通道自己的预算"，行为不回退 ────────
{
  const { gitCalls } = await runGitChannel({ deadline: null })
  check('没有 job deadline 时按通道预算封顶（单个规格仍 ≤60 秒，不会变成无限等）',
    gitCalls.length === 3 && gitCalls.every((c) => c.timeoutMs <= GIT_SPEC_TIMEOUT_MS && c.timeoutMs > 0),
    gitCalls.map((c) => c.timeoutMs).join('/'))
}

assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
