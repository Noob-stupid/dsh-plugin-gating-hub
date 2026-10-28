// 升级失败后的「改名残留」修复：把 `<name>.stale-<ver>-<ts>` 改回真名。
//
// 2026-10-28 真机：升级在「拉起」阶段失败，清扫步已把 10 个框架包改名成 `.stale-*`，
// 真名处什么都没有 ⇒ 框架起不来：`Cannot find package '@deepseek-ai/cordis'`。
// 当时只能手工改目录名；这里把那件事自动化，并**只返回人类可读的步骤**，
// 让调用方（routes/framework-upgrade.js）保持精简（那个文件有 700 行硬顶）。
import { join } from 'node:path'
import { restoreStaleBackups } from './framework-cleanup.js'

/**
 * @returns {{ steps: string[], restored: Array<{from: string, to: string}>, failed: Array<object> }}
 */
function repairStaleRenameResidue({ fwRoot } = {}) {
  const steps = []
  if (typeof fwRoot !== 'string' || fwRoot === '') return { steps, restored: [], failed: [] }
  try {
    const repair = restoreStaleBackups({ scopeDir: join(fwRoot, '@deepseek-ai') })
    if (repair.restored.length > 0) {
      steps.push(`修复上次失败留下的改名残留：${repair.restored.length} 个包已改回真名（${repair.restored.map((r) => r.to).join('、')}）`)
    }
    if (repair.failed.length > 0) {
      steps.push(`改名残留修复未全部成功：${repair.failed.map((f) => f.real).join('、')}（不阻塞升级）`)
    }
    return { steps, restored: repair.restored, failed: repair.failed }
  } catch (error) {
    steps.push(`改名残留修复失败（不阻塞升级）：${error instanceof Error ? error.message : String(error)}`)
    return { steps, restored: [], failed: [{ error: String(error) }] }
  }
}

export { repairStaleRenameResidue }
