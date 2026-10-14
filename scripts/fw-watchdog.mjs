#!/usr/bin/env node
// fw-watchdog.mjs —— DSH 框架闭包看门狗（不改官方代码的"崩溃自愈"）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
//   真机事故（2026-10-14）：框架树里 `@deepseek-ai/cordis` 的 junction 还在、但 `.pnpm`
//   实体被掏空；`dsh-llm`/`dsh-tools`/`dsh-web` 成了空目录 ⇒ dsh 启动即 54 个插件
//   failed to import ⇒ 服务进程 exit code=1 ⇒ 桌面端弹「应用无法启动或已意外停止」。
//
//   官方启动链（已只读取证）**没有**"启动前执行外部命令"的钩子：
//     DeepSeek Harness.exe → dsh-desktop-host/lib/cli.js → runCli()（dsh/lib/bin.js:207）
//       → case "profile": runProfile() → 失败 → reportStartupFailure() → process.exit(1)
//     · bin.js 全文 254 行，读的环境变量：零；
//     · dsh-app-boot 只有 DSH_SNAPSHOT=replay（换配置）与 loadEnv()（读 .env），
//       而 .env 能设的名字有黑名单（PATH/HOME/NODE_OPTIONS/…）——只能设配置，不能"启动前跑脚本"；
//     · 失败路径不 spawn 任何外部命令。
//   ⇒ 想在"每次 dsh 启动前自动修"必须改官方外壳（且一升级就被覆盖）。
//     所以本脚本走另一条路：**观测一个合法事实** —— 外壳进程还在，而它的 **HOST 服务进程没了**。
//     官方自己的崩溃恢复只知道"重启"，不知道"修包"；看门狗补的正是这一段：
//     它把地面修平，官方下一次重启自然成功 —— 用户观感就是"崩了自己又起来了"。
//
// ── 判据（★ 2026-10-14 修正：一开始用"端口无监听"，那是错的）────────────────
//   为什么不能用端口：桌面实例监听 19387，3080 是 web profile 的端口；用固定端口探针
//   会在正常运行时恒判"服务没起来" ⇒ 每轮白跑一次全量闭包检查、日志刷屏。
//   现在的判据（进程树事实，与端口无关）：
//     ① 外壳进程在跑（`DeepSeek Harness.exe` 且命令行**不含** `--type=`）；
//     ② 它的 HOST 服务子进程**不在**（命令行含 `dsh-desktop-host/lib/index.js` 的那个）；
//     ③ 连续 N 轮（默认 2 轮 ≈ 40s）都如此 ⇒ 才动手（避开"正在启动/正在重启"的窗口）。
//   动作：`fw-preflight --check` → 闭包坏 ⇒ `--repair` → `--check` 复验。
//   修完**不自己拉起服务**：官方崩溃恢复/relaunch 会自己重试，我们只把地面修平。
//   红线：不杀进程、不抢端口、不 spawn dsh、不改官方任何文件。
//
// ── 用法 ──────────────────────────────────────────────────────────────────
//   node fw-watchdog.mjs --daemon    后台守护（**计划任务用这个**）：自己脱离、无控制台窗口、幂等
//   node fw-watchdog.mjs --status     只打印当前判据事实，不动作
//   node fw-watchdog.mjs --tick       跑一次完整逻辑（演练 / 手动触发）
//   node fw-watchdog.mjs --once       诊断：判据 + 跑一次 --check 并打印结论
//   node fw-watchdog.mjs              前台常驻（Ctrl-C 退出；排查时用）
// 日志：`<DSH_HOME>/plugin-console/fw-watchdog.log`（追加式，只在有事时写）
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ARGV = process.argv.slice(2)
const HAS = (f) => ARGV.includes(f)
const HOME = homedir()
const DSH_HOME = process.env.DSH_HOME?.trim() || join(HOME, '.dsh')
const LOG_DIR = join(DSH_HOME, 'plugin-console')
const LOG = join(LOG_DIR, 'fw-watchdog.log')
const INTERVAL_MS = Number(process.env.DSH_WATCHDOG_INTERVAL_MS ?? 20000)
const STRIKES = Number(process.env.DSH_WATCHDOG_STRIKES ?? 2)
const EXE = process.platform === 'win32' ? 'DeepSeek Harness.exe' : null

/** 找到本机已装的 fw-preflight.mjs。
 *  扫描各个 profile 的 node_modules/<包>/scripts/（不写死 desktop —— 用户可能只装 web profile，
 *  或 profile 名不同）。★ 注意：本注释里**不能**出现星号后跟斜杠那种通配写法，
 *  那会提前闭合块注释（2026-10-14 实测踩到：脚本因此整份 SyntaxError、看门狗从未真正运行过）。 */
