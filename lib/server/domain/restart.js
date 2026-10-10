// L1 · domain —— restart.js（「重启 / 重载」路径的**唯一承担者**，2026-10-10 改错）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言）——纯判据，不碰 ctx / 不碰 IO。
//
// ── 用户红线原话（2026-10-10）────────────────────────────────────────────────
//   「桌面端重启必须走官方的那种不报错重启，如果你走手动拉起之类的等等很可能会出现那种报错，
//     这是一定不能的」＋「有时候控制台代理重启啥的会出现《应用无法启动或已意外停止》」。
//
// ── 元凶现场（<DSH_HOME>/plugin-console/，2026-10-10 15:27–15:33，实测原文）──────
//   console-restart.log：
//     15:28:02 [guard] 端口 3080 无监听，第 1 次拉起
//     15:28:02 [guard] 已发起拉起服务（守护第 1 次，输出见 fw-relaunch.log）
//     …（每分钟一次，直到第 5 次）
//     15:33:03 [guard] 已尝试 5 次仍拉不起来，放弃并自删（请手动启动，或看 fw-relaunch.log / console-restart.log）
//   fw-relaunch.log：`拉起(守护第 N 次): <npx 缓存>\@deepseek-ai\dsh\lib\bin.js`
//   ⇒ 旧实现：`POST /restart` 生成 PowerShell 自杀脚本 + 注册一个**每分钟跑一次**的
//     `DSH-RestartGuard-<pid>` 计划任务；端口无监听就 `Start-Process node <bin.js> web`
//     手动拉起（最多 5 次），第 6 次 `schtasks /delete` **自删任务**（危险动作）。
//     触发面＝控制台里的「重启服务」按钮 / 自更新成功后自动调 / 升级期间的悬浮「拉起」按钮；
//     守护任务一旦注册就**自己按分钟跑**（按钮触发 → 自动守护，两条都在）。
//
// ── 为什么"手动拉起"必然报错（两条路都通向同一句弹窗）─────────────────────────
//   ① 桌面端实例：宿主是 Electron 外壳的**子进程**（Electron lib/main.js:3674 `spawn(node,
//      [--expose-internals, …dsh-desktop-host/lib/index.js, …])`）。kill 它 ⇒ 外壳
//      `child.once('close')`（lib/main.js:3722-3727）→ `fail()` → DesktopBackendController
//      发布 `phase:'error'` → `reportFatal(state.failure, 'host')`（lib/main.js:11389）
//      ⇒ 弹「应用无法启动或已意外停止。」（lib/main.js:6709 `fatalSummary`）。
//   ② 独立 `dsh web` 实例：再 spawn 一个 `dsh web` 必然与宿主**争同一个端口** ⇒
//      `listen EADDRINUSE` ⇒ 外壳那一支的文案「有其他正在运行的 DSH（如其他 dsh web、桌面端），
//      无法同时启动」（lib/main.js:6543 / 6710）。
//
// ── 官方那条"不报错"的路（原文出处）──────────────────────────────────────────
//   · 桌面端自带的官方重启 = Electron `app.relaunch(); quitWithoutConfirmation()`
//     —— Electron lib/main.js:10983-10986（崩溃恢复对话框的「重启」按钮；标签 `restartApplication`
//     见 lib/main.js:6715，按钮表见 7551-7557，「地址被占用」分支在 7545-7551）、
//     lib/main.js:11906-11911（应用菜单「重启应用与 Host」/ `restartAppHostMenu` lib/main.js:6751）。
//     它先走外壳自己的受管收尾（`child.send({ type:'shutdown' })` → 优雅等待 → SIGTERM/SIGKILL；
//     dsh-desktop-host/lib/index.js:265 + lib/main.js:3790-3807），再由 Electron 自己拉起**整个应用**
//     ——全程只有一个实例、不抢端口、宿主进程由外壳自己收尾 ⇒ 不报错。
//   · **但插件拿不到它**（本模块存在的理由）：桌面端 IPC 全表（lib/preload-app.cjs:6-30 ≡
//     lib/main.js:6193-6218）没有 restart/relaunch 通道；外壳 ↔ 宿主控制通道只有
//     `update-tasks` / `quit-inspection` / `shutdown`（dsh-desktop-host/lib/index.js:265-310）。
//     ⇒ 插件无法调用官方重启，唯一诚实的做法是**请用户在客户端里重启**。
//   · 官方对"改动何时生效"的语义 = `restart-required` → 「更改将在下次启动生效」
//     （dsh-client-ui-plugin-manager/lib/client.js:91 文案 / :626 取值 / :1462 判据）。
//
// ── 本模块的判定（全仓唯一，调用点不许各写一份）──────────────────────────────
//   hosted=true  → channel 'desktop-client'：官方路径 = 用户在桌面端客户端内重启
//   hosted=false → channel 'unavailable'   ：没有受管重启器 ⇒ 如实告知手动重启
//   **两种情况都是 spawns=false / kill=false —— 绝不 spawn / kill / 建计划任务 / 自删。**

