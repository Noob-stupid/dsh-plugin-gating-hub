// L1 · domain —— git-channel.js（git 通道的独立预算与尝试顺序；通道备注的统一样子）
// 2026-09-27 抽出：install-job.js 已到 600 行硬顶（测试 test-architecture-guard.mjs 的行数棘轮），
// 而"git 通道怎么用预算"本来就是一块自洽的策略，独立成模块后 install-job 只留一行调用。
// 抽出只搬移 + 收窄形参，**语义一字未改**（原实现见 commit 8deb112 之前的 tryCandidateChannels 尾段）。

import { gitCloneUrls } from './sources.js'

/** git 通道的**独立预算**（2026-09-27 加法）：默认 120 秒，可用环境变量
 * `DSH_GIT_CHANNEL_BUDGET_MS` 配置（夹在 15 秒 ~ 8 分钟之间，避免被写成 0 或无穷大）。
 * 为什么必须独立封顶：真机实测 git 协议在镜像上可能是 **0 B/s**，一个 git 源就能把 8 分钟的作业预算
 * 吃光 —— 后面的候选与本该可用的通道再没机会试（用户看到的是"卡了 8 分钟然后失败"）。
 * 调用点还有一条硬约束：**不得超过作业剩余预算**（见 tryGitChannel 的 deadline）。
 * 纯函数 + env 注入，便于离线断言。 */
const GIT_CHANNEL_BUDGET_MS = 120000
function gitChannelBudgetMs(env = process.env) {
  const raw = Number.parseInt(String(env?.DSH_GIT_CHANNEL_BUDGET_MS ?? ''), 10)
  if (!Number.isFinite(raw)) return GIT_CHANNEL_BUDGET_MS
  return Math.min(8 * 60 * 1000, Math.max(15000, raw))
}

/** git 通道里**单个** git 规格的 pnpm 超时上限（与旧代码的 60000 一致；预算更少时取剩余预算）。 */
const GIT_SPEC_TIMEOUT_MS = 60000

/** 剩余预算低于这个值就不必再起一个 git 规格了（起也来不及握手，只是白占一个进程位）。 */
const GIT_MIN_ATTEMPT_MS = 250

/** 通道备注（2026-09-27 加法，面板可见）：通道为什么没试/为什么被跳过，必须留在 job 上。
 * 旧代码只在"没有任何更具体错误"时才写原因，用户什么都看不到。 */
function noteChannel(job, text) {
  if (job === null || job === undefined || typeof text !== 'string' || text === '') return
  if (!Array.isArray(job.channelNotes)) job.channelNotes = []
  if (!job.channelNotes.includes(text)) job.channelNotes.push(text)
}

/** 预算时长的可读写法（≥10 秒按秒、否则按毫秒）——只服务面板文案。 */
function formatBudgetMs(ms) {
  const n = Math.max(0, Number(ms) || 0)
  return n >= 10000 ? `${Math.round(n / 1000)} 秒` : `${Math.round(n)} 毫秒`
}

/** git 通道（守卫③）：只对**请求里那个仓库**试 git 规格，且只在"同一作业第一次"试。
 * 返回 { installedName, lastError }（与 tryCandidateChannels 的返回同形，便于原地替换）。
 * 预算规则（2026-09-27）：
 *   · 通道自己的预算与**作业剩余预算**取小（deadline 为 null 时只有通道预算）；
 *   · 单个规格的 pnpm 超时 = min(60 秒, 剩余)；
 *   · 预算耗尽就停手，并在 job 上留一条面板可见的原因（不静默跳过）。
 * 依赖注入：ch（通道实现）与 budget 由调用方传入 —— 与 install-job 的注入缝同一套语义。 */
async function tryGitChannel({ job, ch, name, profileDir, repoChannelAllowed, expanded = false, budget = {}, deadline = null }) {
  let installedName = null
  let lastError = null
  // gitChannelBlocked：作业层面已判定"这个仓库不该走 git"（根包未发布 / 首选候选来自市场索引）。
  // 调用方算的 repoChannelAllowed 已经含它，这里再独立判一次 —— 语义写在离执行最近的地方，
  // 单测注入 job 时也不会因为漏算一个布尔量而意外去 clone 一个几百 MB 的仓库。
  if (!repoChannelAllowed || expanded || job?.gitChannelBlocked === true) return { installedName, lastError }
  // 独立预算：同一作业里 git 通道只进一次，budget.git/gitDeadline 就是全局那份
  if (budget.git === undefined) {
    const cap = Math.max(0, gitChannelBudgetMs())
    const remain = deadline === null ? cap : Math.max(0, deadline - Date.now())
    budget.git = Math.min(cap, remain)
    budget.gitDeadline = Date.now() + budget.git
    if (budget.git <= 0) noteChannel(job, 'git 通道因预算不足被跳过（作业剩余时间已不足）')
  }
  const gitDeadline = budget.gitDeadline ?? (Date.now() + (budget.git ?? 0))
  const gitSpecs = job.source === 'gitee'
    ? [`git+https://gitee.com/${job.repo}.git`]
    : [
        ...gitCloneUrls(job.repo).map((u) => `git+${u}`),
        `github:${job.repo}`,
      ]
  let gitTried = 0
  let gitBudgetHit = false
  for (const spec of gitSpecs) {
    const remain = gitDeadline - Date.now()
    if (remain <= GIT_MIN_ATTEMPT_MS) { gitBudgetHit = true; break }
    gitTried += 1
    try {
      // eslint-disable-next-line no-await-in-loop
      await ch.pnpmInstall(profileDir, spec, undefined, Math.min(GIT_SPEC_TIMEOUT_MS, remain))
      installedName = name
      break
    } catch (gitError) {
      lastError = gitError
    }
  }
  if (installedName === null && gitBudgetHit && gitTried > 0) {
    noteChannel(job, `git 通道预算（${formatBudgetMs(budget.git ?? 0)}）已用尽，剩余的 git 源不再尝试`)
  }
  return { installedName, lastError }
}

export { GIT_CHANNEL_BUDGET_MS, GIT_SPEC_TIMEOUT_MS, GIT_MIN_ATTEMPT_MS, gitChannelBudgetMs, noteChannel, formatBudgetMs, tryGitChannel }
