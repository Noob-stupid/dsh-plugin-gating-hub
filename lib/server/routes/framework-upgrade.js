// L2 · routes —— 框架升级（POST /framework-upgrade）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑）。
// 注：这个 handler 661 行（内置大段 PowerShell 脚本模板），是守卫「单文件 ≤ 600 行」的受限例外（见守卫 SIZE_EXCEPTIONS）；
// 待抽包阶段把脚本模板挪进 domain/framework-script.js 后撤销例外。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { readCompatMode, writeCompatMode } from '../domain/compat-state.js'
import { FRAMEWORK_BACKUP_ROOT, backupProfileSnapshot, checkpointFrameworkTree, preflightDisableIncompatible, relaunchPrelude, resolveDshBin, resolveFrameworkRootNodeModules, resolveFrameworkUpgradePlan, shellHostedRefusal } from '../domain/framework.js'
import { fwIntegrityCheck } from '../infra/fw-integrity-check.js'
import { CORE_PATCH_ROW_IDS } from '../domain/patch.js'
import { migrateAgentConfigsForUpgrade } from '../domain/presets.js'
import { planQuarantine } from '../domain/quarantine.js'
import { listEntries, webPort } from '../domain/runtime.js'
import { copyTree } from '../infra/fsx.js'
import { fetchJsonUrl } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome, findPatchPath, pluginRoot } from '../infra/paths.js'
import { setFwCheckCache } from '../state.js'

/**
 * 用户语义（2026-09-24）：「运行模式」默认开启 = **观察者**（只守门、不接管升级）；
 * 但只要有人走了本控制台这条框架升级路径，就**自动切回托管** —— 此时升级确实由我们负责。
 * 返回提示文案（无切换时返回 null）。
 */
function autoSwitchToManaged(reason) {
  try {
    if (readCompatMode().mode === 'managed') return null
    writeCompatMode('managed', { reason })
    return '检测到使用本控制台的框架升级：运行模式已自动切回「托管」'
  } catch {
    return null
  }
}

