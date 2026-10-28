// L1 · domain —— 自动拉起服务 + 「拉起失败之后怎么办」（2026-10-28 真机事故，两轮修复）
//
// ── 第一轮现场（`<DSH_HOME>/plugin-console/fw-upgrade.log` 原文）─────────────────
//   16:23:25 结构校验通过 / 框架本体升级完成 / 顶层可见版本校验通过
//   16:30:18 服务拉起失败 → 启动失败隔离 → 隔离分析无输出 → 尝试自动回滚
//   16:30:33 全树回滚完成：恢复 62 个版本包 + 顶层 scope
// 而 `fw-relaunch.log` 里**只有一行时间戳 + bin 路径，没有任何子进程输出**。
// ⇒ 框架本体是好的（CLI 手动跑得出版本号，之后手动 `node …\lib\bin.js web --no-open` 也能起），
//   坏的是「自动拉起」这条路径；旧链条「拉起失败 → 立刻回滚」把一次**成功**的升级扔掉了。
//
// ── 第二轮现场（第一轮改过之后）暴露三个问题 ─────────────────────────────────
//   18:21:37 已发起拉起（升级后，PID 15832，最多等 30 秒自证）
//   18:22:08 拉起成功（升级后）：进程已存活 30 秒（端口尚未监听）      ← ① 判据太松
//   18:23:55 服务拉起失败 → 隔离 → 隔离分析无输出                    ← ② 成功后**又查一次**
//   18:23:56 回滚判定器不可用 → 保守回滚 → rollback                  ← ③ 把已起的服务回滚了
// ① 「进程存活」不能算成功：**成功判据只有一个 —— 端口开始监听**（沿用调用方 webPort）。
//    进程存活只是"仍在启动中"，到上限记为 `still-starting-timeout`（不确定，不是失败）。
// ② 已经判成功之后**不许再做任何就绪检查、不许再判失败**：真把 `$ok = $true` 传出去并立刻收尾。
//    直接来源是升级脚本"重启服务生效"那段端口轮询循环里的一行：
//      `if (-not $ok -and -not $started) { if (Invoke-DshRelaunch '升级后') { $started = $true } }`
//    —— 拉起的"成功"只被记成"别再拉起"（$started），没有记成"服务已经好了"（$ok），
//    于是循环又空转约 95 秒等端口，然后隔离/判定链路把已经起来的服务判死并回滚。
//    现在：Note-Relaunch 在"端口已监听"时置 `$script:relaunchListening`，调用点据此立刻 `$ok = $true; break`，
//    隔离块与判定块都在 `if (-not $ok …)` 里 ⇒ 成功之后一个字节的后续就绪检查都不会跑。
// ③ 自动回滚**取消**（用户原话：「他拉起来了后就不用管了啊……回滚需要人工点才行吧」）：
//    拉起失败 / 超时 / 无输出 ⇒ 一律写 `ready|框架已就位，自动拉起失败：<原因>；请手动运行
//    node "<真实 bin>" web --no-open，或点「回滚到上一版」`，**不自动回滚**（回滚是人工动作）。
//    唯一保留自动回滚的情形：失败原因里出现**明确的框架树损坏证据**（缺包 / 模块解析失败 /
//    缺 bin.js / 缺 package.json）—— 那种树留着也起不来，回滚才是对的。
// 缺陷 B（同一次真机）：`cmd /c call "node" … web > out 2> err` 在 schtasks 任务环境里输出仍为零
//   ⇒ 换掉 cmd 重定向，改由 **node 自己当拉起器**（`fw-launch.mjs`：把子进程 stdout/stderr
//   直接接成文件 fd，detached 启动）。判定结论也不再走 stdout（同环境下既有的
//   `隔离分析无输出` 是同一个病），改成**写判定文件**、ps1 读文件。
//
// 判据一行都不许写进 ps1 字符串里（否则测不到、还会分叉）。分工：
//   · judgeRelaunchFailure()          「失败原因文本 → 是否回滚」的唯一纯函数
//   · relaunchFallbackVerdict()       判定器不可用时的兜底（与上面同规则：**默认不回滚**）
//   · relaunchLauncherSource()        生成 `fw-launch.mjs`（node 拉起器：fd 重定向 + detached + 状态代理）
//   · relaunchVerdictHelperSource()   生成判定器转发脚本（结论写文件）
//   · relaunchProbeHelpers()/relaunchInvoke()/relaunchVerdictBlock()  生成 ps1 片段

