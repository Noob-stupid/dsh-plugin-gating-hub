// L2 · routes —— /check-updates（已安装插件「一键检测全部更新」；issue #22 ①）
//
// 用户原话（issue #22 ①）：`familyCheckUpdate` 只覆盖全家桶内部，单独装的第三方插件要逐个点卡片上的
// 「检测更新」；市场 tab 的批量比对只在市场页生效，已安装列表看不到汇总。本路由补的就是这个汇总。
//
// 三条边界（都写在这里，别处不要再实现一遍）：
//   ① **判据不分叉**：每个包走 `routes/framework.js#probePackageUpdate` —— 单卡「检测更新」的同一份代码，
//      末尾是 `dropStaleUpdateCandidates` + `pickUpdateTarget`（即 `infra/semver.js` 的
//      `<<<update-pick>>>` 唯一判据）。本文件里**没有任何版本比较**。
//   ② **并发有限**：执行器是 `domain/update-batch.js#createBatchUpdater`（进程一份闸门，默认 4 条），
//      不是每来一个请求就无上限地并发出去（0.5.84 市场富化把网络打满那次事故的教训）。
//   ③ **不谎报**：一个包的探针失败只影响它自己，且如实标成 `status: 'unknown'`（"未检测到"），
//      绝不混进"已最新"——没查到 ≠ 没有新版。
//
// 入参：`{ packageNames: string[], force?: boolean }`（force=true 越过 60s 结论缓存）
// 出参：`{ ok, checked, updatable, unknown, items: [...], stats }`（items 顺序 = 请求顺序）
//
// 路由注册：`lib/server/routes/index.js` 的 ROUTES（POST，住在 405 守卫之后 —— 它吃 body）；
// 路由清单：`tests/test-route-inventory.mjs`。
import { installedVersionOf, pickUpdateTarget } from '../domain/update-candidates.js'
import { createBatchUpdater } from '../domain/update-batch.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { profileDirOf } from '../infra/paths.js'
import { probePackageUpdate } from './framework.js'

/** 合法的包名形态：`name` / `@scope/name`，允许子路径行（如 `@linxin666/dsh-web-all/plugin-manager`）。 */
const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/u
const PACKAGE_NAME_MAX = 214
const BATCH_LIMIT = 200

// ★ 进程一份执行器：并发上限与结论缓存都在这个实例里共享 ——
//   "用户连点两次不该变成两倍并发"这件事只有模块级实例能保证（见 domain/update-batch.js 顶部）。
const batchUpdater = createBatchUpdater({ max: BATCH_LIMIT })

/** 单测/诊断用：清空结论缓存（生产不会调）。 */
function __clearBatchUpdateCache() {
  batchUpdater.clearCache()
}

async function routeCheckUpdates(req, res, rc) {
  const ctx = rc.ctx
  const body = rc.body ?? {}
  const raw = body.packageNames
  if (!Array.isArray(raw)) {
    sendError(res, 400, 'packageNames 必须是包名数组（一次传要检测的全部已装插件）')
    return
  }
  if (raw.length === 0) {
    // 空列表不是错误：如实回"一件都没查"，不凭空造一个"全部已最新"
    sendJson(res, 200, { ok: true, checked: 0, updatable: 0, unknown: 0, items: [], stats: batchUpdater.stats(), note: '没有需要检测的插件（packageNames 为空）' })
    return
  }
  if (raw.length > BATCH_LIMIT) {
    sendError(res, 400, `一次最多检测 ${BATCH_LIMIT} 个包（收到 ${raw.length} 个）—— 请分批`)
    return
  }
  const names = []
  const bad = []
  for (const item of raw) {
    const name = typeof item === 'string' ? item.trim() : ''
    if (name === '' || name.length > PACKAGE_NAME_MAX || !PACKAGE_NAME_RE.test(name)) {
      bad.push(typeof item === 'string' ? item : JSON.stringify(item))
      continue
    }
    names.push(name)
  }
  if (bad.length > 0) {
    sendError(res, 400, `这些不是合法的包名：${bad.slice(0, 5).join('、')}${bad.length > 5 ? ` 等 ${bad.length} 个` : ''}`)
    return
  }
  const baseUrl = ctx.baseUrl ?? 'file:///'
  const profileDir = profileDirOf(ctx)
  const result = await batchUpdater.run(names, {
    // 每个包都走单卡那条**唯一实现**（含 GitHub release 兜底 + 陈旧候选净化）；
    // target 由**同一个** pickUpdateTarget 取（与 /check-update 的 sendJson 一字不差：同一批已净化候选）
    probe: async (packageName) => {
      const r = await probePackageUpdate(packageName, rc, { fetchJson: rc.deps.fetchJson })
      return { ...r, target: pickUpdateTarget({ latest: r.latest, next: r.next, beta: r.beta }) }
    },
    installedOf: (packageName) => installedVersionOf(packageName, baseUrl, profileDir),
    force: body.force === true,
  })
  if (result.error !== undefined) {
    sendError(res, 500, result.error)
    return
  }
  sendJson(res, 200, {
    ok: true,
    checked: result.checked,
    updatable: result.updatable,
    unknown: result.unknown,
    items: result.items,
    stats: result.stats,
  })
}

export { routeCheckUpdates, __clearBatchUpdateCache, PACKAGE_NAME_RE, BATCH_LIMIT }
