// L1 · domain —— 安装/更新作业的**持久化**（0.5.83）
//
// 今天排障最大的障碍：installJobs 是**内存表**，宿主一重启就清空 ——
//   用户点了更新、作业卡住或失败，重启后我**查不到它到底干了什么**（本次连"版本号有没有传下去"都只能靠猜）。
// 与「待重启徽章」同一个病根（那个已用 pending-restart.json 修好）。
//
// 本模块把**已结束**的作业（done / failed）追加到 <DSH_HOME>/plugin-console/install-jobs.json：
//   · 只保留最近 N 条（默认 50），文件不会无限增长；
//   · 只记**诊断需要的字段**，不复制整个 job（避免把大对象/敏感信息落盘）；
//   · 任何异常都吞掉并降级为"没有持久记录"（绝不因为写日志失败影响安装本身）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'

const INSTALL_JOBS_FILE = 'install-jobs.json'
const KEEP = 50

function installJobsPath(home = undefined) {
  return join(home ?? dshHome(), 'plugin-console', INSTALL_JOBS_FILE)
}

/** 只挑诊断需要的字段（多余的一律不落盘）。 */
function pickJobFields(job) {
  if (job === null || typeof job !== 'object') return null
  const id = typeof job.id === 'string' ? job.id : (typeof job.jobId === 'string' ? job.jobId : null)
  if (id === null) return null
  return {
    jobId: id,
    packageName: typeof job.packageName === 'string' ? job.packageName : null,
    repo: typeof job.repo === 'string' ? job.repo : null,
    status: typeof job.status === 'string' ? job.status : null,
    stage: typeof job.stage === 'string' ? job.stage : null,
    version: typeof job.version === 'string' ? job.version : null,
    // ★ 0.5.87：目标版本（上一行）与**真正落盘的版本**是两件事 —— 真机 2026-10-18 就是
    // "version=0.2.1-rc.2、盘上还是 0.1.6-alpha.1"却记成 done，事后没人能从这条记录里看出没落地。
    installedVersion: typeof job.installedVersion === 'string' ? job.installedVersion : null,
    error: typeof job.error === 'string' ? job.error.slice(0, 500) : null,
    source: typeof job.source === 'string' ? job.source : null,
    startedAt: Number.isFinite(Number(job.startedAt)) ? Number(job.startedAt) : null,
    finishedAt: Number.isFinite(Number(job.finishedAt)) ? Number(job.finishedAt) : Date.now(),
  }
}

function readInstallJobs({ home = undefined } = {}) {
  try {
    const raw = JSON.parse(readFileSync(installJobsPath(home), 'utf8'))
    const list = raw !== null && typeof raw === 'object' && Array.isArray(raw.items) ? raw.items : []
    return list.filter((x) => x !== null && typeof x === 'object' && typeof x.jobId === 'string')
  } catch { return [] }
}

/**
 * 记录一条**已结束**的作业；进行中的不写（否则每次轮询都写盘）。
 * @returns {{ saved: boolean, reason?: string }}
 */
function recordInstallJob(job, { home = undefined } = {}) {
  const picked = pickJobFields(job)
  if (picked === null) return { saved: false, reason: 'job 形状不可识别' }
  if (picked.status !== 'done' && picked.status !== 'failed') return { saved: false, reason: '作业尚未结束' }
  try {
    const prev = readInstallJobs({ home }).filter((x) => x.jobId !== picked.jobId)
    const items = [...prev, picked].slice(-KEEP)
    const file = installJobsPath(home)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8')
    return { saved: true }
  } catch (error) {
    return { saved: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export { INSTALL_JOBS_FILE, installJobsPath, readInstallJobs, recordInstallJob }
