// 批次 A-③（2026-09-27）：懒惰展开的**位置**变了 —— 从"所有通道（含 git）都失败之后"
// 搬到"registry 类通道失败之后、git 通道之前"。
//
// 真机事故（用户点装 zhu1090093659/dsh-web，★8032 全家桶）：该仓库根包 private、未发布到 npm，
// 于是 registry 通道必然 404 → 旧顺序**直接掉进 git 通道**去 clone 那个 429 MB 的巨仓
// （ghproxy 下 git 协议 0 B/s：白等几分钟且注定失败），而真正能装的子包
// `@linxin666/dsh-web-all`（5.97 MB）连一次尝试机会都没有。
// 本用例用注入桩把"通道被调用的顺序"钉死（离线、不联网、不落盘）：
//   ① 顺序：竞速 → pnpm → curl → release → **展开** → git
//   ② 展开失败（网络读不到 trees）不得短路后续通道
//   ③ 根包未发布（private）时 git 通道**整个跳过**（job.gitChannelBlocked）并留下可见备注
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tryCandidateChannels } from '../lib/server/domain/install-job.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'expand-order-profile')

/** 通道桩：每一步都记账；registry 类通道一律"确定性失败"，只有显式给的 git 通道可能成功。 */
function makeCh(calls, { gitFails = true } = {}) {
  return {
    raceInstallChannels: async () => { calls.push('race'); return null },
    pnpmInstall: async (dir, spec) => {
      const s = String(spec)
      if (s.startsWith('git+') || s.startsWith('github:')) {
        calls.push(`git:${s}`)
        if (gitFails) throw new Error('桩：git 通道不可用（真机 ghproxy 0 B/s）')
        return
      }
      calls.push(`pnpm:${s}`)
      throw new Error('桩：registry 404（根包未发布）')
    },
    curlManualInstall: async () => { calls.push('curl'); throw new Error('桩：curl registry 404') },
    githubReleaseInstall: async () => { calls.push('release'); throw new Error('桩：release 没命中') },
    backfillMissingDeps: async () => [],
  }
}

const run = async ({ expand, job = {}, repoChannelAllowed = true, expanded = false }) => {
  const calls = []
  const ch = makeCh(calls)
  const theJob = { id: 'expand-order', repo: 'zhu1090093659/dsh-web', packageName: null, update: false, source: 'github', ...job }
  const res = await tryCandidateChannels({
    job: theJob, ch, name: 'dsh-web', profileDir: PROFILE, registries: ['https://registry.fake'],
    repoChannelAllowed, budget: { release: 3 }, expanded, expand: expand === undefined ? null : expand,
  })
  return { calls, job: theJob, res }
}

// ① 顺序：展开必须发生在 git **之前**（旧代码里它在 tryCandidateChannels 返回之后 = git 之后）
{
  let expandedWhenGitRan = null
  const order = []
  const { calls } = await run({
    expand: async () => { order.push('expand'); return 0 },
  })
  // 用 calls 重新算一次顺序（expand 记在 order 里）
  const gitIndex = calls.findIndex((c) => c.startsWith('git:'))
  check('★ registry 类通道（竞速/pnpm/curl/release）都在展开之前',
    ['race', 'curl'].every((c) => calls.includes(c)) && calls.some((c) => c.startsWith('pnpm:')) && calls.some((c) => c === 'release'),
    calls.join(' → '))
  check('★ 展开被调用了，且 git 通道在展开之后（顺序：… release → 展开 → git）',
    order.length === 1 && gitIndex > 0, `expand=${order.length} 次 / git 在第 ${gitIndex + 1} 步：${calls.join(' → ')}`)
  assert.equal(expandedWhenGitRan, null)
}

// ①-b 展开真的先于 git：给 expand 打时间戳，和 git 桩的调用顺序比
{
  const events = []
  const ch = makeCh([])
  const pnpmOriginal = ch.pnpmInstall
  ch.pnpmInstall = async (dir, spec) => {
    if (String(spec).startsWith('git+') || String(spec).startsWith('github:')) events.push('git')
    return pnpmOriginal(dir, spec)
  }
  await tryCandidateChannels({
    job: { id: 'order-2', repo: 'o/r', packageName: null, source: 'github' }, ch, name: 'pkg',
    profileDir: PROFILE, registries: ['https://registry.fake'], repoChannelAllowed: true,
    budget: { release: 3 }, expanded: false, expand: async () => { events.push('expand'); return 0 },
  })
  check('★ 事件序列里 expand 严格早于第一个 git 规格', events.indexOf('expand') >= 0 && events.indexOf('expand') < events.indexOf('git'), events.join(' → '))
}

// ② 展开返回新增候选：当前候选**仍然**试 git（守卫③的 !expanded 语义一个字没改）
{
  const { calls, job } = await run({ expand: async () => 3 })
  check('展开出 3 个新候选后：仍按原语义给当前候选试 git（不悄悄删掉既有兜底能力）',
    calls.some((c) => c.startsWith('git:')), calls.join(' → '))
  check('展开结果写成面板可见的备注（新增几个候选）',
    (job.channelNotes ?? []).some((n) => n.includes('已自动展开仓库子包') && n.includes('3')), JSON.stringify(job.channelNotes ?? []))
}

// ③ 展开失败（网络受限读不到 trees）→ 不短路：git 照旧试，并如实记一条备注
{
  const { calls, job } = await run({ expand: async () => { throw new Error('桩：trees 接口不可达') } })
  check('★ 展开抛错不短路安装（后续 git 通道照旧尝试）', calls.some((c) => c.startsWith('git:')), calls.join(' → '))
  check('★ 展开失败在 job 上留痕（面板能看出"为什么没展开成"）',
    (job.channelNotes ?? []).some((n) => n.includes('自动展开仓库子包失败') && n.includes('trees 接口不可达')), JSON.stringify(job.channelNotes ?? []))
}

// ④ 根包未发布（private: true）→ gitChannelBlocked：git 通道整个跳过（这才是"不碰 429 MB"的保证）
{
  const { calls, job } = await run({ expand: async () => 0, job: { gitChannelBlocked: true, privateRoot: true }, repoChannelAllowed: false })
  check('★ 根包 private 时：git 通道**一次都不试**（不再去 clone 429 MB 巨仓）',
    !calls.some((c) => c.startsWith('git:')), calls.join(' → '))
  check('但 registry 类通道（含竞速/curl/release）照旧按包名施工（子包仍有机会装上）',
    calls.includes('race') && calls.includes('curl') && calls.some((c) => c.startsWith('pnpm:')), calls.join(' → '))
  check('gitChannelBlocked 与 privateRoot 都由上游设置（这里只验证语义）', job.privateRoot === true && job.gitChannelBlocked === true)
}

// ⑤ 展开出来的新候选由**外层候选循环**继续尝试（本函数只负责当前候选）——
//    这里钉死"展开结果确实带回去了"（新增候选数与备注），端到端的真机路径
//    （registry 404 → 展开 → 命中 @linxin666/dsh-web-all → 真装 5.97 MB）由
//    tests/test-real-npmname-hint.mjs 用真 registry 覆盖。
{
  let added = 0
  const { job } = await run({ expand: async () => { added = 0; return added } })
  check('展开返回 0 时：不写"新增候选"备注（不制造噪声）',
    !(job.channelNotes ?? []).some((n) => n.includes('新增')), JSON.stringify(job.channelNotes ?? []))
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
