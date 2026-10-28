// L1 · domain —— 「自动拉起失败」之后该不该回滚（2026-10-28 真机事故）
//
// ── 事故现场（必须理解，否则这堆代码看着像过度设计）────────────────────────────
// 用户从 0.2.0-rc.2 升 0.2.1-rc.4，`fw-upgrade.log` 明确写着：
//   16:23:25 结构校验通过：package.json + bin.js 就位，CLI 自报 0.2.1-rc.4
//   16:23:25 框架本体升级完成
//   16:23:25 顶层可见版本校验通过
//   … 16:28:32 重启 DSH 服务生效…
//   … 16:30:18 服务拉起失败 → 先做启动失败隔离（隔离肇事者后重试，不直接回滚）
//   16:30:18 隔离分析无输出
//   16:30:18 服务拉起失败，尝试自动回滚到升级前版本…
//   16:30:33 全树回滚完成：恢复 62 个版本包 + 顶层 scope
// 而 `fw-relaunch.log` 里**只有一行时间戳 + bin 路径，没有任何子进程输出**。
//
// 结论（用户判断 + 我认同）：**框架本体是好的**（CLI 自报 0.2.1-rc.4 跑得出来），
// 坏的是「自动拉起」这条脚本路径。旧链条是「拉起失败 → 立刻回滚」，等于把一次成功的
// 升级连同一个说不清的原因一起扔掉 —— 而且失败原因一个字都没留下。
//
// 本模块只承担一件事：**把「失败原因文本 → 是否回滚」这条判断收成一个纯函数**，
// 并且让它在 PowerShell 执行期也能被调用（PS 只负责把原因文本交出去、拿回结论，
// 判断逻辑一行都不许写进 ps1 字符串里 —— 那样既测不到，也会再次分叉）。
//
// 分工：
//   · judgeRelaunchFailure()     纯函数判定（本文件，tests/test-framework-relaunch-verdict.mjs 钉死）
//   · relaunchVerdictHelperSource()  生成十几行的转发脚本（PS 用 node 调它，逻辑仍在本模块）
//   · relaunchVerdictBlock()     生成 PS 执行块（回滚 / 保留 + 写 ready 状态 + 给手动命令）

/**
 * 「框架树真的坏了」的特征串（命中即回滚）。
 *
 * 2026-10-28 现场校准（用户真机证据，比猜测更硬）：
 *   · 用户**手动**跑 `node "…\@deepseek-ai\dsh\lib\bin.js" web --no-open` —— **能正常起来**
 *     （当前 web 就靠它跑着，3080 在监听）。也就是说启动命令 / profile / 这套插件本身都是好的；
 *   · 而脚本拉起失败时 `fw-relaunch.log` **一个字都没有** —— 若真是插件 import 失败，
 *     node 会把 `Cannot find package …` 打到 stderr，而拉起命令带着 `2> err`，本应留痕。
 *     **没有痕迹 ⇒ 更可能是脚本发起的子进程根本没活下来**（父子进程/控制台归属），不是加载崩溃。
 * 所以判据必须**窄**：只有明确的"模块解析失败 / 关键文件缺失"才算框架树坏；
 * 其余一切（秒退、无输出、超时、端口占用…）都归到"框架已就位、只是没拉起来"→ **不回滚**。
 *
 * 明确的树损坏证据（两类，缺一不可地写成整句，避免 "bin.js" 这种散词误伤）：
 *   ① 模块解析失败：Cannot find package / ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND /
 *      Cannot find module / ERR_PACKAGE_PATH_NOT_EXPORTED
 *   ② 关键文件缺失：bin.js 缺失（Invoke-DshRelaunch 自己的措辞）、package.json 不存在
 * 反过来，这些**不许**命中（否则好框架会被回滚掉）：
 *   · `EADDRINUSE`（端口被占 —— 常见于上一个实例还没退干净，重试/换实例即可）
 *   · `listen EACCES`、`npm ERR!`、超时类文本、`child-exited-early`（秒退但无错误文本）
 */