/**
 * 「框架树真的坏了」的特征串（命中才自动回滚）。
 *
 * 2026-10-28 现场校准（用户真机证据，比猜测更硬）：
 *   · 用户**手动**跑 `node "…\@deepseek-ai\dsh\lib\bin.js" web --no-open` —— **能正常起来**
 *     （当前 web 就靠它跑着，3080 在监听）。启动命令 / profile / 这套插件本身都是好的；
 *   · 脚本拉起失败时 `fw-relaunch.log` **一个字都没有** —— 若真是插件 import 失败，
 *     node 会把 `Cannot find package …` 打到 stderr。没有痕迹 ⇒ 是"子进程没活下来 / 看不到"，
 *     不是加载崩溃 ⇒ **不能因为"没输出"就回滚**。
 * 所以判据必须**窄**：只有明确的"模块解析失败 / 关键文件缺失"才算框架树坏。
 * 反过来，这些**不许**命中（否则好框架会被回滚掉）：
 *   · `EADDRINUSE`（端口被占 —— 常见于上一个实例还没退干净）、`listen EACCES`、`npm ERR!`
 *   · `child-exited-early` / `still-starting-timeout`（秒退/超时但没有错误文本）
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

/** 状态/日志里给用户的手动启动命令（用户真机就是这么救回来的：`--no-open` 不弹浏览器）。 */
const MANUAL_URL_FLAGS = 'web --no-open'

/** 拉起器完全没留下输出、判定器也没产出结论时，判定用的原因文本（不含任何树损坏特征）。 */
const NO_OUTPUT_REASON = '未捕获到输出（拉起器没有留下 stdout/stderr，判定器也没有产出结论）'

/** `Invoke-DshRelaunch` 的三种结局前缀（判定器据此区分）。 */
const REASON_PREFIX = {
  stillStarting: 'still-starting-timeout', // 到上限仍没监听端口，但进程还活着 → 不确定，不回滚
  exitedEarly: 'child-exited-early', // <5 秒就退出
  exited: 'child-exited',
  spawnFailed: 'spawn-failed',
  launcherMissing: 'launcher-missing',
  noBin: '找不到 dsh 的 bin.js',
}

/** 原因摘录的最大长度（状态文件是单行 `status|message`，太长会把界面撑爆）。 */
const REASON_EXCERPT_LIMIT = 240

/** 由真实 bin 路径拼手动启动命令（拿不到路径时返回空串 —— 绝不编一个假路径）。 */
function manualRelaunchCommand(binPath) {
  const bin = typeof binPath === 'string' ? binPath.trim() : ''
  if (bin === '') return ''
  return `node "${bin}" ${MANUAL_URL_FLAGS}`
}

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
 * 保留框架时的状态行（三处复用：超时 / 拉起失败 / 判定器不可用）。
 * 用户原话：拉起失败就别管了，**回滚要人工点** ⇒ 文案点明两条人工出路。
 */
function keepStatusText({ reasonPhrase, binPath }) {
  const cmd = manualRelaunchCommand(binPath)
  const tail = cmd === ''
    ? '请手动启动 DSH（本机 bin.js 路径未解析出来），或点「回滚到上一版」'
    : `请手动运行 ${cmd}，或点「回滚到上一版」`
  return `框架已就位，${reasonPhrase}；${tail}`
}

/** 统一的判定返回形状（各分支都走它，避免字段漏写）。 */
function verdictOf(kind, { rollback, treeDamaged = false, reasonExcerpt = '', status = null, manualCommand = null }) {
  return { verdict: kind, rollback, treeDamaged, reasonExcerpt, status, manualCommand }
}

