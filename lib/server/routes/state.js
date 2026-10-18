// L2 · routes —— 状态与详情（GET /state · POST /details）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { detectAdoptablePending, detectCompat, gatingSummary, readCompatGate, readCompatPendingWithVerdicts } from '../domain/compat.js'
import { compUiUrl, findComponents } from '../domain/components.js'
import { currentFrameworkVersion, detectFrameworkUpgrade, detectHostShape } from '../domain/framework.js'
import { peerVetoFor } from '../domain/peer-veto.js'
import { readExtraBundleRows } from '../domain/install-job.js'
import { bundleVetoList } from '../domain/bundle-veto.js'
import { buildLinkInventory } from '../domain/link-inventory.js'
import { buildInstallHealth } from '../domain/install-health.js'
import { applyExemption } from '../domain/compat-exempt.js'
import { addDevRoot, readDevRoots, removeDevRoot } from '../domain/dev-roots.js'
import { applyPinDevDir, planPinDevDir } from '../domain/pin-dev-dir.js'
import { reconcileLockfile } from '../domain/selfupdate.js'
import { ensureLinkSelfSufficiency } from '../domain/link-self-sufficiency.js'
import { readBundlesSync } from '../domain/persist.js'
import { failedJobEvidence } from '../domain/install-verify.js'
import { installJobView, readGithubAuth } from '../domain/install.js'
import { readPluginDetails } from '../domain/market.js'
import { healPatchSafety, readPatchState } from '../domain/patch.js'
import { pendingRestartJobs } from '../domain/revoke.js'
import { mergePendingRestart } from '../domain/pending-restart.js'
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
        pendingCompat: (compatPendingRows.has(entry.rowId) && disabledByPatch) || veto !== null,
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
    // 「最近安装失败」这张卡（0.5.47 改错，用户被误导过）：**下发之前**先查三处（依赖清单 /
    // dsh.profile.bundles / node_modules）—— 那个插件其实已经装上时，面板必须先说
    // 「已安装 vX（无需重装）」，把历史失败降级成次要信息，而不是让用户以为没装上、再点一次重试。
    // 核实是**只读**的（读 profile 清单 + 盘上包），每次都按**当前磁盘**现查（历史失败也要能翻案）。
    const recentFailures = [...installJobs.values()].filter((job) => job.status === 'failed').slice(-3)
      .map((job) => ({ ...installJobView(job), installedEvidence: failedJobEvidence(profileDir, job) ?? job.installedEvidence ?? null }))
    // 已安装但尚未生效的任务（2026-09-20 真装真卸演练实测）：bundle 型插件要重启才被加载，
    // 装完 /install 返回 entryId: null、/state 里新增 loader 条目 = 0 —— 面板过去完全看不出
    // 「装了但还没生效」，也无法撤销。前端据此渲染「已安装·重启后生效」徽标 + 按 jobId 删除。
    // ★ 0.5.70（用户 2026-10-18）：徽章要能活过重启 —— 内存判定的结果与**持久记录**合并；
    //   已经在 entries 里出现过的包会自动从持久记录里清掉（不留陈旧项）。
    const livePackageNames = (() => {
      const set = new Set()
      try {
        for (const e of listEntries(ctx)) {
          const mn = typeof e?.moduleName === 'string' ? e.moduleName : ''
          if (mn === '' || mn.startsWith('cordis:')) continue
          set.add(mn)
          const m = /^(@[^/]+\/[^/]+)(?:\/.*)?$/u.exec(mn)
          if (m) set.add(m[1])
        }
      } catch {}
      return set
    })()
    let pendingRestart = []
    try { pendingRestart = mergePendingRestart(pendingRestartJobs([...installJobs.values()], listEntries(ctx)), livePackageNames) } catch { pendingRestart = pendingRestartJobs([...installJobs.values()], listEntries(ctx)) }
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
    // ★ 0.5.53 加法（真机 2026-10-15）：**被框架整层跳过的 bundle**。
    //   症状：插件装了、在 dsh.profile.bundles 里，但面板上连"未加载"都不显示（用户原话：
    //   "为啥有的插件我本身是有的，但是没显示呢"）。原因是框架在**装载 bundle 时**就因 peer 不满足
    //   throw，整个 bundle 层进 skippedBundles，它要插的行根本不存在 —— 而面板 enumerate 的是 loader 行。
    //   这里复算同一判据（纯只读），把它们如实列出来；绝不改动任何东西。
    let skippedBundles = { items: [], reliable: true, note: null }
    try {
      skippedBundles = bundleVetoList({
        bundleNames: readBundlesSync(profileDir),
        profileDir,
        baseUrl: ctx.baseUrl ?? 'file:///',
        frameworkVersion: vetoFrameworkVersion,
      })
    } catch {}
    // ★ 0.5.53 加法（真机 2026-10-15）：把「本实例是否由桌面端外壳托管」告诉面板。
    //   为什么必须下发：一键升级 / 一键回滚这两条通道在**外壳托管时会被服务端拒绝**
    //   （409 + 「本实例由桌面端外壳托管，请在桌面端内重启/更新」）—— 那是一份历史事故的修补：
    //   回滚脚本曾按端口 Stop-Process 杀掉 Electron 承载的 host，重新拉起时又找不到 bin.js，
    //   于是外壳记了一次 crash。拒绝本身是对的，但面板**过去照旧显示一个可点的「回滚到上一版」**，
    //   点下去必然 409 —— 典型的"按钮存在但永远失败"。这里把同一份事实（detectHostShape）
    //   下发给面板，让按钮按事实禁用并说明原因，而不是让人撞墙。
    let host = { hosted: false, kind: 'standalone', notice: null }
    try {
      const shape = detectHostShape()
      host = { hosted: shape.hosted === true, kind: shape.kind, notice: shape.hosted === true ? shape.notice : null }
    } catch {}
    // ★ 0.5.60 加法（真机 2026-10-18）：**为被 bundle 级跳过的插件合成虚拟行**。
    //   为什么必须做：bundle 层被跳过 ⇒ 它要插的 loader 行**根本不存在** ⇒ 列表里没有位置可挂，
    //   用户只能看到一条横幅，无法像别的插件那样"看到它、更新它、再启用它"。
    //   合成后它出现在列表里，显示为「已停用 / 未加载」+ 否决原因；toggleable=false 表示
    //   **没有真实行可开关**（开关自动置灰），但「详情 → 检测更新」照常可用 —— 更新到兼容版本后
    //   重启，bundle 才会真正装载并出现真实行，那时才谈得上"启用"。
    const realModuleNames = new Set(entries.map((e) => e.moduleName))
    const virtualEntries = skippedBundles.reliable === true && Array.isArray(skippedBundles.items)
      ? skippedBundles.items
        .filter((b) => b !== null && b !== undefined && typeof b.packageName === 'string' && !realModuleNames.has(b.packageName))
        .map((b) => ({
          entryId: `bundle-skipped:${b.packageName}`,
          rowId: null,
          moduleName: b.packageName,
          enabled: false,
          fiberPhase: null,
          protected: false,
          toggleable: false,
          userDisabled: false,
          userForced: false,
          // ★ 0.5.64（用户 2026-10-18「还是没显示出来那俩第三方插件」）：客户端安装列表**默认**
          //   extraOnly=true，只显示 extra===true 的行；虚拟行原本写 false ⇒ 被默认筛选滤掉，
          //   服务端发了、界面看不到。语义上也该是 true：它与"控制台插入的行"同属非核心行。
          extra: true,
          installDate: null,
          version: b.version ?? null,
          repository: null,
          // ★ 0.5.61（用户 2026-10-18）：虚拟行本质就是「待适配」——标成 true 才能拿到客户端那条
          //   既有的「更新并适配」（updateAndAdapt）链路，也就是用户记得的"更新后启用"。
          pendingCompat: true,
          compatRescinded: false,
          compatVerdict: null,
          adoptable: null,
          // 复用既有的 veto 通道：卡片会照常渲染原因 + 出路（tooltip），无需新 UI。
          veto: { reason: b.reason ?? null, hint: b.hint ?? null, kind: b.kind ?? null, judged: b.judged ?? null },
          virtual: true,
        }))
      : []
    const allEntries = virtualEntries.length === 0 ? entries : [...entries, ...virtualEntries]

    // ★ 0.5.55 加法：把已经算好的各块**折成一行健康摘要**（不新增 IO、不新增判据）。
    //   面板 176 个按钮、信息散在六处，用户没有一个地方能回答"整体健康吗、我该先处理哪件"。
    const liveRowIds = new Set(entries.map((e) => e.rowId))
    let health = { issues: 0, items: [] }
    try {
      health = buildInstallHealth({
        entries,
        skippedBundles,
        // ★ 0.5.68：与界面同口径 —— 只统计「仍待适配」且**目标行仍存在**的记录。
        //   否则会把已采纳的历史记录、以及指向已删除行的陈旧记录都算成"待处理"（实测 24 vs 界面 0）。
        pendingCompat: (compatPending?.pending ?? []).filter((p) => (p?.status ?? 'pending') === 'pending' && liveRowIds.has(p?.rowId)),
        patchUncertain: patchHeal === null ? [] : (patchHeal.uncertain ?? []),
      })
    } catch {}
    sendJson(res, 200, { ok: true, entries: allEntries, skippedBundles, host, health, patchPath, compat, installJobs: jobs, recentFailures, pendingRestart, github: { loggedIn: auth.loggedIn, login: auth.login }, patch: { disables: patch.disables, forced: patch.forced, inserts: patch.inserts }, framework, patchHeal: patchHeal === null ? null : { healed: patchHeal.healed ?? [], autoDisabled: patchHeal.autoDisabled ?? [], healedAt: patchHeal.healedAt ?? 0, written: patchHeal.written === true, writeError: patchHeal.writeError ?? null, skippedFrameworkOwned: (patchHeal.skipped ?? []).map((s) => s.id ?? null), uncertain: (patchHeal.uncertain ?? []).map((u) => u.id ?? null) }, gating: gatingSummary(ctx, compatPending, entries, compatVerdicts), compatPending: compatPending === null ? null : { frameworkVersion: compatPending.frameworkVersion ?? null, upgradeFrom: compatPending.upgradeFrom ?? null, pending: (compatPending.pending ?? []).filter((p) => (p.status ?? 'pending') === 'pending').map((p) => ({ rowId: p.rowId, moduleName: p.moduleName, version: p.version ?? null, checkNote: p.checkNote ?? null, check: p.check ?? null, riskyApprovedAt: p.riskyApprovedAt ?? null, adoptable: adoptable.get(p.rowId) ?? null, verdict: compatVerdicts.get(p.rowId) ?? null })), verdictRefresh: pendingState.refresh === null ? null : { version: pendingState.refresh.version ?? null, updated: pendingState.refresh.updated ?? [], unchanged: pendingState.refresh.unchanged ?? [], unresolved: pendingState.refresh.unresolved ?? [], wrote: pendingState.refresh.wrote === true, writeError: pendingState.refresh.writeError ?? null } }, compatGate, rollback: rollbackRec, selfVersion, components: findComponents().map((c) => ({ id: c.id, name: c.name, kind: c.kind ?? 'server', pid: c.pid ?? null, port: c.port ?? null, healthUrl: c.healthUrl ?? null, uiUrl: compUiUrl(c), autoStart: c.autoStart === true })) })
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
    // ★ 0.5.66：白名单补 `@` `/` —— 带 scope 的虚拟行 id 形如 bundle-skipped:@scope/pkg。
    //   放宽外层的安全性由后续校验保证：虚拟行会再用 npm 包名正则验一次（非法即 400）。
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_:.@/-]{1,120}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    // ★ 0.5.65：虚拟行（bundle 被跳过、没有 loader 行）也要能看详情 —— 否则"详情 → 检测更新 → 更新并适配"
    //   这条唯一可行的出路就断了（实测报"没有名为 bundle-skipped:xxx 的插件条目"）。
    const VIRTUAL_PREFIX = 'bundle-skipped:'
    let moduleName = null
    if (entryId.startsWith(VIRTUAL_PREFIX)) {
      const virtualName = entryId.slice(VIRTUAL_PREFIX.length)
      // 包名必须像 npm 包名，避免把任意字符串当包名去解析
      if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(virtualName)) {
        sendError(res, 400, `虚拟条目 id 不是合法包名：${entryId}`)
        return
      }
      const details = await readPluginDetails(virtualName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
      sendJson(res, 200, { ok: true, entryId, rowId: null, moduleName: virtualName, virtual: true, ...details })
      return
    }
    const entry = ctx.loader.entries().find((candidate) => candidate.id === entryId)
    if (!entry) {
      sendError(res, 404, `没有名为 ${entryId} 的插件条目`)
      return
    }
    moduleName = entry.options.name
    const details = await readPluginDetails(moduleName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
    sendJson(res, 200, { ok: true, entryId, rowId: rowIdOf(ctx, entryId), moduleName, ...details })
    return
}