const TREE_DAMAGE_MARKERS = [
  'Cannot find package',
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'Cannot find module',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  '找不到 dsh 的 bin.js',
  'package.json 不存在',
]

/** 状态/日志里给用户的手动启动命令（用户真机就是这么救回来的：`--no-open` 不要弹浏览器）。 */
const MANUAL_URL_FLAGS = 'web --no-open'

/** 由真实 bin 路径拼手动启动命令（拿不到路径时返回空串 —— 绝不编一个假路径）。 */
function manualRelaunchCommand(binPath) {
  const bin = typeof binPath === 'string' ? binPath.trim() : ''
  if (bin === '') return ''
  return `node "${bin}" ${MANUAL_URL_FLAGS}`
}

/** 原因摘录的最大长度（状态文件是单行 `status|message`，太长会把界面撑爆）。 */
const REASON_EXCERPT_LIMIT = 240

/**
 * 把任意输入归一成"可以写进状态文件/日志的一行文本"。
 * 关键点：状态文件格式是 `status|message`，且会被 `/framework-upgrade-status` 按 `|` 切分，
 * 所以原因里的换行与竖线必须先抹平（否则 message 会被切碎、stage= 判定也会错位）。
 */
function flatReason(value, limit = REASON_EXCERPT_LIMIT) {
  const raw = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value))
  const flat = raw.replace(/\s+/gu, ' ').replace(/\|/gu, '/').trim()
  if (flat === '') return ''
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * **唯一**的「拉起失败 → 是否回滚」判据（纯函数，无 IO、无宿主）。
 *
 * 规则（顺序即优先级，tests/test-framework-relaunch-verdict.mjs 逐条钉死）：
 *   ① 没有失败原因（空/空白）→ ok：不需要判定，什么都不做（幂等边界）；
 *   ② 原因明确指向框架树损坏 → rollback（缺包/模块解析失败时回滚是**对的**：
 *      那种树留着重启也好不了）；
 *   ③ 结构校验通过 **且** 顶层可见版本校验通过 → keep：框架已就位，**不回滚**，
 *      状态写成 ready + 手动启动命令（这次事故就是这一类：框架好好的，只是没拉起来）；
 *   ④ 其余（结构校验没过 / 顶层版本没验过）→ rollback：证据不足时保守回滚，
 *      绝不把一棵来路不明的树留成"已就位"。
 *
 * @param {object} p
 * @param {string|null} [p.reason] 拉起失败原因（Invoke-DshRelaunch 的返回值）
 * @param {boolean} [p.structureVerified] 结构校验是否通过（package.json + bin.js + CLI 自报版本）
 * @param {boolean} [p.topLevelVerified]  顶层可见版本校验是否通过
 * @param {string} [p.binPath]  真实的 dsh bin.js 路径（拼手动启动命令用；空串 = 没解析出来）
 * @returns {{ verdict: 'ok'|'rollback'|'keep', rollback: boolean, treeDamaged: boolean,
 *   reasonExcerpt: string, status: string|null, manualCommand: string|null }}
 */