/** 保留分支的统一产物（超时 / 失败 / 未验证 都走它）。 */
function keepVerdict({ reasonPhrase, binPath, reasonExcerpt }) {
  const cmd = manualRelaunchCommand(binPath)
  return verdictOf('keep', {
    rollback: false,
    reasonExcerpt,
    status: keepStatusText({ reasonPhrase, binPath }),
    manualCommand: cmd === '' ? null : cmd,
  })
}

/**
 * **唯一**的「拉起失败 → 是否回滚」判据（纯函数，无 IO、无宿主）。
 *
 * 规则（顺序即优先级，tests/test-framework-relaunch-verdict.mjs 逐条钉死）：
 *   ① 没有失败原因（空/空白）→ ok：不需要判定，什么都不做（幂等边界）；
 *   ② 原因里**有明确的框架树损坏证据** → rollback（唯一的自动回滚情形：那种树留着也起不来）；
 *   ③ `still-starting-timeout` → keep（端口没通但进程还活着 = 不确定，不是坏树）；
 *   ④ 其余一切（秒退 / 无输出 / 结构校验没过…）→ keep：框架保留 + 手动命令 + 提示可人工回滚。
 *      —— 2026-10-28 用户定案「拉起失败就别管了，回滚要人工点」，所以这里**不再**保守回滚。
 *
 * @param {object} p
 * @param {string|null} [p.reason] 拉起失败原因（Invoke-DshRelaunch 的返回值）
 * @param {boolean} [p.structureVerified] 结构校验是否通过（留作记录/告警，不再决定是否回滚）
 * @param {boolean} [p.topLevelVerified]  顶层可见版本校验是否通过（同上）
 * @param {string} [p.binPath]  真实的 dsh bin.js 路径（拼手动启动命令用；空串 = 没解析出来）
 * @returns {{ verdict: 'ok'|'rollback'|'keep', rollback: boolean, treeDamaged: boolean,
 *   reasonExcerpt: string, status: string|null, manualCommand: string|null }}
 */
function judgeRelaunchFailure({ reason = '', structureVerified = false, topLevelVerified = false, binPath = '' } = {}) {
  const reasonExcerpt = flatReason(reason)
  // ① 没有原因 = 没有失败要判（调用方只在拉起失败时问，但纯函数自己也要幂等）
  if (reasonExcerpt === '') return verdictOf('ok', { rollback: false })
  // ② 框架树损坏证据（**唯一**的自动回滚情形）
  if (TREE_DAMAGE_MARKERS.some((marker) => reasonExcerpt.includes(marker))) {
    return verdictOf('rollback', { rollback: true, treeDamaged: true, reasonExcerpt })
  }
  // ③ 端口没通但进程还活着 = 不确定 → 保留（真机 18:24:39 那次就是再等一会儿端口才通的）
  if (reasonExcerpt.startsWith(REASON_PREFIX.stillStarting)) {
    return keepVerdict({ reasonPhrase: `自动拉起超时，端口在等待上限内未监听（${reasonExcerpt}）`, binPath, reasonExcerpt })
  }
  // ④ 其余一律保留：回滚改成人工动作（点了「回滚到上一版」才回滚）
  const unverified = structureVerified === true && topLevelVerified === true
    ? ''
    : '（注意：结构校验/顶层版本校验没有都通过，框架是否完整未能确认）'
  return keepVerdict({ reasonPhrase: `自动拉起失败：${reasonExcerpt}${unverified}`, binPath, reasonExcerpt })
}

/**
 * 「判定器不可用」时的兜底结论 —— **必须与 judgeRelaunchFailure 同规则**：
 * 把 `NO_OUTPUT_REASON` 喂进同一个纯函数（测试断言两者逐字段相等）。
 * 真机 18:23:56 的"保守回滚"就是错的：拿不到输出 ≠ 框架坏了。
 */
