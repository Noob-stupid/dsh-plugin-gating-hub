// L2 · routes —— 框架（/framework-check · /check-update · /framework-upgrade · /framework-rollback · /framework-upgrade-status · /framework-relaunch · /compat-gate · /restart）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readCompatGate, writeCompatGate } from '../domain/compat.js'
import { cleanupStaleFwTasks, currentFrameworkVersion, detectHostShape, pickFrameworkTarget, platformUpgradeRefusal, relaunchPrelude, resolveDshBin, shellHostedRefusal } from '../domain/framework.js'
import { relaunchLauncherSource } from '../domain/framework-relaunch.js'
import { restartPathDecision } from '../domain/restart.js'
// 0.5.84 加法（用户第 5 项）：独立实例的 detached 重拉 —— 计划在 domain/restart-launcher.js，
// 进程原语仍走 infra/egress.js 的可注入出口（单测能证明"一次真进程都没起"）。
import { planRelaunch, relaunchDetached } from '../domain/restart-launcher.js'
import { readGithubAuth } from '../domain/install.js'
import { webPort } from '../domain/runtime.js'
import { fetchJsonUrl } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome, entryPkgMeta, findPatchPath, packageNameOf, pluginRoot, profileDirOf, resolvePackageJson } from '../infra/paths.js'
import { isFrameworkVersionNewer, semverRangeMatchLoose, frameworkUpgradeCandidates } from '../infra/semver.js'
import { dropStaleUpdateCandidates, pickUpdateTarget } from '../domain/update-candidates.js'
import { fwCheckCache, setFwCheckCache } from '../state.js'

/**
 * 宿主形态守卫（2026-09-26 真机事故后的**加法分支**，只挡外壳托管这一种新形态）：
 * 桌面端里 DSH host 由 Electron 二进制承载（asar 内 dsh-desktop-host），实例里根本没有 `node bin.js web` 可拉起。
 * 我们原先的「按端口 Stop-Process → Invoke-DshRelaunch」会杀掉 host 却拉不起来，
 * Electron 外壳只留下 `crash-…-host.log: dsh desktop host exited with 4294967295`（真机 20:28）。
 * 命中时：**不 kill、不 spawn、不建 schtasks**，返回结构化 409 + 面向用户短句。
 * 返回 true = 已拒绝（调用方直接 return）；false = 独立 `dsh web` 实例，原路径一字不改。
 */
function refuseWhenShellHosted(res) {
  const refusal = shellHostedRefusal()
  if (refusal === null) return false
  sendError(res, 409, refusal.error, refusal.details)
  return true
}

/**
 * 「本实例是否由桌面端外壳托管」——**零 spawn 路由**（/restart 与 /framework-relaunch）的唯一判定入口。
 * 与 refuseWhenShellHosted 共用 domain/framework.js#detectHostShape 这一份事实，不另立判据。
 * `rc.deps.hosted` 是单测的确定性注入口（正/负控见 tests/test-restart-official-path.mjs）；
 * 生产路径不传 ⇒ 现判（读真实进程全局）。缺省语义 =「判不出托管就不当作托管」——本路由在任何
 * 分支都**不 spawn / 不 kill**，所以偏向哪边都不会造成"拉起"这个危险动作。
 */
function hostedHere(rc) {
  return rc.deps?.hosted ?? detectHostShape().hosted === true
}

/** 解析 DSH 的 bin.js（**失败不抛**）：拿不到就返回 null，判据据此回落"手动重启"。 */
function resolveDshBinSafe() {
  try {
    return resolveDshBin()
  } catch {
    return null
  }
}

/** 本实例真实监听的端口（自定义 --port / 系统分配也对；拿不到返回 null）。 */
function webPortHard(rc) {
  try {
    return webPort(rc.ctx)
  } catch {
    return null
  }
}

/** 优雅退出的默认实现：回完响应后结束本进程（**不 kill 任何进程**，端口随进程结束而释放）。 */
function defaultGracefulExit(delayMs) {
  const timer = setTimeout(() => { process.exit(0) }, Math.max(0, Number(delayMs) || 0))
  // 不阻止进程退出：这个定时器只是"晚一点退"，不是"必须跑完"
  if (typeof timer?.unref === 'function') timer.unref()
}

/**
 * 平台守卫（2026-09-29 改错，与宿主守卫同形）：一键升级/回滚脚本整体依赖 Windows 机制 ——
 * `schtasks.exe` 计划任务 + PowerShell + `Get-NetTCPConnection`；非 Windows 上 execFile 必然 ENOENT，
 * 而旧实现会先写一个「脚本已启动」的状态文件、再去 exec 不存在的 powershell.exe，**最后仍回 ok:true**
 * （用户以为在跑，实际零动作）。判据与文案见 domain/framework.js#platformUpgradeRefusal。
 * 命中时：不写状态文件、不 spawn、不建计划任务，直接 501 + 手动升级出路。
 * 返回 true = 已拒绝（调用方直接 return）；false = win32，原路径一字不改。
 */