/**
 * GET /links —— **link 开发式安装清单**（0.5.54 加法，纯只读）。
 *
 * 用户 2026-10-15 的原话：「这主要是对标他们本地开发插件 link 挂载钉住」。
 * 过去面板上 link 钉住的插件与普通插件长得一模一样：看不出指向哪、目标还在不在、
 * 依赖/peer 齐不齐、改完代码加载的是哪一份。本路由把它们聚合成一份清单，让"看见"先成立。
 *
 * 判据全部复用既有唯一真源（domain/link-inventory.js → planLinkSelfSufficiency / persistReport /
 * listSelfSufficiencyRecords），**不新增任何写盘、不 spawn、不联网**。
 */
async function routeLinksGet(req, res, rc) {
  const ctx = rc.ctx
  let payload = { ok: true, items: [], count: 0, readyCount: 0, error: null }
  try {
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    payload = { ok: true, ...buildLinkInventory({ profileDir, patchPath, entries: listEntries(ctx) }), error: null }
  } catch (error) {
    // 体检失败要如实说，不能假装"没有 link 依赖"
    payload = { ok: false, items: [], count: 0, readyCount: 0, error: error instanceof Error ? error.message : String(error) }
  }
  sendJson(res, 200, payload)
}

/**
 * POST /compat-exempt —— **写**一条精确版本豁免（0.5.56 加法）。
 *
 * 0.5.53 让"被框架跳过的 bundle"可见，并在提示里给了三条出路；但控制台只会**读** compatibility.json，
 * 从不写 —— 那条提示等于把活推回用户（"你自己去编辑文件，格式自己查"）。本路由把那半截补上。
 *
 * 安全与纪律（与仓库其它写动作一致）：
 *   · 只接受 { packageName, version, mode }，**不收任何路径** —— 文件位置由服务端按 profile 决定；
 *   · 精确版本校验（范围/前缀一律拒），框架版本必须是**当前运行时**那个；
 *   · 先备份 → 原子写 → **读回来验证**，验证不过即回滚并如实报错（绝不谎报成功）；
 *   · 已有坏文件时**停止**而不是覆盖（那是用户的文件）。
 */
