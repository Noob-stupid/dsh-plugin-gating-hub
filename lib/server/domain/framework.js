// L1 · domain —— framework.js（升级三件套的可搬部分：状态/备份路径、dsh 可执行文件定位、app boot 定位、容忍补丁、版本比较、重启前奏；分层 Step 6 从 lib/index.js 搬出，只搬移未改逻辑。注：detectFrameworkUpgrade / backupProfileSnapshot / currentFrameworkVersion 吃运行上下文，留到 Step 8）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { checkPluginFrameworkCompat, isFrameworkOwnedPackage, readCompatGate, readCompatPending, writeCompatPending } from './compat.js'
import { CORE_PATCH_ROW_IDS, disableEntry } from './patch.js'
import { listEntries } from './runtime.js'
import { copyTree } from '../infra/fsx.js'
import { dshHome, entryPkgMeta, findPatchPath, pluginRoot, profileDirOf, resolvePackageJson } from '../infra/paths.js'
import { frameworkUpgradeCandidates, isFrameworkVersionNewer, parseFrameworkVersion } from '../infra/semver.js'

/** 解析 dsh CLI 的 bin.js 绝对路径（守护拉起用）。 */
function resolveDshBin() {
  try {
    const requireLocal = createRequire(join(pluginRoot(), 'package.json'))
    return join(dirname(requireLocal.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  } catch {
    return null
  }
}

const FRAMEWORK_STATE_FILE = () => join(dshHome(), 'plugin-console', 'framework-state.json')

const FRAMEWORK_BACKUP_ROOT = () => join(dshHome(), 'plugin-console', 'framework-backups')

/** 定位 @deepseek-ai/dsh-app-boot（与 @deepseek-ai/dsh 同级）。 */
function locateAppBootFile(baseUrl) {
  try {
    const require = createRequire(baseUrl)
    const dshPkg = require.resolve('@deepseek-ai/dsh/package.json')
    const candidate = join(dirname(dshPkg), 'dsh-app-boot', 'lib', 'index.js')
    if (existsSync(candidate)) return candidate
  } catch {}
  const cacheRoots = [
    process.env.NODE_CACHE || '',
    'D:\\node_cache\\_npx',
    join(homedir(), '.npm', '_npx'),
    join(process.env.LOCALAPPDATA || '', 'node_cache', '_npx'),
  ].filter(Boolean)
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 内联框架补丁（dsh-app-boot parsePatchList 容错，issue #5）——DSH 升级后框架文件被覆盖，需重打。 */
function applyFrameworkTolerancePatchOnce(baseUrl) {
  const target = locateAppBootFile(baseUrl)
  if (!target) return { applied: false, reason: 'dsh-app-boot 未找到' }
  let source = ''
  try { source = readFileSync(target, 'utf8') } catch (error) { return { applied: false, reason: `读取失败：${error.message}` } }
  if (source.includes('tryDropEmptyArrayPlaceholder')) return { applied: false, reason: '已打过补丁' }
  if (!source.includes('function parsePatchList')) return { applied: false, reason: 'parsePatchList 不存在（框架版本可能已变更）' }
  const OLD = 'function parsePatchList(binName, file, content, label) {\n\tlet parsed;\n\ttry {\n\t\tparsed = yaml.load(content, { schema: userPatchesSchema });\n\t} catch (error) {\n\t\tthrow new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);\n\t}'
  const NEW = 'function parsePatchList(binName, file, content, label) {\n\tlet parsed;\n\ttry {\n\t\tparsed = yaml.load(content, { schema: userPatchesSchema });\n\t} catch (error) {\n\t\tconst retried = tryDropEmptyArrayPlaceholder(content);\n\t\tif (retried !== null) {\n\t\t\ttry {\n\t\t\t\tparsed = yaml.load(retried, { schema: userPatchesSchema });\n\t\t\t} catch {\n\t\t\t\tthrow new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);\n\t\t\t}\n\t\t} else {\n\t\t\tthrow new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);\n\t\t}\n\t}'
  const HELPER = '\n/**\n * 容错辅助（issue #5）：若文件含顶格空数组占位行（`[]` / `[ ]`，可带行尾注释），视为 no-op 移除。\n */\nfunction tryDropEmptyArrayPlaceholder(content) {\n\tconst lines = String(content).split("\\n");\n\tconst kept = [];\n\tlet dropped = false;\n\tfor (const line of lines) {\n\t\tif (/^\\[\\s*\\]\\s*(?:#.*)?$/u.test(line)) {\n\t\t\tdropped = true;\n\t\t\tcontinue;\n\t\t}\n\t\tkept.push(line);\n\t}\n\tif (!dropped) return null;\n\treturn kept.join("\\n");\n}\n'
  try {
    copyFileSync(target, `${target}.bak-issue5`)
    const next = source.replace(OLD, NEW) + HELPER
    writeFileSync(target, next, 'utf8')
    return { applied: true, target }
  } catch (error) {
    return { applied: false, reason: `应用失败：${error.message}` }
  }
}

/** 清理残留的框架升级/回滚/重启计划任务（脚本被强杀时它来不及自删）。
 *  v0.3.43：把「重启」与「重启守护」任务也纳入——2026-09-11 现场残留了 5 个 Ready 僵尸任务
 *  （DSH-Restart-13804 / -31688 / -3744 / RestartV2 / RestartV3），正是"重启后没人拉起"的证据。
 *  只在服务已经起来了的时候清理是安全的：服务在跑 ⇒ 守护任务无事可做（它自己也会立刻收工）。 */
function cleanupStaleFwTasks() {
  try {
    execFile('schtasks', ['/query', '/fo', 'CSV', '/nh'], { windowsHide: true, timeout: 20000 }, (error, stdout) => {
      if (error) return
      const names = String(stdout).split(/\r?\n/u)
        .map((line) => (line.match(/^"([^"]*)"/u)?.[1] ?? '').trim())
        .filter((name) => /^\\?DSH-(?:FW-(?:Upgrade|Rollback)|Restart(?:V\d+)?|RestartGuard)-\d+$/u.test(name))
      for (const name of names) {
        execFile('schtasks', ['/delete', '/f', '/tn', name], { windowsHide: true, timeout: 20000 }, () => {})
      }
    })
  } catch {}
}

/** 定位框架安装根（顶层 node_modules）：优先运行进程入口，其次从包目录上溯找含 .pnpm 的 node_modules。 */
function resolveFrameworkRootNodeModules(fromDir) {
  try {
    const entry = process.argv[1]
    if (typeof entry === 'string' && /bin\.js$/u.test(entry)) {
      const nm = dirname(dirname(entry))
      if (existsSync(join(nm, '.pnpm')) && existsSync(join(nm, '@deepseek-ai'))) return nm
    }
  } catch {}
  let dir = typeof fromDir === 'string' && fromDir !== '' ? fromDir : null
  for (let i = 0; i < 24 && dir !== null; i += 1) {
    if (basename(dir) === 'node_modules' && existsSync(join(dir, '.pnpm'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 框架全树 checkpoint（可靠回滚点）：镜像 .pnpm 中所有 @deepseek-ai 条目「自包」内容 +
 * 顶层 @deepseek-ai scope + lock.yaml。只镜像自包、不跟随依赖 junction，避免重复拷贝；
 * 恢复时按同路径写回 .pnpm 条目即可让整个依赖世界回到升级前。
 */
function checkpointFrameworkTree(fwRoot, destRoot) {
  const pnpmRoot = join(fwRoot, '.pnpm')
  const dest = join(destRoot, 'fw-tree', String(Date.now()))
  mkdirSync(dest, { recursive: true })
  let mirrored = 0
  const selfNameOf = (entryName) => entryName.slice('@deepseek-ai+'.length).split('@')[0]
  for (const entry of readdirSync(pnpmRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('@deepseek-ai+')) continue
    const name = selfNameOf(entry.name)
    const selfDir = join(pnpmRoot, entry.name, 'node_modules', '@deepseek-ai', name)
    if (!existsSync(join(selfDir, 'package.json'))) continue
    copyTree(selfDir, join(dest, '.pnpm', entry.name, 'node_modules', '@deepseek-ai', name))
    mirrored += 1
  }
  const topScope = join(fwRoot, '@deepseek-ai')
  if (existsSync(topScope)) copyTree(topScope, join(dest, 'top-@deepseek-ai'))
  try { copyFileSync(join(pnpmRoot, 'lock.yaml'), join(dest, 'lock.yaml')) } catch {}
  try { copyFileSync(join(fwRoot, 'package.json'), join(dest, 'fw-package.json')) } catch {}
  return { dest, mirrored }
}

/**
 * 宿主形态识别（2026-09-26 真机事故后的**加法分支**）。
 *
 * 事故现场（官方桌面端实例，127.0.0.1:19387，20:28）：
 *   桌面端里 DSH host 是 **Electron 二进制**跑的 asar 内入口
 *   （`D:\dsh-desktop\DeepSeek Harness.exe --expose-internals …\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js …`），
 *   不是 `node bin.js web`。我们的「重启服务 / 回滚 / 框架升级重启」那一套会
 *   `Stop-Process` 掉 host，然后 `Resolve-DshBin` 三种方式全找不到 bin.js
 *   （桌面端 profile 的 node_modules 里根本没有 `@deepseek-ai` 作用域）→ 拉不起来 →
 *   Electron 外壳记 `crash-…-host.log: dsh desktop host exited with 4294967295`。
 *
 * 判据（**只看「我们自己是不是被 Electron 运行时承载」**，任一命中即判定为外壳托管）：
 *   ① `process.versions.electron` 非空 —— 当前进程就跑在 Electron 运行时里（含 ELECTRON_RUN_AS_NODE 模式）；
 *   ② 环境变量 `ELECTRON_RUN_AS_NODE` 非空 —— Electron 以 Node 模式承载 DSH host；
 *   ③ `process.execPath` 或任一 `process.argv` 命中 `resources\app.asar` —— 入口在打包 Electron 应用内；
 *   ④ `process.execPath` 文件名是 `electron(.exe)`；
 *   ⑤ `process.resourcesPath` 存在 **且** execPath 文件名不是 node —— 纯 Node 进程没有这个属性。
 *
 * **刻意不用「父进程是 Electron 外壳」当判据**：本机实测（2026-09-26）独立实例
 *   `node …\dsh\lib\bin.js web --no-open`（3080, pid 32464）的父进程也是 Electron
 *   （`%TEMP%\…\DeepSeek Harness.exe`，用户的启动器），拿父进程判定会把**独立 dsh web 实例误判成桌面端托管**
 *   —— 那正好违反「独立 dsh web 进程的既有行为一字不改」。父进程只作为 evidence 记录，不参与判定。
 */
const SHELL_HOSTED_NOTICE = '本实例由桌面端外壳托管，请在桌面端内重启/更新'

function detectHostShape(deps = {}) {
  const env = deps.env ?? process.env ?? {}
  const versions = deps.versions ?? process.versions ?? {}
  const execPath = String(deps.execPath ?? process.execPath ?? '')
  const argv = Array.isArray(deps.argv) ? deps.argv : (process.argv ?? [])
  const resourcesPath = deps.resourcesPath === undefined ? process.resourcesPath : deps.resourcesPath
  const reasons = []
  const electronVersion = typeof versions.electron === 'string' && versions.electron !== '' ? versions.electron : ''
  if (electronVersion !== '') reasons.push(`process.versions.electron=${electronVersion}（当前进程跑在 Electron 运行时里）`)
  const runAsNode = typeof env.ELECTRON_RUN_AS_NODE === 'string' && env.ELECTRON_RUN_AS_NODE !== '' ? env.ELECTRON_RUN_AS_NODE : ''
  if (runAsNode !== '') reasons.push(`环境变量 ELECTRON_RUN_AS_NODE=${runAsNode}（Electron 以 Node 模式承载 DSH host）`)
  const argvText = argv.map((a) => String(a ?? ''))
  const asarHit = [execPath, ...argvText].find((p) => /resources[\\/]app\.asar/iu.test(p)) ?? null
  if (asarHit !== null) reasons.push(`入口在打包 Electron 应用内（${asarHit}）`)
  const exeBase = basename(execPath).toLowerCase()
  if (/^electron(\.exe)?$/u.test(exeBase)) reasons.push(`process.execPath 是 Electron（${execPath}）`)
  const resourcesText = typeof resourcesPath === 'string' ? resourcesPath : ''
  if (resourcesText !== '' && !/^node(\.exe)?$/u.test(exeBase)) {
    reasons.push(`process.resourcesPath 存在（${resourcesText}）且可执行文件不是 node（${exeBase || '未知'}）`)
  }
  const hosted = reasons.length > 0
  return {
    hosted,
    kind: hosted ? 'desktop-shell' : 'standalone',
    reasons,
    notice: hosted ? SHELL_HOSTED_NOTICE : null,
    evidence: {
      execPath,
      argv1: String(argv[1] ?? ''),
      asarEntry: asarHit,
      electronVersion,
      runAsNode,
      resourcesPath: resourcesText === '' ? null : resourcesText,
      ppid: typeof deps.ppid === 'number' ? deps.ppid : (typeof process.ppid === 'number' ? process.ppid : null),
    },
  }
}

/**
 * 外壳托管时的标准拒绝载荷（**纯数据，不碰 HTTP**）：路由层负责把它翻成响应。
 * 返回 null = 独立 `dsh web` 实例，调用方走原路径（一字不改）。
 */
function shellHostedRefusal(deps) {
  const shape = detectHostShape(deps)
  if (shape.hosted !== true) return null
  return {
    error: SHELL_HOSTED_NOTICE,
    details: { code: 'hosted-by-shell', hostKind: shape.kind, reasons: shape.reasons, evidence: shape.evidence },
  }
}

/**
 * 生成「拉起 DSH 服务」的 PowerShell 前导块（升级脚本 / 回滚脚本共用，v0.3.37 事故修复）。
 *
 * 2026-09-11 事故：脚本在「重启服务」这一步崩溃，服务没人拉起（框架其实已经升级成功，
 * 界面却显示全红）。根因是一条**静默的 null**：
 *     $binNow = ''; try { $binNow = (& node -e "…require.resolve…" | Select-Object -Last 1) } catch {}
 *     if ($binNow -ne '' -and (Test-Path $binNow)) { … }
 * 当 node 解析那一瞬间失败（新版链接尚未就绪等）时输出为空 → `Select-Object -Last 1` 让
 * `$binNow` 变成 **$null**，而 PowerShell 里 `$null -ne ''` 是 **true**（守卫失效）→
 * `Test-Path $null` 抛「无法将参数绑定到参数"Path"，因为该参数是空值」→ 脚本当场终止。
 * 同一段代码原先被复制了 5 份，所以这个坑反复出现。
 *
 * 现在：只保留这一份实现，并且
 *   1) 返回值**永不为 $null**（非字符串一律归一成空串，再做 IsNullOrWhiteSpace 判断）；
 *   2) 解析走**多级回退**（不再假设某一处路径一定可用）：node resolve → 目标版本的 .pnpm 实体
 *      目录 → 顶层可见链接 → .pnpm 里最新的一个；
 *   3) 全路径参数一律 `Test-Path -LiteralPath`，失败只记录、不抛错。
 */
function relaunchPrelude({ nodePath, pluginDir, fwRoot, target, ps, hosted }) {
  // 未显式传 hosted 时自己判定一次（自接线，避免调用方漏传导致守卫失效）。
  // 独立 `dsh web` 实例下 detectHostShape().hosted === false ⇒ 生成结果与旧实现逐字节相同。
  const shellHosted = typeof hosted === 'boolean' ? hosted : detectHostShape().hosted === true
  const probe = "const path=require('path');const p=require.resolve('@deepseek-ai/dsh/package.json',{paths:[process.env.DSH_RESOLVE_ROOT]});console.log(path.join(path.dirname(p),'lib','bin.js'))"
  const pnpmBin = (dirExpr) => `Join-Path ${dirExpr} 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'`
  // 外壳托管（桌面端 Electron 承载）：脚本里**只留一句拒绝**，绝不 Start-Process 拉起第二个实例。
  // `hosted === false` 时这里是空数组 —— 生成的脚本与旧实现**逐字节相同**（加法分支）。
  const hostedFlag = shellHosted === true ? [`$script:DSH_HOSTED = $true`] : []
  const hostedGuard = shellHosted === true
    ? [`  if ($script:DSH_HOSTED) { Log ('本实例由桌面端外壳托管，跳过拉起（' + $tag + '）：请在桌面端内重启/更新'); return $false }`]
    : []
  return [
    `$launchLog = ''`,
    ...hostedFlag,
    // 心跳（v0.3.39）：脚本每推进一小步就更新一次心跳文件的时间戳。服务端据此区分
    // 「脚本还在干活」与「脚本进程被系统/启动器杀掉」。2026-09-11 真机事故：回滚脚本
    // 干完活之后被 Ctrl+C 类事件结束（计划任务 Last Result = 0xC000013A），终态没写成，
    // 界面就永远卡在「回滚中…」——有心跳就能判定「脚本已死 + 现实是什么」。
    `$hb = $state + '.hb'`,
    `function Beat { try { Set-Content -Path $hb -Value ([string](Get-Date).Ticks) -Encoding UTF8 } catch {} }`,
    `try { Beat } catch {}`,
    `try { if ($log) { $launchLog = Join-Path (Split-Path -LiteralPath $log) 'fw-relaunch.log' } } catch {}`,
    `if ([string]::IsNullOrWhiteSpace($launchLog)) { $launchLog = Join-Path $env:TEMP 'fw-relaunch.log' }`,
    `function Resolve-DshBin {`,
    `  $cand = ''`,
    `  try { $env:DSH_RESOLVE_ROOT = ${ps(pluginDir)}; $cand = (& ${ps(nodePath)} -e "${probe}" 2>$null | Select-Object -Last 1) } catch { $cand = '' }`,
    `  if ($cand -isnot [string]) { $cand = '' }`,
    `  $cand = ([string]$cand).Trim()`,
    `  if ($cand -ne '' -and (Test-Path -LiteralPath $cand)) { return $cand }`,
    `  try { foreach ($d in @(Get-ChildItem -Path (Join-Path ${ps(fwRoot)} '.pnpm') -Directory -Filter '@deepseek-ai+dsh@${target}*' -ErrorAction SilentlyContinue)) { $c = ${pnpmBin('$d.FullName')}; if (Test-Path -LiteralPath $c) { return $c } } } catch {}`,
    `  try { $c = ${ps(join(fwRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))}; if (Test-Path -LiteralPath $c) { return $c } } catch {}`,
    `  try { foreach ($d in @(Get-ChildItem -Path (Join-Path ${ps(fwRoot)} '.pnpm') -Directory -Filter '@deepseek-ai+dsh@*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) { $c = ${pnpmBin('$d.FullName')}; if (Test-Path -LiteralPath $c) { return $c } } } catch {}`,
    `  return ''`,
    `}`,
    `function Invoke-DshRelaunch($tag) {`,
    ...hostedGuard,
    `  $bin = Resolve-DshBin`,
    `  if ([string]::IsNullOrWhiteSpace($bin)) { Log ('拉起失败（' + $tag + '）：node resolve / .pnpm / 顶层链接 三种方式都找不到 dsh 的 bin.js，请手动启动 DSH'); return $false }`,
    `  try { Add-Content -Path $launchLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' 拉起(' + $tag + '): ' + $bin) -Encoding UTF8 } catch {}`,
    `  try { Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + ${ps(nodePath)} + '" "' + $bin + '" web >> "' + $launchLog + '" 2>&1')) -WindowStyle Hidden } catch { Log ('拉起进程启动失败（' + $tag + '）：' + $_.Exception.Message); return $false }`,
    `  Log ('已发起拉起服务（' + $tag + '，输出见 fw-relaunch.log）')`,
    `  return $true`,
    `}`,
  ].join('\r\n')
}

/**
 * 拉 registry 元数据 → 解出「可选升级版本列表 + 本次目标」（2026-09-24 从 framework-upgrade 路由收进来：
 * 那段逻辑 13 行，而路由文件贴着架构守卫上限；收进 domain 后路由只剩一行调用，也更方便被单测覆盖）。
 *
 * @param {object} p
 * @param {string|null} p.current 当前框架版本
 * @param {string} p.wanted    用户显式选择的目标版本（空串 = 没选）
 * @param {(url: string) => Promise<any>} p.fetchJson 取 JSON 的实现（由路由传入，domain 不直接碰网络层）
 * @returns {Promise<{ latest, next, alpha, versions, tagDefault, target, rejected, registryError }>}
 */
async function resolveFrameworkUpgradePlan({ current, wanted = '', fetchJson }) {
  let latest = null
  let next = null
  let alpha = null
  let versions = []
  let tagDefault = null
  let registryError = null
  try {
    const data = await fetchJson('https://registry.npmmirror.com/@deepseek-ai%2fdsh')
    latest = data?.['dist-tags']?.latest ?? null
    next = data?.['dist-tags']?.next ?? null
    alpha = data?.['dist-tags']?.alpha ?? null
    const cand = frameworkUpgradeCandidates(data, current)
    versions = cand.versions
    tagDefault = cand.tagDefault
  } catch (error) {
    // 网络黑洞/超时：区分「检测失败」与「无更新」，避免误导用户以为已是最新
    registryError = error instanceof Error ? error.message : String(error)
  }
  const picked = pickFrameworkTarget({ current, latest, next, wanted, candidates: versions })
  return { latest, next, alpha, versions, tagDefault, target: picked.target, rejected: picked.rejected, registryError }
}

/**
 * 解析"这次要升到哪个版本"（2026-09-23 抽出：原先 framework-check 与 framework-upgrade 各写了一份，
 * 加了「用户自选版本」后两份逻辑必须完全一致，索性收成一处）。
 *
 * @param {object} p
 * @param {string|null} p.current 当前框架版本
 * @param {string|null} p.latest  dist-tags.latest
 * @param {string|null} p.next    dist-tags.next
 * @param {string} [p.wanted]     用户在面板里显式选的版本（空串 = 没选）
 * @param {Array<{version: string}>} [p.candidates] 可选候选列表（有 wanted 时必须提供，用作白名单校验）
 * @returns {{ target: string|null, rejected: string|null }} rejected 非空 = 用户选的版本非法
 */
function pickFrameworkTarget({ current, latest, next, wanted = '', candidates = [] }) {
  const want = typeof wanted === 'string' ? wanted.trim() : ''
  if (want !== '') {
    const hit = candidates.find((v) => v.version === want)
    return hit === undefined ? { target: null, rejected: want } : { target: hit.version, rejected: null }
  }
  return {
    // 稳定版 latest 优先；latest 不高于当前而 next（预发布渠道）确实更新时，目标取 next。
    // 必须用版本号比较而不是字符串不等（避免 current=0.1.1 稳定版时被 next=0.1.1-rc.3 反向降级）。
    target: latest !== null && current !== null && isFrameworkVersionNewer(latest, current)
      ? latest
      : (next !== null && current !== null && isFrameworkVersionNewer(next, current) ? next : null),
    rejected: null,
  }
}

/** 目标版本是否 ≥ since（只比 major.minor.patch，忽略 rc 段——0.1.5-rc.1 也算已达 0.1.5 变更）。 */
function isVersionAtLeast(target, since) {
  const t = parseFrameworkVersion(target)
  const s = parseFrameworkVersion(since)
  if (t === -1 || s === -1) return false
  if (t.maj !== s.maj) return t.maj > s.maj
  if (t.min !== s.min) return t.min > s.min
  return t.pat >= s.pat
}

/** 备份当前 profile 配置快照（按版本目录；框架升级后旧版本目录即升级前配置）。 */
function backupProfileSnapshot(profileDir, version, ports) {
  const dir = join(FRAMEWORK_BACKUP_ROOT(), version)
  mkdirSync(dir, { recursive: true })
  try { copyFileSync(join(profileDir, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml')) } catch {}
  try { copyFileSync(join(profileDir, 'package.json'), join(dir, 'profile-package.json')) } catch {}
  try {
    const plugins = listEntries(ports).map((e) => {
      const meta = entryPkgMeta(e.moduleName, ports.baseUrl ?? 'file:///', profileDirOf(ports))
      return { rowId: e.rowId, moduleName: e.moduleName, enabled: e.enabled, version: meta?.version ?? null, installDate: meta?.installDate ?? null }
    })
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify(plugins, null, 2), 'utf8')
  } catch {}
  return dir
}

/** 框架升级检测与适配：记录版本 → 每次启动备份配置快照 → 升级/首次时重打框架补丁。 */
function detectFrameworkUpgrade(ports) {
  let current = null
  try {
    const require = createRequire(ports.baseUrl ?? 'file:///')
    const dshPkg = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
    current = dshPkg.version ?? null
  } catch {}
  const statePath = FRAMEWORK_STATE_FILE()
  let prev = null
  try { prev = JSON.parse(readFileSync(statePath, 'utf8')) } catch {}
  const upgraded = prev !== null && prev.lastVersion !== null && current !== null && prev.lastVersion !== current
  const result = { version: current, upgraded, from: prev?.lastVersion ?? null, backupDir: null, patchApplied: false, patchNote: null }
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    const profileDir = dirname(findPatchPath(ports))
    if (current !== null) result.backupDir = backupProfileSnapshot(profileDir, current, ports)
    const patch = applyFrameworkTolerancePatchOnce(ports.baseUrl ?? 'file:///')
    result.patchApplied = patch.applied
    result.patchNote = patch.reason ?? null
    writeFileSync(statePath, JSON.stringify({ lastVersion: current, backupAt: Date.now() }), 'utf8')
  } catch {}
  return result
}

/** 当前运行框架版本（@deepseek-ai/dsh package.json）。 */
function currentFrameworkVersion(ports) {
  try {
    const require = createRequire(ports?.baseUrl ?? 'file:///')
    const pkgPath = require.resolve('@deepseek-ai/dsh/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 框架升级前置门禁（用户硬要求：「升级后所有不适配的必须先禁用」）。
 * 在升级脚本执行**之前**扫描全部可开关行，对目标框架版本判定为 fail 的行就地写 disabled:true，
 * 并记入 compat-pending（UI 显示「待适配」，更新后一键解锁）。这样新框架 boot 时不会因为
 * 某行 import 失败而整树崩溃（loader 单行失败 = 服务起不来）。
 * 受保护行/核心行/自身永不禁用——禁它们本身就会让服务起不来。
 * 返回 { disabled:[{rowId,moduleName,version,reason}], skipped:[{rowId,reason}] } */
async function preflightDisableIncompatible({ ports, profileDir, patchPath, targetVersion }) {
  const disabled = []
  const skipped = []
  const gate = readCompatGate()
  if (typeof targetVersion !== 'string' || targetVersion === '') return { disabled, skipped }
  let entries = []
  try { entries = listEntries(ports) } catch { return { disabled, skipped } }
  let pending = readCompatPending()
  if (pending === null || !Array.isArray(pending.pending)) pending = { frameworkVersion: targetVersion, upgradeFrom: null, pending: [] }
  for (const entry of entries) {
    if (typeof entry.rowId !== 'string' || entry.rowId === '') continue
    if (!entry.enabled) continue
    if (entry.rowId === 'plugin-console') continue // 控制台自己永不禁用
    if (!entry.toggleable || CORE_PATCH_ROW_IDS.has(entry.rowId)) {
      skipped.push({ rowId: entry.rowId, reason: '受保护/核心行（禁用会让服务起不来，改由启动失败隔离兜底）' })
      continue
    }
    let pkg = null
    let pkgDir = null
    try {
      const pkgPath = resolvePackageJson(entry.moduleName, profileDir)
      if (pkgPath !== null) { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); pkgDir = dirname(pkgPath) }
    } catch {}
    if (pkg === null) {
      skipped.push({ rowId: entry.rowId, reason: '无法读取包信息（保持启用，改由启动失败隔离兜底）' })
      continue
    }
    // v0.3.35：框架自带包永不自动禁用（真机演练抓到：框架自己的 settings 控制器被误判成不适配）。
    // 它们与框架同源安装，禁用不是正确处置——正确处置是回滚；误判则直接砍掉框架功能。
    if (isFrameworkOwnedPackage(pkgDir, profileDir)) {
      skipped.push({ rowId: entry.rowId, reason: '框架自带包（与框架同源安装，禁用不是正确处置，改由回滚兜底）' })
      continue
    }
    let check = { decision: 'unknown', reason: '' }
    try { check = checkPluginFrameworkCompat(pkg, targetVersion, pkgDir) } catch (error) { check = { decision: 'unknown', reason: error instanceof Error ? error.message : String(error) } }
    if (check.decision !== 'fail') continue // pass / unknown 一律不禁用（避免过度禁用把功能砍掉）
    if (gate.autoDisable !== true) {
      // 总开关关闭：只报告不动开关（用户定案：自动行为必须可关）
      skipped.push({ rowId: entry.rowId, reason: `判定不适配（${check.reason ?? '不兼容'}），但「升级时自动禁用」已关闭——保持启用，请手动处理` })
      continue
    }
    try {
      await disableEntry(patchPath, entry.rowId)
    } catch (error) {
      skipped.push({ rowId: entry.rowId, reason: `禁用写入失败：${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const version = typeof pkg.version === 'string' ? pkg.version : null
    disabled.push({ rowId: entry.rowId, moduleName: entry.moduleName, version, reason: check.reason ?? null })
    const record = {
      rowId: entry.rowId,
      moduleName: entry.moduleName,
      version,
      status: 'pending',
      check: 'fail',
      checkNote: check.reason ?? null,
      forcedAt: Date.now(),
      source: 'preflight-disabled-before-upgrade',
    }
    const at = pending.pending.findIndex((p) => p.rowId === entry.rowId)
    if (at >= 0) pending.pending[at] = { ...pending.pending[at], ...record }
    else pending.pending.push(record)
  }
  if (disabled.length > 0) {
    pending.frameworkVersion = targetVersion
    pending.updatedAt = new Date().toISOString()
    writeCompatPending(pending)
  }
  return { disabled, skipped }
}
export { FRAMEWORK_STATE_FILE, FRAMEWORK_BACKUP_ROOT, SHELL_HOSTED_NOTICE, detectHostShape, shellHostedRefusal, cleanupStaleFwTasks, resolveDshBin, locateAppBootFile, applyFrameworkTolerancePatchOnce, resolveFrameworkRootNodeModules, checkpointFrameworkTree, relaunchPrelude, isVersionAtLeast, pickFrameworkTarget, resolveFrameworkUpgradePlan, currentFrameworkVersion, backupProfileSnapshot, detectFrameworkUpgrade, preflightDisableIncompatible }
