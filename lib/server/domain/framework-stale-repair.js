// 升级失败后的「改名残留」修复：把 `<name>.stale-<ver>-<ts>` 改回真名。
//
// 2026-10-28 真机：升级在「拉起」阶段失败，清扫步已把 10 个框架包改名成 `.stale-*`，
// 真名处什么都没有 ⇒ 框架起不来：`Cannot find package '@deepseek-ai/cordis'`。
// 当时只能手工改目录名；这里把那件事自动化，并**只返回人类可读的步骤**，
// 让调用方（routes/framework-upgrade.js）保持精简（那个文件有 700 行硬顶）。
//
// ★ 0.5.99 改错（真机 2026-11-02）：「真名存在但只是空壳（没有 package.json）」以前被当成
//   "已存在 ⇒ 跳过"，于是坏状态一直留着。判据已收敛到 domain/framework-stale-restore.js
//   （可用 = 目录里有 package.json；候选包名必须与真名一致）。本文件把三类结果**都**翻成
//   升级日志里的可读步骤：restored / noCandidate（真缺内容，无可用候选）/ failed。
import { join } from 'node:path'
import { restoreStaleBackups } from './framework-cleanup.js'

/** 一列名字最多列几个（升级日志是单行步骤，别把几百个包名全塞进去）。 */
const LIST_LIMIT = 8
const brief = (names) => (names.length <= LIST_LIMIT ? names.join('、') : `${names.slice(0, LIST_LIMIT).join('、')} 等 ${names.length} 个`)

/**
 * @returns {{ steps: string[], restored: Array<object>, emptied: Array<object>, noCandidate: Array<object>, failed: Array<object> }}
 */
function repairStaleRenameResidue({ fwRoot, deps = {} } = {}) {
  const steps = []
  const empty = { steps, restored: [], emptied: [], noCandidate: [], failed: [] }
  if (typeof fwRoot !== 'string' || fwRoot === '') return empty
  try {
    const repair = restoreStaleBackups({ scopeDir: join(fwRoot, '@deepseek-ai'), deps })
    if (repair.restored.length > 0) {
      steps.push(`修复上次失败留下的改名残留：${repair.restored.length} 个包已改回真名（${brief(repair.restored.map((r) => r.to))}）`
        + (Array.isArray(repair.emptied) && repair.emptied.length > 0 ? `；${repair.emptied.length} 个空壳已挪成 .empty-*（未删除）` : ''))
    }
    // ★ 0.5.99：真缺内容（真名不可用且没有可用候选）必须**说出来** —— 否则"框架解析不到包"在日志里无声无息
    if (Array.isArray(repair.noCandidate) && repair.noCandidate.length > 0) {
      steps.push(`有 ${repair.noCandidate.length} 个框架包真名不可用、且没有可用的 .stale-* 候选（真缺内容，需要重装/重新安装该版本）：${brief(repair.noCandidate.map((n) => n.real))}`)
    }
    if (repair.failed.length > 0) {
      steps.push(`改名残留修复未全部成功：${brief(repair.failed.map((f) => `${f.real}${f.reason ? `(${f.reason})` : ''}`))}（不阻塞升级）`)
    }
    return { steps, restored: repair.restored, emptied: repair.emptied ?? [], noCandidate: repair.noCandidate ?? [], failed: repair.failed }
  } catch (error) {
    steps.push(`改名残留修复失败（不阻塞升级）：${error instanceof Error ? error.message : String(error)}`)
    return { ...empty, steps, failed: [{ error: String(error) }] }
  }
}

export { repairStaleRenameResidue }