async function routeCompatExempt(req, res, rc) {
  const ctx = rc.ctx
  const body = rc.body ?? {}
  let profileDir = null
  try { profileDir = dirname(findPatchPath(ctx)) } catch {}
  const frameworkVersion = typeof body.frameworkVersion === 'string' && body.frameworkVersion !== ''
    ? body.frameworkVersion
    : (() => { try { return currentFrameworkVersion(ctx) } catch { return null } })()
  const result = applyExemption({
    profileDir,
    packageName: body.packageName,
    version: body.version,
    frameworkVersion,
    mode: body.mode === 'revoke' ? 'revoke' : 'grant',
  })
  const payload = {
    ok: result.ok === true,
    changed: result.changed === true,
    key: result.key ?? null,
    note: result.note ?? null,
    error: result.error ?? null,
    backup: result.backup ?? null,
  }
  if (result.ok === true) sendJson(res, 200, payload)
  else sendError(res, result.status ?? 400, payload.error ?? '豁免写入失败', payload)
}

/**
 * POST /dev-roots —— 开发区根的登记表（0.5.57 加法）。
 * 用户 2026-10-15 决定：「允许」注册自己的开发区根、「不允许」任意目录。
 * 本路由只管登记表本身；**包含性判定**在 domain/dev-roots.js，是"不许任意目录"的唯一执行点。
 * body: { action: 'list' | 'add' | 'remove', dir? }
 */
