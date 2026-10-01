// L2 · routes —— 状态与详情（GET /state · POST /details）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { detectAdoptablePending, detectCompat, gatingSummary, readCompatGate, readCompatPendingWithVerdicts } from '../domain/compat.js'
import { compUiUrl, findComponents } from '../domain/components.js'
import { currentFrameworkVersion, detectFrameworkUpgrade } from '../domain/framework.js'
import { peerVetoFor } from '../domain/peer-veto.js'
import { readExtraBundleRows } from '../domain/install-job.js'
import { installJobView, readGithubAuth } from '../domain/install.js'
import { readPluginDetails } from '../domain/market.js'
import { healPatchSafety, readPatchState } from '../domain/patch.js'
import { pendingRestartJobs } from '../domain/revoke.js'
import { listEntries } from '../domain/runtime.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome, entryPkgMeta, findPatchPath, pluginRoot, profileDirOf, rowIdOf } from '../infra/paths.js'
import { installJobs, patchHealAt, patchHealReport, setPatchHealAt, setPatchHealReport } from '../state.js'

async function routeStateGet(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const detectFrameworkUpgrade = rc.deps.detectFrameworkUpgrade
  const detectCompat = rc.deps.detectCompat
  const listEntries = rc.deps.listEntries
  const detectAdoptablePending = rc.deps.detectAdoptablePending
  const readExtraBundleRows = rc.deps.readExtraBundleRows
    const patchPath = findPatchPath(ctx)
    const patch = await readPatchState(patchPath)
    // 补丁安全自愈（核心行误禁用恢复 / **确证**缺失模块行自动禁用）——每 2 分钟最多跑一次。
    // 2026-09-30 改错：① 无真正需要修复的内容时零写盘（避免每 2 分钟无谓重写用户补丁）；
    //   ② 写盘失败 / 解析不确定 / 框架自带包 → 如实回报（skipped / uncertain / writeError），不静默。
    let patchHeal = null
    try {
      if (patchHealAt === null || Date.now() - patchHealAt > 120000) {
        setPatchHealAt(Date.now())
        patchHeal = await healPatchSafety(patchPath)
      } else {
        patchHeal = patchHealReport
      }
      if (patchHeal !== null) setPatchHealReport(patchHeal)
    } catch (error) {
      // 自愈本身抛异常也要如实进 patchHeal（过去这里 catch {} 静默吞掉，面板看不出任何异常）
      patchHeal = { healed: [], autoDisabled: [], skipped: [], uncertain: [], healedAt: 0, written: false, writeError: String(error?.message ?? error) }
      setPatchHealReport(patchHeal)
    }
    const extraRows = await readExtraBundleRows(dirname(patchPath))
    const profileDir = dirname(patchPath)
    // 0.5.34 加法（**读取代发**）：给 profileDir ⇒ 判据戳落后的记录用当前判据只读重算，
    // 结论变了才回写（幂等：结论不变**零写盘**）。真不兼容的重算仍 fail，一个字都不动。
    const pendingState = readCompatPendingWithVerdicts({ baseDir: profileDir })
    const compatPending = pendingState.pending
    const compatVerdicts = pendingState.verdicts
    const compatPendingRows = new Set((compatPending?.pending ?? []).filter((p) => (p.status ?? 'pending') === 'pending').map((p) => p.rowId))
    // 兼容门总开关 + 自动检测（只提示不自动开）
    const compatGate = readCompatGate()
    const adoptable = compatGate.autoDetect ? detectAdoptablePending(ctx) : new Map()
    let rollbackRec = null
    try {
      const rr = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8'))
      if (rr !== null && typeof rr.checkpointDir === 'string' && existsSync(join(rr.checkpointDir, '.pnpm'))) {
        rollbackRec = { from: rr.from ?? null, to: rr.to ?? null, at: rr.at ?? null, applicable: true }
      }
    } catch {}
    // 0.5.33 加法 D-⑧（诊断缺口）：**补丁要求启用、运行时却没挂载**（fiberPhase === null）的行，
    // 本地复算框架启动时的 peer 预检，补出短句原因 + 出路。框架那一侧只在**内存里**把
    // row.disabled 置 true（不写用户补丁）、原因只 process.stderr.write —— 面板此前一个字都看不出。
    // 判据与 dsh-app-boot 的 evaluatePluginCompatibility / preflight 对齐（见 domain/peer-veto.js）。
    const vetoFrameworkVersion = currentFrameworkVersion(ctx)
    const entries = listEntries(ctx).map((entry) => {
      const meta = entryPkgMeta(entry.moduleName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
      const disabledByPatch = patch.disables.includes(entry.rowId)
      let veto = null
      if (!disabledByPatch && entry.fiberPhase === null && vetoFrameworkVersion !== null) {
        try { veto = peerVetoFor({ moduleName: entry.moduleName, profileDir, frameworkVersion: vetoFrameworkVersion }) } catch { veto = null }
      }
      const verdict = compatVerdicts.get(entry.rowId) ?? null
      return {
        ...entry,
        userDisabled: disabledByPatch,
        userForced: patch.forced.includes(entry.rowId),
        extra: patch.inserts.includes(entry.rowId) || extraRows.has(entry.moduleName) || extraRows.has(entry.rowId),
        installDate: meta?.installDate ?? null,
        version: meta?.version ?? null,
        repository: meta?.repository ?? null,
        // v0.3.45：只有"补丁里此刻确实还禁着它"的行才显示【待适配】——
        // 记录与开关脱节时（用户手动启用过 / 补丁块被清掉）不能继续挂着「待适配」误导人
        pendingCompat: compatPendingRows.has(entry.rowId) && disabledByPatch,
        // 0.5.34 加法：记录的 `fail` 若已被**当前判据**撤回（旧误报），面板据此不再说「待适配」，
        // 改说「判据已撤回·可解锁」并给一键解锁入口（判据本身一个字都没放宽：真 fail 仍 fail）
        compatRescinded: compatPendingRows.has(entry.rowId) && verdict?.rescinded === true,
        // 结论视图：当前判据下的结论 + 是否过期/撤回/复核不了（面板要如实展示，不许把旧结论当事实）
        compatVerdict: verdict,
        // 自动检测结果（只提示，不自动开）：该待适配行现在是否已适配（插件已更新 + 扫描通过）
        // 或**旧判据的误报已被撤回**（0.5.34：不再要求"版本变化"，否则用户被永久钉住）
        adoptable: adoptable.get(entry.rowId) ?? null,
        // 框架 peer 预检的本地复算结果（null = 无话可说；只在这类行上下发，不新增常驻面板行）
        veto,
      }
    })
    const compat = await detectCompat(ctx.baseUrl ?? 'file:///')
    const auth = readGithubAuth()
    const jobs = [...installJobs.values()].filter((job) => job.status === 'installing').map(installJobView)
    const recentFailures = [...installJobs.values()].filter((job) => job.status === 'failed').slice(-3).map(installJobView)
    // 已安装但尚未生效的任务（2026-09-20 真装真卸演练实测）：bundle 型插件要重启才被加载，
    // 装完 /install 返回 entryId: null、/state 里新增 loader 条目 = 0 —— 面板过去完全看不出
    // 「装了但还没生效」，也无法撤销。前端据此渲染「已安装·重启后生效」徽标 + 按 jobId 删除。
    const pendingRestart = pendingRestartJobs([...installJobs.values()], listEntries(ctx))
    // 框架升级检测与适配（备份快照 + 重打框架补丁），try 包裹不阻塞 state 返回
    let framework = null
    try { framework = detectFrameworkUpgrade(ctx) } catch {}
    // 回滚可用性（2026-09-11 用户困惑：版本已经回滚了，回滚按钮还能点）——
    // 当前版本已经等于记录里的 from 时，再点回滚等于"恢复到你现在这个版本"，无意义。
    if (rollbackRec !== null) {
      const currentVer = typeof framework?.version === 'string' ? framework.version : null
      rollbackRec.applicable = !(currentVer !== null && rollbackRec.from !== null && currentVer === rollbackRec.from)
    }
    let selfVersion = null
    try {
      const selfPkg = JSON.parse(readFileSync(join(pluginRoot(), 'package.json'), 'utf8'))
      selfVersion = typeof selfPkg.version === 'string' ? selfPkg.version : null
    } catch {}
    sendJson(res, 200, { ok: true, entries, patchPath, compat, installJobs: jobs, recentFailures, pendingRestart, github: { loggedIn: auth.loggedIn, login: auth.login }, patch: { disables: patch.disables, forced: patch.forced, inserts: patch.inserts }, framework, patchHeal: patchHeal === null ? null : { healed: patchHeal.healed ?? [], autoDisabled: patchHeal.autoDisabled ?? [], healedAt: patchHeal.healedAt ?? 0, written: patchHeal.written === true, writeError: patchHeal.writeError ?? null, skippedFrameworkOwned: (patchHeal.skipped ?? []).map((s) => s.id ?? null), uncertain: (patchHeal.uncertain ?? []).map((u) => u.id ?? null) }, gating: gatingSummary(ctx, compatPending, entries, compatVerdicts), compatPending: compatPending === null ? null : { frameworkVersion: compatPending.frameworkVersion ?? null, upgradeFrom: compatPending.upgradeFrom ?? null, pending: (compatPending.pending ?? []).filter((p) => (p.status ?? 'pending') === 'pending').map((p) => ({ rowId: p.rowId, moduleName: p.moduleName, version: p.version ?? null, checkNote: p.checkNote ?? null, check: p.check ?? null, riskyApprovedAt: p.riskyApprovedAt ?? null, adoptable: adoptable.get(p.rowId) ?? null, verdict: compatVerdicts.get(p.rowId) ?? null })), verdictRefresh: pendingState.refresh === null ? null : { version: pendingState.refresh.version ?? null, updated: pendingState.refresh.updated ?? [], unchanged: pendingState.refresh.unchanged ?? [], unresolved: pendingState.refresh.unresolved ?? [], wrote: pendingState.refresh.wrote === true, writeError: pendingState.refresh.writeError ?? null } }, compatGate, rollback: rollbackRec, selfVersion, components: findComponents().map((c) => ({ id: c.id, name: c.name, kind: c.kind ?? 'server', pid: c.pid ?? null, port: c.port ?? null, healthUrl: c.healthUrl ?? null, uiUrl: compUiUrl(c), autoStart: c.autoStart === true })) })
    return
}

async function routeDetails(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const detectFrameworkUpgrade = rc.deps.detectFrameworkUpgrade
  const detectCompat = rc.deps.detectCompat
  const listEntries = rc.deps.listEntries
  const detectAdoptablePending = rc.deps.detectAdoptablePending
  const readExtraBundleRows = rc.deps.readExtraBundleRows
  const body = rc.body
    const { entryId } = body
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    const entry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
    if (!entry) {
      sendError(res, 404, `没有名为 ${entryId} 的插件条目`)
      return
    }
    const moduleName = entry.options.name
    const details = await readPluginDetails(moduleName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
    sendJson(res, 200, { ok: true, entryId, rowId: rowIdOf(ctx, entryId), moduleName, ...details })
    return
}

export { routeStateGet, routeDetails }
