// L2 · routes —— 安装（POST /install · POST /install-status）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { installJobView } from '../domain/install.js'
import { runInstallJob } from '../domain/install-job.js'
import { fetchRepoPackageEx, githubRepoInfo, subpackageCandidates } from '../domain/market.js'
import { runSkillInstallJob } from '../domain/skills.js'
import { probeGitmodules, resolveInstallKind, runSuiteInstallJob } from '../domain/suite.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { installJobs, nextInstallJobSeq } from '../state.js'

async function routeInstall(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const runSuiteInstallJob = rc.deps.runSuiteInstallJob
  const runInstallJob = rc.deps.runInstallJob
  const body = rc.body
    // repo 允许为空：纯 registry 更新（已安装插件的"检测更新"走此路径，无 git 兜底）
    const rawRepo = typeof body.repo === 'string' ? body.repo.trim() : ''
    let repo = ''
    if (rawRepo !== '') {
      try { repo = githubRepoInfo(rawRepo) } catch {}
    }
    const givenName = typeof body.packageName === 'string' ? body.packageName.trim() : ''
    // 框架本体拦截：deepseek-harness 仓库与其根包 @deepseek-ai/dsh-root 是 DSH 框架自身，
    // 作为插件安装会试图构建整个框架源码——直接拒绝并提示
    if (repo === 'deepseek-ai/deepseek-harness'
      || givenName === '@deepseek-ai/dsh-root'
      || givenName === '@deepseek-ai/dsh') {
      sendError(res, 400, 'deepseek-harness 是 DSH 框架本体，不是插件——无需安装（升级请用官方 dsh 升级方式）')
      return
    }
    const requestedKind = body.kind === 'skill' ? 'skill' : body.kind === 'suite' ? 'suite' : 'plugin'
    if ((requestedKind === 'skill' || requestedKind === 'suite') && repo === '') {
      sendError(res, 400, `${requestedKind === 'skill' ? '技能' : '套装'}安装必须提供仓库（owner/name）`)
      return
    }
    const source = body.source === 'gitee' ? body.source : 'github'
    const npmNamePattern = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u
    if (givenName !== '' && (!npmNamePattern.test(givenName) || givenName.length > 214)) {
      sendError(res, 400, 'packageName 不是合法的 npm 包名')
      return
    }
    // 防重（事故教训）：同一插件已在安装/更新中时拒绝新任务——否则反复点更新/安装会产生
    // 几十个并发下载任务（同一插件重复安装、消息刷屏、浪费流量）
    const dupJob = [...installJobs.values()].some((j) => j.status === 'installing'
      && ((repo !== '' && j.repo === repo) || (givenName !== '' && j.packageName === givenName)))
    if (dupJob) {
      sendError(res, 409, '该插件正在安装/更新中，请等待当前任务完成后再试')
      return
    }
    // 套装请求必须复检内容（2026-09-19 事故）：前端标记可能来自 24h enrich 缓存的误判，
    // 探测内容不像 .gitmodules 就按普通插件安装——别把用户送进注定失败的套装通道。
    let kind = requestedKind
    let suiteNote = null
    if (requestedKind === 'suite') {
      kind = resolveInstallKind('suite', await probeGitmodules(repo))
      if (kind !== 'suite') suiteNote = '探测未发现有效的 .gitmodules（不是 submodule 套装仓库），已按普通插件安装'
    }
    const job = {
      id: `job-${nextInstallJobSeq()}`,
      repo,
      source,
      packageName: givenName || null,
      status: 'installing',
      stage: 'preparing',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      entryId: null,
      bundle: false,
      ai: false,
      aiNote: null,
      subpackages: null,
      lastError: null,
        update: body.update === true,
      kind,
    }
    if (suiteNote !== null) job.suiteNote = suiteNote
    installJobs.set(job.id, job)
    // 套装通道兜底：探测说有、clone 下来却没有 .gitmodules（假阳性 / 仓库已重构）时
    // 回落普通插件安装，而不是给用户一个「未找到 .gitmodules」的失败。
    const runSuiteThenFallback = async () => {
      // 0.5.19：套装作业入口自己也有一道判据（根包/子包已发布 → 不克隆整个仓库），它需要真实探测：
      // 显式「安装套装」（前端 hasSuite=true 的卡片）走的就是这条路，不经过 install-job 的候选循环。
      const result = await runSuiteInstallJob(job, ctx, {
        probes: { fetchRepoPackageEx, subpackageCandidates, probeGitmodules },
      })
      if (result?.notASuite !== true) return
      job.kind = 'plugin'
      // 回落文案一律用 result.reason：克隆失败与"内容不符"是两回事，不能都报成后者（用户会被带偏）
      job.suiteNote = result.reason ?? '仓库实际内容与探测不符（没有 .gitmodules），已自动回落普通插件安装'
      await runInstallJob(job, ctx)
    }
    // 后台执行：请求立即返回，安装不受客户端断开/离开面板影响
    void (kind === 'skill' ? runSkillInstallJob(job, ctx) : kind === 'suite' ? runSuiteThenFallback() : runInstallJob(job, ctx))
    sendJson(res, 200, { ok: true, jobId: job.id, status: 'installing', kind, ...(suiteNote !== null ? { suiteNote } : {}) })
    return
}

async function routeInstallStatus(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const runSuiteInstallJob = rc.deps.runSuiteInstallJob
  const runInstallJob = rc.deps.runInstallJob
  const body = rc.body
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const job = installJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个安装任务')
      return
    }
    sendJson(res, 200, { ok: true, ...installJobView(job) })
    return
}

export { routeInstall, routeInstallStatus }