async function routeDevRoots(req, res, rc) {
  const body = rc.body ?? {}
  const action = body.action === 'add' ? 'add' : body.action === 'remove' ? 'remove' : 'list'
  if (action === 'list') {
    const r = readDevRoots(null)
    sendJson(res, 200, { ok: true, roots: r.roots, warnings: r.warnings, file: r.file })
    return
  }
  const result = action === 'add' ? addDevRoot(null, body.dir) : removeDevRoot(null, body.dir)
  const payload = { ok: result.ok === true, roots: result.roots ?? [], file: result.file ?? null, note: result.note ?? null, error: result.error ?? null }
  if (result.ok === true) sendJson(res, 200, payload)
  else sendError(res, 400, result.error ?? '开发区根操作失败', payload)
}

/**
 * POST /pin-dev-dir —— 把一个**开发区里的目录**钉成 link 依赖（0.5.57 加法）。
 *
 * 用户 2026-10-15 决定：① 允许注册自己的根；② 不允许任意目录；③ agent 自动钉住要用户勾选、**默认关闭**。
 * 所以本路由有两段，都是刻意的：
 *   { dir, confirm: false }（默认）→ **只规划**，返回"将要发生什么"的清单（面板先给人看）；
 *   { dir, confirm: true }          → 真写（备份清单 → 写 link: → pnpm 对齐 lock → 自足性 → 读回验证）。
 * `byAgent: true` 时服务端会检查 `allowAgent`（面板上的勾选，默认关），未放行一律 403。
 */
