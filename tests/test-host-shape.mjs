// 覆盖 2026-09-26 真机事故（官方桌面端实例 127.0.0.1:19387）：
//   桌面端里 DSH host 是 **Electron 二进制**跑 asar 内入口，不是 `node bin.js web`。
//   我们的「重启服务 / 回滚 / 框架升级重启」会 Stop-Process 掉 host，再 Resolve-DshBin 找不到 bin.js
//   → 拉不起来 → Electron 外壳记 `crash-…-host.log: dsh desktop host exited with 4294967295`（真机 20:28）。
// 断言（全部离线、纯函数 + 静态接线）：
//   ① 独立 `node bin.js web` 形态**不**被判定为外壳托管（既有行为一字不改）
//   ② 桌面端 host 形态（真机原样命令行的 execPath / argv）被判为外壳托管，且理由可读
//   ③ 单个证据也能命中（ELECTRON_RUN_AS_NODE / versions.electron / resourcesPath / electron.exe）
//   ④ 「父进程是 Electron 外壳」**不参与判定**（本机 3080 的父进程也是 Electron —— 否则就误杀独立实例）
//   ⑤ `relaunchPrelude` 在非托管形态下与旧实现**逐字节相同**（25 行、无任何 DSH_HOSTED）；托管形态只多拒绝、不 spawn
//   ⑥ 路由里 4 处「会 kill/spawn 的框架动作」都接了守卫（静态接线，防以后被删掉）

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectHostShape, relaunchPrelude, SHELL_HOSTED_NOTICE } from '../lib/server/domain/framework.js'
import { refuseWhenShellHosted } from '../lib/server/routes/framework.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

