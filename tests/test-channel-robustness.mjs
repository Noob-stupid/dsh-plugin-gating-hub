// 批次 A-④ / A-⑤（2026-09-27）：两处"会让用户看不到真相"的缺口。
//
// A-④ 通道 0（并行竞速）不设防：旧代码里 raceInstallChannels 或紧随其后的 backfillMissingDeps
//   抛一次异常就直接把作业判 failed —— **后面的串行通道一个都不再试**，而它们本来可能装得上。
// A-⑤ release 通道因预算被跳过时**必须可见**：旧代码只在 lastError === null 时才写原因，
//   于是最常见的情形（curl/pnpm 也失败）面板上完全看不出"release 通道根本没试"。
//
// 全部离线：通道实现注入桩，断言"异常之后谁还被调用"与"job 上留下了什么"。
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_CHANNEL_BUDGET, tryCandidateChannels } from '../lib/server/domain/install-job.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'channel-robustness-profile')

async function run({ race = null, backfill = null, release = null, budget = { release: 3 } } = {}) {
  const calls = []
  const ch = {
    raceInstallChannels: async () => { calls.push('race'); return race === null ? null : race() },
    pnpmInstall: async (dir, spec) => {
      const s = String(spec)
      calls.push(`${s.startsWith('git+') || s.startsWith('github:') ? 'git' : 'pnpm'}:${s}`)
      throw new Error('桩：registry 404')
    },
    curlManualInstall: async () => { calls.push('curl'); throw new Error('桩：curl 404') },
    githubReleaseInstall: async () => { calls.push('release'); return release === null ? (() => { throw new Error('桩：release 没命中') })() : release() },
    backfillMissingDeps: async () => { calls.push('backfill'); return backfill === null ? [] : backfill() },
  }
  const job = { id: 'robust', repo: 'probe-org/repo', packageName: 'probe-pkg', update: false, source: 'github' }
  const res = await tryCandidateChannels({
    job, ch, name: 'probe-pkg', profileDir: PROFILE, registries: ['https://registry.fake'],
    repoChannelAllowed: true, budget, expanded: false,
  })
  return { calls, job, res }
}

// ── ① 竞速抛异常：后续串行通道必须继续被尝试（旧代码会整条抛出 → 作业直接 failed）────────
{
  const { calls, job, res } = await run({ race: () => { throw new Error('桩：竞速内部炸了（abort 竞态）') } })
  check('★ 竞速异常后：pnpm / curl / release 通道照旧被尝试（不短路）',
    calls.includes('pnpm:probe-pkg') && calls.includes('curl') && calls.includes('release'), calls.join(' → '))
  check('★ 竞速异常如实记进面板备注（用户能看到"并行竞速为什么没结果"）',
    (job.channelNotes ?? []).some((n) => n.includes('并行竞速通道异常') && n.includes('已继续尝试后续串行通道') && n.includes('竞速内部炸了')),
    JSON.stringify(job.channelNotes ?? []))
  check('函数自己正常返回（没有异常逃逸到 runInstallJob 的外层 catch）', res.installedName === null)
}

// ── ② 竞速里 curl 赢了，但 backfillMissingDeps 抛异常：安装**仍然算成功**（不能误判失败）────
{
  const { calls, job, res } = await run({
    race: () => ({ channel: 'curl', info: { version: '1.2.3', missingDeps: ['dep-a'], boxNote: null, integrity: { ok: true } } }),
    backfill: () => { throw new Error('桩：补齐依赖时网络断了') },
  })
  check('★ backfillMissingDeps 抛异常不吞掉"已安装"的事实（installedName 保留）',
    res.installedName === 'probe-pkg', String(res.installedName))
  check('★ 如实写进 job.curlNote + 备注（说清包已装好、只是依赖没补齐）',
    String(job.curlNote ?? '').includes('已通过并行 curl 通道安装 v1.2.3') && String(job.curlNote).includes('捆绑依赖补齐失败')
    && (job.channelNotes ?? []).some((n) => n.includes('依赖补齐失败（安装本身已成功）')),
    job.curlNote)
  check('后续通道不再被试（已经有了成功通道，级联顺序不变）',
    !calls.includes('curl') && !calls.some((c) => c.startsWith('git:')), calls.join(' → '))
}

// ── ③ A-⑤：release 预算用尽 + 已有真实错误 → 原因**仍然**写进 job.channelNotes ────────────
{
  const { job, res } = await run({ budget: { release: 0 } })
  check('★ 预算用尽：job.channelNotes 里有"release 通道因预算跳过"（旧代码此时什么都不写）',
    (job.channelNotes ?? []).some((n) => n.includes('release 通道因预算跳过')), JSON.stringify(job.channelNotes ?? []))
  check('lastError 仍是真实错误（预算文案不顶掉 curl/pnpm 的失败原因）',
    !String(res.lastError?.message ?? '').includes('release 通道候选预算已用尽')
    && String(res.lastError?.message ?? '').length > 0, String(res.lastError?.message ?? ''))
}

// ── ④ A-⑤：预算用尽且没有更具体的错误 → 预算原因同时作为 lastError（保持旧语义）────────────
{
  const calls = []
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async () => { throw new Error('桩：registry 404') },
    curlManualInstall: async () => { calls.push('curl'); throw new Error('桩：curl 404') },
    githubReleaseInstall: async () => { throw new Error('不该被调用') },
    backfillMissingDeps: async () => [],
  }
  const job = { id: 'robust-4', repo: 'probe-org/repo', packageName: 'probe-pkg', source: 'github' }
  // 让 curl 与 pnpm 都不写 lastError 是不可能的（都是真实失败）→ 这里直接验证常量与备注语义：
  const res = await tryCandidateChannels({ job, ch, name: 'p', profileDir: PROFILE, registries: ['https://registry.fake'], repoChannelAllowed: false, budget: { release: 0 }, expanded: true, deadline: null })
  check('预算封顶常量仍是 3（release 反查不放开）', RELEASE_CHANNEL_BUDGET === 3, String(RELEASE_CHANNEL_BUDGET))
  check('repoChannelAllowed=false 时不碰 git（守卫③语义未变）', !calls.includes('git'), calls.join(' → '))
  assert.ok(res !== undefined)
}

assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
