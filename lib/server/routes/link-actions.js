// L2 · routes —— link 面板的**两个写动作**（0.5.87 加法）
//   POST /plugin-console/link-repair     缺什么补什么（kind: deps 补依赖 / shims 造垫片 / all 两件都做）
//   POST /plugin-console/unpin-dev-dir   取消钉住（两段式：先只读计划，confirm:true 才移除）
//
// 为什么单独一个文件：`routes/state.js` 已经 439 行（上限 600），而这两条动作与「只读清单」
//   是两种职责（写 vs 读）。判据一律在 domain 层（link-self-sufficiency.js / unpin-dev-dir.js），
//   本文件只做三件事：**白名单校验 → 调 domain → 如实回包**。
//
// 安全语义（与 routes/revoke-force.js、routes/disk.js 同一套）：
//   · 包名必须是合法 npm 包名（NPM_NAME_RE），且**必须真的是本 profile 里的 link:/file: 依赖** ——
//     不接受任意包名，也不对 registry 依赖动手（那不是"开发式链接"）；
//   · 路径**绝不从请求体来** —— profileDir 由服务端按当前 profile 决定；
//   · 未确认（confirm!==true）时只回计划，一个字节都不写。
import { dirname } from 'node:path'
import { NPM_NAME_RE } from '../domain/dep-source.js'
import { pathDepsOf } from '../domain/link-inventory.js'
import { repairLinkTarget } from '../domain/link-self-sufficiency.js'
import { applyUnpinDevDir, planUnpinDevDir } from '../domain/unpin-dev-dir.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome, findPatchPath } from '../infra/paths.js'

/** 当前 profile 根目录（拿不到就 null —— 调用方必须当成"拒绝改动"处理）。 */
function profileDirOfCtx(ctx) {
  try { return dirname(findPatchPath(ctx)) } catch { return null }
}

/** 请求体 → 合法包名（不合法就空串）。 */
function packageNameOf(body) {
  const raw = body !== null && typeof body === 'object' && typeof body.packageName === 'string' ? body.packageName.trim() : ''
  return NPM_NAME_RE.test(raw) ? raw : ''
}

/**
 * POST /link-repair —— 把"缺依赖 / 缺 peer"这两条出路做成可点动作。
 * body: { packageName, kind?: 'deps' | 'shims' | 'all' }
 */
async function routeLinkRepair(req, res, rc) {
  const body = rc.body ?? {}
  const packageName = packageNameOf(body)
  if (packageName === '') { sendError(res, 400, '包名无效（只接受合法 npm 包名）'); return }
  const kind = body.kind === 'deps' ? 'deps' : body.kind === 'shims' ? 'shims' : 'all'
  const profileDir = profileDirOfCtx(rc.ctx)
  if (typeof profileDir !== 'string' || profileDir === '') { sendError(res, 400, '拿不到 profile 目录，拒绝改动'); return }
  // 只对**确实是本 profile 里的路径型依赖**生效（不凭空对任意包名动手）
  const dep = pathDepsOf(profileDir).find((x) => x.packageName === packageName) ?? null
  if (dep === null) {
    sendError(res, 400, `${packageName} 不是本 profile 里的 link:/file: 依赖 —— 这份清单只处理开发式链接，不改别的东西`)
    return
  }
  const result = await repairLinkTarget({ profileDir, packageName, kind, spec: dep.spec, home: dshHome() })
  const plan = result.plan ?? null
  const payload = {
    ok: result.ok === true,
    kind: result.kind,
    packageName,
    ready: result.ready === true,
    changed: result.changed === true,
    installed: result.installed === null || result.installed === undefined
      ? null
      : { ok: result.installed.ok === true, error: result.installed.error ?? null },
    created: Array.isArray(result.created) ? result.created : [],
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
    target: plan?.target ?? null,
    missingDeps: plan?.missingDeps ?? [],
    missingPeers: plan?.missingPeers ?? [],
    shimmablePeers: plan?.shimmablePeers ?? [],
    note: result.note ?? null,
    error: result.ok === true ? null : (result.note ?? '补齐失败'),
  }
  if (result.ok === true) sendJson(res, 200, payload)
  else sendError(res, 500, payload.error, payload)
}

/**
 * POST /unpin-dev-dir —— 取消钉住（摘掉清单里那条 link:/file: 依赖）。
 * body: { packageName, confirm?: boolean }
 *   confirm !== true → 只读计划（面板先给人看会怎样）
 *   confirm === true → 备份清单 → pnpm remove → **读回三处** → 失败即回滚
 */
async function routeUnpinDevDir(req, res, rc) {
  const body = rc.body ?? {}
  const packageName = packageNameOf(body)
  if (packageName === '') { sendError(res, 400, '包名无效（只接受合法 npm 包名）'); return }
  const profileDir = profileDirOfCtx(rc.ctx)
  if (typeof profileDir !== 'string' || profileDir === '') { sendError(res, 400, '拿不到 profile 目录，拒绝改动'); return }
  if (body.confirm !== true) {
    const plan = planUnpinDevDir({ profileDir, packageName })
    if (plan.ok !== true) {
      sendError(res, plan.status ?? 400, plan.error ?? '取消钉住规划失败', { ok: false, packageName, spec: plan.spec ?? null })
      return
    }
    sendJson(res, 200, {
      ok: true, applied: false, packageName, spec: plan.spec, target: plan.target,
      targetExists: plan.targetExists, inBundles: plan.inBundles, bundles: plan.bundles,
      warnings: plan.warnings, steps: plan.steps,
    })
    return
  }
  // 真删：用与 /uninstall 同一条 pnpm 通道（rc.deps.pnpmRemove），保持"一个动作负责三处"
  const injected = rc.deps !== null && typeof rc.deps === 'object' && typeof rc.deps.pnpmRemove === 'function' ? rc.deps.pnpmRemove : null
  const runRemove = injected === null ? null : (args) => injected(args.profileDir, args.packageName)
  const result = await applyUnpinDevDir({ profileDir, packageName, runRemove })
  const payload = {
    ok: result.ok === true,
    applied: result.changed === true,
    packageName,
    spec: result.spec ?? null,
    target: result.target ?? null,
    inBundles: result.inBundles === true,
    removed: result.removed ?? null,
    backup: result.backup ?? null,
    warnings: result.warnings ?? [],
    note: result.note ?? null,
    error: result.ok === true ? null : (result.error ?? '取消钉住失败'),
  }
  if (result.ok === true) sendJson(res, 200, payload)
  else sendError(res, result.status ?? 400, payload.error, payload)
}

export { routeLinkRepair, routeUnpinDevDir }
