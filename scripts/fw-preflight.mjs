#!/usr/bin/env node
// scripts/fw-preflight.mjs —— **服务起不来时的预检与治包**（0.5.50 加法）
//
// 为什么要在**服务之外**再来一条命令（真机停机事故 2026-10-14）：
//   那次的坏法是「框架包被掏空」—— `cordis` 顶层 junction 还在、它指向的 `.pnpm` 实体被清空；
//   `dsh-llm` / `dsh-tools` / `dsh-web` 直接成了空目录。后果是 dsh 启动即
//   `54 个插件 failed to import`、web 服务 exit code=1。
//
//   而既有的 safe-boot 快照恢复的是 **`cordis.patch.yml` 的文本**（配置层）—— 那次补丁好端端的，
//   恢复它等于"把一份没坏的配置换成另一份没坏的配置"，四个空目录纹丝不动；
//   指纹数的是 `.pnpm` 里的**目录个数** —— "壳还在、里面被掏空"⇒ 计数不变 ⇒ 不触发。
//   最根本的是：**控制台插件是跑在 dsh 里的**，dsh 起不来它就从未加载（事故日志里出现 0 次）。
//   ⇒ 这类事故必须在**服务之外**有一条出路。这就是本脚本。
//
// 三条硬约束（与 scripts/safe-boot.mjs 同族）：
//   · **零依赖**：只用 Node 内置模块 + 本插件自己的 infra/domain 纯函数（不装包、**不联网**）；
//   · **服务未运行也能跑**：不读端口、不连 webServer、不需要 profile 正被使用；
//   · **绝不 kill / spawn / 抢端口 / 建计划任务**：只做文件级修复。
//     （2026-10-10 的教训：那套"按端口 kill 再拉起"会与宿主争端口 ⇒ `listen EADDRINUSE`，
//      或让桌面端外壳弹出「应用无法启动或已意外停止」。跑完要不要重启，由你自己决定。）
//
// 用法（在插件目录下，或 `node <插件目录>/scripts/fw-preflight.mjs`）：
//   node scripts/fw-preflight.mjs --check              只诊断，列出坏掉的包（**一个字节都不写**）
//   node scripts/fw-preflight.mjs --repair             从本地 npm 缓存把缺的包装回来，再复验
//   node scripts/fw-preflight.mjs --check --json       机器可读输出
//   可选：--fw-root <dir>  指定框架树（默认自动探测：从本插件解析 @deepseek-ai/dsh 反推）
//         --cache <dir>   指定 npm 缓存根（默认自动找 npm_config_cache / %LOCALAPPDATA%\npm-cache / 常见位置）
//         --help          显示本帮助

import { isAbsolute, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectFrameworkRoot } from '../lib/server/infra/fw-root-detect.js'
import { runFwPreflight } from '../lib/server/domain/fw-preflight.js'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const HELP = `框架闭包预检与治包（fw-preflight）—— 服务起不来时用这个，不需要服务在跑。

用法：
  node scripts/fw-preflight.mjs --check
      只诊断：从 dsh 的 lib/bin.js 出发走一遍 @deepseek-ai/* 依赖闭包，
      列出**解析不了**的包（= 真正的损坏面）。一个字节都不写。

  node scripts/fw-preflight.mjs --repair
      把解析不了的包装回来：按 package-lock.json 的 integrity 从**本地 npm 缓存**取 tarball 解开。
      改前若目标已有内容，先改名成 <name>.preflight-bak-<时间戳>（绝不直接删）。
      装完**重新走一遍闭包复验**，不靠"我装完了"自证。

可选参数：
  --fw-root <dir>   框架树根（含 @deepseek-ai/ 与 .pnpm/）。默认自动探测。
  --cache <dir>     npm 缓存根（含 content-v2/）。默认自动探测，可重复。
  --json            机器可读输出（面板/子代理可直接解析）。
  --help            显示本帮助。

判据为什么是"能不能解析"而不是"目录空不空"：
  这次事故的形态是「目录壳还在、里面被掏空」—— 数目录个数完全看不见
  （2026-10-14 实测：按"目录空不空"粗扫本机会误报 237 个；换成闭包判据后 287 个包精准通过，
   清空一个立刻只点名那一个）。

它不做什么：
  不 kill 进程、不 spawn 服务、不抢端口、不建计划任务、不联网。
  修完请自己重启服务（桌面端：完全退出再打开；独立 dsh web：终端里 Ctrl+C 后重跑）。
`

/** 解析命令行（只认本脚本声明的这几个开关；未知参数如实报错，不静默忽略）。 */
function parseArgv(argv) {
  const out = { mode: null, fwRoot: null, caches: [], json: false, help: false, bad: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--check') out.mode = 'check'
    else if (a === '--repair') out.mode = 'repair'
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--fw-root') { out.fwRoot = argv[i + 1] ?? null; i += 1 }
    else if (a === '--cache') { const v = argv[i + 1]; if (v) out.caches.push(v); i += 1 }
    else out.bad.push(a)
  }
  return out
}

/**
 * 探测框架树根：多基准（见 lib/server/infra/fw-root-detect.js 的头注释）。
 * 这里只做转发，判据收在 infra 一处 —— 脚本与（日后的）路由不会分叉。
 */
function detectFwRoot() {
  return detectFrameworkRoot({ pluginDir: PLUGIN_ROOT })
}