// ── 真机取样的两个形态（原样抄自 2026-09-26 的 Win32_Process.CommandLine）──────────
const STANDALONE = { // 3080：node …\dsh\lib\bin.js web --no-open（pid 32464）
  execPath: 'D:\\nvm4w\\nodejs\\node.exe',
  argv: ['D:\\nvm4w\\nodejs\\node.exe', 'D:\\node_cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'web', '--no-open'],
  env: { PATH: 'C:\\Windows' },
  versions: { node: '24.13.0' },
  resourcesPath: undefined,
  ppid: 28660, // 真实父进程 = %TEMP%\…\DeepSeek Harness.exe（用户启动器）—— 刻意不参与判定
}
const DESKTOP_HOST = { // 19387：DeepSeek Harness.exe --expose-internals …\app.asar\dsh\node_modules\…\dsh-desktop-host\lib\index.js（pid 32252）
  execPath: 'D:\\dsh-desktop\\DeepSeek Harness.exe',
  argv: [
    'D:\\dsh-desktop\\DeepSeek Harness.exe',
    'D:\\dsh-desktop\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
    'D:\\dsh-desktop\\resources\\app.asar\\dsh',
    'C:\\Users\\花火\\.dsh\\profiles\\desktop',
    'D:\\dsh-desktop\\resources\\runtime\\primary-runtime',
    'D:\\dsh-desktop\\resources\\runtime\\pnpm\\bin\\pnpm.mjs',
    'D:\\dsh-desktop\\resources\\runtime\\bin',
  ],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  versions: { node: '24.18.1', electron: '44.0.0' },
  resourcesPath: 'D:\\dsh-desktop\\resources',
  ppid: 28776,
}

// ① 独立 dsh web：不得命中
{
  const shape = detectHostShape(STANDALONE)
  check('独立 node bin.js web 不判为外壳托管（既有行为不变）', shape.hosted === false && shape.kind === 'standalone', `reasons=${JSON.stringify(shape.reasons)}`)
  check('独立实例的 notice 为 null（调用方不需要分支）', shape.notice === null)
}
// ② 桌面端 host：必须命中，且理由能让人看懂
{
  const shape = detectHostShape(DESKTOP_HOST)
  check('桌面端 host（asar 内 dsh-desktop-host）判为外壳托管', shape.hosted === true && shape.kind === 'desktop-shell', shape.reasons.join('；'))
  check('命中理由含 asar 入口（真机可核对）', shape.reasons.some((r) => /app\.asar/u.test(r)), shape.reasons.find((r) => /app\.asar/u.test(r)) ?? '（无）')
  check('notice 就是面向用户的短句', shape.notice === SHELL_HOSTED_NOTICE, shape.notice ?? '（null）')
  check('evidence 记录 execPath/argv1/electron 版本（事后可复现判定）',
    shape.evidence.execPath === DESKTOP_HOST.execPath && /app\.asar/u.test(shape.evidence.argv1) && shape.evidence.electronVersion === '44.0.0')
}
// ③ 单证据命中（判据之间互相独立，任一成立就够）
{
  const only = (patch) => detectHostShape({ ...STANDALONE, ...patch })
  check('单证据：ELECTRON_RUN_AS_NODE=1', only({ env: { ELECTRON_RUN_AS_NODE: '1' } }).hosted === true)
  check('单证据：process.versions.electron', only({ versions: { node: '24.18.1', electron: '44.0.0' } }).hosted === true)
  check('单证据：execPath 是 electron.exe', detectHostShape({ ...STANDALONE, execPath: 'C:\\app\\electron.exe' }).hosted === true)
  check('单证据：resourcesPath + 非 node 可执行文件', only({ execPath: 'C:\\x\\some-app.exe', resourcesPath: 'C:\\x\\resources' }).hosted === true)
  check('反向：resourcesPath 存在但 execPath 是 node.exe → 不判（保守）', only({ resourcesPath: 'C:\\x\\resources' }).hosted === false)
  check('反向：argv 里没有 asar 时不会命中该条', only({ argv: ['C:\\node.exe', 'D:\\dsh\\lib\\bin.js'] }).reasons.every((r) => !/app\.asar/u.test(r)))
}
// ④ 父进程证据不参与判定（本机真实陷阱：3080 的父进程也是 Electron 启动器）
{
  const sameParent = detectHostShape({ ...STANDALONE, ppid: 28660 })
  check('父进程是 Electron 启动器 ≠ 外壳托管（不误杀独立实例）', sameParent.hosted === false, `ppid=${sameParent.evidence.ppid}`)
}
// ⑤ relaunchPrelude：非托管形态逐字节不变；托管形态只拒绝、不 spawn
{
  const base = { nodePath: 'C:\\node\\node.exe', pluginDir: 'C:\\p', fwRoot: 'C:\\fw', target: '0.1.7', ps: (s) => JSON.stringify(String(s)) }
  const off = relaunchPrelude({ ...base, hosted: false })
  const auto = relaunchPrelude({ ...base })
  const on = relaunchPrelude({ ...base, hosted: true })
  check('非托管形态：脚本行数与旧实现一致（25 行）', off.split('\r\n').length === 25, `${off.split('\r\n').length} 行`)
  check('非托管形态：不含任何宿主守卫痕迹（逐字节不变）', !off.includes('DSH_HOSTED') && !off.includes('外壳托管'))
  check('未显式传 hosted 时自动判定，独立实例下与旧实现逐字节相同', auto === off)
  check('托管形态：写入 $script:DSH_HOSTED 标记', on.includes('$script:DSH_HOSTED = $true'))
  check('托管形态：Invoke-DshRelaunch 里直接 return $false（不 Start-Process）',
    /if \(\$script:DSH_HOSTED\) \{ Log \('本实例由桌面端外壳托管，跳过拉起/u.test(on) && on.split('Start-Process').length === off.split('Start-Process').length,
    `Start-Process 出现 ${on.split('Start-Process').length - 1} 次（与旧实现相同——那是 Resolve 失败分支的兜底，托管分支先 return）`)
  check('托管形态：只多 2 行（标记 + 守卫）', on.split('\r\n').length === off.split('\r\n').length + 2)
}
// ⑥ refuseWhenShellHosted：桌面形态下写 409 + 短句；独立形态下不写、返回 false
{
  const fakeRes = () => {
    const rec = { status: null, body: null }
    return { rec, writeHead(status) { rec.status = status }, end(payload) { rec.body = JSON.parse(payload) } }
  }
  // 默认（本测试进程 = 独立 node）→ 不拒绝
  const resOff = fakeRes()
  check('独立实例：守卫不拦截（返回 false、不写响应）', refuseWhenShellHosted(resOff) === false && resOff.rec.status === null)
  // 临时把本进程伪装成 Electron 承载的 host（走真实 detectHostShape 的全局读取路径）
  const saved = { ...process.env }
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const resOn = fakeRes()
    const refused = refuseWhenShellHosted(resOn)
    check('外壳托管：守卫拦截并返回结构化 409 + 面向用户短句',
      refused === true && resOn.rec.status === 409 && resOn.rec.body?.ok === false && resOn.rec.body?.error === SHELL_HOSTED_NOTICE,
      `status=${resOn.rec.status} error=${resOn.rec.body?.error}`)
    check('拒绝响应带 code/hostKind/reasons（前端与日志可判因）',
      resOn.rec.body?.details?.code === 'hosted-by-shell' && resOn.rec.body?.details?.hostKind === 'desktop-shell' && Array.isArray(resOn.rec.body?.details?.reasons),
      JSON.stringify(resOn.rec.body?.details?.reasons ?? []))
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    for (const [k, v] of Object.entries(saved)) process.env[k] = v
  }
  check('守卫已从 routes/framework.js 导出（framework-upgrade 复用同一份判据）', typeof refuseWhenShellHosted === 'function')
}
// ⑦ 静态接线：4 处会 kill/spawn 的框架动作都接了守卫
{
  const fw = readFileSync(join(ROOT, 'lib', 'server', 'routes', 'framework.js'), 'utf8')
  const up = readFileSync(join(ROOT, 'lib', 'server', 'routes', 'framework-upgrade.js'), 'utf8')
  const guardCalls = [...fw.matchAll(/if \(refuseWhenShellHosted\(res\)\) return/gu)].length
    + [...up.matchAll(/const refusal = shellHostedRefusal\(\); if \(refusal !== null\)/gu)].length
  check('守卫接线：routeFrameworkRelaunch / routeFrameworkRollback / routeRestart / routeFrameworkUpgrade 共 4 处', guardCalls === 4, `实际 ${guardCalls} 处`)
  check('upgrade 路由用同一份判据（shellHostedRefusal，来自 domain）', up.includes("shellHostedRefusal } from '../domain/framework.js'"))
  check('rollback 路由（20:28 事故真正凶手）确实在生成脚本前就守卫', /refuseWhenShellHosted\(res\)\) return\r?\n\s*let rec = null/u.test(fw))
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
