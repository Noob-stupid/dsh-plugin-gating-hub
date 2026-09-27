// L2 · routes —— 结构化建议动作（POST /plugin-console/run-suggested，2026-09-27 加法）
//
// 为什么要有它：安装结果卡片会下发 `job.suggestedAction = { kind, label, command, payload }`
// （见 domain/install-job.js 与 domain/dep-source.js#suggestedPinAction），用户要求能**直接点执行**，
// 而不是自己抄一条命令去终端跑。
//
// 安全语义（写死，配套测试 tests/test-plugin-actions.mjs 与 tests/test-route-inventory.mjs）：
//   · 请求体只认 `{ action, packageName, version, profile }`；`command`/`argv`/`shell`… 任一出现即 400，
//     命令行**全部**由 domain/plugin-actions.js 的白名单动作自己拼；
//   · `profile` 只作回显 —— profileDir 一律取当前实例（profileDirOf）的目录，**绝不**按请求体挑目录；
//   · 动作只对"本 profile 自己清单里的包"生效（服务端读盘判定，不信客户端）。
import { runSuggestedAction } from '../domain/plugin-actions.js'
import { preferredRegistries } from '../domain/sources.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { profileDirOf } from '../infra/paths.js'

async function routeRunSuggested(req, res, rc) {
  const profileDir = profileDirOf(rc.ctx)
  if (typeof profileDir !== 'string' || profileDir === '') {
    sendError(res, 400, '无法定位 profile 目录（读不到 cordis.yml 的 include 条目）')
    return
  }
  const result = await runSuggestedAction({ body: rc.body, profileDir, registries: preferredRegistries() })
  if (result.ok === false && result.status === 400) {
    sendError(res, 400, result.error)
    return
  }
  const { status, error, ...view } = result
  sendJson(res, 200, { ok: result.ok === true, ...view, ...(typeof error === 'string' ? { error } : {}) })
}

export { routeRunSuggested }
