// L2 · routes —— 撤销「无效的强制启用覆盖」（0.5.76，用户 2026-10-18）
//
// 场景：补丁里写了 `disabled: false`（强制开启），但该行运行时根本没加载、也不是 peer 否决造成的
//   —— 这条覆盖是**死的**，留着只会让界面继续显示「强制启用未生效」而毫无作用。
//
// 语义（写死）：
//   · 只对**确实在 forced 列表**里的行生效 —— 不凭空改别人的补丁；
//   · 复用 patch.js#removeDisableBlock（与 adapt-unlock 同一实现，不写第二份）；
//   · 移除后**不承诺"已启用"**：撤掉覆盖只代表不再强压，实际是否加载由框架决定。
import { existsSync } from 'node:fs'
import { findPatchPath } from '../infra/paths.js'
import { removeDisableBlock, readPatchState } from '../domain/patch.js'
import { sendError, sendJson } from '../infra/httpd.js'

async function routeRevokeForce(req, res, rc) {
  const body = rc.body !== null && typeof rc.body === 'object' ? rc.body : {}
  const entryId = typeof body.entryId === 'string' ? body.entryId : ''
  if (entryId === '') { sendError(res, 400, '缺少 entryId'); return }
  const rowId = entryId.includes(':') ? entryId.split(':').slice(1).join(':') : entryId
  let patchPath = null
  try { patchPath = findPatchPath(rc.ctx) } catch { patchPath = null }
  if (typeof patchPath !== 'string' || patchPath === '' || !existsSync(patchPath)) {
    sendError(res, 400, '当前 profile 没有可写的补丁文件'); return
  }
  let forced = []
  try { const state = await readPatchState(patchPath); forced = Array.isArray(state?.forced) ? state.forced : [] } catch { forced = [] }
  if (!forced.includes(rowId)) {
    sendError(res, 400, `${rowId} 当前不是「补丁强制启用」状态（没有 disabled: false 覆盖块），无需撤销`); return
  }
  try { await removeDisableBlock(patchPath, rowId) }
  catch (error) { sendError(res, 500, `撤销失败：${error instanceof Error ? error.message : String(error)}`); return }
  sendJson(res, 200, { ok: true, rowId, revoked: true, note: `已移除 ${rowId} 的强制启用覆盖（disabled: false）。该行是否加载由框架决定，本次未改清单。` })
}

export { routeRevokeForce }
