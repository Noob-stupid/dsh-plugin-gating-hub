// L2 · routes —— AI 赋能（/ai-consent · /ai-empower/*）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { dirname } from 'node:path'
import { aiEmpowerExecute, aiEmpowerPlan } from '../domain/ai-run.js'
import { aiJobView, aiJobs, builtinPlanFor, saveAiJobs } from '../domain/ai.js'
import { frameworkCompatReportFor } from '../domain/compat.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { findPatchPath } from '../infra/paths.js'
import { installJobs, nextAiJobSeq } from '../state.js'

async function routeAiConsent(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const approved = body.approved === true
    const job = installJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个安装任务')
      return
    }
    if (job.stage !== 'ai-consent' || typeof job.aiWait?.then !== 'function') {
      sendError(res, 400, '该任务不在等待 AI 授权状态')
      return
    }
    const resolver = job.aiPending?.resolver
    job.aiWait = null
    job.aiPending = null
    if (typeof resolver === 'function') resolver({ approved })
    sendJson(res, 200, { ok: true, jobId, approved })
    return
}

async function routeAiEmpowerPlan(req, res, rc) {
  const frameworkCompatReportFor = rc.deps.frameworkCompatReportFor
  const aiEmpowerPlan = rc.deps.aiEmpowerPlan
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const source = typeof body.source === 'string' ? body.source.trim() : ''
    if (source === '' || source.length > 200) {
      sendError(res, 400, '请提供要部署的组件来源（npm 包名或 GitHub 仓库）')
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const jobId = `ai-${Date.now()}-${nextAiJobSeq()}`
    const job = { id: jobId, source, status: 'running', stage: 'planning', createdAt: Date.now(), logText: '', stepStates: [] }
    // 框架适配预检（兼容门 + registry 声明）：规划期即给出权威说明，供子代理引用与用户查看
    try { job.frameworkCheck = await frameworkCompatReportFor(source, ctx, profileDir) } catch { job.frameworkCheck = null }
    aiJobs.set(jobId, job)
    const builtin = builtinPlanFor(source)
    if (builtin !== null) {
      job.plan = builtin
      job.status = 'plan-ready'
      job.stage = 'builtin'
      job.finishedAt = Date.now()
      saveAiJobs()
      sendJson(res, 200, { ok: true, jobId, frameworkCheck: job.frameworkCheck })
      return
    }
    aiEmpowerPlan(job, ctx, profileDir).catch((error) => {
      job.status = 'failed'
      job.error = `规划任务异常：${error instanceof Error ? error.message : String(error)}`
      job.finishedAt = Date.now()
    })
    sendJson(res, 200, { ok: true, jobId, frameworkCheck: job.frameworkCheck })
    return
}

async function routeAiEmpowerStatus(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const job = aiJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个 AI 赋能任务')
      return
    }
    sendJson(res, 200, { ok: true, ...aiJobView(job) })
    return
}

async function routeAiEmpowerList(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 并发任务列表（轻量视图，不含日志全文）：面板展示/切换多个并发 AI 赋能任务
    const list = [...aiJobs.values()].slice(-10).reverse().map((job) => ({
      jobId: job.id,
      source: job.source,
      status: job.status,
      stage: job.stage,
      type: job.plan?.type ?? null,
      displayName: job.plan?.displayName ?? null,
      progress: job.progress ?? { done: 0, total: (job.plan?.steps ?? []).length },
      error: job.error ?? null,
      createdAt: job.createdAt,
    }))
    sendJson(res, 200, { ok: true, tasks: list })
    return
}

async function routeAiEmpowerRun(req, res, rc) {
  const aiEmpowerExecute = rc.deps.aiEmpowerExecute
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const selected = Array.isArray(body.steps) ? body.steps : null
    // 纵深防御：必须显式确认（前端「同意并部署」按钮携带 confirmed:true），防止任何绕过同意直接执行
    if (body.confirmed !== true) {
      sendError(res, 400, '未确认部署：请先在面板勾选步骤并点击「同意并部署」')
      return
    }
    const job = aiJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个 AI 赋能任务')
      return
    }
    if (job.status !== 'plan-ready') {
      sendError(res, 400, '任务状态不是 plan-ready，无法执行')
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    aiEmpowerExecute(job, ctx, profileDir, selected).catch((error) => {
      job.status = 'failed'
      job.error = `执行任务异常：${error instanceof Error ? error.message : String(error)}`
      job.finishedAt = Date.now()
      saveAiJobs()
    })
    sendJson(res, 200, { ok: true, jobId })
    return
}

async function routeAiEmpowerCancel(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const job = aiJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个 AI 赋能任务')
      return
    }
    try { job.abort?.abort() } catch {}
    if (job.status === 'running' && job.stage === 'executing') {
      job.status = 'failed'
      job.error = '已取消执行（用户中断）'
      job.finishedAt = Date.now()
      saveAiJobs()
    }
    sendJson(res, 200, { ok: true, jobId })
    return
}

export { routeAiConsent, routeAiEmpowerPlan, routeAiEmpowerStatus, routeAiEmpowerList, routeAiEmpowerRun, routeAiEmpowerCancel }