function findPreflight() {
  if (typeof process.env.DSH_WATCHDOG_CONSOLE === 'string' && process.env.DSH_WATCHDOG_CONSOLE !== '') {
    return join(process.env.DSH_WATCHDOG_CONSOLE, 'scripts', 'fw-preflight.mjs')
  }
  // 本脚本自己就在 <包>/scripts/ 下时，优先用同包那份（最不容易错配）
  try {
    const self = fileURLToPath(import.meta.url)
    const samePkg = join(self, '..', 'fw-preflight.mjs')
    if (existsSync(samePkg)) return samePkg
  } catch {}
  const profilesDir = join(DSH_HOME, 'profiles')
  let names = []
  try { names = readdirSync(profilesDir) } catch { return join(profilesDir, 'desktop', 'node_modules', '@noob-stupid', 'dsh-plugin-console', 'scripts', 'fw-preflight.mjs') }
  for (const name of names) {
    const p = join(profilesDir, name, 'node_modules', '@noob-stupid', 'dsh-plugin-console', 'scripts', 'fw-preflight.mjs')
    if (existsSync(p)) return p
  }
  return join(profilesDir, 'desktop', 'node_modules', '@noob-stupid', 'dsh-plugin-console', 'scripts', 'fw-preflight.mjs')
}
const PREFLIGHT = findPreflight()

const log = (line) => {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const text = `[${stamp}] ${line}\n`
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG, text, 'utf8') } catch {}
  process.stdout.write(text)
}

/** 进程树事实（一次 PowerShell 调用取全，避免每条判据各 spawn 一次）。
 *  ★ 坑（2026-10-14 实测踩到）：PowerShell 里 `$host` 是**只读自动变量**，赋值直接报
 *    "Cannot overwrite variable Host because it is read-only or constant" ⇒ 探针恒返回 0
 *    ⇒ 看门狗永远以为"外壳没在跑"、静默失效。所以变量名一律用 `$hostN`/`$shellN`。
 *    同族坑：$HOME / $PID / $PSHOME 等一律不许赋值。 */
function probeProcesses() {
  // 测试注入缝（只为离线演练；生产不设这个变量）
  const fake = process.env.DSH_WATCHDOG_FAKE_PROCS
  if (typeof fake === 'string' && /^\d+\|\d+$/u.test(fake)) {
    const [s, h] = fake.split('|').map(Number)
    return { shell: s, host: h, raw: `${s}|${h} (injected)` }
  }
  if (EXE === null) return { shell: 0, host: 0, raw: 'non-win32' }
  const ps = [
    `$all = @(Get-CimInstance Win32_Process -Filter "Name='${EXE}'" -ErrorAction SilentlyContinue)`,
    `$shellN = @($all | Where-Object { $_.CommandLine -notmatch '--type=' }).Count`,
    `$hostN = @($all | Where-Object { $_.CommandLine -match 'dsh-desktop-host[\\\\/]lib[\\\\/]index\\.js' }).Count`,
    `Write-Output ($shellN.ToString() + '|' + $hostN.ToString())`,
  ].join('; ')
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  const m = /(\d+)\|(\d+)/u.exec(String(r.stdout ?? ''))
  return { shell: m ? Number(m[1]) : 0, host: m ? Number(m[2]) : 0, raw: String(r.stdout ?? '').trim() }
}

const preflight = (mode) => {
  if (!existsSync(PREFLIGHT)) {
    log(`找不到 fw-preflight：${PREFLIGHT}（控制台未安装或路径变了）—— 本轮跳过`)
    return { ok: false, stdout: '', missing: true }
  }
  const r = spawnSync(process.execPath, [PREFLIGHT, mode], { encoding: 'utf8', timeout: 180000, windowsHide: true })
  return { ok: r.status === 0, stdout: String(r.stdout ?? '') + String(r.stderr ?? ''), missing: false }
}

/** 闭包是否坏。判据取自 fw-preflight 自己那行结论：「走了 N 个包，M 个解析不了」，M>0 即坏。
 *  认不出格式时按"坏"处理 —— 宁可多查一次，也不放过真事故。 */
function closureBroken(out) {
  const m = /走了\s*(\d+)\s*个包[，,]\s*(\d+)\s*个解析不了/u.exec(out)
  if (m) return Number(m[2]) > 0
  if (/闭包完整/u.test(out)) return false
  return true
}

let strikes = 0
let repairing = false

