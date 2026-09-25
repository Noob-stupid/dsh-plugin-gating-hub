// L2 · routes —— 框架（/framework-check · /check-update · /framework-upgrade · /framework-rollback · /framework-upgrade-status · /framework-relaunch · /compat-gate · /restart）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readCompatGate, writeCompatGate } from '../domain/compat.js'
import { cleanupStaleFwTasks, currentFrameworkVersion, pickFrameworkTarget, relaunchPrelude, resolveDshBin, resolveFrameworkRootNodeModules } from '../domain/framework.js'
import { readGithubAuth } from '../domain/install.js'
import { webPort } from '../domain/runtime.js'
import { fetchJsonUrl } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome, entryPkgMeta, findPatchPath, packageNameOf, pluginRoot, profileDirOf, resolvePackageJson } from '../infra/paths.js'
import { isFrameworkVersionNewer, semverRangeMatchLoose, frameworkUpgradeCandidates } from '../infra/semver.js'
import { fwCheckCache, setFwCheckCache } from '../state.js'

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
        const terminal = status.status === 'idle' || status.status === 'done' || status.status === 'failed'
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
        if (status.status !== 'idle' && status.status !== 'done' && status.status !== 'failed'
          && Date.now() - at > 15 * 60 * 1000) {
          try { writeFileSync(f, 'idle|', 'utf8') } catch {}
          status = { status: 'idle', message: null, at: Date.now() }
        }
      }
    } catch {}
    sendJson(res, 200, { ok: true, ...status })
    return
}

async function routeFrameworkRelaunch(req, res, rc) {
  const webPort = rc.deps.webPort
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
    // 手动拉起服务（升级期间左侧悬浮按钮调用）：Start-Process node bin.js web。
    // 端口已有监听则不重复拉起；bin.js 缺失时明确报错。
    const port = webPort(ctx)
    const binPath = resolveDshBin()
    const nodePath = process.execPath
    if (binPath === null || !existsSync(binPath)) {
      sendError(res, 500, '无法定位 DSH 启动入口（bin.js 缺失）')
      return
    }
    try {
      const ps1 = join(tmpdir(), `console-relaunch-${Date.now()}.ps1`)
      const lines = [
        '$ok = $false',
        `try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true } } catch {}`,
        `if (-not $ok) { Start-Process -FilePath ${JSON.stringify(nodePath)} -ArgumentList ${JSON.stringify(binPath)},'web' -WindowStyle Hidden }`,
      ]
      writeFile(ps1, lines.join('\r\n'), 'utf8').then(
        () => execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true }, () => {}),
        () => {},
      )
      sendJson(res, 200, { ok: true, message: '已发起手动拉起（端口无监听时自动启动服务）' })
    } catch (error) {
      sendError(res, 500, `拉起失败：${error instanceof Error ? error.message : String(error)}`)
    }
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

