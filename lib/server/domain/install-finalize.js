// L1 · domain —— install-finalize.js（安装收口结果 → 作业字段的**唯一映射**；2026-10-06 从 install-job.js 搬出）
//
// 为什么单独成模块：install-job.js 贴着 600 行架构棘轮（tests/test-architecture-guard.mjs），而这块
// 本来就是自洽的一块 —— 收口（domain/persist.js）返回什么，作业（`installJobView` 下发给面板）就怎么显示，
// 中间**不许**再各判一套。搬移只搬移未改逻辑；0.5.41 只多一条：**真装失败 ⇒ 一键真装动作优先**
// （link 回落让插件能加载，但用户要的那一步"依赖交给 pnpm"没成，必须能一键补上；三处齐备时也要下发）。
//
// `deps` 是**离线测试缝**（与 marketProbes/sourceDeps 同一风格）：正控/负控必须能确定性地让 lock 那一步
// 失败（"故意让 lock 写入失败 ⇒ 必须报未持久化而不是成功"），生产调用方不传时形状与默认值一个字都不变。

import { ensurePersisted } from './persist.js'
import { sourcePersistOptions } from './source-spec.js'

/**
 * 收口 + 落到作业字段。返回 `ensurePersisted` 的完整结果（调用方按需再读）。
 * 只写这些字段（与旧代码逐字一致）：`job.depNote` / `job.declared` / `job.entryId` / `job.persisted` /
 * `job.persist` / `job.persistNote` / `job.suggestedAction`。
 */
async function finalizeInstallPersistence({
  job, profileDir, patchPath, packageName, mode, taken = null, entries = null, registries = [],
  source = null, deps = {},
}) {
  const persist = await ensurePersisted({
    profileDir, patchPath, packageName, mode, taken, entries, registries, deps,
    ...sourcePersistOptions(source),
  })
  const persistNotes = [persist.declared?.depNote, persist.declared?.lockNote, persist.lock?.lockNote, persist.lock?.depNote, ...persist.notes]
    .filter((n) => typeof n === 'string' && n !== '')
  if (persistNotes.length > 0) job.depNote = job.depNote === undefined ? persistNotes.join('；') : `${job.depNote}；${persistNotes.join('；')}`
  if (persist.declared?.changed === true) job.declared = persist.declared.spec
  // entryId 的语义**与旧行为一致**：只有"用户补丁里的 insert 行"才算本作业注册的行（bundle 层提供的行
  // 与运行时已有行都不算，旧代码在这两条路上也不设 entryId）——撤销安装的归属判定依赖这一点。
  job.entryId = persist.after.parts.mount.via === 'patch-row' ? (persist.rowId ?? null) : null
  job.persisted = persist.persisted
  job.persist = { missing: persist.missing, actual: persist.after.actual, note: persist.note }
  if (persist.persisted !== true) job.persistNote = persist.note
  const persistSuggested = persist.suggested ?? null
  if (persistSuggested !== null
    && (persistSuggested.kind === 'real-install' || job.suggestedAction === undefined || job.suggestedAction === null)) {
    job.suggestedAction = persistSuggested
  }
  return persist
}

export { finalizeInstallPersistence }
