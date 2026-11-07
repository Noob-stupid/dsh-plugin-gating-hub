// L2 · routes —— POST /plugin-console/self-auto-update（「自更新」开关的读写 + 「立即检查」；2026-11-04 加法）
//
// 为什么新开一条路由而不是塞进既有路由：能给这个动作腾位置的三个文件都贴着行数棘轮
// （`routes/framework.js` 600/600、`routes/framework-upgrade.js` 699/700、`domain/self-update-guard.js` 600/600），
// `/self-update` 所在的 `routes/plugins.js` 又只表示"按 latest 装一次"、语义不同（那个动作不看开关、不排队、不等定时器）。
// 所以按仓库既有做法**新开一条**，并同步登记 `tests/test-route-inventory.mjs`（漏登记会红）。
//
// 契约（只增不减）：
//   · `{ action: 'toggle' | 'set-enabled', enabled?: boolean }` → `{ ok, selfAutoUpdate, note }`
//     不给 `enabled` 就是"翻转当前值"（面板点一下的语义）；给了就照给的值设。
//   · `{ action: 'check' | 'check-now' }` → `{ ok, check, selfAutoUpdate }`
//     `check` 是 domain/self-auto-update.js#checkAndUpdate 的**完整原样结构**
//     （`{ checked, from, to, updated, reason, skipped? }` + 如实字段）。
//   · 都认 `packageName`，但**只用于拒绝**：只要不是控制台自己 ⇒ `check.skipped = 'not-self'`。
//     本文件绝不把请求体里的包名当成"要装的目标"（自动更新只对自己生效）。
//   · 入参不认识 ⇒ 400 + 可读原因（绝不 200 假装做过什么）。
//
// 判据全部在 domain 层（配置读坏降级、忙判据、版本比对、覆盖式安装、退避、自愈）；这里只做
// 「取宿主信息 → 调 domain → 回包」，一个判断都不自己写。
import { dirname } from 'node:path'
import { readAutoUpdateConfig, runCheckOnce, selfAutoUpdateState, writeAutoUpdateConfig } from '../domain/self-auto-update.js'
import { findPatchPath } from '../infra/paths.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { installJobs } from '../state.js'

/**
 * 宿主侧要注入给 domain 的两件事（domain 不认识 cordis，所以由这一层取好传下去）：
 *   · profileDir —— 覆盖式安装的落点（与 /install、/self-update 同一个推导方式）；
 *   · installBusy —— 内存里的作业表最准：只要还有作业在 `installing`，本轮就别动目录
 *     （包锁只覆盖"正在动这个目录"的那一小段，作业在换通道 / 等授权时锁是空的）。
 */
function autoUpdateDeps(ctx) {
  let profileDir = ''
  try { profileDir = dirname(findPatchPath(ctx)) } catch { profileDir = '' }
  return {
    profileDir,
    installBusy: () => {
      try {
        for (const job of installJobs.values()) {
          if (job !== null && job !== undefined && job.status === 'installing') {
            return `有安装作业正在跑（${job.id ?? '未命名作业'}：${job.packageName ?? job.repo ?? '未知目标'}）`
          }
        }
      } catch { /* 作业表读不出来 ⇒ 交给包锁那道闸，别在这里编一个"忙" */ }
      return null
    },
  }
}

async function routeSelfAutoUpdate(req, res, rc) {
  const action = typeof rc.body?.action === 'string' ? rc.body.action.trim() : ''
  const deps = autoUpdateDeps(rc.ctx)
  const requested = typeof rc.body?.packageName === 'string' ? rc.body.packageName.trim() : ''
  if (action === 'toggle' || action === 'set-enabled') {
    const read = readAutoUpdateConfig({ deps })
    const wanted = typeof rc.body?.enabled === 'boolean' ? rc.body.enabled : read.config.enabled !== true
    const written = writeAutoUpdateConfig({ enabled: wanted }, { deps })
    if (written.ok !== true) {
      // 写不进去就如实失败（面板显示错误原文），绝不回一个"看起来切过去了"的状态
      sendError(res, 500, written.note ?? '写自更新配置失败')
      return
    }
    const note = [read.note, written.note].filter((x) => typeof x === 'string' && x !== '').join('；')
    sendJson(res, 200, { ok: true, selfAutoUpdate: selfAutoUpdateState({ deps }), note: note === '' ? null : note })
    return
  }
  if (action === 'check' || action === 'check-now') {
    // 点「立即检查」与定时器是**同一条路**（单飞：定时器正在跑时这里回 skipped:'busy'，不叠第二轮）
    const check = await runCheckOnce({ deps, targetPackage: requested === '' ? null : requested })
    sendJson(res, 200, { ok: true, check, selfAutoUpdate: selfAutoUpdateState({ deps }) })
    return
  }
  sendError(res, 400, action === ''
    ? '没有提供 action（可用：toggle / set-enabled / check / check-now）'
    : `不认识的 action：${action}（可用：toggle / set-enabled / check / check-now）`)
}

export { autoUpdateDeps, routeSelfAutoUpdate }
