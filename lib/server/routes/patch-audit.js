// L2 · routes —— 补丁体检（GET /plugin-console/patch-audit；0.5.30 加法）
//
// 真机事故 2026-09-28：框架 0.2.0-rc.1 移除了 `@deepseek-ai/dsh-workflow-worker-thread`（引擎改为 ptc），
// 而 profile 补丁三处行仍指向旧包 → 该行解析失败 → 隔离组里 `workflowEngine` 没有提供方 →
// `dsh-tool-workflow` / `dsh-tool-ralph` 永久 waiting → 老会话 resume 失败
//   （RemoteError: tool-workflow … waiting for workflowEngine）。
//
// 本路由把 domain/patch-composition-audit.js 的**纯判据**接到真实环境（真补丁文件 + 真 Node 解析器），
// 并且**只报告、不代改**：改名建议来自「真机确证表」（KNOWN_RENAMES），猜不到的只列候选 ——
// 绝不自动改写用户补丁（同 preset-rows.js 的判据文化：宁缺勿滥、不猜）。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPatchText } from '../domain/patch-composition-audit.js'
import { frameworkBases } from '../infra/framework-root.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { listAvailablePackages, makePackageResolver } from '../infra/package-resolve.js'
import { baseDirOf, findPatchPath } from '../infra/paths.js'

// 框架运行时根的取法已收敛到 infra/framework-root.js（0.5.30 改错：**同一份判据**必须同时供
// 只读体检与本文件、以及 domain/patch.js 的自愈使用 —— 各写一份的话，框架下次再挪目录只会有一处被修好；
// 2026-09-29 真机事故正是"自愈那处没跟上"）。

/** profile 补丁 → 体检报告（只读；不写任何文件）。 */
async function routePatchAuditGet(req, res, rc) {
  const ctx = rc.ctx
  let patchPath = null
  try { patchPath = findPatchPath(ctx) } catch {}
  if (patchPath === null || !existsSync(patchPath)) {
    sendError(res, 404, '找不到 profile 补丁文件（cordis.patch.yml）—— 无法体检')
    return
  }
  const profileDir = dirname(patchPath)
  let baseDir = null
  try { baseDir = baseDirOf(rc?.deps?.baseUrl ?? rc?.ctx?.baseUrl ?? 'file:///') } catch { baseDir = null }
  const fwBases = frameworkBases(baseDir, profileDir)
  const bases = [profileDir, ...fwBases]
  const resolve = makePackageResolver(bases)
  const candidates = listAvailablePackages([join(profileDir, 'node_modules'), ...fwBases])
  const text = readFileSync(patchPath, 'utf8')
  const report = auditPatchText(text, {
    resolve,
    existsFile: (url) => { try { return existsSync(fileURLToPath(url)) } catch { return false } },
    candidates,
  })
  sendJson(res, 200, {
    ok: true,
    patchPath,
    bases,
    rows: report.rows,
    blockerCount: report.blockers.length,
    warningCount: report.warnings.length,
    blockers: report.blockers,
    warnings: report.warnings,
  })
}

export { routePatchAuditGet }