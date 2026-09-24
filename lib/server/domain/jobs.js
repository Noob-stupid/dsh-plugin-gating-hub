// L1 · domain —— jobs.js（任务辅助：日志追加 + 健康等待轮询）。方案原稿把 jobLog 归 ai.js、waitHealth 归 components.js，但这俩是 install / suite / ai 三个域共用的，埋在任何一个域里都会造成跨域反向依赖 —— 故单独成模块（偏离已记录）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三


function jobLog(job, line) {
  job.logText = `${job.logText ?? ''}${line}\n`
}

async function waitHealth(url, timeoutMs, job, signal) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
      last = `HTTP ${res.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    jobLog(job, `  ⏳ 健康检查 ${url} … ${last}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  jobLog(job, `  ✘ 健康检查超时：${url}（最后状态 ${last}）`)
  return false
}

export { jobLog, waitHealth }