function relaunchFallbackVerdict({ structureVerified = false, topLevelVerified = false, binPath = '' } = {}) {
  return judgeRelaunchFailure({ reason: NO_OUTPUT_REASON, structureVerified, topLevelVerified, binPath })
}

/**
 * 生成 **node 拉起器** `fw-launch.mjs`（2026-10-28 第二轮：绕开 cmd/schtasks 的重定向）。
 *
 * 为什么不让 ps1 直接 `Start-Process node bin.js web > out`：
 *   · `cmd /c "…"` 的行首引号剥离会让整段重定向失效（真机 18:21：进程活了 30 秒，
 *     `.out/.err` 一个字都没有）；
 *   · `Start-Process -RedirectStandard*` 在本仓记录过「schtasks 下子进程启动即退出」。
 * 拉起器做三件事（全部由 Node 自己的 fd 完成，跟 cmd 无关）：
 *   ① `openSync(outFile,'a')` / `openSync(errFile,'a')` 直接当子进程的 stdio；
 *   ② `spawn(nodePath, [bin,'web'], { detached: true, stdio: ['ignore', outFd, errFd], windowsHide: true })`
 *      —— detached 保证计划任务/脚本退出后服务继续活着；
 *   ③ 自己留在前台当**状态代理**：子进程退出就 `process.exit(child.code)`，并把
 *      `{event, pid, code, signal, error}` 写进 status 文件。
 *      这里刻意**不 unref()+立即退出**（虽然那样更省一个进程）：一旦拉起器先退，ps1 的
 *      `-PassThru` 句柄立刻 `HasExited`，就再也分不清"服务在启动"还是"服务崩了"，退出码也没了。
 *      detached 已经保证服务不受拉起器生死影响 —— 那正是必须保住的那件事。
 */
function relaunchLauncherSource() {
  return [
    '// 自动生成：DSH 服务拉起器（升级/回滚脚本用 node 启动它；逻辑见 domain/framework-relaunch.js）',
    "import { spawn } from 'node:child_process'",
    "import { closeSync, openSync, writeFileSync } from 'node:fs'",
    'const [nodePath, binPath, outFile, errFile, statusFile] = process.argv.slice(2)',
    'const say = (obj) => { try { writeFileSync(statusFile, JSON.stringify(obj), "utf8") } catch {} }',
    'if (!nodePath || !binPath || !outFile || !errFile || !statusFile) { say({ event: "error", error: "拉起器参数不足" }); process.exit(2) }',
    'let outFd = null',
    'let errFd = null',
    'try { outFd = openSync(outFile, "a"); errFd = openSync(errFile, "a") } catch (error) { say({ event: "error", error: "打不开输出文件：" + String(error && error.message ? error.message : error) }); process.exit(3) }',
    'let child = null',
    'try {',
    '  child = spawn(nodePath, [binPath, "web"], { detached: true, stdio: ["ignore", outFd, errFd], windowsHide: true })',
    '} catch (error) { say({ event: "error", error: "spawn 抛错：" + String(error && error.message ? error.message : error) }); process.exit(4) }',
    'say({ event: "spawned", pid: child.pid ?? null, at: Date.now() })',
    'child.on("error", (error) => { say({ event: "error", pid: child.pid ?? null, error: String(error && error.message ? error.message : error) }); process.exit(5) })',
    'child.on("exit", (code, signal) => {',
    '  say({ event: "exited", pid: child.pid ?? null, code, signal })',
    '  try { closeSync(outFd); closeSync(errFd) } catch {}',
    '  process.exit(typeof code === "number" ? code : 1)',
    '})',
    '',
  ].join('\n')
}

/**
 * 生成「读文件尾部」+「端口监听」两个小助手（PowerShell，整段作为一个数组元素展开）。
 *
 * · `Get-TailText`：把某文件的尾部压成一行、只留最后 600 字符 —— 失败原因要短到能进日志与状态文件。
 *   刻意**不用 `Test-Path` 探变量**（既有断言要求拉起助手块里的 Test-Path 只出现在
 *   Resolve-DshBin 的归一化变量上），直接 `Get-Content -ErrorAction SilentlyContinue`。
 * · `Test-RelaunchPort`：沿用调用方（webPort）算好的 `$relaunchPort`；为 0 时永远不通过
 *   （只可能落到 still-starting-timeout，绝不假装成功）。
 */