/** 桌面端托管的实例：官方重启通道在客户端手里（插件无此通道）。 */
const DESKTOP_CLIENT_RESTART_NOTICE = '本实例由桌面端外壳托管 —— 请在桌面端客户端里重启：完全退出 DeepSeek Harness 再重新打开；'
  + '若已弹出「应用无法启动或已意外停止」，直接点弹窗里的「重启」。'
  + '控制台不会自行 kill / spawn 进程：手动拉起会与宿主争端口，那正是该报错的来源。'

/** 独立 `dsh web` 实例：DSH 没有给插件用的受管重启器，官方重启通道不可用。 */
const STANDALONE_RESTART_NOTICE = 'DSH 没有可由插件调用的官方重启通道：请手动重启这个 dsh web 进程'
  + '（在启动它的终端里 Ctrl+C，然后重新运行 dsh web）。'
  + '控制台不会自行 kill / spawn —— 手动拉起会与宿主争端口并产生「应用无法启动或已意外停止」这类报错。'

/** `/framework-relaunch`（原「手动拉起服务」悬浮按钮）：同一判据，另加"这条路已下线"的说明。 */
const MANUAL_LAUNCH_REMOVED_NOTE = '「手动拉起服务」已按官方路径下线（控制台不再 spawn 新的 dsh 实例）：'

/** 两条官方判定通道（稳定字符串，前端与测试按它判因）。 */
const RESTART_CHANNEL = { desktopClient: 'desktop-client', unavailable: 'unavailable' }

/** 面向用户的出路（结构化下发，前端可原样展示；桌面端与独立实例各自一条真出路）。 */
const GUIDES = {
  'desktop-client': [
    '桌面端：完全退出 DeepSeek Harness，再重新打开（官方 app.relaunch 那条路）。',
    '已弹出「应用无法启动或已意外停止」时：直接点弹窗里的「重启」（官方恢复对话框）。',
    '只是想让插件改动生效：按 DSH 官方语义"下次启动生效"（restart-required），刷新页面即可看到已生效的部分。',
  ],
  unavailable: [
    '独立 dsh web：在启动它的终端里 Ctrl+C，然后重新运行 dsh web。',
    '只改了客户端插件：DSH 官方语义是"下次启动生效"（restart-required），直接刷新页面。',
    '不要用任何"按端口 kill 再拉起"的做法：第二个实例会与宿主争端口（listen EADDRINUSE）。',
  ],
}

/**
 * 「重启 / 重载」路径的唯一判据。
 *
 * @param {object} p
 * @param {boolean} p.hosted  是否由桌面端外壳托管（调用方用 domain/framework.js#detectHostShape 判定后传入；
 *                            本函数不重复判定，保证与 shellHostedRefusal 同一份事实）
 * @param {'restart'|'relaunch'} [p.intent]  控制台里的哪颗按钮（只影响文案前缀，判定完全相同）
 * @returns {{ ok: false, official: boolean, channel: string, spawns: false, kill: false,
 *             status: number, code: string, message: string, details: object }}
 */
function restartPathDecision({ hosted, intent = 'restart' } = {}) {
  const shellHosted = hosted === true
  const channel = shellHosted ? RESTART_CHANNEL.desktopClient : RESTART_CHANNEL.unavailable
  const base = shellHosted ? DESKTOP_CLIENT_RESTART_NOTICE : STANDALONE_RESTART_NOTICE
  const message = intent === 'relaunch' ? MANUAL_LAUNCH_REMOVED_NOTE + base : base
  return {
    ok: false,
    official: shellHosted,
    channel,
    spawns: false,
    kill: false,
    status: 409,
    code: `official-restart-${channel}`,
    message,
    details: {
      code: `official-restart-${channel}`,
      official: shellHosted,
      channel,
      // 机器可读的红线判据：这两项永远是 false（测试的负控就钉在这里）
      spawns: false,
      kill: false,
      scheduledTask: false,
      selfDelete: false,
      manualLaunch: intent === 'relaunch' ? 'removed' : 'never',
      guide: GUIDES[channel],
    },
  }
}

export { DESKTOP_CLIENT_RESTART_NOTICE, MANUAL_LAUNCH_REMOVED_NOTE, RESTART_CHANNEL, STANDALONE_RESTART_NOTICE, restartPathDecision }