function judgeRelaunchFailure({ reason = '', structureVerified = false, topLevelVerified = false, binPath = '' } = {}) {
  const reasonExcerpt = flatReason(reason)
  // ① 没有原因 = 没有失败要判（调用方只在拉起失败时问，但纯函数自己也要幂等）
  if (reasonExcerpt === '') {
    return { verdict: 'ok', rollback: false, treeDamaged: false, reasonExcerpt: '', status: null, manualCommand: null }
  }
  // ② 框架树损坏特征（**优先于**③的放行规则：结构校验在安装完那一刻通过，
  //    但拉起时才暴露的缺包同样是真坏树）
  const treeDamaged = TREE_DAMAGE_MARKERS.some((marker) => reasonExcerpt.includes(marker))
  if (treeDamaged) {
    return { verdict: 'rollback', rollback: true, treeDamaged: true, reasonExcerpt, status: null, manualCommand: null }
  }
  // ③ 框架本体已被两组校验证明是好的 → 只保留一条"请手动启动"的明确状态
  if (structureVerified === true && topLevelVerified === true) {
    const cmd = manualRelaunchCommand(binPath)
    const tail = cmd === '' ? '请手动启动 DSH（本机 bin.js 路径未解析出来，可用控制台的「重启服务」）' : `请手动运行 ${cmd} 或点「重启服务」`
    return {
      verdict: 'keep',
      rollback: false,
      treeDamaged: false,
      reasonExcerpt,
      status: `框架已就位，自动拉起失败：${reasonExcerpt}；${tail}`,
      manualCommand: cmd === '' ? null : cmd,
    }
  }
  // ④ 证据不足 → 保守回滚
  return { verdict: 'rollback', rollback: true, treeDamaged: false, reasonExcerpt, status: null, manualCommand: null }
}

/**
 * 生成「回滚判定器」转发脚本源码（写进 `<DSH_HOME>/plugin-console/fw-relaunch-verdict.mjs`）。
 * 与既有 `fw-analyze-boot.mjs` 同一手法：**判断逻辑留在插件内，落盘文件只做转发**，
 * 这样 ps1 里永远只有"调用 + 按结论分支"，判据仍然只有一份、仍然可被单测覆盖。
 *
 * @param {object} p
 * @param {string} p.libUrl 本模块的 file:// URL（由调用方用 pathToFileURL 算好）
 * @returns {string} 可直接 writeFileSync 的 .mjs 源码
 */
function relaunchVerdictHelperSource({ libUrl }) {
  return [
    '// 自动生成：自动拉起失败的「是否回滚」判定器（逻辑在插件内，本文件只做转发）',
    `import { judgeRelaunchFailure } from ${JSON.stringify(libUrl)}`,
    "import { readFileSync } from 'node:fs'",
    'const [reasonPath, structureFlag, topFlag, binPath] = process.argv.slice(2)',
    "let reason = ''",
    'try { reason = readFileSync(reasonPath, "utf8") } catch {}',
    'try {',
    '  process.stdout.write(JSON.stringify(judgeRelaunchFailure({',
    "    reason, structureVerified: structureFlag === '1', topLevelVerified: topFlag === '1', binPath,",
    '  })))',
    '} catch (error) { process.stdout.write(JSON.stringify({ error: String(error && error.message ? error.message : error) })) }',
    '',
  ].join('\n')
}

/**
 * 生成「拉起失败 → 判定 → 回滚 or 保留」的 PowerShell 执行块（整段作为一个数组元素展开）。
 *
 * 要求调用点已具备：`$log` / `SetState` / `Log` / `Beat` / `Resolve-DshBin` / `Invoke-Rollback` /
 * `Invoke-DshRelaunch`，以及三个由脚本自己维护的事实位：
 *   `$script:relaunchReason`（Invoke-DshRelaunch 的返回值）、
 *   `$script:structureOk`（结构校验）、`$script:topLevelOk`（顶层可见版本校验）。
 *
 * @param {object} p
 * @param {(s: string) => string} p.ps  PowerShell 双引号字符串字面量（与升级脚本共用同一份转义）
 * @param {string} p.nodePath            node.exe 绝对路径
 * @param {string} p.helperPath          判定器 .mjs 的绝对路径
 * @param {number} p.port                目标端口（沿用调用方的 webPort，不在这里另算）
 */