function relaunchProbeHelpers() {
  return [
    `function Get-TailText($path) {`,
    `  $t = ''`,
    // -Encoding UTF8 必写：拉起器/判定器写的是**无 BOM 的 UTF-8**，PS 5.1 的 Get-Content 默认按 ANSI(GBK) 读，
    // 中文会变成乱码（真机 18:23 的"判定器不可用"就是这个：JSON 里的中文一乱、ConvertFrom-Json 直接抛）。
    `  try { $t = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } catch { $t = '' }`,
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
 * 2026-10-28 两轮改错：
 * 第一轮把 fire-and-forget 改成"发出去 + 等一小段"，但判据用了「进程存活」⇒ 缺陷 ①。
 * 第二轮定稿：
 *   ① 启动走 **node 拉起器**（`fw-launch.mjs`，fd 重定向 + detached），ps1 只 `Start-Process node 拉起器`；
 *   ② **成功只认端口监听**（`webPort`）；进程存活只算"仍在启动中"，继续等（默认 120 秒，
 *      `$script:DSH_RELAUNCH_WAIT_SEC` 可覆盖）；
 *   ③ 三种结局：`listening`（返回空串，调用方据此立刻收尾、不再做任何就绪检查）/
 *      `still-starting-timeout`（到上限端口没通但进程还活着）/ `child-exited-early|child-exited`
 *      （失败，带退出码 + 拉起器状态 + 输出尾部）。
 *   `Note-Relaunch` 是唯一的结果记账点：成功时置 `$script:relaunchListening = $true`。
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
    // 拉起结果的统一记账（三处调用点共用）：
    //   空串            = **端口已监听**（真·成功）→ $script:relaunchListening = $true，调用方立刻收尾
    //   still-starting  = 已经拉起过、别再重复拉起（但不算成功）
    //   其余            = 失败原因，允许下一轮重试
    `function Note-Relaunch($lr) {`,
    `  if ([string]::IsNullOrEmpty($lr)) { $script:relaunchListening = $true; return $true }`,
    `  $script:relaunchReason = $lr`,
    `  if ($lr.StartsWith('${REASON_PREFIX.stillStarting}')) { return $true }`,
    `  return $false`,
    `}`,
    `function Invoke-DshRelaunch($tag) {`,
    ...hostedGuard,
    `  $bin = Resolve-DshBin`,
    `  if ([string]::IsNullOrWhiteSpace($bin)) { Log ('拉起失败（' + $tag + '）：node resolve / .pnpm / 顶层链接 三种方式都找不到 dsh 的 bin.js，请手动启动 DSH'); return '${REASON_PREFIX.noBin}（node resolve / .pnpm / 顶层链接 三种方式都失败）' }`,
    // 拉起器就在 fw-relaunch.log 旁边（由升级/回滚脚本落盘），不额外传参
    `  $launcher = Join-Path (Split-Path -LiteralPath $launchLog) 'fw-launch.mjs'`,
    `  if (-not (Test-Path -LiteralPath $launcher)) { Log ('拉起器缺失（' + $tag + '）：' + $launcher + ' 不存在（请重跑一次升级以重新生成）'); return ('${REASON_PREFIX.launcherMissing}：' + $launcher + ' 不存在') }`,
    `  try { Add-Content -Path $launchLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' 拉起(' + $tag + '): ' + $bin) -Encoding UTF8 } catch {}`,
    // 每轮拉起用**独立**的 .out/.err/.status.json：这轮失败才读得到这轮的证据
    `  $outFile = $launchLog + '.out'`,
    `  $errFile = $launchLog + '.err'`,
    `  $statusFile = $launchLog + '.status.json'`,
    `  try { Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue } catch {}`,
    `  try { Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue } catch {}`,
    `  try { Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue } catch {}`,
    `  $proc = $null`,
    `  try {`,
    `    $proc = Start-Process -FilePath ${ps(nodePath)} -ArgumentList @(('"' + $launcher + '" "' + ${ps(nodePath)} + '" "' + $bin + '" "' + $outFile + '" "' + $errFile + '" "' + $statusFile + '"')) -PassThru -WindowStyle Hidden`,
    `  } catch {`,
    `    Log ('拉起器启动失败（' + $tag + '）：' + $_.Exception.Message)`,
    `    return ('${REASON_PREFIX.spawnFailed}：拉起器启动失败：' + $_.Exception.Message)`,
    `  }`,
    `  $startedAt = Get-Date`,
    `  $waitSec = 120`,
    `  if ($script:DSH_RELAUNCH_WAIT_SEC -gt 0) { $waitSec = [int]$script:DSH_RELAUNCH_WAIT_SEC }`,
    `  $deadline = (Get-Date).AddSeconds($waitSec)`,
    `  Log ('已发起拉起（' + $tag + '，拉起器 PID ' + [string]$proc.Id + '，最多等 ' + [string]$waitSec + ' 秒等端口 ' + [string]$relaunchPort + ' 监听）')`,
    // 成功**只认端口监听**：进程存活只说明"还在启动中"，继续等到上限
    `  while ($true) {`,
    `    if (Test-RelaunchPort) { Log ('拉起成功（' + $tag + '）：服务已监听端口 ' + [string]$relaunchPort + '（拉起器 PID ' + [string]$proc.Id + '）'); return '' }`,
    `    $alive = $false`,
    `    try { if ($proc -and -not $proc.HasExited) { $alive = $true } } catch { $alive = $false }`,
    `    if (-not $alive) { break }`,
    `    if ((Get-Date) -ge $deadline) {`,
    `      $tailT = Get-TailText $errFile`,
    `      if ([string]::IsNullOrWhiteSpace($tailT)) { $tailT = Get-TailText $outFile }`,
    `      Log ('拉起未完成（' + $tag + '）：进程仍存活，但 ' + [string]$waitSec + ' 秒内端口 ' + [string]$relaunchPort + ' 未监听 → still-starting-timeout（不确定，不是坏树）')`,
    `      $why = '${REASON_PREFIX.stillStarting}(' + [string]$waitSec + 's,pid=' + [string]$proc.Id + ')'`,
    `      if (-not [string]::IsNullOrWhiteSpace($tailT)) { $why = $why + '：' + $tailT }`,
    `      return $why`,
    `    }`,
    `    Start-Sleep -Milliseconds 1000`,
    `  }`,
    // 走到这里 = 拉起器/服务已退出（秒退或跑一会儿才崩）。这次事故就丢在这一步：必须留证据。
    `  $elapsedSec = [int](((Get-Date) - $startedAt).TotalSeconds)`,
    `  $exitTag = '${REASON_PREFIX.exited}'`,
    `  if ($elapsedSec -lt 5) { $exitTag = '${REASON_PREFIX.exitedEarly}' }`,
    `  $codeText = '未知'`,
    `  try { $codeText = [string]$proc.ExitCode } catch { $codeText = '未知' }`,
    `  $statusText = Get-TailText $statusFile`,
    `  $tailOut = Get-TailText $outFile`,
    `  $tailErr = Get-TailText $errFile`,
    `  $tail = $tailErr`,
    `  if ([string]::IsNullOrWhiteSpace($tail)) { $tail = $tailOut }`,
    `  Log ('拉起失败（' + $tag + '）：' + $exitTag + '（' + [string]$elapsedSec + ' 秒后退出，exit=' + $codeText + '）')`,
    `  if (-not [string]::IsNullOrWhiteSpace($statusText)) { Log ('拉起失败（' + $tag + '）拉起器状态：' + $statusText) }`,
    `  if ([string]::IsNullOrWhiteSpace($tail)) { Log ('拉起失败（' + $tag + '）：stdout/stderr 均为空 —— 没有任何输出证据（判定器据此**默认不回滚**，写 ready 交人工）') }`,
    `  if (-not [string]::IsNullOrWhiteSpace($tail)) { Log ('拉起失败（' + $tag + '）输出尾部：' + $tail) }`,
    `  $why = $exitTag + '(exit=' + $codeText + ',' + [string]$elapsedSec + 's)'`,
    `  if (-not [string]::IsNullOrWhiteSpace($statusText)) { $why = $why + '|' + $statusText }`,
    `  if (-not [string]::IsNullOrWhiteSpace($tail)) { $why = $why + '：' + $tail }`,
    `  return $why`,
    `}`,
  ]
}

