// L2 · routes —— 依赖锁体检 / 重建（2026-09-27，纯加法）
//   POST /plugin-console/lockfile-check   只读体检：清单 vs pnpm-lock.yaml vs 磁盘 + registry 解析（**不写任何文件**）
//   POST /plugin-console/lockfile-repair  **用户显式触发**的 lock 重建：pnpm install --lockfile-only
//
// 为什么要有这两条路由（真问题，隔离环境已复现）：live 的 web profile 里 `plugin remove` / 任何一次 pnpm
// 全量解析都会失败，三条独立原因叠在一起 —— 依赖 404（npmmirror 与 npmjs 双双 404）、lock 陈旧残缺
// （importers 写 0.5.4 / manifest 写 0.5.14、7 个依赖缺 4 个）、供应链年龄闸（新发版本不足 24h）。
// 面板过去只能看到一句原始 stderr，用户无法判断"能不能修、修了会不会丢依赖"。
//
// 安全语义（写死）：
//   · check 纯只读（不写、不跑 pnpm）；
//   · repair **必须被显式调用**，且只跑 `pnpm install --lockfile-only`（argv 由 domain 的 repairArgsFor 唯一产出）；
//   · 有 404 依赖时 repair **停下并点名**，绝不为"重建成功"而静默丢弃依赖，也绝不自动绕过供应链闸。
// 细节与安全边界见 lib/server/domain/lockfile-health.js 头注释。

import { runLockfileCheck, runLockfileRepair } from '../domain/lockfile-health.js'
import { orderedRegistries, readSources } from '../domain/sources.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { profileDirOf } from '../infra/paths.js'

/** 主源优先的 registry 列表（与安装通道同一份来源配置：用户可在「源管理」里改）。 */
function registryList() {
  try {
    const list = orderedRegistries(readSources())
    return Array.isArray(list) && list.length > 0 ? list : ['https://registry.npmmirror.com']
  } catch {
    return ['https://registry.npmmirror.com']
  }
}

function lockProfileDir(rc, res) {
  const dir = profileDirOf(rc.ctx)
  if (typeof dir !== 'string' || dir === '') {
    sendError(res, 400, '无法定位 profile 目录（读不到 cordis.yml 的 include 条目）')
    return null
  }
  return dir
}

async function routeLockfileCheck(req, res, rc) {
  const profileDir = lockProfileDir(rc, res)
  if (profileDir === null) return
  const view = await runLockfileCheck({ profileDir, registries: registryList() })
  sendJson(res, 200, view)
}

async function routeLockfileRepair(req, res, rc) {
  const profileDir = lockProfileDir(rc, res)
  if (profileDir === null) return
  const result = await runLockfileRepair({ profileDir, registries: registryList() })
  sendJson(res, 200, result)
}

export { routeLockfileCheck, routeLockfileRepair }