function relaunchVerdictBlock({ ps, nodePath, helperPath, port }) {
  return [
    `  $relaunchWhy = [string]$script:relaunchReason`,
    `  if ([string]::IsNullOrWhiteSpace($relaunchWhy)) { $relaunchWhy = '未记录到具体原因（拉起进程没有留下输出，脚本可能被外部中断）' }`,
    `  Log ('自动拉起失败 → 判定是否回滚：' + $relaunchWhy)`,
    // 原因走文件（避免命令行引号/长度把文本吃掉），判定走 node 调插件内的纯函数
    `  $reasonFile = $log + '.relaunch-reason.txt'`,
    `  try { Set-Content -Path $reasonFile -Value $relaunchWhy -Encoding UTF8 } catch {}`,
    `  $binForCmd = Resolve-DshBin`,
    `  $structureFlag = '0'; if ($script:structureOk) { $structureFlag = '1' }`,
    `  $topFlag = '0'; if ($script:topLevelOk) { $topFlag = '1' }`,
    `  $verdictJson = ''`,
    `  try { $verdictJson = (& ${ps(nodePath)} ${ps(helperPath)} $reasonFile $structureFlag $topFlag $binForCmd 2>$null | Select-Object -Last 1) } catch { Log ('回滚判定器调用失败：' + $_.Exception.Message) }`,
    `  $verdict = $null`,
    `  if (-not [string]::IsNullOrWhiteSpace($verdictJson)) { try { $verdict = $verdictJson | ConvertFrom-Json } catch { $verdict = $null } }`,
    `  if ($null -eq $verdict) {`,
    `    $verdict = [pscustomobject]@{ verdict = 'rollback'; rollback = $true; status = ''; manualCommand = '' }`,
    `    Log '回滚判定器不可用 → 按保守策略回滚（不把来路不明的树留成"已就位"）'`,
    `  }`,
    `  Log ('回滚判定：' + [string]$verdict.verdict)`,
    `  if ($verdict.rollback) {`,
    `    Log '服务拉起失败，尝试自动回滚到升级前版本…'`,
    `    Invoke-Rollback`,
    `    $ok = $false`,
    `    $started = $false`,
    `    for ($i = 0; $i -lt 20; $i++) {`,
    `      try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
    `      if (-not $ok -and -not $started) { $lr = Invoke-DshRelaunch '回滚后'; if ([string]::IsNullOrEmpty($lr)) { $started = $true } else { $script:relaunchReason = $lr } }; Beat`,
    `      Start-Sleep -Seconds 5`,
    `    }`,
    `  } else {`,
    // 保留分支：框架本体已在目标版本，**不回滚**；状态写成一个明确的终态 ready，
    // 并把真实的手动启动命令留给用户（服务此时是停的，界面看不到 —— 命令得能直接复制粘贴）。
    `    $script:keptReady = $true`,
    `    SetState 'ready' ([string]$verdict.status)`,
    `    Log ('框架本体已就位、不回滚：' + [string]$verdict.status)`,
    `    Log ('手动启动命令：' + [string]$verdict.manualCommand)`,
    `  }`,
  ].join('\r\n')
}

/**
 * 生成「读文件尾部」+「端口监听」两个小助手（PowerShell，整段作为一个数组元素展开）。
 *
 * · `Get-TailText`：把某文件的尾部压成一行、只留最后 600 字符 —— 失败原因要短到能进日志与状态文件。
 *   刻意**不用 `Test-Path` 探变量**（既有断言要求拉起助手块里的 Test-Path 只出现在
 *   Resolve-DshBin 的归一化变量上），直接 `Get-Content -ErrorAction SilentlyContinue`。
 * · `Test-RelaunchPort`：沿用调用方（webPort）算好的 `$relaunchPort`；为 0 时本判据整体失效，
 *   只按"进程存活"判定 —— 绝不在 domain 里自己编一个端口。
 */
function relaunchProbeHelpers() {
  return [
    `function Get-TailText($path) {`,
    `  $t = ''`,
    `  try { $t = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue } catch { $t = '' }`,
    `  if ([string]::IsNullOrEmpty($t)) { return '' }`,
    `  $t = ($t -replace '\\s+', ' ').Trim()`,
    `  if ($t.Length -gt 600) { $t = '…' + $t.Substring($t.Length - 600) }`,
    `  return $t`,
    `}`,
    `function Test-RelaunchPort {`,
    `  if ($relaunchPort -le 0) { return $false }`,
    `  try { $c = Get-NetTCPConnection -LocalPort $relaunchPort -State Listen -ErrorAction SilentlyContinue; if ($c) { return $true } } catch {}`,
    `  return $false`,
    `}`,
  ]
}

/**
 * 生成「拉起 DSH 服务并自证」的 PowerShell 函数（整段作为一个数组元素展开）。
 *
 * 2026-10-28 改错（真机：升级到 0.2.1-rc.4 后「自动拉起」无任何证据 → 好升级被当成失败回滚）：
 * 旧实现在这里 `Start-Process cmd /c "node bin.js web >> fw-relaunch.log 2>&1"` 之后**立刻**
 * `Log '已发起拉起服务'` + `return $true` —— fire-and-forget：不等、不验、不抓退出码。
 * 真机 `fw-relaunch.log` 里因此只剩一行时间戳 + bin 路径。现在做三件事：
 *   ① 拿句柄：`-PassThru`（cmd 包装 + `call` + 每轮独立的 .out/.err）。为什么不用
 *      `Start-Process node … -RedirectStandard*`（更"标准"但本机不可靠）：
 *      · PS 5.1 的 `-ArgumentList` 不会替含空格的路径加引号（本仓一直在手写引号）；
 *      · 本仓已实测记录过「schtasks 任务环境下带 -Redirect* 的子进程启动即退出、输出 0 字节」；
 *      · `call` 放在最前面还能避开 `cmd /c "…"` 的行首引号剥离（那会让重定向整段失效）。
 *   ② 等一小段（默认 30 秒，`$script:DSH_RELAUNCH_WAIT_SEC` 可覆盖）：**正面证据**才判成功
 *      —— 进程仍存活 **或** 端口开始监听；
 *   ③ 秒退/崩溃时留下 退出码 + **是否秒退**（`child-exited-early` / `child-exited`）+ stderr 尾部，
 *      并 `return` 失败原因字符串（不再是布尔：调用方要拿这段文本去判"该不该回滚"）。
 *
 * @param {object} p
 * @param {(s: string) => string} p.ps PowerShell 双引号字符串字面量（与升级脚本共用同一份转义）
 * @param {string} p.nodePath node.exe 绝对路径
 * @param {boolean} [p.hosted] 外壳托管（桌面端承载）时脚本里只留一句拒绝
 */
function relaunchInvoke({ ps, nodePath, hosted = false }) {
  const hostedGuard = hosted === true
    ? [`  if ($script:DSH_HOSTED) { Log ('本实例由桌面端外壳托管，跳过拉起（' + $tag + '）：请在桌面端内重启/更新'); return '本实例由桌面端外壳托管，不自动拉起' }`]
    : []
  return [
    `function Invoke-DshRelaunch($tag) {`,
    ...hostedGuard,
    `  $bin = Resolve-DshBin`,
    `  if ([string]::IsNullOrWhiteSpace($bin)) { Log ('拉起失败（' + $tag + '）：node resolve / .pnpm / 顶层链接 三种方式都找不到 dsh 的 bin.js，请手动启动 DSH'); return '找不到 dsh 的 bin.js（node resolve / .pnpm / 顶层链接 三种方式都失败）' }`,
    `  try { Add-Content -Path $launchLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' 拉起(' + $tag + '): ' + $bin) -Encoding UTF8 } catch {}`,
    // 每轮拉起用**独立**的 .out/.err：这轮失败才读得到这轮的 stderr（旧实现追加进同一个日志，
    // 跨轮次混在一起，事后没法判断"这次的证据在哪"）
    `  $outFile = $launchLog + '.out'`,
    `  $errFile = $launchLog + '.err'`,
    `  try { Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue } catch {}`,
    `  try { Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue } catch {}`,
    `  $proc = $null`,
    `  try {`,
    `    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('call "' + ${ps(nodePath)} + '" "' + $bin + '" web > "' + $outFile + '" 2> "' + $errFile + '"')) -PassThru -WindowStyle Hidden`,
    `  } catch {`,
    `    Log ('拉起进程启动失败（' + $tag + '）：' + $_.Exception.Message)`,
    `    return ('spawn-failed：拉起进程启动失败：' + $_.Exception.Message)`,
    `  }`,
    `  $startedAt = Get-Date`,
    `  $waitSec = 30`,
    `  if ($script:DSH_RELAUNCH_WAIT_SEC -gt 0) { $waitSec = [int]$script:DSH_RELAUNCH_WAIT_SEC }`,
    `  $deadline = (Get-Date).AddSeconds($waitSec)`,
    `  Log ('已发起拉起（' + $tag + '，PID ' + [string]$proc.Id + '，最多等 ' + [string]$waitSec + ' 秒自证，输出见 fw-relaunch.log）')`,
    // 判成功的**正面证据**只有两种：端口开始监听，或进程熬过整个观察窗口仍然存活
    `  while ($true) {`,
    `    $alive = $false`,
    `    try { if ($proc -and -not $proc.HasExited) { $alive = $true } } catch { $alive = $false }`,
    `    if (-not $alive) { break }`,
    `    if (Test-RelaunchPort) { Log ('拉起成功（' + $tag + '）：服务已监听端口 ' + [string]$relaunchPort + '（PID ' + [string]$proc.Id + '）'); return '' }`,
    `    if ((Get-Date) -ge $deadline) { Log ('拉起成功（' + $tag + '）：进程已存活 ' + [string]$waitSec + ' 秒（端口尚未监听，可能仍在启动）'); return '' }`,
    `    Start-Sleep -Milliseconds 1000`,
    `  }`,
    // 走到这里 = 进程已退出（秒退/崩溃）。这次事故就丢在这一步：必须留下退出码 + 秒退判定 + 输出尾部
    `  $elapsedSec = [int](((Get-Date) - $startedAt).TotalSeconds)`,
    `  $exitTag = 'child-exited'`,
    `  if ($elapsedSec -lt 5) { $exitTag = 'child-exited-early' }`,
    `  $codeText = '未知'`,
    `  try { $codeText = [string]$proc.ExitCode } catch { $codeText = '未知' }`,
    `  $tailOut = Get-TailText $outFile`,
    `  $tailErr = Get-TailText $errFile`,
    `  $tail = $tailErr`,
    `  if ([string]::IsNullOrWhiteSpace($tail)) { $tail = $tailOut }`,
    `  Log ('拉起失败（' + $tag + '）：' + $exitTag + '（' + [string]$elapsedSec + ' 秒后退出，exit=' + $codeText + '）')`,
    `  if ([string]::IsNullOrWhiteSpace($tail)) { Log ('拉起失败（' + $tag + '）：stdout/stderr 均为空 —— 没有任何证据留下（排查方向：子进程是否根本没活下来/控制台归属、cmd 引号与重定向、node 路径是否可执行）') }`,
    `  if (-not [string]::IsNullOrWhiteSpace($tail)) { Log ('拉起失败（' + $tag + '）输出尾部：' + $tail) }`,
    `  $why = $exitTag + '(exit=' + $codeText + ',' + [string]$elapsedSec + 's)'`,
    `  if (-not [string]::IsNullOrWhiteSpace($tail)) { $why = $why + '：' + $tail }`,
    `  return $why`,
    `}`,
  ]
}

export { judgeRelaunchFailure, relaunchVerdictHelperSource, relaunchVerdictBlock, relaunchProbeHelpers, relaunchInvoke, TREE_DAMAGE_MARKERS, REASON_EXCERPT_LIMIT, MANUAL_URL_FLAGS, manualRelaunchCommand }