async function routeCheckUpdate(req, res, rc) {
  const currentFrameworkVersion = rc.deps.currentFrameworkVersion
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 检测已安装插件是否有新版本：curl registry 元数据取 dist-tags.latest（node 网络黑洞时 curl 可用）。
    // 聚合包（有 dependencies）额外对比子包版本：声明版本 vs 本地 node_modules 实际版本，
    // 返回 depsOutdated 提示"更新本包需同步子包"，避免半更新混搭导致启动冲突。
    const packageName = packageNameOf(typeof body.packageName === 'string' ? body.packageName.trim() : '')
    if (!packageName) {
      sendError(res, 400, 'packageName 不能为空')
      return
    }
    let latest = null
    let next = null
    let beta = null
    let depsOutdated = []
    let error = null
    let source = 'npm'
    try {
      const encoded = packageName.startsWith('@')
        ? `@${encodeURIComponent(packageName.slice(1).split('/')[0])}%2f${encodeURIComponent(packageName.split('/').slice(1).join('/'))}`
        : encodeURIComponent(packageName)
      const data = await fetchJsonUrl(`https://registry.npmmirror.com/${encoded}`)
      latest = data?.['dist-tags']?.latest ?? null
      next = data?.['dist-tags']?.next ?? null
      beta = data?.['dist-tags']?.beta ?? null
      if (latest === null) throw new Error(`registry 无 dist-tags.latest（${packageName}）`)
      // 子包配套检查：最新版声明依赖 vs 本地实际版本
      const patchPath = findPatchPath(ctx)
      const profileDir = dirname(patchPath)
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
            const release = await fetchJsonUrl(`https://api.github.com/repos/${m[1]}/releases/latest`, 12000, headers)
            if (typeof release?.tag_name === 'string') tag = release.tag_name
          } catch {}
          // 通道 2：jsDelivr 版本列表（GitHub 直连黑洞时可用；取最高版本号）
          if (tag === null) {
            try {
              const data = await fetchJsonUrl(`https://data.jsdelivr.com/v1/packages/gh/${m[1]}`, 12000)
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
        const meta = await fetchJsonUrl(`https://registry.npmmirror.com/${encTo}`)
        const toLatest = meta?.['dist-tags']?.latest ?? meta?.['dist-tags']?.next ?? null
        const toPkg = toLatest !== null ? (meta?.versions?.[toLatest] ?? null) : null
        const engine = toPkg?.dsh?.engines?.dsh ?? toPkg?.engines?.dsh ?? null
        const fwVer = currentFrameworkVersion(ctx)
        const compatible = fwVer !== null && (engine === null || semverRangeMatchLoose(fwVer, engine))
        migrate = { to, latest: toLatest, engine, compatible }
      }
      }
    } catch {}
    sendJson(res, 200, { ok: true, packageName, latest, next, beta, depsOutdated, error, source, migrate })
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
    let rec = null
    try { rec = JSON.parse(readFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), 'utf8')) } catch {}
    if (rec === null || typeof rec.checkpointDir !== 'string' || typeof rec.fwRoot !== 'string'
      || !existsSync(join(rec.checkpointDir, '.pnpm')) || !existsSync(join(rec.fwRoot, '.pnpm'))) {
      sendError(res, 409, '没有可用的框架全树回滚点（framework-rollback.json 缺失或 checkpoint 已清理）')
      return
    }
    const port = webPort(ctx)
    const nodePath = process.execPath
    const taskName = `DSH-FW-Rollback-${process.pid}`
    const ps1 = join(tmpdir(), `fw-rollback-${process.pid}.ps1`)
    const logFile = join(dshHome(), 'plugin-console', 'fw-upgrade.log')
    const stateFile = join(dshHome(), 'plugin-console', 'fw-upgrade-state.txt')
    const ps = (s) => JSON.stringify(s).replace(/\\\\/gu, '\\')
    const lines = [
      `$state = ${ps(stateFile)}`,
      `$log = ${ps(logFile)}`,
      "function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }",
      "function SetState($s, $m) {",
      "  try { if ($s -eq 'failed') { Set-Content -Path $state -Value ($s + '|' + $m + '|stage=' + [string]$script:stage) -Encoding UTF8; return } } catch {}",
      "  try { if ($s -ne 'done' -and $s -ne 'idle') { $script:stage = $s }; Set-Content -Path $state -Value ($s + '|' + $m) -Encoding UTF8; Beat } catch {}",
      "}",
      relaunchPrelude({ nodePath, pluginDir: pluginRoot(), fwRoot: rec.fwRoot, target: rec.from ?? '', ps }),
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
      `  if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '回滚后') { $started = $true } }; Beat`,
      `  Start-Sleep -Seconds 5`,
      `}`,
      `if ($ok) { SetState 'done' ('已回滚到升级前版本 ${rec.from ?? '?'}，服务正常') ; Log '回滚完成，服务已恢复' } else { SetState 'failed' '回滚后服务拉起失败：请手动运行 node ${resolveDshBin() ?? '<bin>'} web' ; Log '回滚后拉起失败' }`,
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
  const webPort = rc.deps.webPort
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 自带守护的自杀式重启：分离脚本杀掉本进程后，若端口无人监听则自动拉起服务。
    // 不再依赖桌面端监督器（它并不总是会重启服务，曾导致用户需要重启电脑）。
    // 安全护栏（事故教训）：无法定位 dsh bin 或 bin.js 不存在时**拒绝重启**——
    // 避免"kill 后拉不起"（框架缓存损坏时常见），提示先修复框架安装。
    //
    // v0.3.43 事故修复（2026-09-11 用户实测「重启后服务没自己拉起来，只能手动重启」）：
    // 现场证据＝一堆 Ready 僵尸任务（DSH-Restart-13804 / -31688 / -3744 / V2 / V3），
    // 说明脚本杀完服务后**自己也被结束了**（与升级/回滚脚本同一个毛病：0xC000013A），
    // 于是"检查端口→拉起"那几行根本没跑到；而且原来只等 3 秒、只查一次端口。
    // 现在改成三层保险：
    //   ① 主脚本：等到端口真正空出来（最多 20 秒轮询）→ 拉起 → 重试 3 次 → 写 console-restart.log
    //   ② **守护任务**（关键）：主脚本动手**之前**就注册一个每分钟跑一次的独立计划任务，
    //      服务被杀、主脚本被杀都不影响它；端口起来了它自删，起不来就继续拉（最多 5 次）
    //   ③ bin 解析用与升级/回滚同一套多级回退（node resolve → .pnpm → 顶层链接）
    const port = webPort(ctx)
    const binPath = resolveDshBin()
    const nodePath = process.execPath
    if (binPath === null || !existsSync(binPath)) {
      sendError(res, 500, `无法定位 DSH 启动入口（bin.js${binPath !== null ? `：${binPath}` : ''}），已取消重启——框架安装可能已损坏，请先修复 @deepseek-ai/dsh 后再重启`)
      return
    }
    if (process.platform === 'win32') {
      const consoleDir = join(dshHome(), 'plugin-console')
      try { mkdirSync(consoleDir, { recursive: true }) } catch {}
      const restartLog = join(consoleDir, 'console-restart.log')
      const fwRoot = resolveFrameworkRootNodeModules(dirname(dirname(binPath)))
      let installedVersion = ''
      try { installedVersion = JSON.parse(readFileSync(join(dirname(dirname(binPath)), 'package.json'), 'utf8')).version ?? '' } catch {}
      const ps = (s) => {
        const j = JSON.stringify(String(s)).replace(/\\\\/gu, '\\')
        if (j === '""') return "''"
        return j.replace(/`/gu, '``').replace(/\$/gu, '`$')
      }
      const prelude = relaunchPrelude({ nodePath, pluginDir: pluginRoot(), fwRoot: fwRoot ?? dirname(dirname(binPath)), target: installedVersion, ps })
      const taskName = `DSH-Restart-${process.pid}`
      const guardName = `DSH-RestartGuard-${process.pid}`
      const guardCount = join(consoleDir, `restart-guard-${process.pid}.count`)
      const killLine = `Stop-Process -Id ${process.pid} -Force -ErrorAction SilentlyContinue`
      // ① 主脚本：等端口空 → 拉起（重试 3 次）
      const mainLines = [
        `$log = ${ps(restartLog)}`,
        `$state = ${ps(join(consoleDir, 'fw-upgrade-state.txt'))}`,
        `function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }`,
        prelude,
        `Log ('重启脚本启动：目标端口 ${port}，bin=' + ${ps(binPath)})`,
        killLine,
        // 等到端口真正空出来（原实现只 sleep 3 秒、只查一次 —— 端口还占着就误判"已有人监听"而跳过拉起）
        `$free = $false`,
        `for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 1; try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if (-not $c -or $c.Count -eq 0) { $free = $true; break } } catch { $free = $true; break } }`,
        `Log ('端口 ' + ${ps(String(port))} + ' 状态：' + $(if ($free) { '已释放' } else { '仍被占用（可能被其它实例占着）' }))`,
        `$up = $false`,
        `for ($a = 1; $a -le 3; $a++) {`,
        `  [void](Invoke-DshRelaunch ('重启第 ' + $a + ' 次'))`,
        `  for ($w = 0; $w -lt 8; $w++) { Start-Sleep -Seconds 2; try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c -and $c.Count -gt 0) { $up = $true; break } } catch {} }; if ($up) { break }`,
        `}`,
        `if ($up) { Log '服务已重新监听，重启完成' } else { Log '三次拉起后端口仍未监听：守护任务会继续尝试（输出见 fw-relaunch.log）' }`,
        `schtasks /delete /f /tn ${taskName} 2>$null`,
      ]
      // ② 守护任务：独立于主脚本与服务进程，端口不起来就一直拉（最多 5 次）
      const guardLines = [
        `$log = ${ps(restartLog)}`,
        `$state = ${ps(join(consoleDir, 'fw-upgrade-state.txt'))}`,
        `function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' [guard] ' + $m) -Encoding UTF8 } catch {} }`,
        prelude,
        `$c = $null`,
        `try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue } catch {}`,
        `if ($c -and $c.Count -gt 0) { Log '服务已在监听，守护任务收工'; Remove-Item ${ps(guardCount)} -Force -ErrorAction SilentlyContinue; schtasks /delete /f /tn ${guardName} 2>$null; schtasks /delete /f /tn ${taskName} 2>$null; exit 0 }`,
        `$n = 0`,
        `try { $n = [int](Get-Content ${ps(guardCount)} -Raw -ErrorAction SilentlyContinue) } catch { $n = 0 }`,
        `$n = $n + 1`,
        `if ($n -gt 5) { Log ('已尝试 ' + ($n - 1) + ' 次仍拉不起来，放弃并自删（请手动启动，或看 fw-relaunch.log / console-restart.log）'); schtasks /delete /f /tn ${guardName} 2>$null; exit 0 }`,
        `try { Set-Content -Path ${ps(guardCount)} -Value ([string]$n) -Encoding UTF8 } catch {}`,
        `Log ('端口 ' + ${ps(String(port))} + ' 无监听，第 ' + $n + ' 次拉起')`,
        `[void](Invoke-DshRelaunch ('守护第 ' + $n + ' 次'))`,
      ]
      const ps1 = join(tmpdir(), `console-restart-${process.pid}.ps1`)
      const guardPs1 = join(tmpdir(), `console-restart-guard-${process.pid}.ps1`)
      const scheduleFor = (file, name, scheduleArgs) => {
        const posix = String(file).replace(/\\/gu, '/')
        // 无引号 /tr（重要）：Task Scheduler 对带引号命令的解析会把 Command 拆坏成
        // `"powershell ... -File \"`（非有效可执行文件）——任务显示 Ready、/run 报 SUCCESS
        // 但永不执行（曾导致升级/重启脚本反复"已启动"却不动作、服务不停止）。实测无引号
        // 格式（exe 与脚本路径均无空格时）任务正常执行、脚本完整跑通。仅当脚本路径含空格
        // 时才退回带引号格式（schtasks 引号解析在服务 execFile 上下文不可靠，此时宁可用它）。
        const tr = / /.test(posix)
          ? `"powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"${posix}\\""`
          : `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${posix}`
        return new Promise((resolve) => {
          execFile('schtasks.exe', ['/create', '/f', '/tn', name, '/tr', tr, ...scheduleArgs], { windowsHide: true }, (error) => resolve(error ?? null))
        })
      }
      Promise.all([
        writeFile(ps1, `\uFEFF${mainLines.join('\r\n')}`, 'utf8'),
        writeFile(guardPs1, `\uFEFF${guardLines.join('\r\n')}`, 'utf8'),
      ]).then(
        async () => {
          // 守护任务先注册（每分钟一次，独立于服务进程树）——主脚本被杀也有它兜底
          const guardError = await scheduleFor(guardPs1, guardName, ['/sc', 'minute', '/mo', '1'])
          const mainError = await scheduleFor(ps1, taskName, ['/sc', 'once', '/st', '00:00'])
          if (mainError !== null) {
            // schtasks 不可用：退回 detached 直接执行主脚本（守护任务仍可能已建）
            execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
            return
          }
          execFile('schtasks.exe', ['/run', '/tn', taskName], { windowsHide: true }, () => {})
          if (guardError !== null) {
            try { writeFileSync(restartLog, `[warn] 守护任务注册失败（${guardError.message}），仅靠主脚本重启\n`, { flag: 'a' }) } catch {}
          }
        },
        () => {},
      )
    } else {
      const script = process.platform === 'win32'
        ? `Start-Sleep -Seconds 2; Stop-Process -Id ${process.pid} -Force`
        : `sleep 2; kill -9 ${process.pid}`
      const cmd = process.platform === 'win32' ? 'powershell.exe' : 'sh'
      const args = process.platform === 'win32'
        ? ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script]
        : ['-c', script]
      execFile(cmd, args, { windowsHide: true }, () => {})
    }
    sendJson(res, 200, { ok: true, message: `正在重启 DSH 服务（自带守护，端口 ${port} 无监听会自动拉起），页面稍后自动恢复` })
    return
}

/** 清掉「最近一次升级/回滚记录」（2026-09-25 用户要求）：记录常驻是设计，但用户要能一键关掉。
 *  只删状态文件与心跳（不动日志，日志仍可在 ~/.dsh/plugin-console 里查）。 */
async function routeFrameworkStatusClear(req, res, rc) {
  const dir = join(dshHome(), 'plugin-console')
  const state = join(dir, 'fw-upgrade-state.txt')
  const removed = []
  for (const f of [state, `${state}.hb`]) {
    try { if (existsSync(f)) { rmSync(f, { force: true }); removed.push(basename(f)) } } catch {}
  }
  sendJson(res, 200, { ok: true, removed, status: 'idle', message: null })
}
export { routeFrameworkStatusClear, routeFrameworkUpgradeStatusGet, routeFrameworkRelaunch, routeFrameworkCheck, routeCompatGate, routeCheckUpdate, routeFrameworkRollback, routeRestart }