/**
 * 生成「回滚判定器」转发脚本源码（写进 `<DSH_HOME>/plugin-console/fw-relaunch-verdict.mjs`）。
 *
 * 2026-10-28 第二轮：结论**写文件**，不再依赖 stdout —— 同一次真机里，既有的
 * `隔离分析无输出` 与新的 `回滚判定器不可用` 是同一个病（`& node helper | Select -Last 1`
 * 在 schtasks 环境里拿不到输出）。文件证据则一直好用（日志/状态文件都正常写）。
 *
 * argv: `<reasonFile> <structureFlag 0|1> <topLevelFlag 0|1> <binPath> <verdictFile>`
 *
 * @param {object} p
 * @param {string} p.libUrl 本模块的 file:// URL（由调用方用 pathToFileURL 算好）
 * @returns {string} 可直接 writeFileSync 的 .mjs 源码
 */
function relaunchVerdictHelperSource({ libUrl }) {
  return [
    '// 自动生成：自动拉起失败的「是否回滚」判定器（逻辑在插件内，本文件只做转发）',
    `import { judgeRelaunchFailure } from ${JSON.stringify(libUrl)}`,
    "import { readFileSync, writeFileSync } from 'node:fs'",
    'const [reasonPath, structureFlag, topFlag, binPath, verdictFile] = process.argv.slice(2)',
    "let reason = ''",
    'try { reason = readFileSync(reasonPath, "utf8") } catch {}',
    'let out = null',
    'try {',
    '  out = judgeRelaunchFailure({',
    "    reason, structureVerified: structureFlag === '1', topLevelVerified: topFlag === '1', binPath,",
    '  })',
    '} catch (error) { out = { error: String(error && error.message ? error.message : error) } }',
    'try { writeFileSync(verdictFile, JSON.stringify(out), "utf8") } catch (error) { process.exit(6) }',
    '',
  ].join('\n')
}

