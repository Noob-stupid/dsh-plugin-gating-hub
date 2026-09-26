// L1 · domain —— install-cleanup.js（安装失败清场 + 授权被拒/超时后的失败文案）
// 2026-09-27 从 install-job.js 原样搬出（install-job.js 触到 600 行硬顶，见 test-architecture-guard.mjs）。
// 只搬移、未改逻辑；install-job.js 继续 re-export 这两个名字，调用点与测试的 import 面一个字都没变。

import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { AI_CONSENT_TIMEOUT_MS } from './install.js'
import { disposeDir, disposeNote } from '../infra/fsx.js'

/** 安装失败清场：把本次尝试过的候选包目录与 pnpm `_tmp_` 半成品一起清掉，并**如实汇报**清了什么、什么没清掉
 * （2026-09-20 真装演练：聚合仓库跑 19 分钟后失败，node_modules 留着 `…_tmp_56272_2` 半成品，面板只说"安装失败"）。
 * 2026-09-26（改错）：删除一律走 disposeDir（本机 C 盘/`%TEMP%` 下 rmSync 会静默落空，不核实就会谎报干净）；
 * 删不掉时它**改名降级成同父目录的 `.trash-<ts>`**（做法借自 2BingLing/dsh-market 的 `.bak-<ts>` + renameSync）。 */
function cleanupAttemptedCandidates(profileDir, candidates) {
  const cleaned = []
  const failed = []
  const trashed = []
  const dispose = (label, dir) => {
    const result = disposeDir(dir)
    if (result.trashed === true) trashed.push({ name: label, path: dir, trashPath: result.trashPath, note: disposeNote(result) })
    if (result.ok === true) return 1
    failed.push({ name: label, path: dir, error: result.reason, note: disposeNote(result) })
    return 0
  }
  for (const name of candidates) {
    const dir = join(profileDir, 'node_modules', ...String(name).split('/'))
    const parent = dirname(dir)
    const base = basename(dir)
    let touched = 0
    if (existsSync(dir)) touched += dispose(name, dir)
    try {
      for (const entry of readdirSync(parent)) {
        if (!entry.startsWith(`${base}_tmp_`)) continue
        touched += dispose(`${name}（临时目录）`, join(parent, entry))
      }
    } catch {}
    if (touched > 0) cleaned.push(name)
  }
  return { cleaned, failed, trashed }
}

/** 授权被拒/超时后的失败文案（纯函数，单测覆盖）：说清为什么失败、清理了什么、什么没清掉。
 * 时长取自 AI_CONSENT_TIMEOUT_MS —— 文案里的"10 分钟"不能与实际等待时间脱节。
 * 2026-09-26（改错）：**不再出现「请手动删除」**——降级成 `.trash-*` 的项由后台清理接手。 */
function aiConsentFailureText(decision, leftovers, timeoutMs = AI_CONSENT_TIMEOUT_MS) {
  const waitMinutes = Math.max(1, Math.round((Number(timeoutMs) || AI_CONSENT_TIMEOUT_MS) / 60000))
  const base = decision?.timeout === true
    ? `等待授权超时（${waitMinutes} 分钟），已取消本地 AI 兜底（该操作会调用模型 API 产生费用）`
    : '用户取消本地 AI 兜底（该操作会调用模型 API 产生费用）'
  const cleaned = leftovers?.cleaned ?? []
  const failed = leftovers?.failed ?? []
  const trashed = leftovers?.trashed ?? []
  const noteOf = (item) => (typeof item?.note === 'string' && item.note !== '' ? `（${item.note}）` : (item?.error != null ? `（${item.error}）` : ''))
  const cleanedNote = cleaned.length > 0 ? `；已清理本次落盘残留：${cleaned.join('、')}` : ''
  const trashedNote = trashed.length > 0
    ? `；有 ${trashed.length} 项正被占用、已改名降级为 .trash-*（${trashed.map((t) => (typeof t?.note === 'string' && t.note !== '' ? t.note : basename(String(t?.trashPath ?? '')))).join('、')}）`
    : ''
  const failedNote = failed.length > 0 ? `；**有 ${failed.length} 项没能清理**：${failed.map((f) => `${f.path}${noteOf(f)}`).join('、')}` : ''
  return `${base}${cleanedNote}${trashedNote}${failedNote}`
}

export { cleanupAttemptedCandidates, aiConsentFailureText }