/** 把探测结果 + 修复结果渲染成人读报告。 */
function renderReport(report, { attempted }) {
  const lines = []
  const bad = report.before?.broken ?? []
  lines.push(`框架树 : ${report.fwRoot ?? '(未探测到)'}`)
  lines.push(`解析入口: ${report.entry ?? '(无)'}${report.entryVia === null || report.entryVia === undefined ? '' : `  [${report.entryVia}]`}`)
  lines.push(`npm 缓存: ${(report.cacheRoots ?? []).join(' ; ') || '(未找到 —— 只能诊断，不能修复)'}`)
  lines.push('')
  if (report.error !== undefined && report.error !== null) {
    lines.push(`✗ ${report.error}`)
    return lines.join('\n')
  }
  const walked = report.before?.walked?.length ?? 0
  lines.push(attempted ? `① 修复前：走了 ${walked} 个包，${bad.length} 个解析不了` : `走了 ${walked} 个包，${bad.length} 个解析不了`)
  for (const b of bad) lines.push(`   ✗ ${b.name}   ← ${b.from}  (${b.reason})`)
  if (bad.length === 0) lines.push('   ✓ 依赖闭包完整 —— 框架树是好的，起不来的原因不在这里')

  if (!attempted) {
    if (bad.length > 0) lines.push('\n用 --repair 试着把它们装回来（只动文件，不碰任何进程）。')
    return lines.join('\n')
  }

  lines.push('')
  lines.push(`② 本次修复：成功 ${report.repaired.length} 个，失败 ${report.failed.length} 个，不可修 ${report.skipped.length} 个`)
  for (const r of report.repaired) lines.push(`   ✓ ${r.name}@${r.version}  → ${r.via}  ${r.note}`)
  for (const f of report.failed) lines.push(`   ✗ ${f.name}  (${f.action})  ${f.note}`)
  for (const s of report.skipped) {
    const why = { 'no-lock-entry': 'package-lock.json 里没有它的记录 —— 不猜版本', 'no-integrity': '记录里没有 integrity 校验和', 'no-target': '定不出该装到哪个目录' }[s.reason] ?? s.reason
    lines.push(`   · ${s.name}  ${why}`)
  }

  lines.push('')
  const after = report.after?.broken ?? []
  lines.push(`③ 复验：走了 ${report.after?.walked?.length ?? 0} 个包，${after.length} 个仍解析不了`)
  for (const b of after) lines.push(`   ✗ ${b.name}   ← ${b.from}`)
  if (report.okAfter === true) {
    lines.push('   ✓ 闭包已完整')
    lines.push('')
    lines.push('接下来：重启服务让修复生效（本脚本**不会**替你 kill / 拉起进程）。')
    lines.push('  · 桌面端：完全退出 DeepSeek Harness，再重新打开')
    lines.push('  · 独立 dsh web：在启动它的终端里 Ctrl+C，然后重新运行 dsh web')
  } else {
    lines.push('')
    lines.push('仍有包解析不了。可能原因：本地 npm 缓存里也没有那些 tarball（本脚本不联网）。')
    lines.push('可对该包单独装一次（会联网）：dsh plugin --profile <名> add <包名>')
  }
  return lines.join('\n')
}

async function main() {
  const args = parseArgv(process.argv.slice(2))
  if (args.help) { process.stdout.write(HELP); return 0 }
  if (args.bad.length > 0) {
    process.stderr.write(`未知参数：${args.bad.join(' ')}\n\n${HELP}`)
    return 2
  }
  if (args.mode === null) {
    process.stderr.write(`请指定 --check 或 --repair（或 --help）。\n\n${HELP}`)
    return 2
  }

  let fwRoot = args.fwRoot
  let via = 'explicit'
  let tried = []
  if (typeof fwRoot !== 'string' || fwRoot === '') {
    const d = detectFwRoot()
    fwRoot = d.fwRoot
    via = d.via
    tried = d.tried ?? []
  } else {
    fwRoot = isAbsolute(fwRoot) ? fwRoot : resolve(process.cwd(), fwRoot)
  }

  if (fwRoot === null || fwRoot === undefined || fwRoot === '') {
    const msg = '探测不到框架树根 —— 请用 --fw-root <dir> 显式指定（该目录下应有 @deepseek-ai/ 与 .pnpm/）。'
    const detail = tried.map((t) => `  · 试过 ${t.via}: ${t.base}`).join('\n')
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg, tried }, null, 2)}\n`)
    else process.stderr.write(`✗ ${msg}\n${detail}\n`)
    return 1
  }

  const cacheRoots = args.caches.length > 0 ? args.caches.map((c) => (isAbsolute(c) ? c : resolve(process.cwd(), c))) : null
  const report = runFwPreflight({ fwRoot, repair: args.mode === 'repair', cacheRoots })
  const payload = { ...report, fwRootVia: via, mode: args.mode }

  if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else process.stdout.write(`${renderReport(payload, { attempted: args.mode === 'repair' })}\n`)

  // 退出码：诊断模式 = 闭包是否完整；修复模式 = 修复后是否完整（供脚本/CI 判断）
  const good = args.mode === 'repair' ? report.okAfter === true : report.ok === true
  return good ? 0 : 1
}

main().then((code) => { process.exitCode = code }, (error) => {
  process.stderr.write(`fw-preflight 异常：${error?.stack ?? error}\n`)
  process.exitCode = 1
})