/**
 * 生成「拉起失败 → 判定 → 保留（或唯一情形的回滚）」的 PowerShell 执行块。
 *
 * 要求调用点已具备：`$log` / `SetState` / `Log` / `Beat` / `Resolve-DshBin` / `Invoke-Rollback` /
 * `Invoke-DshRelaunch` / `Note-Relaunch`，以及三个事实位：
 *   `$script:relaunchReason`（Note-Relaunch 记下的原因）、`$script:structureOk`、`$script:topLevelOk`。
 *
 * 判定器不可用时**不再保守回滚**（真机 18:23:56 那样会把好框架扔掉）：走
 * `relaunchFallbackVerdict` 的同一规则 —— 没有树损坏证据就保留 + 给手动命令。
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
    `  if ([string]::IsNullOrWhiteSpace($relaunchWhy)) { $relaunchWhy = '${NO_OUTPUT_REASON}' }`,
    `  Log ('自动拉起失败 → 判定是否回滚：' + $relaunchWhy)`,
    // 原因与结论都走文件（该环境下子进程 stdout 抓不到，文件读写一直好用）
    `  $reasonFile = $log + '.relaunch-reason.txt'`,
    `  $verdictFile = $log + '.relaunch-verdict.json'`,
    `  try { Set-Content -Path $reasonFile -Value $relaunchWhy -Encoding UTF8 } catch {}`,
    `  try { Remove-Item -LiteralPath $verdictFile -Force -ErrorAction SilentlyContinue } catch {}`,
    `  $binForCmd = Resolve-DshBin`,
    `  $structureFlag = '0'; if ($script:structureOk) { $structureFlag = '1' }`,
    `  $topFlag = '0'; if ($script:topLevelOk) { $topFlag = '1' }`,
    `  try { & ${ps(nodePath)} ${ps(helperPath)} $reasonFile $structureFlag $topFlag $binForCmd $verdictFile 2>&1 | Out-Null } catch { Log ('回滚判定器调用异常：' + $_.Exception.Message) }`,
    `  $verdictJson = ''`,
    // -Encoding UTF8 必写：判定器写的是无 BOM UTF-8，而 PS 5.1 默认按 ANSI(GBK) 读
    // ⇒ 中文乱码 ⇒ ConvertFrom-Json 抛"Invalid object passed in" ⇒ 判定被误判成"不可用"（真机 18:23）。
    `  try { $verdictJson = Get-Content -LiteralPath $verdictFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } catch { $verdictJson = '' }`,
    `  $verdict = $null`,
    `  if (-not [string]::IsNullOrWhiteSpace($verdictJson)) { try { $verdict = $verdictJson | ConvertFrom-Json } catch { $verdict = $null } }`,
    `  if ($null -ne $verdict -and -not [string]::IsNullOrWhiteSpace([string]$verdict.error)) { Log ('回滚判定器报错：' + [string]$verdict.error); $verdict = $null }`,
    `  if ($null -eq $verdict) {`,
    // 兜底 = 与 relaunchFallbackVerdict 同规则：没有树损坏证据 ⇒ 保留 + 手动命令（回归人工回滚）
    `    $verdict = [pscustomobject]@{ verdict = 'keep'; rollback = $false; status = ('框架已就位，自动拉起失败：' + $relaunchWhy + '；请手动运行 node "' + $binForCmd + '" web --no-open，或点「回滚到上一版」'); manualCommand = ('node "' + $binForCmd + '" web --no-open') }`,
    `    Log '判定器没有产出结论 → 兜底为「保留框架 + 人工决定是否回滚」（自动回滚已取消）'`,
    `  }`,
    `  Log ('回滚判定：' + [string]$verdict.verdict)`,
    `  if ($verdict.rollback) {`,
    `    Log '判定结果指向框架树损坏 → 自动回滚到升级前版本（唯一保留的自动回滚情形）'`,
    `    Invoke-Rollback`,
    `    $ok = $false`,
    `    $started = $false`,
    `    for ($i = 0; $i -lt 20; $i++) {`,
    `      try { $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c.Count -gt 0) { $ok = $true; break } } catch {}`,
    `      if (-not $ok -and -not $started) { $started = Note-Relaunch (Invoke-DshRelaunch '回滚后') }; Beat`,
    `      if ($script:relaunchListening) { $ok = $true; break }`,
    `      Start-Sleep -Seconds 5`,
    `    }`,
    `  } else {`,
    // 保留分支（默认分支）：框架本体已在目标版本，**不回滚**；状态写成明确的终态 ready，
    // 并把真实的手动启动命令留给用户（服务此时是停的，界面看不到 —— 命令得能直接复制粘贴）。
    `    $script:keptReady = $true`,
    `    SetState 'ready' ([string]$verdict.status)`,
    `    Log ('框架本体已就位、不回滚：' + [string]$verdict.status)`,
    `    Log ('手动启动命令：' + [string]$verdict.manualCommand)`,
    `  }`,
  ].join('\r\n')
}

export {
  judgeRelaunchFailure,
  relaunchFallbackVerdict,
  relaunchLauncherSource,
  relaunchVerdictHelperSource,
  relaunchVerdictBlock,
  relaunchProbeHelpers,
  relaunchInvoke,
  manualRelaunchCommand,
  keepStatusText,
  TREE_DAMAGE_MARKERS,
  REASON_EXCERPT_LIMIT,
  REASON_PREFIX,
  NO_OUTPUT_REASON,
  MANUAL_URL_FLAGS,
}