async function tick() {
  if (repairing) return
  try {
    const p = probeProcesses()
    if (p.shell === 0) { strikes = 0; return }      // 外壳没开 = 用户没在用，不管
    if (p.host > 0) {                                // HOST 在 = 服务活着 = 正常
      if (strikes !== 0) log('HOST 服务进程已回来 —— 恢复正常，看门狗回待命')
      strikes = 0
      return
    }
    strikes += 1
    if (strikes < STRIKES) return
    log(`外壳在跑(${p.shell}) 但 HOST 服务进程不在（连续 ${strikes} 轮）⇒ 开始检查框架闭包`)
    const check = preflight('--check')
    if (check.missing) { strikes = 0; return }
    if (!closureBroken(check.stdout)) {
      log('闭包本身是好的 ⇒ 起不来另有原因（不是包被掏空），本轮不动作，等官方自己的恢复逻辑')
      strikes = 0
      return
    }
    log('闭包确实坏了 ⇒ 执行 --repair（从本地 npm 缓存按 integrity 离线装回，不联网）')
    repairing = true
    try {
      const fix = preflight('--repair')
      log(`--repair 退出码=${fix.ok ? 0 : '非0'}`)
      const re = preflight('--check')
      const good = re.ok && !closureBroken(re.stdout)
      log(good
        ? '✅ 修复成功：闭包复验通过。服务交由官方自己的恢复/relaunch 拉起（本脚本不抢端口、不 spawn dsh）。'
        : '❌ 修复后复验仍未通过 —— 需人工介入（手动跑 --repair 看详细输出；日志在 ~/.dsh/plugin-console/）')
    } finally { repairing = false; strikes = 0 }
  } catch (error) {
    log(`本轮异常（不影响下一轮）：${String(error?.message ?? error)}`)
  }
}

// ── 后台守护（计划任务用）：自己脱离，不留控制台窗口 ──────────────────────────
// ★ 为什么要这一模式（2026-10-14 实测）：计划任务直接跑 node.exe 会让 Windows 弹出**可见的
//   控制台窗口**（本机实测桌面出现一个 Windows Terminal）；改用 .vbs 启动器（window style 0）
//   又踩到 wscript 挂住、拉不起子进程。最稳的是让脚本**自己以 detached 方式再拉起一份**，
//   并让它 `stdio: 'ignore' + windowsHide: true`（子进程没有控制台可挂）⇒ 任务那条命令立刻返回，
//   真正干活的那份在后台无窗口运行。重复启动由 pid 锁挡住。
if (HAS('--daemon')) {
  const PID_FILE = join(LOG_DIR, 'fw-watchdog.pid')
  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }
  let already = null
  try { already = Number(String(readFileSync(PID_FILE, 'utf8')).trim()) } catch {}
  if (alive(already)) {
    log(`后台看门狗已在运行（pid ${already}）—— 本次不重复启动`)
    process.exit(0)
  }
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env },
  })
  child.unref()
  try { mkdirSync(LOG_DIR, { recursive: true }); writeFileSync(PID_FILE, String(child.pid), 'utf8') } catch {}
  log(`已用后台守护模式拉起看门狗（pid ${child.pid}，无窗口）`)
  process.exit(0)
}

// ── 单轮完整逻辑（演练 / 计划任务手动触发）──
if (HAS('--tick')) {
  log('── 单轮完整逻辑（--tick）──')
  await tick()
  log('── 本轮结束 ──')
  process.exit(0)
}

// ── 状态 / 诊断 ──
if (HAS('--status') || HAS('--once')) {
  const p = probeProcesses()
  log(HAS('--once') ? '── 诊断（--once）──' : '── 状态（--status）──')
  log(`外壳进程: ${p.shell} 个   HOST 服务进程: ${p.host} 个`)
  log(`判定：${p.shell === 0 ? '外壳没在跑（不管）' : p.host > 0 ? '服务活着（正常）' : '★ 外壳在跑但服务不在（事故形态）'}`)
  log(`预检脚本：${PREFLIGHT}`)
  if (HAS('--once')) {
    const check = preflight('--check')
    log(`fw-preflight --check 退出码=${check.ok ? 0 : '非0'}${check.missing ? '（脚本缺失）' : ''}`)
    if (!check.missing) {
      log(check.stdout.trim().split('\n').map((l) => '    ' + l).join('\n'))
      log(`闭包判定：${closureBroken(check.stdout) ? '★ 坏' : '好'}`)
    }
  }
  process.exit(0)
}

// ── 常驻 ──
// ★ 主入口守卫（2026-10-14 补）：没有它时，任何人 `import()` 本文件都会**意外启动常驻看门狗**
//   （验证语法时就踩到过：一个 import 把看门狗跑起来了）。只在真正作为脚本执行时才启动。
if (import.meta.main !== true) {
  process.exit(0)
}

log(`看门狗启动：间隔=${INTERVAL_MS}ms 连续${STRIKES}轮 预检=${PREFLIGHT}`)
log('判据：外壳在跑 + HOST 服务进程不在；只修框架闭包，不杀进程、不抢端口、不改官方文件')
// 记下自己的 pid（`--daemon` 靠它防重复启动；退出时清掉）
try { mkdirSync(LOG_DIR, { recursive: true }); writeFileSync(join(LOG_DIR, 'fw-watchdog.pid'), String(process.pid), 'utf8') } catch {}
await tick()
const timer = setInterval(tick, INTERVAL_MS)
const stop = () => {
  clearInterval(timer)
  try {
    const f = join(LOG_DIR, 'fw-watchdog.pid')
    if (String(readFileSync(f, 'utf8')).trim() === String(process.pid)) rmSync(f, { force: true })
  } catch {}
  log('看门狗停止')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