async function routePinDevDir(req, res, rc) {
  const ctx = rc.ctx
  const body = rc.body ?? {}
  let profileDir = null
  try { profileDir = dirname(findPatchPath(ctx)) } catch {}
  const common = {
    profileDir,
    dir: body.dir,
    byAgent: body.byAgent === true,
    allowAgent: body.allowAgent === true,
  }
  if (body.confirm !== true) {
    const plan = planPinDevDir(common)
    if (plan.ok !== true) { sendError(res, plan.status ?? 400, plan.error ?? '钉住规划失败', { ok: false }); return }
    sendJson(res, 200, { ok: true, applied: false, packageName: plan.packageName, version: plan.version, spec: plan.spec, current: plan.current, marker: plan.marker, root: plan.root, steps: plan.steps })
    return
  }
  // 真写：pnpm 通过真实执行器（这里用 install.js 的既有通道，与安装流程同一套）
  const runInstall = async ({ profileDir: pd }) => {
    const r = await reconcileLockfile({ profileDir: pd })
    return { ok: r?.lockUpdated === true || r?.ok === true, note: r?.note ?? null, stderr: r?.stderr ?? null }
  }
  const ensureSufficiency = async ({ profileDir: pd, packageName }) => ensureLinkSelfSufficiency({ profileDir: pd, packageName })
  const result = await applyPinDevDir({ ...common, runInstall, ensureSufficiency })
  const payload = {
    ok: result.ok === true, applied: result.changed === true, packageName: result.packageName ?? null,
    spec: result.spec ?? null, after: result.after ?? null, error: result.error ?? null,
    backup: result.backup ?? null, note: result.note ?? null, sufficiency: result.sufficiency ?? null,
  }
  if (result.ok === true) sendJson(res, 200, payload)
  else sendError(res, result.status ?? 400, result.error ?? '钉住失败', payload)
}
export { routeStateGet, routeDetails, routeLinksGet, routeCompatExempt, routeDevRoots, routePinDevDir }