function refuseWhenPlatformUnsupported(res) {
  const refusal = platformUpgradeRefusal()
  if (refusal === null) return false
  sendError(res, 501, refusal.error, refusal.details)
  return true
}

async function routeFrameworkUpgradeStatusGet(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
    // 框架升级进度（页面断连后重连恢复进度条用）：读状态文件 {status|message}
    let status = { status: 'idle', message: null }
    try {
      const f = join(dshHome(), 'plugin-console', 'fw-upgrade-state.txt')
      if (existsSync(f)) {
        // PS5.1 Set-Content -Encoding UTF8 会写 BOM——strip 掉，否则 status 变成 '\uFEFFdone'，
        // 客户端 status === 'done' 永不匹配（进度条/悬浮按钮不消失）
        let raw = readFileSync(f, 'utf8')
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
        const [st, ...rest] = raw.split('|')
        const at = statSync(f).mtimeMs
        // v0.3.37：失败记录里带 stage=<崩溃前最后阶段>，界面据此把已完成的步骤显示成 ✓（而不是整列 ✕）
        const stageRaw = rest.find((p) => p.startsWith('stage='))
        const stage = stageRaw === undefined ? null : (stageRaw.slice(6) || null)
        status = { status: st ?? 'idle', message: rest.filter((p) => !p.startsWith('stage=')).join('|') || null, stage, at }
        // ── v0.3.39 状态自愈 ──────────────────────────────────────────────────
        // 2026-09-11 真机：回滚脚本干完活之后**进程被 Ctrl+C 类事件结束**（计划任务 Last Result
        // = 0xC000013A），终态没写成 → 界面永远卡在「回滚中…」并每 3 秒轮询。心跳 + 现实核对
        // 能把它纠正回来：脚本不再心跳（>90 秒没动静）时，用「已装版本 vs 回滚记录的 from/to」
        // 判断真实结果；同时清掉残留的 DSH-FW-* 计划任务。
        // 2026-10-28 加法：`ready` = 框架本体已就位、只有自动拉起失败（**不回滚**，回滚交人工）。
        // 它是**终态**（下面两处 terminal 判定都得认它，否则自愈会改写成 done、15 分钟残留清理会抹成 idle）。
        const terminal = status.status === 'idle' || status.status === 'done' || status.status === 'failed' || status.status === 'ready'
        if (!terminal) {
          let hbAge = null
          try { hbAge = Date.now() - statSync(`${f}.hb`).mtimeMs } catch { hbAge = null }
          const scriptAlive = hbAge !== null && hbAge < 90000
          if (!scriptAlive) {
            let rec = null
            let current = null
            try { rec = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8')) } catch {}
            try {
              const localRequire = createRequire(ctx.baseUrl ?? 'file:///')
              current = JSON.parse(readFileSync(localRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version ?? null
            } catch {}
            const upgradedTo = rec !== null && typeof rec.to === 'string' && current === rec.to
            const rolledBackTo = rec !== null && typeof rec.from === 'string' && current === rec.from
            // 「安装阶段」不能靠 from 判定（那时本来就还是旧版本），只认 to
            if (upgradedTo) {
              status = { ...status, status: 'done', reconciled: { from: st, note: `脚本进程已中断，但框架已是 ${current}、服务正常 —— 实际结果：升级成功` } }
            } else if (rolledBackTo && (st === 'rollback' || st === 'relaunching' || st === 'stopped')) {
              status = { ...status, status: 'done', reconciled: { from: st, note: `脚本进程已中断，但框架已回到 ${current}、服务正常 —— 实际结果：回滚成功` } }
            } else if (hbAge !== null) {
              status = { ...status, stalled: true, note: '升级/回滚脚本已超过 90 秒没有心跳，进程可能已被结束——请用「重新检查版本」核对，必要时重启服务' }
            }
            if (status.reconciled !== undefined) cleanupStaleFwTasks()
          }
        }
        // 失败但框架本体其实已经装到目标版本：明确告诉用户「升级本体成功、失败的是重启那一步」，
        // 免得整列红叉让人以为白干了（2026-09-11 真机事故就是这样）。
        if (status.status === 'failed') {
          try {
            const rr = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8'))
            const cur = JSON.parse(readFileSync(join(rr.fwRoot, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
            if (typeof rr.to === 'string' && rr.to !== '' && cur === rr.to) status.frameworkAtTarget = cur
          } catch {}
        }
        // 残留清理：非终止状态（starting/stopped/installing/rollback/pkg/relaunching）超过 15 分钟
        // 视为上次升级的残留——升级脚本要么成功（done）要么失败（failed），服务重启后不可能还在
        // 中途；任务调度失败/脚本空跑时状态会永远停在 starting，重启后不应再自动恢复进度条。
        // （升级进行中页面断连后用户手动重启服务属边缘情况：<15 分钟不受影响，进度仍可恢复）
        if (status.status !== 'idle' && status.status !== 'done' && status.status !== 'failed' && status.status !== 'ready'
          && Date.now() - at > 15 * 60 * 1000) {
          try { writeFileSync(f, 'idle|', 'utf8') } catch {}
          status = { status: 'idle', message: null, at: Date.now() }
        }
        // ready → 对客户端表现成 done + keptFrame/relaunchFailed 标记（不改 UI：done 是终态、message 原样显示）
        if (status.status === 'ready') status = { ...status, status: 'done', keptFrame: true, relaunchFailed: true }
      }
    } catch {}
    sendJson(res, 200, { ok: true, ...status })
    return
}

async function routeFrameworkRelaunch(req, res, rc) {
    // 原「手动拉起服务」（升级期间左侧悬浮按钮）：`Start-Process node bin.js web`。
    // 2026-10-10 用户红线 + 现场取证（console-restart.log「[guard] 端口 N 无监听，第 N 次拉起」/
    // fw-relaunch.log「拉起(守护第 N 次): …\dsh\lib\bin.js」）⇒ 这条"手动拉起"整条下线：
    // spawn 出来的第二个 `dsh web` 会与宿主争端口（listen EADDRINUSE），桌面端托管时更是
    // 直接把宿主子进程顶掉 ⇒ 外壳弹「应用无法启动或已意外停止。」。
    // 现在统一走 domain/restart.js 的**唯一判据**（官方路径 / 如实告知），本路由零 spawn / 零 kill。
    const decision = restartPathDecision({ hosted: hostedHere(rc), intent: 'relaunch' })
    sendError(res, decision.status, decision.message, decision.details)
    return
}

async function routeFrameworkCheck(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 框架版本检查（「功能包 → 框架」常驻面板用）：当前版本 / latest / next / 升级目标。
    // 与升级路由同一套判定规则，但**只读**（不备份、不写状态文件）；5 分钟内存缓存 +
    // body.refresh === true 强制重查——面板是常驻入口，不能每次打开都打 registry。
    const now = Date.now()
    if (body.refresh === true || fwCheckCache === null || now - fwCheckCache.at > 300000) {
      // 当前版本先从本地包读出来——候选列表要拿它做「只收更新的」过滤
      let current = null
      try {
        const localRequire = createRequire(ctx.baseUrl ?? 'file:///')
        const pkg = JSON.parse(readFileSync(localRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
        current = typeof pkg.version === 'string' ? pkg.version : null
      } catch {}
      let latest = null
      let next = null
      let alpha = null
      let versions = []
      let tagDefault = null
      let registryError = null
      try {
        const data = await fetchJsonUrl('https://registry.npmmirror.com/@deepseek-ai%2fdsh')
        latest = data?.['dist-tags']?.latest ?? null
        next = data?.['dist-tags']?.next ?? null
        alpha = data?.['dist-tags']?.alpha ?? null
        // 可选升级目标列表（用户 2026-09-23 要求：所有比当前新的版本都列出来，测试版也列）
        const cand = frameworkUpgradeCandidates(data, current)
        versions = cand.versions
        tagDefault = cand.tagDefault
      } catch (error) {
        registryError = error instanceof Error ? error.message : String(error)
      }
      const target = pickFrameworkTarget({ current, latest, next }).target
      setFwCheckCache({ at: now, data: { current, latest, next, alpha, target, versions, tagDefault, registryError } })
    }
    sendJson(res, 200, { ok: true, ...fwCheckCache.data, checkedAt: fwCheckCache.at })
    return
}

async function routeCompatGate(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 兼容门总开关（用户定案 2026-09-11）：自动行为必须可关，关掉即回到纯手动。
    //  autoDisable —— 升级前是否自动禁用判定不适配的行
    //  autoDetect  —— 打开控制台时是否自动检测「已适配」（仅提示，绝不自动解锁）
    const patchBody = {}
    if (typeof body.autoDisable === 'boolean') patchBody.autoDisable = body.autoDisable
    if (typeof body.autoDetect === 'boolean') patchBody.autoDetect = body.autoDetect
    const gateNext = Object.keys(patchBody).length > 0 ? writeCompatGate(patchBody) : readCompatGate()
    sendJson(res, 200, { ok: true, compatGate: gateNext })
    return
}

/**
 * 单个已装插件的更新检测 —— **唯一实现**（issue #22 ①：一键批量检测必须与单卡检测同结论）。
 * 批量入口若另写一份"问 registry / 回落 GitHub release / 净化陈旧候选"，就是第二套检测逻辑 ——
 * 本仓已为"两套判据分叉"付过代价（0.5.37 反向更新）。所以只留一份：`/check-update`（单卡）与
 * `/check-updates`（批量）都调本函数；判据仍是 `infra/semver.js` 的 `<<<update-pick>>>` 块。
 * 本函数**不是路由**：不写 res、不校验入参（调用方各自校验），只回结论。
 * options.fetchJson = 出网注入缝（默认 infra/http.js 的 fetchJsonUrl ⇒ 生产行为零变化；批量离线测试靠它）。
 */
async function probePackageUpdate(packageName, rc, options = {}) {
  const currentFrameworkVersion = rc.deps.currentFrameworkVersion
  const ctx = rc.ctx
  const fetchJson = typeof options.fetchJson === 'function' ? options.fetchJson : fetchJsonUrl
  // ★ 2026-10-25 改错（抽函数时发现）：profileDir 必须在**函数作用域**里。
  //   旧代码只在 registry 那个 `try {}` 块内声明 `const profileDir = dirname(patchPath)`，
  //   而下面的 migrate（换名检测）块在 try **之外**引用它 ⇒ 每次调用必抛
  //   `ReferenceError: profileDir is not defined`，被那个块自己的 `catch {}` 吞掉
  //   ⇒ `migrate` 恒为 null（面板上"项目已改名/迁移发布 → 去装新包"这条提示从未生效过）。
  //   tests/test-update-batch.mjs ⑤ 用正控钉住：声明了 dsh.migrate.to 的包必须真的回 migrate。
  const profileDir = dirname(findPatchPath(ctx))
  let latest = null
  let next = null
  let beta = null
  let depsOutdated = []
  let error = null
  let source = 'npm'
  // 检测已安装插件是否有新版本：curl registry 元数据取 dist-tags.latest（node 网络黑洞时 curl 可用）。
  // 聚合包（有 dependencies）额外对比子包版本：声明版本 vs 本地 node_modules 实际版本，
  // 返回 depsOutdated 提示"更新本包需同步子包"，避免半更新混搭导致启动冲突。
  try {
    const encoded = packageName.startsWith('@')
      ? `@${encodeURIComponent(packageName.slice(1).split('/')[0])}%2f${encodeURIComponent(packageName.split('/').slice(1).join('/'))}`
      : encodeURIComponent(packageName)
    const data = await fetchJson(`https://registry.npmmirror.com/${encoded}`)
    latest = data?.['dist-tags']?.latest ?? null
    next = data?.['dist-tags']?.next ?? null
    beta = data?.['dist-tags']?.beta ?? null
    if (latest === null) throw new Error(`registry 无 dist-tags.latest（${packageName}）`)
    // 子包配套检查：最新版声明依赖 vs 本地实际版本
    const declared = latest ? data?.versions?.[latest]?.dependencies ?? {} : {}
    const keys = typeof declared === 'object' ? Object.keys(declared) : []
    for (const dep of keys) {
      const required = String(declared[dep] ?? '').replace(/^[\^~>=< ]+/u, '')
      if (!required) continue
      let current = null
      try {
        const pkgPath = join(profileDir, 'node_modules', dep, 'package.json')
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          current = typeof pkg.version === 'string' ? pkg.version : null
        }
      } catch {}
      if (current !== null && current !== required) {
        depsOutdated.push({ name: dep, current, required })
      }
    }
  } catch (err) {
    // GitHub 发布回退（自身/未发布到 npm 的插件）：npm registry 404/无 latest 时，
    // 从已装包 package.json 的 repository 字段反查 GitHub 最新版本。
    // 通道顺序：GitHub API（带 token）→ jsDelivr 版本 API（GitHub 黑洞期可用，已验证 200）。
    // 覆盖 dsh-plugin-console（本面板）这类"源码在 GitHub、npm 上不存在"的宿主插件。
    let fallbackError = err instanceof Error ? err.message : String(err)
    try {
      const meta = entryPkgMeta(packageName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))
      const repo = typeof meta?.repository === 'string'
        ? meta.repository.replace(/^git\+/u, '').replace(/\.git$/u, '')
        : (meta?.repository && typeof meta.repository === 'object' ? meta.repository.url : null)
      const m = typeof repo === 'string' ? repo.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/u) : null
      if (m) {
        let tag = null
        // 通道 1：GitHub API（匿名可读，限流 60/h；token 时 5000/h）
        try {
          const auth = readGithubAuth()
          const headers = { 'User-Agent': 'dsh-plugin-console' }
          if (auth.token) headers.Authorization = `token ${auth.token}`
          const release = await fetchJson(`https://api.github.com/repos/${m[1]}/releases/latest`, 12000, headers)
          if (typeof release?.tag_name === 'string') tag = release.tag_name
        } catch {}
        // 通道 2：jsDelivr 版本列表（GitHub 直连黑洞时可用；取最高版本号）
        if (tag === null) {
          try {
            const data = await fetchJson(`https://data.jsdelivr.com/v1/packages/gh/${m[1]}`, 12000)
            const versions = Array.isArray(data?.versions) ? data.versions.map((v) => String(v.version ?? '')) : []
            // 按语义版本号排序取最高（v 前缀剥离后比较）
            const parsed = versions
              .map((v) => ({ raw: v, ver: v.replace(/^v/iu, '') }))
              .filter((x) => /^\d+\.\d+\.\d+/u.test(x.ver))
              .sort((a, b) => {
                const pa = a.ver.split(/[.-]/u).map((n) => (Number.isFinite(Number(n)) ? Number(n) : n))
                const pb = b.ver.split(/[.-]/u).map((n) => (Number.isFinite(Number(n)) ? Number(n) : n))
                for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                  const x = pa[i] ?? -1; const y = pb[i] ?? -1
                  if (x !== y) return typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : 1
                }
                return 0
              })
            if (parsed.length > 0) tag = parsed[parsed.length - 1].raw
          } catch {}
        }
        if (tag !== null) {
          latest = tag.replace(/^v/iu, '')
          next = null
          source = 'github'
          error = null
          fallbackError = null
        }
      }
      if (fallbackError !== null && latest === null) error = `npm 与 GitHub 均未检测到版本（${fallbackError}）`
    } catch (fbErr) {
      error = `npm registry 查询失败且 GitHub 回退不可用（${fallbackError}；${fbErr instanceof Error ? fbErr.message : String(fbErr)}）`
    }
  }
  // migrate 换名检测（2026-09-04 缺陷修复）：本地包声明 dsh.migrate.to 时查目标包最新版/引擎声明，
  // 识别「项目已改名/迁移发布」的更新（如 @linxin666/dsh-web-ui-all → @linxin666/dsh-web-all 0.3.14）
  let migrate = null
  try {
    const localPath = resolvePackageJson(packageName, profileDir)
    if (localPath !== null) {
    const localPkg = JSON.parse(readFileSync(localPath, 'utf8'))
    const to = typeof localPkg.dsh?.migrate?.to === 'string' ? localPkg.dsh.migrate.to : null
    if (to !== null && to !== '' && to !== packageName) {
      const encTo = to.startsWith('@')
        ? `@${encodeURIComponent(to.slice(1).split('/')[0])}%2f${encodeURIComponent(to.split('/').slice(1).join('/'))}`
        : encodeURIComponent(to)
      const meta = await fetchJson(`https://registry.npmmirror.com/${encTo}`)
      const toLatest = meta?.['dist-tags']?.latest ?? meta?.['dist-tags']?.next ?? null
      const toPkg = toLatest !== null ? (meta?.versions?.[toLatest] ?? null) : null
      const engine = toPkg?.dsh?.engines?.dsh ?? toPkg?.engines?.dsh ?? null
      const fwVer = currentFrameworkVersion(ctx)
      const compatible = fwVer !== null && (engine === null || semverRangeMatchLoose(fwVer, engine))
      migrate = { to, latest: toLatest, engine, compatible }
    }
    }
  } catch {}
  // 兜底（0.5.37）：低于已装版本的候选不是"新版"（真机：镜像 latest=0.1.1-rc.1 < 已装 0.2.0-rc.2）
  ;({ latest, next, beta } = dropStaleUpdateCandidates({ latest, next, beta }, packageName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx)))
  return { latest, next, beta, depsOutdated, error, source, migrate }
}

async function routeCheckUpdate(req, res, rc) {
  const body = rc.body
    const packageName = packageNameOf(typeof body.packageName === 'string' ? body.packageName.trim() : '')
    if (!packageName) {
      sendError(res, 400, 'packageName 不能为空')
      return
    }
    // 检测走**唯一实现** probePackageUpdate（与 /check-updates 批量入口同一份，见其函数注释）
    const { latest, next, beta, depsOutdated, error, source, migrate } = await probePackageUpdate(packageName, rc, { fetchJson: rc.deps.fetchJson })
    sendJson(res, 200, { ok: true, packageName, latest, next, beta, target: pickUpdateTarget({ latest, next, beta }), depsOutdated, error, source, migrate })
    return
}

async function routeFrameworkRollback(req, res, rc) {
  const webPort = rc.deps.webPort
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 一键回滚（2026-09-04 事故后的新能力）：读 framework-rollback.json（升级时写入），
    // 生成分离脚本：停服 → 全树恢复（.pnpm 自包镜像 + 顶层 scope + lock）→ 拉起 → 状态。
    // 宿主守卫（**本机 20:28 事故的真正凶手就是这条路径**：它没有 bin.js 预检，直接按端口 Stop-Process，
    // 杀掉 Electron 承载的 host 后 Invoke-DshRelaunch 找不到 bin.js → 外壳记 crash）：
    // 外壳托管时一律拒绝，绝不生成会杀 host 的脚本。
    if (refuseWhenShellHosted(res)) return
    let rec = null
    try { rec = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8')) } catch {}
    if (rec === null || typeof rec.checkpointDir !== 'string' || typeof rec.fwRoot !== 'string'
      || !existsSync(join(rec.checkpointDir, '.pnpm')) || !existsSync(join(rec.fwRoot, '.pnpm'))) {
      sendError(res, 409, '没有可用的框架全树回滚点（framework-rollback.json 缺失或 checkpoint 已清理）')
      return
    }
    if (refuseWhenPlatformUnsupported(res)) return // 平台守卫（改错）：回滚脚本同样是 schtasks+PowerShell，非 win32 一律拒绝而不是假成功（放在只读状态校验之后、任何写盘/exec 之前）
    const port = webPort(ctx)
    const nodePath = process.execPath
    const taskName = `DSH-FW-Rollback-${process.pid}`
    const ps1 = join(tmpdir(), `fw-rollback-${process.pid}.ps1`)
    const logFile = join(dshHome(), 'plugin-console', 'fw-upgrade.log')
    const stateFile = join(dshHome(), 'plugin-console', 'fw-upgrade-state.txt')
    const ps = (s) => JSON.stringify(s).replace(/\\\\/gu, '\\')
    try { writeFileSync(join(dshHome(), 'plugin-console', 'fw-launch.mjs'), relaunchLauncherSource(), 'utf8') } catch {} // 2026-10-28：回滚后的拉起也走 node 拉起器（与升级脚本共用同一份生成物）
    const lines = [
      `$state = ${ps(stateFile)}`,
      `$log = ${ps(logFile)}`,
      "function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }",
      "function SetState($s, $m) {",
      "  try { if ($s -eq 'failed') { Set-Content -Path $state -Value ($s + '|' + $m + '|stage=' + [string]$script:stage) -Encoding UTF8; return } } catch {}",
      "  try { if ($s -ne 'done' -and $s -ne 'idle') { $script:stage = $s }; Set-Content -Path $state -Value ($s + '|' + $m) -Encoding UTF8; Beat } catch {}",
      "}",
      relaunchPrelude({ nodePath, pluginDir: pluginRoot(), fwRoot: rec.fwRoot, target: rec.from ?? '', ps, port }),
      "trap {",
      "  try { SetState 'failed' ('回滚脚本异常终止：' + $_.Exception.Message) } catch {}",
      `  schtasks /delete /f /tn ${taskName} 2>$null`,
      "  exit 1",
      "}",
      "SetState 'rollback' '回滚到升级前版本…'",
      "Log '一键回滚脚本启动'",
      `try { $svc = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($svc) { $svc | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3 } } catch {}`,
      "Log '服务已停止（回滚生效）'",
      `$cp = ${ps(rec.checkpointDir)}`,
      `$restored = 0`,
      `$entries = Get-ChildItem -Path (Join-Path $cp '.pnpm') -Directory -ErrorAction SilentlyContinue`,
      `foreach ($e in $entries) {`,
      `  $name = @($e.Name -split '\\+')[1].Split('@')[0]`,
      `  $src = Join-Path $e.FullName ('node_modules\\@deepseek-ai\\' + $name)`,
      `  $dst = Join-Path (Join-Path ${ps(rec.fwRoot)} ('.pnpm\\' + $e.Name)) ('node_modules\\@deepseek-ai\\' + $name)`,
      `  if (Test-Path (Join-Path $src 'package.json')) { New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null; robocopy $src $dst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null; $restored++ }`,
      `}`,
      `$topSrc = Join-Path $cp 'top-@deepseek-ai'`,
      `if (Test-Path $topSrc) { Remove-Item ${ps(join(rec.fwRoot, '@deepseek-ai'))} -Recurse -Force -ErrorAction SilentlyContinue; robocopy $topSrc ${ps(join(rec.fwRoot, '@deepseek-ai'))} /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null }`,
      `try { Copy-Item (Join-Path $cp 'lock.yaml') ${ps(join(rec.fwRoot, '.pnpm', 'lock.yaml'))} -Force -ErrorAction SilentlyContinue } catch {}`,
      `Log ('全树回滚完成：恢复 ' + $restored + ' 个版本包 + 顶层 scope，拉起验证中…')`,
      `$ok = $false`,
      `$started = $false`,
      `for ($i = 0; $i -lt 20; $i++) {`,
      `  try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
      `  if (-not $ok -and -not $started) { $started = Note-Relaunch (Invoke-DshRelaunch '回滚后'); if ($script:relaunchListening) { $ok = $true; break } }; Beat`,
      `  Start-Sleep -Seconds 5`,
      `}`,
      `if ($ok) { SetState 'done' ('已回滚到升级前版本 ${rec.from ?? '?'}，服务正常') ; Log '回滚完成，服务已恢复' } else { SetState 'failed' ('回滚后服务拉起失败：' + [string]$script:relaunchReason + '；请手动运行 node ${resolveDshBin() ?? '<bin>'} web --no-open') ; Log ('回滚后拉起失败：' + [string]$script:relaunchReason) }`,
      `schtasks /delete /f /tn ${taskName} 2>$null`,
    ].filter((l) => l !== '').join('\r\n')
    try { writeFileSync(stateFile, 'rollback|回滚脚本已启动…', 'utf8') } catch {}
    setFwCheckCache(null)// 回滚后 [框架] 面板要立刻显示回滚到的版本
    writeFile(ps1, `\uFEFF${lines}`, 'utf8').then(
      () => {
        const ps1Posix = ps1.replace(/\\/gu, '/')
        const tr = / /.test(ps1Posix)
          ? `"powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"${ps1Posix}\\""`
          : `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${ps1Posix}`
        execFile('schtasks.exe', ['/create', '/f', '/tn', taskName, '/tr', tr, '/sc', 'once', '/st', '00:00'], { windowsHide: true }, (error) => {
          if (error) {
            execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
            return
          }
          setTimeout(() => {
            execFile('schtasks.exe', ['/run', '/tn', taskName], { windowsHide: true }, (runError) => {
              if (runError) {
                execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
              }
            })
          }, 800)
        })
      },
      () => {},
    )
    sendJson(res, 200, { ok: true, from: rec.from ?? null, checkpointDir: rec.checkpointDir })
    return
}

async function routeRestart(req, res, rc) {
    // 「重启服务」按钮 / 自更新成功后自动调 / 升级期间悬浮按钮，全部收进这一条：
    // domain/restart.js#restartPathDecision 是**唯一承担者**，本路由只负责把它翻成响应。
    //
    // 2026-10-10 改错（用户红线 + 现场取证）——旧实现在这里做了三件必须消失的事：
    //   ① `Stop-Process -Id <本进程>` 自杀脚本（桌面端托管时 = 杀掉 Electron 外壳的宿主子进程
    //      ⇒ 外壳 reportFatal(...,'host') ⇒ 弹「应用无法启动或已意外停止。」，Electron lib/main.js:6709）；
    //   ② 注册**每分钟跑一次**的 `DSH-RestartGuard-<pid>` 计划任务 —— 端口无监听就
    //      `Start-Process node <bin.js> web` 手动拉起（现场原文见 console-restart.log
    //      `[guard] 端口 3080 无监听，第 1..5 次拉起` / fw-relaunch.log `拉起(守护第 N 次): …`）；
    //   ③ 第 6 次 `schtasks /delete /f /tn DSH-RestartGuard-<pid>` **自删计划任务**（危险动作）。
    // 现在：官方路径优先（桌面端托管 ⇒ 让用户在客户端里重启）；官方通道不可用（独立 dsh web）
    // ⇒ 如实告知手动重启。两种情况都**零 spawn / 零 kill / 零计划任务 / 零自删**。
    //
    // 注：清僵尸计划任务的既有能力**保留**（cleanupStaleFwTasks 见 lib/index.js 接线），
    // 只是控制台自己再也不新建这类任务了。
    //
    // ★ 0.5.84（用户第 5 项，**只在非 shell 托管时**）：独立 dsh web 实例现在支持**真重启** ——
    //   detach 起一个新实例，老进程自己优雅退出。桌面端托管时判据照旧拒绝（那一半一个字没动）。
    //   判据仍在 domain/restart.js（唯一承担者）；这里只做三件事，顺序是刻意的：
    //     ① 先算重拉计划（拿不到 bin.js 就如实回落"手动重启"，不硬来）；
    //     ② 起启动器（detached，它自己等端口空了再起新实例 —— 于是没有 EADDRINUSE 竞态）；
    //     ③ **先回响应**，再让本进程退出（不 kill 自己、不建计划任务）。
    const hosted = hostedHere(rc)
    // `rc.deps.relaunch` 是单测的确定性注入口（与 rc.deps.hosted 同一风格）：
    // 传 `null` = 模拟"拿不到 bin.js"；不传 = 按真实解析（resolveDshBin + webPort）算。
    const relaunchPlan = hosted === true ? null : (rc.deps?.relaunch !== undefined ? rc.deps.relaunch : planRelaunch({
      binPath: resolveDshBinSafe(),
      // 与真机那条原始命令同形：`node <bin.js> web`；端口显式带上（自定义 --port 也能原样重启）
      args: (() => { const p = webPortHard(rc); return p === null ? ['web'] : ['web', '--port', String(p)] })(),
      port: webPortHard(rc),
      cwd: null,
    }))
    const decision = restartPathDecision({ hosted, intent: 'restart', relaunch: relaunchPlan })
    if (decision.spawns !== true) {
      sendError(res, decision.status, decision.message, decision.details)
      return
    }
    const kicked = await relaunchDetached(relaunchPlan.plan, { spawn: rc.deps?.spawnDetached })
    if (kicked.started !== true) {
      // 起不来就**如实说**，绝不让面板以为"重启了"（也不会退出本进程——那样用户就真的没有实例了）
      sendError(res, 500, `重启失败：没能拉起新进程（${kicked.error ?? '原因未知'}）。本进程仍在运行，请手动重启。`, {
        code: 'standalone-relaunch-failed', channel: decision.channel, spawns: false, kill: false, scheduledTask: false, selfDelete: false,
      })
      return
    }
    sendJson(res, 200, { ok: true, restarted: true, channel: decision.channel, pid: kicked.pid, message: decision.message, details: decision.details })
    // ★ 先回响应、再退（"优雅退出"）：让端口随本进程结束而释放；启动器在那之后才起新实例。
    //   延时是给响应刷出去的时间；delayedExit 可注入（单测绝不真的退出进程）。
    const exit = typeof rc.deps?.delayedExit === 'function' ? rc.deps.delayedExit : defaultGracefulExit
    exit(500)
    return
}

/** 清掉「最近一次升级/回滚记录」（2026-09-25 用户要求）：记录常驻是设计，但用户要能一键关掉。
 *  只删状态文件与心跳（不动日志，日志仍可在 ~/.dsh/plugin-console 里查）。
 *  2026-10-11 改错：删除失败**如实上报**（500 + 每个文件的原因 + removed/failed 明细），
 *  不再像旧实现那样吞掉异常还回 ok:true —— 静默失败一律不许（见函数内注释与
 *  tests/test-framework-status-clear.mjs 的正控/负控）。 */
/** 删文件失败时给用户看的一句话原因（code + 系统原文，便于判因）。 */
function explainRemoveError(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'UNKNOWN'
  const text = (error instanceof Error ? error.message : String(error ?? '')).split('\n')[0].trim()
  return text === '' ? code : `${code}: ${text}`
}

/** 删除时文件已不在 = 目标达成（不计失败）；其余错误一律算失败。 */
function removeTargetGone(error) {
  return error?.code === 'ENOENT'
}

async function routeFrameworkStatusClear(req, res, rc) {
  const dir = join(dshHome(), 'plugin-console')
  const state = join(dir, 'fw-upgrade-state.txt')
  const io = rc.deps?.fs ?? { existsSync, rmSync } // 注入缝：负控要能造出真实的删除失败
  const removed = []
  const failed = []
  for (const f of [state, `${state}.hb`]) {
    let present = false
    try { present = io.existsSync(f) === true } catch (error) { failed.push({ file: basename(f), reason: explainRemoveError(error) }); continue }
    if (!present) continue
    try {
      io.rmSync(f, { force: true })
      removed.push(basename(f))
    } catch (error) {
      // 2026-10-11 改错：这里原来是 `catch {}` + 无条件 ok:true —— 静默失败。
      // 先前的真实现状更糟：rmSync/basename 没 import ⇒ 每轮都抛 ReferenceError、被空 catch 吞掉，
      // 路由照样回 200 {"ok":true,"removed":[]}，标记文件一个都没删（用户以为清掉了）。
      // 判据（用户红线）：宁可红，也不报假的绿 —— 删除失败必须如实上报原因。
      if (removeTargetGone(error)) { removed.push(basename(f)); continue }
      failed.push({ file: basename(f), reason: explainRemoveError(error) })
    }
  }
  if (failed.length > 0) {
    // 如实上报：500 + 每个文件的原因 + 与成功路径同形的 removed/status 字段（客户端不必猜）。
    sendJson(res, 500, {
      ok: false,
      error: `清除升级记录失败：${failed.map((x) => `${x.file}（${x.reason}）`).join('、')}`,
      removed,
      failed,
      status: 'clear-failed',
      message: null,
    })
    return
  }
  sendJson(res, 200, { ok: true, removed, failed, status: 'idle', message: null })
}
export { refuseWhenShellHosted, refuseWhenPlatformUnsupported, routeFrameworkStatusClear, routeFrameworkUpgradeStatusGet, routeFrameworkRelaunch, routeFrameworkCheck, routeCompatGate, routeCheckUpdate, routeFrameworkRollback, routeRestart, probePackageUpdate }