async function routeFrameworkUpgrade(req, res, rc) {
  const backupProfileSnapshot = rc.deps.backupProfileSnapshot
  const preflightDisableIncompatible = rc.deps.preflightDisableIncompatible
  const webPort = rc.deps.webPort
  const listEntries = rc.deps.listEntries
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 框架升级入口：一键流程 = 备份配置快照 + 备份框架本体（回滚点）+ 自动升级
    // （npx 缓存 dsh 本体 + profile 官方配套包）+ 失败自动回滚 + 重启提示。
    // 升级完成重启后，框架适配逻辑自动：备份新版本快照 + 重打框架补丁 + 版本提示。
    const refusal = shellHostedRefusal(); if (refusal !== null) { sendError(res, 409, refusal.error, refusal.details); return } // 宿主守卫：本路由的「升级后重启」步骤含 Stop-Process + Invoke-DshRelaunch，外壳托管（桌面端 Electron 承载）时禁止生成该脚本——判据见 domain/framework.js#detectHostShape
    let current = null
    let dshDir = null
    // 面板自报名（自报名一致性校验用）：从插件自身 package.json 读，与部署目录比对
    let selfName = null
    try {
      // 面板自报名（自报名一致性校验用）：从插件自身 package.json 读，与部署目录比对
      // （Step 1 顺带修正：原来这里写的是 lib/package.json —— 恒抛错被 catch 吞掉，
      //   selfName 一直是 null，生成脚本时只能退回 hardcode 兜底；现在走真实包根）
      const selfPkg = JSON.parse(readFileSync(join(pluginRoot(), 'package.json'), 'utf8'))
      selfName = typeof selfPkg.name === 'string' ? selfPkg.name : null
    } catch {}
    try {
      const require = createRequire(ctx.baseUrl ?? 'file:///')
      const dshPkgPath = require.resolve('@deepseek-ai/dsh/package.json')
      const dshPkg = JSON.parse(readFileSync(dshPkgPath, 'utf8'))
      current = dshPkg.version ?? null
      dshDir = dirname(dshPkgPath) // .../node_modules/@deepseek-ai/dsh
    } catch {
      // 兜底：ctx.baseUrl 不可用时从插件自身目录解析（与 resolveDshBin 同源）
      try {
        const requireLocal = createRequire(join(pluginRoot(), 'package.json'))
        const dshPkgPath = requireLocal.resolve('@deepseek-ai/dsh/package.json')
        const dshPkg = JSON.parse(readFileSync(dshPkgPath, 'utf8'))
        current = dshPkg.version ?? null
        dshDir = dirname(dshPkgPath)
      } catch {}
    }
    // 拉元数据 → 候选版本列表 → 本次目标（helper 里同时做「用户自选版本」的白名单校验）
    const plan = await resolveFrameworkUpgradePlan({ current, wanted: body.version, fetchJson: fetchJsonUrl })
    const { latest, next, alpha, versions, tagDefault, registryError } = plan
    if (plan.rejected !== null) {
      sendError(res, 400, `升级目标 ${plan.rejected} 不在可选列表内（只接受比当前 ${current ?? '?'} 更新的已发布版本；降级请用「回滚到上一版」）`)
      return
    }
    const target = plan.target
    const profileDir = dirname(findPatchPath(ctx))
    // 1) 升级前打包备份现有配置（patch / profile package.json / 插件清单）
    let backupDir = null
    try {
      if (current !== null) backupDir = backupProfileSnapshot(profileDir, current, ctx)
    } catch {}
    const hasUpdate = target !== null
    const steps = []
    let upgraded = false
    // 1.5) 预设/config 迁移门禁（写在生成升级脚本之前）：框架新版不再接受的旧字段
    //（如 0.1.5 的 persona.text → prefix）会让升级后**预设挂载失败、服务起不来**——
    // 适配门只扫插件包，扫不到预设；这里就地改名并留 .bak，避免整次升级被一个字段搞死。
    let configMigrations = []
    if (hasUpdate) {
      try {
        configMigrations = migrateAgentConfigsForUpgrade(profileDir, target)
      } catch (error) {
        steps.push(`预设配置迁移检查失败：${error instanceof Error ? error.message : String(error)}`)
      }
      for (const m of configMigrations) {
        steps.push(`预设字段迁移：${m.file} 第 ${m.line} 行 ${m.from} → ${m.to}（${m.pkg}，已留 .bak 备份）`)
      }
      if (configMigrations.length > 0) {
        steps.push(`自动迁移了 ${configMigrations.length} 处框架新版不再接受的预设字段（不迁移会让升级后预设挂载失败、服务拉不起来）`)
      }
    }
    // 1.6) 不适配行预禁用（用户硬要求：「更新框架后所有不适配的必须先禁用」）。
    // 适配门此前只有「执行侧」（读清单→锁启用→更新后解锁），**检测侧从未实现**：
    // 那份 compat-pending.json 一直是人工/一次性脚本产出的（v0.3.25 起遗留至今）。
    // 这里补上检测侧：升级脚本执行**前**扫描全部可开关行，判定 fail 的就地禁用 + 记入清单，
    // 保证新框架 boot 时不会被某行 import 失败拖垮（loader 单行失败 = 整个服务起不来）。
    let preflight = { disabled: [], skipped: [] }
    if (hasUpdate) {
      // 用户语义（2026-09-24）：走本控制台这条升级路径 = 升级由我们负责 → 自动从观察者切回托管
      const switched = autoSwitchToManaged('使用本控制台执行框架升级')
      if (switched !== null) steps.push(switched)
      try {
        preflight = await preflightDisableIncompatible({ ports: ctx, profileDir, patchPath: findPatchPath(ctx), targetVersion: target })
      } catch (error) {
        steps.push(`不适配行预禁用失败（不阻塞升级，改由启动失败隔离兜底）：${error instanceof Error ? error.message : String(error)}`)
      }
      for (const row of preflight.disabled) {
        steps.push(`已预先禁用不适配行：${row.rowId}（${row.moduleName}@${row.version ?? '?'}）— ${row.reason ?? '判定不兼容目标框架'}`)
      }
      if (preflight.disabled.length > 0) {
        steps.push(`共预先禁用 ${preflight.disabled.length} 行：新框架启动不会再被它们拖垮；等它们发布适配版本后点「更新并适配」即可解锁`)
      }
      if (preflight.skipped.length > 0) {
        steps.push(`另有 ${preflight.skipped.length} 行无法预判（受保护行/包信息读不到），保持启用，由升级后的启动失败隔离兜底`)
      }
    }
    // 2) 自动升级框架：运行中的服务锁着 dsh/lib 目录（EBUSY 无法原地替换），
    //    因此生成独立升级脚本（kill 服务 → npm 升级 → 失败回滚 → 拉起服务），后台执行。
    //    与 /restart 同款自守护模式：端口无监听会自动拉起，不会留下"服务起不来"。
    if (hasUpdate && dshDir !== null) {
      const port = webPort(ctx)
      const nodePath = process.execPath
      const binPath = resolveDshBin()
      const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      // 事故教训：npm 的 lib/cli.js 是「函数模块」（module.exports = (process) => validateEngines(...)），
      // 直跑 `node lib/cli.js` 只加载函数定义、不执行命令——立即退出 exit 0（假成功，曾导致
      // "npm 退出码 0 但版本未更新"）。唯一正确入口是 bin/npm-cli.js（它调用 cli.js 函数）。
      const corepackJs = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js')
      // 预检（事故教训）：corepack（pnpm 通道）/ dsh bin.js 缺失时**拒绝生成升级脚本**（不 kill 服务）——
      // 避免"kill 后升级/拉起双双失败，服务永久 down"
      if (!existsSync(corepackJs) || binPath === null || !existsSync(binPath)) {
        steps.push(`升级已取消：无法定位 ${!existsSync(corepackJs) ? 'corepack（pnpm 通道）' : 'dsh bin.js'}（框架安装可能不完整），服务保持运行；请先修复框架再升级`)
        sendJson(res, 200, { ok: true, current, latest, next, target, hasUpdate, upgraded: false, backupDir, configMigrations, preflight, steps, hints: steps })
        return
      }
      const profileDir2 = profileDir
      // 官方配套包列表（profile package.json 里的 @deepseek-ai/* 依赖）
      let officialList = ''
      try {
        const profilePkg = JSON.parse(readFileSync(join(profileDir2, 'package.json'), 'utf8'))
        const deps = { ...(profilePkg.dependencies ?? {}), ...(profilePkg.devDependencies ?? {}) }
        officialList = Object.keys(deps).filter((d) => d.startsWith('@deepseek-ai/')).join(' ')
      } catch {}
      const rollbackDir = backupDir !== null ? join(backupDir, 'dsh-package-backup') : null
      // 官方配套包参数（Start-Process ArgumentList 需要逐包独立元素；包名无空格，单引号安全）
      const pkgArgs = officialList !== '' ? officialList.split(' ').map((p) => `'${p}'`) : []
      const taskName = `DSH-FW-Upgrade-${process.pid}`
      // 备份 dsh 目录（回滚点）
      try {
        if (rollbackDir !== null) {
          mkdirSync(rollbackDir, { recursive: true })
          copyTree(dshDir, rollbackDir)
        }
      } catch {}
      // 安全护栏（事故教训）：回滚点必须真实有效（含 lib/bin.js），否则升级失败时无副本可恢复
      // ——曾因备份缺失导致回滚后框架目录为空、服务无法重启。备份无效直接取消升级。
      if (rollbackDir === null || !existsSync(join(rollbackDir, 'lib', 'bin.js'))) {
        sendError(res, 500, `框架备份失败（回滚点${rollbackDir !== null ? `：${rollbackDir}` : '（无）'}缺失或无效），已取消升级——请检查磁盘空间/权限后重试`)
        return
      }
      // 框架安装根识别（事故教训 2026-09-04）：require.resolve 返回 .pnpm 内部 realpath，
      // 旧逻辑 dirname(dirname(dshDir)) 指向 .pnpm/<entry>/node_modules——「重链跳过：.pnpm 目录不存在」、
      // 依赖修复 0 个，pnpm 还在错误 cwd 里把新 CLI 原位覆盖进旧 .pnpm 目录，旧树就此被毁。
      const fwRoot = resolveFrameworkRootNodeModules(dshDir)
      if (fwRoot === null || !existsSync(join(fwRoot, '.pnpm')) || !existsSync(join(fwRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
        sendError(res, 500, `无法定位框架安装根（期望含 .pnpm 与 @deepseek-ai/dsh 的顶层 node_modules，实际：${fwRoot ?? '未找到'}）——已取消升级，请修复框架安装后重试`)
        return
      }
      // 框架全树 checkpoint（可靠回滚点）：升级前镜像全部 @deepseek-ai 版本包（自包内容）+ 顶层 scope + lock
      let fwCheckpoint = null
      try {
        const cpRoot = backupDir !== null ? backupDir : join(FRAMEWORK_BACKUP_ROOT(), current ?? 'unknown')
        fwCheckpoint = checkpointFrameworkTree(fwRoot, cpRoot)
        steps.push(`框架全树 checkpoint 完成：${fwCheckpoint.dest}（镜像 ${fwCheckpoint.mirrored} 个 @deepseek-ai 版本包；升级失败/拉起失败会自动全树回滚，也可用框架卡片的「回滚到上一版」一键回滚）`)
      } catch (error) {
        steps.push(`框架全树 checkpoint 失败：${error instanceof Error ? error.message : String(error)}（回滚点降级为 CLI 备份）`)
      }
      // 一键回滚记录：框架卡片「回滚到上一版」按钮读取
      try {
        writeFileSync(join(dshHome(), 'plugin-console', 'framework-rollback.json'), JSON.stringify({ from: current, to: target, checkpointDir: fwCheckpoint?.dest ?? null, cliBackupDir: rollbackDir, fwRoot, at: Date.now() }, null, 2), 'utf8')
      } catch {}
      const ps1 = join(tmpdir(), `fw-upgrade-${process.pid}.ps1`)
      const logFile = join(dshHome(), 'plugin-console', 'fw-upgrade.log')
      const stateFile = join(dshHome(), 'plugin-console', 'fw-upgrade-state.txt')
      // 启动失败隔离所需的两个文件（升级脚本在服务起不来时调用）：
      // ① 分析器：直接 import 本插件的 planQuarantine，避免把判断逻辑再写一份到 PowerShell；
      // ② 候选行快照：升级发起时的可开关行（决策器据此把日志里的模块名映射回行 id）。
      const qHelperPath = join(dshHome(), 'plugin-console', 'fw-analyze-boot.mjs')
      const qCandidatesPath = join(dshHome(), 'plugin-console', 'fw-quarantine-candidates.json')
      const qRecordPath = join(dshHome(), 'plugin-console', 'fw-quarantine.json')
      let thirdPartyRows = []
      try {
        thirdPartyRows = listEntries(ctx)
          .filter((e) => e.enabled && e.toggleable && e.rowId !== 'plugin-console'
            && !CORE_PATCH_ROW_IDS.has(e.rowId)
            && typeof e.moduleName === 'string' && !e.moduleName.startsWith('@deepseek-ai/'))
          .map((e) => e.rowId)
      } catch {}
      try {
        const selfLibUrl = pathToFileURL(join(pluginRoot(), 'lib', 'index.js')).href
        const helperSource = [
          '// 自动生成：启动失败隔离分析器（升级脚本在服务起不来时调用；逻辑在插件内，本文件只做转发）',
          `import { planQuarantine } from ${JSON.stringify(selfLibUrl)}`,
          "import { readFileSync } from 'node:fs'",
          'const [logPath, candPath] = process.argv.slice(2)',
          "let logText = ''",
          "try { logText = readFileSync(logPath, 'utf8').split(/\\r?\\n/u).slice(-400).join('\\n') } catch {}",
          'let candidates = []',
          'try { candidates = JSON.parse(readFileSync(candPath, "utf8")) } catch {}',
          'try { process.stdout.write(JSON.stringify(planQuarantine({ logText, candidates }))) } catch (error) { process.stdout.write(JSON.stringify({ error: String(error && error.message ? error.message : error) })) }',
          '',
        ].join('\n')
        writeFileSync(qHelperPath, helperSource, 'utf8')
        const candidateSnapshot = listEntries(ctx)
          .filter((e) => typeof e.rowId === 'string' && e.rowId !== '')
          .map((e) => ({ rowId: e.rowId, moduleName: e.moduleName, toggleable: e.toggleable === true, enabled: e.enabled === true }))
        writeFileSync(qCandidatesPath, JSON.stringify(candidateSnapshot, null, 2), 'utf8')
      } catch {}
      try { mkdirSync(dirname(logFile), { recursive: true }) } catch {}
      // PowerShell 字符串里反斜杠是字面量（无 \\ 转义）：JSON.stringify 产生的 \\ 必须还原为 \，
      // 否则所有路径无效（npm 调不起来、回滚无效、拉起失败——曾导致升级脚本空跑）
      // PowerShell 双引号字面量：反斜杠还原 + 空串产出 ''（JSON 的 "" 被单引号包裹会变成字面量 "" ，
      // 曾导致 $cp = '""' → Test-Path 恒假 → 全树回滚被静默跳过）+ $ / 反引号转义（路径含 $ 不被插值）
      const ps = (s) => {
        const j = JSON.stringify(String(s)).replace(/\\\\/gu, '\\')
        if (j === '""') return "''"
        return j.replace(/`/gu, '``').replace(/\$/gu, '`$')
      }
      const patchFilePath = join(profileDir, 'cordis.patch.yml')
      // 拉起服务的 PowerShell 片段（隔离重试用；与升级/回滚路径共用 relaunchPrelude 里的同一份实现）
      const launchSnippet = (tag) => `if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '${tag}') { $started = $true } }; Beat`
      const lines = [
        `$state = ${ps(stateFile)}`,
        `$log = ${ps(logFile)}`,
        "function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }",
        "function SetState($s, $m) {",
        // v0.3.37：失败时把**崩溃前最后到达的阶段**一起写进状态文件（stage=…）——
        // 否则界面只能看到 failed，把已经成功的步骤全打成 ✕（2026-09-11 用户实测就是这个观感：
        // 框架其实升好了，卡片却整列红叉）。$script:stage 未设置时 [string] 会安全地变成空串。
        "  try { if ($s -eq 'failed') { Set-Content -Path $state -Value ($s + '|' + $m + '|stage=' + [string]$script:stage) -Encoding UTF8; return } } catch {}",
        "  try { if ($s -ne 'done' -and $s -ne 'idle') { $script:stage = $s }; Set-Content -Path $state -Value ($s + '|' + $m) -Encoding UTF8; Beat } catch {}",
        "}",
        relaunchPrelude({ nodePath, pluginDir: pluginRoot(), fwRoot, target, ps }),
        // 全局异常兜底（事故教训）：脚本任何未捕获异常都会无声死亡、状态永远卡住、服务没人拉起。
        // trap 捕获后：写 failed 状态 + 日志 + 尝试拉起服务 + 自删任务 + 退出
        "trap {",
        "  try { SetState 'failed' ('升级脚本异常终止：' + $_.Exception.Message) } catch {}",
        // 事故教训（2026-09-10）：只记消息无法定位是哪一行崩的 —— 连出错位置一起写日志
        "  try { Log ('升级脚本异常终止：' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage) } catch {}",
        `  try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if (-not $c) { [void](Invoke-DshRelaunch '异常兜底') } } catch {}`,
        `  schtasks /delete /f /tn ${taskName} 2>$null`,
        "  exit 1",
        "}",
        "SetState 'starting' '备份配置…'",
        "Log '框架升级脚本启动'",
        // 流程优化（用户建议）：先在线下载安装（服务保持运行、页面不断、进度可见），
        // 成功后最后重启服务生效；在线替换失败（服务占用框架目录 EBUSY）才停止服务重试
        `SetState 'installing' '升级框架 ${current} -> ${target}（npm 下载中，服务保持在线）'`,
        `Log '升级框架本体 ${current} -> ${target}…'`,
        // 关键：npm 的工作目录必须是缓存 node_modules（schtasks 默认 cwd 是 system32/用户目录，
        // 不指定会装错位置——缓存永远不更新的根因）
        `Set-Location -Path ${ps(fwRoot)}`,
        // npm 安装函数：Start-Process 跑 npm-cli.js（唯一正确入口——lib/cli.js 是函数模块，
        // 直跑只加载不执行，假成功 exit 0）+ --force（显式指定版本但已在 package.json 的
        // semver 范围内时 npm 会跳过安装，假成功）+ 15 分钟总时长硬超时。注意：**不能加
        // -RedirectStandardOutput/-RedirectStandardError**——schtasks 任务环境下带重定向的
        // Start-Process 子进程会启动即异常退出（ExitCode 读不到、输出 0 字节，实测）；
        // 无重定向时 ExitCode 正常（实测 exit=0）。npm 自身 debug 日志（cache\_logs）留档。
        // 超时策略：总时长 15 分钟硬上限 + npm debug 日志 5 分钟无更新判定卡死（网络黑洞/挂起时
        // 快速失败换 registry，不用干等 15 分钟）；等待期间每 15 秒更新进度状态（客户端可见）。
        // 成功后校验 package.json 版本 === target（防 npm 假成功）。
        // 另注意：npm install 在 schtasks 环境启动慢（约 1-2 分钟 0 日志，初始化/编译缓存），
        // 属正常，5 分钟卡死阈值不会误杀。
        `function Install-Framework($reg) {`,
        `  $startAt = Get-Date`,
        `  $deadline = $startAt.AddMinutes(15)`,
        `  $stallDeadline = $startAt.AddMinutes(5)`,
        `  $lastLogM = (Get-Date)`,
        `  $logSeen = $false`,
        `  $cacheDir = ''`,
        `  try {`,
        `    $npmrcFile = Join-Path $env:USERPROFILE '.npmrc'`,
        `    if (Test-Path $npmrcFile) { $m = Select-String -Path $npmrcFile -Pattern '^cache\\s*=\\s*(.+)$' | Select-Object -Last 1; if ($m) { $cacheDir = $m.Matches[0].Groups[1].Value.Trim().Trim('"') } }`,
        `  } catch {}`,
        `  if ($cacheDir -eq '') { $fb = Join-Path $env:APPDATA 'npm-cache'; if (Test-Path (Join-Path $fb '_logs')) { $cacheDir = $fb } }`,
        `  $npmOut = $log + '.npm.out.txt'`,
        `  $marker = $log + '.pnpm.marker'`,
        `  try { Remove-Item $marker -Force -ErrorAction SilentlyContinue } catch {}`,
        `  $proc = $null`,
        `  try {`,
        `    # pnpm 通道 + 黑框实时进度：start 独立窗口（有真实 stdout，黑框显示 pnpm 进度条，`,
        `    # 标题 DSH-Upgrade）；pnpm 结束后 cmd 写 marker（含退出码），脚本轮询 marker 判断完成`,
        `    $cmdLine = 'start "DSH-Upgrade" cmd /c "title DSH-Upgrade && ${nodePath} ${corepackJs} pnpm install @deepseek-ai/dsh@${target} --force --config.dangerouslyAllowAllBuilds=true --registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"'`,
        `    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdLine) -PassThru -WindowStyle Hidden`,
        `  } catch {`,
        `    Log ('启动 pnpm 失败：' + $_.Exception.Message)`,
        `    return 1`,
        `  }`,
        `  $done = $false`,
        `  $code = 1`,
        `  while (-not $done -and (Get-Date) -lt $deadline) {`,
        `    Start-Sleep -Seconds 5`,
        `    if (Test-Path $marker) {`,
        `      $mc = Get-Content $marker -Raw -ErrorAction SilentlyContinue`,
        `      $mm = [regex]::Match($mc, 'DSH-DONE:(\\d+)')`,
        `      if ($mm.Success) { $code = [int]$mm.Groups[1].Value; $done = $true }`,
        `    }`,
        `    if (-not $done) {`,
        `      SetState 'installing' ('升级框架 ${current} -> ${target}（已等待 ' + [int]((Get-Date) - $startAt).TotalSeconds + ' 秒，进度见 DSH-Upgrade 窗口）')`,
        `    }`,
        `  }`,
        `  if (-not $done) {`,
        `    Log 'pnpm 超过 15 分钟未完成，判定超时'`,
        `    try { taskkill /F /FI "WINDOWTITLE eq DSH-Upgrade" 2>$null | Out-Null } catch {}`,
        `    return 1`,
        `  }`,
        `  if ($code -eq 0) {`,
        `    try {`,
        // 事故教训（2026-09-10）：版本校验必须看「启动器可见路径」（顶层 @deepseek-ai\dsh），
        // 而不是 require.resolve 得到的 .pnpm 内部路径——旧逻辑查 .pnpm 里的旧副本，
        // 于是 pnpm 明明装好了却报「版本未更新，按失败处理」，白等两轮。
        `      $v = (Get-Content ${ps(join(fwRoot, '@deepseek-ai', 'dsh', 'package.json'))} -Raw | ConvertFrom-Json).version`,
        `      if ($v -ne '${target}') { Log ('pnpm 退出码 0 但顶层可见版本未更新（顶层 ' + $v + '，目标 ${target}），按失败处理'); $code = 1 }`,
        `    } catch { Log 'pnpm 退出码 0 但无法读取顶层版本，按失败处理'; $code = 1 }`,
        `  }`,
        fwIntegrityCheck({ target, nodePath, fwRoot }),
        `  return $code`,
        `}`,
        // 回滚函数（2026-09-04 事故后升级为「全树优先」）：robocopy 支持长路径（Copy-Item 对 >260
        // 字符路径静默失败，曾导致回滚后框架目录缺失、服务无法重启）；回滚前确保服务已停
        // （进程 cwd 会锁住框架目录）。checkpoint 存在 → 恢复全部 @deepseek-ai 版本包 + 顶层 scope；
        // checkpoint 缺失 → CLI 兜底。
        `function Invoke-Rollback {`,
        `  SetState 'rollback' '升级失败，回滚框架（全树/CLI 备份）…'`,
        `  Log '升级失败，回滚框架…'`,
        // 事故教训（2026-09-10）：整个回滚体包 try/catch —— 脚本崩在回滚里（曾报
        // 「无法将参数绑定到参数 Path」，回滚没跑完、旧树半新半旧），必须记录出错位置而不是
        // 只留一句 trap 消息；回滚失败也要明确写状态，别让人以为已回滚。
        `  try {`,
        `    try { $svc = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($svc) { $svc | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3 } } catch {}`,
        `    $cp = ${ps(fwCheckpoint?.dest ?? '')}`,
        `    if ($cp -and (Test-Path (Join-Path $cp '.pnpm'))) {`,
        `      $restored = 0`,
        `      $entries = Get-ChildItem -Path (Join-Path $cp '.pnpm') -Directory -ErrorAction SilentlyContinue`,
        `      foreach ($e in $entries) {`,
        `        if ($e.Name -notlike '*+*') { continue }`,
        `        $name = @($e.Name -split '\\+')[1] -replace '@.*$', ''`,
        `        if (-not $name) { continue }`,
        `        $src = Join-Path $e.FullName ('node_modules\\@deepseek-ai\\' + $name)`,
        `        $dst = Join-Path (Join-Path ${ps(fwRoot)} ('.pnpm\\' + $e.Name)) ('node_modules\\@deepseek-ai\\' + $name)`,
        `        if (Test-Path (Join-Path $src 'package.json')) { New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null; robocopy $src $dst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null; $restored++ }`,
        `      }`,
        `      $topSrc = Join-Path $cp 'top-@deepseek-ai'`,
        `      if (Test-Path $topSrc) { Remove-Item ${ps(join(fwRoot, '@deepseek-ai'))} -Recurse -Force -ErrorAction SilentlyContinue; robocopy $topSrc ${ps(join(fwRoot, '@deepseek-ai'))} /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null }`,
        `      try { Copy-Item (Join-Path $cp 'lock.yaml') ${ps(join(fwRoot, '.pnpm', 'lock.yaml'))} -Force -ErrorAction SilentlyContinue } catch {}`,
        `      Log ('全树回滚完成：恢复 ' + $restored + ' 个版本包 + 顶层 scope')`,
        `      $script:rolledBack = $true`,
        `      return`,
        `    }`,
        `    # CLI 兜底（checkpoint 缺失或损坏）`,
        `    if (-not (Test-Path ${ps(join(rollbackDir, 'lib', 'bin.js'))})) { Log ('回滚失败：CLI 备份也缺失（' + ${ps(rollbackDir)} + '）'); return }`,
        `    Remove-Item ${ps(dshDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
        `    robocopy ${ps(rollbackDir)} ${ps(dshDir)} /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null`,
        `    if (Test-Path ${ps(join(dshDir, 'lib', 'bin.js'))}) { Log '回滚完成（CLI 恢复）'; $script:rolledBack = $true } else { Log '回滚失败：复制失败，请手动修复框架安装' }`,
        `  } catch {`,
        `    Log ('回滚过程异常：' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)`,
        `    SetState 'failed' ('回滚过程异常，框架可能处于混合状态：' + $_.Exception.Message)`,
        `  }`,
        `}`,
        `$script:rolledBack = $false`,
        `$code = Install-Framework 'https://registry.npmmirror.com'`,
        `if ($code -ne 0) { Log ('npmmirror 安装失败（exit=' + $code + '），切换 registry.npmjs.org 重试一次'); $code = Install-Framework 'https://registry.npmjs.org' }`,
        `if ($code -ne 0) {`,
        `  # 在线安装失败（服务可能占用框架目录导致替换失败）：停止服务后重试一次`,
        `  SetState 'stopped' '在线安装失败（框架目录可能被服务占用），停止服务后重试…'`,
        `  Log '在线安装失败，停止服务后重试'`,
        `  try { $svc = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($svc) { $svc | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3 } } catch {}`,
        `  $code = Install-Framework 'https://registry.npmmirror.com'`,
        `  if ($code -ne 0) { Log ('（停服后）npmmirror 安装失败（exit=' + $code + '），切换 registry.npmjs.org 重试一次'); $code = Install-Framework 'https://registry.npmjs.org' }`,
        `}`,
        `if ($code -ne 0) { Invoke-Rollback } else {`,
        `  Log '框架本体升级完成'`,
        // 事故教训（2026-09-10）：启动器（桌面端/`npx dsh`）用的是**顶层** @deepseek-ai\dsh；
        // 若它是 npm 时代的真实目录，pnpm 无法把它换成链接 → 顶层永远停在旧版，
        // 桌面端下次自己拉服务就跑旧框架（版本错配 → 拉起失败 → 又提示升级，循环）。
        // 这里校验「启动器可见版本」，是实体目录就改名备份后重装一次，让 pnpm 重建链接。
        `  $visible = ${ps(join(fwRoot, '@deepseek-ai', 'dsh'))}`,
        `  $vv = ''`,
        `  try { $vv = (Get-Content (Join-Path $visible 'package.json') -Raw | ConvertFrom-Json).version } catch {}`,
        `  if ($vv -ne '${target}') {`,
        `    $item = Get-Item $visible -Force -ErrorAction SilentlyContinue`,
        `    if ($item -and -not $item.LinkType) {`,
        `      $bakName = 'dsh.npm-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')`,
        `      try { Rename-Item -Path $visible -NewName $bakName -ErrorAction Stop; Log ('顶层为旧版实体目录（' + $vv + '）→ 已改名备份 ' + $bakName + '，重装以重建链接…') } catch { Log ('顶层实体目录改名失败：' + $_.Exception.Message) }`,
        `      $code = Install-Framework 'https://registry.npmmirror.com'`,
        `      if ($code -ne 0) { $code = Install-Framework 'https://registry.npmjs.org' }`,
        `      $vv = ''`,
        `      try { $vv = (Get-Content (Join-Path $visible 'package.json') -Raw | ConvertFrom-Json).version } catch {}`,
        `      if ($vv -eq '${target}') { Log '顶层可见版本已修正为 ${target}' } else { Log ('顶层可见版本仍为 ' + $vv + '（拉起不受影响：Node 按链接真实路径解析依赖）') }`,
        `    } else { Log ('顶层可见版本异常（' + $vv + '）且非实体目录，跳过改名（LinkType=' + $item.LinkType + '）') }`,
        `  } else { Log '顶层可见版本校验通过' }`,
        `}`,
        // 回滚后跳过重链/依赖修复/版本对齐（它们按新树预期运行，会对已恢复的旧树造成二次破坏）
        `if (-not $script:rolledBack) {`,
        // 重新链接框架配套包（事故教训）：pnpm 升级到新版本时 .pnpm 目录重建，
        // 但顶层 node_modules/@deepseek-ai/* 不会自动切换，仍指向旧版（如 0.1.0-rc.7）——
        // 导致框架混版本（如 dsh-llm-deepseek 旧版无 vision 模型）、部分功能异常。
        // 升级成功后：遍历顶层 @deepseek-ai 的 dsh-* 包，读 .pnpm 主目录里的最新版本，
        // 若与顶层不一致则重建为 Junction（旧版备份 .bak-rc7）。
        `$relinked = 0`,
        `function Relink-FrameworkPackages($version) {`,
        `  # dshDir = .../node_modules/@deepseek-ai/dsh → nodeModules = .../node_modules`,
        `  $nodeModules = ${ps(fwRoot)}`,
        `  $pnpm = Join-Path $nodeModules '.pnpm'`,
        `  if (-not (Test-Path $pnpm)) { Log ('重链跳过：.pnpm 目录不存在'); return }`,
        `  $topPkgs = Get-ChildItem -Path (Join-Path $nodeModules '@deepseek-ai') -Directory | Where-Object { $_.Name -like 'dsh-*' }`,
        `  # 版本数值比较（修复：字符串比较在版本号位数变化时出错，如 0.1.10 < 0.1.9；PS5.1 兼容，不用三元运算符）`,
        `  function Compare-Version($a, $b) {`,
        `    if ($a -eq $b) { return 0 }`,
        `    $pa = [regex]::Match($a, '^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(?:[a-z]+\\.)?(\\d+))?' )`,
        `    $pb = [regex]::Match($b, '^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(?:[a-z]+\\.)?(\\d+))?' )`,
        `    if (-not $pa.Success -or -not $pb.Success) { return ($a.CompareTo($b)) }`,
        `    for ($i = 1; $i -le 4; $i++) {`,
        `      if ($pa.Groups[$i].Success) { $va = [int]$pa.Groups[$i].Value } else { $va = 2147483647 }`,
        `      if ($pb.Groups[$i].Success) { $vb = [int]$pb.Groups[$i].Value } else { $vb = 2147483647 }`,
        `      if ($va -ne $vb) { if ($va -lt $vb) { return -1 } else { return 1 } }`,
        `    }`,
        `    return 0`,
        `  }`,
        `  foreach ($top in $topPkgs) {`,
        `    $name = $top.Name`,
        `    $topPkgJson = Join-Path $top.FullName 'package.json'`,
        `    if (-not (Test-Path $topPkgJson)) { continue }`,
        `    try { $topVer = (Get-Content $topPkgJson -Raw | ConvertFrom-Json).version } catch { continue }`,
        `    # 找 .pnpm 里该包的所有主目录（@deepseek-ai+dsh-<name>@<ver>_<hash> 或 @deepseek-ai+dsh-<name>@<ver>-rc.x_<hash>）`,
        `    $cands = Get-ChildItem -Path $pnpm -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match ('^@deepseek-ai\\\\+dsh-' + [regex]::Escape($name.Substring(4)) + '@') }`,
        `    $best = $null; $bestVer = ''`,
        `    foreach ($c in $cands) {`,
        `      $inner = Join-Path $c.FullName ('node_modules\\@deepseek-ai\\' + $name)`,
        `      $pj = Join-Path $inner 'package.json'`,
        `      if (-not (Test-Path $pj)) { continue }`,
        `      try { $v = (Get-Content $pj -Raw | ConvertFrom-Json).version } catch { continue }`,
        `      if ($null -eq $best -or (Compare-Version $v $bestVer) -gt 0) { $bestVer = $v; $best = $inner }`,
        `    }`,
        `    if ($null -eq $best) { continue }`,
        `    if ($bestVer -eq $topVer) { continue }`,
        `    try {`,
        `      $bak = $top.FullName + '.bak-' + $topVer`,
        `      if (Test-Path $bak) { Remove-Item $bak -Recurse -Force -ErrorAction SilentlyContinue }`,
        `      Rename-Item -LiteralPath $top.FullName -NewName ($name + '.bak-' + $topVer) -Force`,
        `      cmd /c mklink /J "$($top.FullName)" "$($best)" 2>$null | Out-Null`,
        `      if (Test-Path (Join-Path $top.FullName 'package.json')) { $script:relinked++; Log ('重链 ' + $name + ': ' + $topVer + ' -> ' + $bestVer) } else { Log ('重链失败：' + $name) }`,
        `    } catch { Log ('重链异常：' + $name + ' ' + $_.Exception.Message) }`,
        `  }`,
        `}`,
        `Relink-FrameworkPackages '${target}'`,
        `Log ('重链框架配套包完成（' + $script:relinked + ' 个）')`,
        // 依赖树完整性验证（事故教训：升级只装框架主包，pnpm 不重装依赖树——dsh-client-* 等
        // 39 个客户端组件仍停旧版（如 0.1.0-rc.7），新旧混版本导致输入框传图卡死等异常。
        // 修复：扫描 web-app 声明的 @deepseek-ai 依赖，与顶层实际版本比对，
        // 不一致则按声明版本从 npm registry 精确下载 tarball 修复（绕过 pnpm dist-tags 远古版陷阱）。
        `$treeFixed = 0`,
        `function Verify-DependencyTree($refVersion) {`,
        `  # dshDir = .../node_modules/@deepseek-ai/dsh → nodeModules = .../node_modules`,
        `  $nodeModules = ${ps(fwRoot)}`,
        `  $webApp = Join-Path $nodeModules '@deepseek-ai\\dsh-web-app\\package.json'`,
        `  if (-not (Test-Path $webApp)) { Log ('依赖树验证跳过：dsh-web-app 未找到'); return }`,
        `  try { $deps = (Get-Content $webApp -Raw | ConvertFrom-Json).dependencies } catch { Log ('依赖树验证跳过：读取失败'); return }`,
        `  foreach ($dep in $deps.PSObject.Properties) {`,
        `    $name = $dep.Name`,
        `    if (-not ($name -match '^@deepseek-ai/')) { continue }`,
        `    $short = $name.Substring(13)`,
        `    $topDir = Join-Path $nodeModules (@('@deepseek-ai', $short) -join '\')`,
        `    $topPkgJson = Join-Path $topDir 'package.json'`,
        `    if (-not (Test-Path $topPkgJson)) { continue }`,
        `    try { $curVer = (Get-Content $topPkgJson -Raw | ConvertFrom-Json).version } catch { continue }`,
        `    if ($curVer -eq $refVersion) { continue }`,
        `    try {`,
        `      # 按声明版本精确下载 npm tarball（registry 的 dist-tags.latest 是远古版不可信，必须显式版本）`,
        `      $tmpDir = Join-Path $env:TEMP ('dsh-depfix-' + [guid]::NewGuid().ToString('N'))`,
        `      New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null`,
        `      $tgz = Join-Path $tmpDir 'pkg.tgz'`,
        `      $encName = $name.Replace('/','%2f')`,
        `      $url = 'https://registry.npmmirror.com/' + $encName + '/-/' + $short + '-' + $refVersion + '.tgz'`,
        `      curl.exe -s -L -m 60 -o $tgz $url`,
        `      if (-not (Test-Path $tgz) -or (Get-Item $tgz).Length -lt 1000) {`,
        `        $url = 'https://registry.npmjs.org/' + $encName + '/-/' + $short + '-' + $refVersion + '.tgz'`,
        `        curl.exe -s -L -m 60 -o $tgz $url`,
        `      }`,
        `      if (-not (Test-Path $tgz) -or (Get-Item $tgz).Length -lt 1000) { Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue; continue }`,
        `      tar -xzf $tgz -C $tmpDir`,
        `      $ver = (Get-Content (Join-Path $tmpDir 'package\\package.json') -Raw | ConvertFrom-Json).version`,
        `      if ($ver -eq $refVersion) {`,
        `        $bak = $topDir + '.bak-' + $curVer`,
        `        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force -ErrorAction SilentlyContinue }`,
        `        Rename-Item -LiteralPath $topDir -NewName ($short + '.bak-' + $curVer) -Force`,
        `        Copy-Item (Join-Path $tmpDir 'package') $topDir -Recurse -Force`,
        `        $script:treeFixed++`,
        `        Log ('依赖修复 ' + $short + ': ' + $curVer + ' -> ' + $ver)`,
        `      }`,
        `      Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue`,
        `    } catch { Log ('依赖修复异常：' + $short + ' ' + $_.Exception.Message) }`,
        `  }`,
        `}`,
        `Verify-DependencyTree '${target}'`,
        `Log ('依赖树完整性修复完成（' + $script:treeFixed + ' 个）')`,
        // 自报名一致性校验（事故教训：面板自身部署名与代码自报名不一致崩溃）——
        // 曾把 @noob-stupid/dsh-plugin-console 的代码装进 @deepseek-ai/dsh-plugin-console 目录，
        // 浏览器端报 loaded without registering "@deepseek-ai/dsh-plugin-console"（加载器期望
        // 目录名 = 包名 = 登记 ID，三者必须一致）。校验面板自身：export const name / client.js
        // 注册 id 必须与部署目录名一致，不一致则日志告警（升级脚本不自动改名——避免破坏运行时）。
        `function Verify-SelfNameConsistency($expectedName) {`,
        `  $selfDir = ${ps(pluginRoot())}`,
        `  $indexJs = Join-Path $selfDir 'lib\\index.js'`,
        `  $clientJs = Join-Path $selfDir 'lib\\client.js'`,
        `  if (-not (Test-Path $indexJs)) { Log ('自报名校验跳过：index.js 未找到'); return }`,
        `  # 计算部署目录的完整包名（scoped 包为 @scope/name，非 scoped 包为 name）`,
        `  $leaf = Split-Path $selfDir -Leaf`,
        `  $parentLeaf = Split-Path (Split-Path $selfDir -Parent) -Leaf`,
        `  if ($parentLeaf.StartsWith('@')) { $deployName = $parentLeaf + '/' + $leaf } else { $deployName = $leaf }`,
        `  $idx = Get-Content $indexJs -Raw`,
        `  $nameOk = $idx.Contains("export const name = '" + $expectedName + "'")`,
        `  $clientOk = $true`,
        `  if (Test-Path $clientJs) {`,
        `    $cli = Get-Content $clientJs -Raw`,
        `    $clientOk = $cli.Contains('id: "' + $expectedName + '"')`,
        `  }`,
        `  $dirOk = ($deployName -eq $expectedName)`,
        `  if ($nameOk -and $clientOk -and $dirOk) { Log ('自报名一致性 OK：' + $expectedName + ' @ ' + $deployName) } else { Log ('⚠️ 自报名一致性异常：部署目录=' + $deployName + '，期望 ' + $expectedName + '（index=' + $nameOk + ' client=' + $clientOk + ' dir=' + $dirOk + '）——请检查部署目录与包名是否匹配') }`,
        `}`,
        `Verify-SelfNameConsistency '${selfName ?? '@noob-stupid/dsh-plugin-console'}'`,
        pkgArgs.length > 0 ? `SetState 'pkg' '更新官方配套包…'\n  Log '更新官方配套包…'\n  Set-Location -Path ${ps(profileDir2)}\n  if (Test-Path ${ps(corepackJs)}) {\n    $pp = Start-Process -FilePath ${ps(nodePath)} -ArgumentList @(${ps(corepackJs)}, 'pnpm', 'update', ${pkgArgs.join(', ')}, '--no-optional', '--registry', 'https://registry.npmmirror.com') -PassThru -WindowStyle Hidden\n    if (-not $pp.WaitForExit(300000)) { Stop-Process -Id $pp.Id -Force -ErrorAction SilentlyContinue; Log '官方配套包更新超时（5 分钟），已跳过' } else { try { Log ('官方配套包更新结束（exit=' + $pp.ExitCode + '）') } catch { Log '官方配套包更新结束（退出码读取失败）' } }\n  }` : '',
        "}",
        "SetState 'relaunching' '升级完成，重启 DSH 服务生效…'",
        "Log '重启 DSH 服务生效…'",
        // 升级全程服务保持在线（先下载后重启）：这里停掉旧服务（内存仍是旧代码），拉起新版本生效
        `try { $svc = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($svc) { $svc | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3; Log '旧服务已停止（重启生效）' } } catch {}`,
        '$ok = $false',
        '$started = $false',
        `for ($i = 0; $i -lt 20; $i++) {`,
        `  try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
        `  if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '升级后') { $started = $true } }; Beat`,
        '  Start-Sleep -Seconds 5',
        '}',
        // ── 启动失败隔离（用户硬要求）：新框架起不来时先隔离肇事者再重试，不直接回滚 ──
        // 判定逻辑全在 Node 决策器（fw-analyze-boot.mjs → planQuarantine）；这里只执行方案。
        `function Invoke-Quarantine {`,
        `  $helper = ${ps(qHelperPath)}`,
        `  if (-not (Test-Path $helper)) { Log '隔离分析器缺失，跳过隔离'; return $false }`,
        `  $logPath = Join-Path (Split-Path $log) 'fw-relaunch.log'`,
        `  if (-not (Test-Path $logPath)) { $logPath = $log }`,
        `  $out = ''`,
        `  try { $out = (& ${ps(nodePath)} $helper $logPath ${ps(qCandidatesPath)} 2>$null | Select-Object -Last 1) } catch { Log ('隔离分析调用失败：' + $_.Exception.Message); return $false }`,
        `  if (-not $out) { Log '隔离分析无输出'; return $false }`,
        `  $plan = $null`,
        `  try { $plan = $out | ConvertFrom-Json } catch { Log '隔离分析输出无法解析'; return $false }`,
        `  $acted = $false; $doneP = @(); $doneR = @(); $mode = 'targeted'`,
        `  foreach ($p in @($plan.presets)) {`,
        `    if (-not $p.exists) { continue }`,
        `    try { Rename-Item -LiteralPath $p.file -NewName ((Split-Path $p.file -Leaf) + '.broken-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -ErrorAction Stop; $doneP += $p.name; $acted = $true; Log ('已隔离预设：' + $p.name + '（改名 .broken，不再参与挂载）') } catch { Log ('预设隔离失败：' + $p.name + ' ' + $_.Exception.Message) }`,
        `  }`,
        `  foreach ($r in @($plan.rows)) {`,
        `    try {`,
        `      $has = Select-String -Path ${ps(patchFilePath)} -Pattern ('^- id: ' + [regex]::Escape($r) + '\\s*$') -Quiet -ErrorAction SilentlyContinue`,
        `      if (-not $has) { Add-Content -Path ${ps(patchFilePath)} -Value ('- id: ' + $r) -Encoding UTF8; Add-Content -Path ${ps(patchFilePath)} -Value '  disabled: true' -Encoding UTF8 }`,
        `      $doneR += $r; $acted = $true; Log ('已禁用不适配行：' + $r)`,
        `    } catch { Log ('禁用行失败：' + $r + ' ' + $_.Exception.Message) }`,
        `  }`,
        `  if (-not $acted -and $plan.safeMode) {`,
        `    $mode = 'safe-mode'`,
        `    foreach ($r in @(${thirdPartyRows.length > 0 ? thirdPartyRows.map((r) => ps(r)).join(', ') : "''"})) {`,
        `      try { $has = Select-String -Path ${ps(patchFilePath)} -Pattern ('^- id: ' + [regex]::Escape($r) + '\\s*$') -Quiet -ErrorAction SilentlyContinue; if (-not $has) { Add-Content -Path ${ps(patchFilePath)} -Value ('- id: ' + $r) -Encoding UTF8; Add-Content -Path ${ps(patchFilePath)} -Value '  disabled: true' -Encoding UTF8 }; $doneR += $r; $acted = $true } catch {}`,
        `    }`,
        `    if ($acted) { Log ('安全模式：已禁用 ' + $doneR.Count + ' 个第三方行，先让服务起来（适配后逐个解锁）') }`,
        `  }`,
        `  if ($acted) {`,
        `    try {`,
        `      $rec = [pscustomobject]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); mode = $mode; presets = $doneP; rows = $doneR; lines = $plan.lines } | ConvertTo-Json -Depth 4`,
        `      Set-Content -Path ${ps(qRecordPath)} -Value $rec -Encoding UTF8`,
        `    } catch {}`,
        `  } else { Log '隔离分析未定位到可隔离对象' }`,
        `  return $acted`,
        `}`,
        `if (-not $ok -and -not $script:rolledBack) {`,
        `  Log '服务拉起失败 → 先做启动失败隔离（隔离肇事者后重试，不直接回滚）'`,
        `  for ($q = 1; $q -le 3; $q++) {`,
        `    if (-not (Invoke-Quarantine)) { Log ('第 ' + $q + ' 轮：未定位到可隔离对象，停止隔离'); break }`,
        `    $ok = $false; $started = $false`,
        `    for ($i = 0; $i -lt 12; $i++) {`,
        `      try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
        `      ${launchSnippet('隔离后重试')}`,
        `      Start-Sleep -Seconds 5`,
        `    }`,
        `    if ($ok) { Log ('第 ' + $q + ' 轮隔离后服务已起来（被隔离项可在控制台解锁）'); break }`,
        `    Log ('第 ' + $q + ' 轮隔离后仍失败')`,
        `  }`,
        `}`,
        // 隔离也救不回才回滚（2026-09-04 教训：自动全树回滚并再拉起一次）
        `if (-not $ok -and -not $script:rolledBack) {`,
        `  Log '服务拉起失败，尝试自动回滚到升级前版本…'`,
        `  Invoke-Rollback`,
        `  $ok = $false`,
        `  $started = $false`,
        `  for ($i = 0; $i -lt 20; $i++) {`,
        `    try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
        `    if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '回滚后') { $started = $true } }; Beat`,
        `    Start-Sleep -Seconds 5`,
        `  }`,
        `}`,
        `if ($ok) { if ($script:rolledBack) { SetState 'failed' '升级失败，已自动回滚到升级前版本（服务已恢复）' ; Log '升级失败已自动回滚，服务已恢复' } else { SetState 'done' '升级完成，服务已监听 ${port}' ; Log '服务已监听 ${port}，升级完成' } } else { SetState 'failed' '拉起失败且自动回滚未生效：请手动运行 node ${binPath} web' ; Log '拉起失败且自动回滚未生效：请手动运行 node ${binPath} web（参考本日志排查）' }`,
        `schtasks /delete /f /tn ${taskName} 2>$null`,
      ].filter((l) => l !== '').join('\r\n')
      // 初始状态（备份完成、脚本即将执行）
      try { writeFileSync(stateFile, 'starting|备份配置完成，启动升级脚本…', 'utf8') } catch {}
      // 版本检查缓存作废：升级后 [框架] 面板要立刻显示新版本（否则 5 分钟内还显示"可升级到…"）
      setFwCheckCache(null)
      // UTF-8 BOM：powershell 5.1 按 ANSI 读无 BOM 文件，中文会乱码——加 BOM 保证解析正确。
      // 执行方式：schtasks 一次性计划任务（Task Scheduler 启动，独立于服务进程树/Job Object）——
      // 服务进程被杀时，其子进程（execFile/detached 的 powershell）会被 Job/进程树连带杀死，
      // 曾多次卡死在「停止服务」之后；计划任务彻底脱离，杀服务绝对影响不到升级脚本。
      writeFile(ps1, `\uFEFF${lines}`, 'utf8').then(
        () => {
          const ps1Posix = ps1.replace(/\\/gu, '/')
          // 无引号 /tr（重要）：Task Scheduler 对带引号命令的解析会把 Command 拆坏成
          // `"powershell ... -File \"`（非有效可执行文件）——任务显示 Ready、/run 报 SUCCESS
          // 但永不执行（曾导致升级/重启脚本反复"已启动"却不动作、服务不停止）。实测无引号
          // 格式（exe 与脚本路径均无空格时）任务正常执行、脚本完整跑通。仅当脚本路径含空格
          // 时才退回带引号格式（schtasks 引号解析在服务 execFile 上下文不可靠，此时宁可用它）。
          const tr = / /.test(ps1Posix)
            ? `"powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\"${ps1Posix}\\""`
            : `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${ps1Posix}`
          execFile('schtasks.exe', ['/create', '/f', '/tn', taskName, '/tr', tr, '/sc', 'once', '/st', '00:00'], { windowsHide: true }, (error) => {
            if (error) {
              // 兜底：schtasks 不可用时退回 detached（可能仍受 Job 影响，但尽力）
              try { writeFileSync(stateFile, 'starting|升级脚本将通过 detached 启动（schtasks 不可用）|detached', 'utf8') } catch {}
              execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
              return
            }
            try { writeFileSync(stateFile, 'starting|升级脚本已通过计划任务启动|schtasks', 'utf8') } catch {}
            // create 回调里立即 /run 会因任务注册未完成而静默失败（曾导致任务从未执行）：
            // 延迟 800ms 再 run；run 仍失败则退回 detached 兜底
            setTimeout(() => {
              execFile('schtasks.exe', ['/run', '/tn', taskName], { windowsHide: true }, (runError) => {
                if (runError) {
                  try { writeFileSync(stateFile, 'starting|计划任务运行失败，改用 detached 兜底|detached-fallback', 'utf8') } catch {}
                  execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, detached: true, stdio: 'ignore' }, () => {})
                }
              })
            }, 800)
          })
        },
        () => {},
      )
      upgraded = true
      steps.push(`框架升级脚本已启动：${current} → ${target}（在线下载安装，服务保持运行，成功后自动重启生效，约 1-3 分钟）`)
      steps.push(`升级前配置已打包：${backupDir ?? '（跳过）'}；框架本体回滚点：${rollbackDir ?? '（跳过）'}`)
    } else if (hasUpdate) {
      steps.push('检测到新版本，但无法定位框架安装目录（@deepseek-ai/dsh 解析失败），已取消升级——请修复框架安装后重试')
    } else if (!hasUpdate) {
      steps.push(registryError !== null ? `版本检测失败（${registryError}），无法确认是否有新版本——请检查网络后重试` : '当前已是最新版本，无需升级')
    }
    // 4) 配置移植说明：cordis.patch.yml / bundles 位于 profile（升级不触碰），天然保留；
    //    重启后框架适配逻辑自动备份新版本快照 + 重打补丁
    const hints = [
      `现有配置已打包备份：${backupDir ?? '（跳过）'}。升级不触碰 profile 配置（cordis.patch.yml / bundles 天然保留）。`,
      '重要：升级全程约 1-3 分钟，服务保持在线（进度实时可见），仅最后重启生效时页面短暂断开——期间请勿手动拉起服务或重启桌面端，否则会中断升级。',
      ...steps,
      '升级完成后请重启 DSH 服务生效——重启后 Hub 自动：备份新版本配置快照、重打框架补丁（issue #5 容错）、给出适配提示。',
      '官方配套组件（@deepseek-ai/*）随框架一起升级，请勿在市场单独更新。',
    ]
    sendJson(res, 200, { ok: true, current, latest, next, target, hasUpdate, upgraded, backupDir, registryError, configMigrations, preflight, steps, hints })
    return
}

export { routeFrameworkUpgrade }
