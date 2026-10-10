// 升级/回滚脚本「生成物」语法门禁：
// 2026-09-10 事故里，升级脚本的回滚分支在真机上崩了（PowerShell 报「无法将参数绑定到参数 Path」），
// 而这段脚本是 JS 模板串拼出来的 —— 拼错引号/路径只能在真机升级时才暴露。
// 本测试把两段生成逻辑（升级脚本 / 一键回滚脚本）从源码里抽出来，用桩变量真跑一遍，
// 再把生成结果交给 PowerShell 解析器做**语法校验（只解析不执行）**，把这类错误拦在提交前。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = dirname(fileURLToPath(import.meta.url))
// 统一归一化行尾再抽函数：本机 core.autocrlf=true，工作区文件是 CRLF，
// 而下面的 `indexOf('\n}\n')` 是按 LF 写的 —— 不归一化就会在 Windows 上抠不到函数定义
// （CI 是 Linux/LF 所以一直绿，本地却红：2026-09-24 整理 tests/ 后实测踩到）。
const readSrc = (p) => readFileSync(p, 'utf8').replace(/\r\n/gu, '\n')
const SRC = readSrc(join(ROOT, '..', 'lib', 'index.js'))
// relaunchPrelude 已在 Step 6 搬进 framework.js（生成器函数里的局部 ps/launchSnippet 仍在 index.js）
const SRC_FW = readSrc(join(ROOT, '..', 'lib', 'server', 'domain', 'framework.js'))
const SRC_RFU = readSrc(join(ROOT, '..', 'lib', 'server', 'routes', 'framework-upgrade.js'))
const SRC_FR = readSrc(join(ROOT, '..', 'lib', 'server', 'routes', 'framework.js'))
// 2026-09-24：安装后「结构完整性校验」生成器抽到 infra（routes 撞守卫行数上限）
const SRC_FWIS = readSrc(join(ROOT, '..', 'lib', 'server', 'infra', 'fw-integrity-check.js'))
const OUT = join(ROOT, '.testdir')
mkdirSync(OUT, { recursive: true })

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

/** 找一个可用的 PowerShell（Windows: powershell.exe；跨平台 CI: pwsh）；都没有则返回 null（跳过语法校验）。 */
function findPowerShell() {
  for (const bin of ['powershell.exe', 'pwsh', 'pwsh.exe']) {
    try {
      execFileSync(bin, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 30000 })
      return bin
    } catch {}
  }
  return null
}

/** 从源码中抽出全部 PowerShell 生成块：以「结束标记」为锚点**回推**最近的 `const lines = [`
 *  （正向配对会把无关的 `const lines = []` 与远处的结束标记配成一对，导致抽出原始 JS 而报语法错）。 */
function extractBlocks() {
  const endMarker = ".filter((l) => l !== '').join('\\r\\n')"
  const startMarker = 'const lines = ['
  const out = []
  // 路由拆分（Step 8b）后脚本生成块搬进了 routes/framework-upgrade.js（升级）与 routes/framework.js（回滚/重启）；三处都扫
  for (const source of [SRC_RFU, SRC_FR, SRC]) {
    let at = source.indexOf(endMarker)
    while (at !== -1) {
      const from = source.lastIndexOf(startMarker, at)
      if (from !== -1) out.push(source.slice(from + startMarker.length - 1, at) + endMarker)
      at = source.indexOf(endMarker, at + endMarker.length)
    }
  }
  return out
}

/** 抽出真实的 ps() 实现（要测的就是它的转义正确性，不能另写一份）。
 *  结束边界取「下一个 const 声明」——ps() 与 lines 之间现在还有 launchSnippet/patchFilePath，
 *  直接切到 `const lines` 会把它们一起吞进来（里面含 import.meta，破坏 new Function 求值）。 */
const psStart = SRC_RFU.indexOf('const ps = (s) => {')
const psEndCandidates = ['const launchSnippet', 'const patchFilePath', 'const lines = [']
  .map((marker) => SRC_RFU.indexOf(marker, psStart))
  .filter((at) => at > psStart)
const psImpl = SRC_RFU.slice(psStart, Math.min(...psEndCandidates)).replace(/\s+$/u, '')

/** 抽出真实 launchSnippet 实现（单行箭头函数），让语法校验覆盖真实片段文本。 */
const lsStart = SRC_RFU.indexOf('const launchSnippet = (tag) =>')
const launchSnippetSrc = SRC_RFU.slice(lsStart, SRC_RFU.indexOf('\n', lsStart)).replace(/;\s*$/u, '')

/** 抽出真实的 relaunchPrelude 生成器（v0.3.37：拉起逻辑只此一份，必须测真的）。
 *  结束边界用「函数体最后一行的 `].join('\r\n')` + 其后第一个 }」定位——
 *  直接匹配 `\n}` 会被 CRLF 检出害死（仓库文件是 CRLF）。 */
const rpStart = SRC_FW.indexOf('function relaunchPrelude(')
const rpTail = rpStart === -1 ? -1 : SRC_FW.indexOf("].join('\\r\\n')", rpStart)
const rpEnd = rpTail === -1 ? -1 : SRC_FW.indexOf('}', rpTail)
const relaunchPreludeSrc = rpEnd === -1 ? '' : SRC_FW.slice(rpStart, rpEnd + 1)

// 桩变量：路径故意带空格与 $，用来验证转义（PowerShell 双引号串里 $ 会被插值）
const scope = {
  ps: null,
  join,
  dirname,
  port: 3080,
  target: '0.1.5-rc.1',
  current: '0.1.2-rc.1',
  fwRoot: 'C:\\tmp dir\\$weird\\node_modules',
  dshDir: 'C:\\tmp dir\\$weird\\node_modules\\.pnpm\\@deepseek-ai+dsh@0.1.2-rc.1_x\\node_modules\\@deepseek-ai\\dsh',
  fwCheckpoint: { dest: 'C:\\Users\\user\\.dsh\\plugin-console\\framework-backups\\0.1.2-rc.1\\fw-tree\\1789022284780' },
  backupDir: 'C:\\Users\\user\\.dsh\\plugin-console\\framework-backups\\0.1.2-rc.1',
  rollbackDir: 'C:\\Users\\user\\.dsh\\plugin-console\\framework-backups\\0.1.2-rc.1\\dsh-package-backup',
  taskName: 'DSH-FW-Upgrade-1234',
  corepackJs: 'C:\\nodejs\\node_modules\\corepack\\dist\\corepack.js',
  pkgArgs: ["'@deepseek-ai/dsh-base'"],
  profileDir2: 'C:\\Users\\user\\.dsh\\profiles\\web',
  nodePath: 'C:\\nodejs\\node.exe',
  stateFile: 'C:\\Users\\user\\.dsh\\plugin-console\\fw-upgrade-state.txt',
  logFile: 'C:\\Users\\user\\.dsh\\plugin-console\\fw-upgrade.log',
  ps1: 'C:\\Users\\user\\AppData\\Local\\Temp\\fw-upgrade-1234.ps1',
  rec: { from: '0.1.2-rc.1', checkpointDir: 'C:\\Users\\user\\.dsh\\plugin-console\\framework-backups\\0.1.2-rc.1\\fw-tree\\1789022284780', fwRoot: 'C:\\tmp dir\\$weird\\node_modules' },
  resolveDshBin: () => 'C:\\tmp dir\\$weird\\node_modules\\.pnpm\\@deepseek-ai+dsh@0.1.5-rc.1_x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  fileURLToPath: () => 'file:///C:/work/dsh-plugin-hub/lib/index.js',
  selfName: '@noob-stupid/dsh-plugin-console',
  binPath: 'C:\\tmp dir\\$weird\\node_modules\\.pnpm\\@deepseek-ai+dsh@0.1.5-rc.1_x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  // 启动失败隔离相关（新）
  qHelperPath: 'C:\\Users\\user\\.dsh\\plugin-console\\fw-analyze-boot.mjs',
  qCandidatesPath: 'C:\\Users\\user\\.dsh\\plugin-console\\fw-quarantine-candidates.json',
  qRecordPath: 'C:\\Users\\user\\.dsh\\plugin-console\\fw-quarantine.json',
  patchFilePath: 'C:\\Users\\user\\.dsh\\profiles\\web\\cordis.patch.yml',
  thirdPartyRows: ['dsh-routing-suite', 'dsh-github-login'],
  // 重启路由（v0.3.43）用到的局部变量
  restartLog: 'C:\\Users\\user\\.dsh\\plugin-console\\console-restart.log',
  consoleDir: 'C:\\Users\\user\\.dsh\\plugin-console',
  taskName: 'DSH-Restart-1234',
  guardName: 'DSH-RestartGuard-1234',
  guardCount: 'C:\\Users\\user\\.dsh\\plugin-console\\restart-guard-1234.count',
  killLine: 'Stop-Process -Id 1234 -Force -ErrorAction SilentlyContinue',
  prelude: '',
  // Step 1（L0 分层）之后：包根统一走 lib/server/infra/paths.js 的 pluginRoot()
  // （原来是 join(dirname(fileURLToPath(import.meta.url)), '..')，搬进子目录后会指错）
  pluginRoot: () => 'C:\\work\\dsh-plugin-hub',
}

// 未知标识符用桩兜底（只为跑通生成、验证 PowerShell 语法；名字会打印出来供人工核对）
const stubbed = new Set()
const scoped = new Proxy(scope, {
  has: () => true,
  get: (target, key) => {
    if (key === Symbol.unscopables) return undefined
    if (key in target) return target[key]
    if (key in globalThis) return globalThis[key] // String/Date/JSON 等内置不能被桩掉
    stubbed.add(String(key))
    return `<stub:${String(key)}>`
  },
})

function build(expr) {
  // import.meta 在 new Function 里不可用：把所有 import.meta.url 换成字面量桩（语法校验不受影响）
  const stubUrl = "C:/work/dsh-plugin-hub/lib/index.js"
  const prep = (text) => text.replace(/import\.meta\.url/gu, JSON.stringify(stubUrl))
  const extras = launchSnippetSrc === '' ? '' : `${prep(launchSnippetSrc)};`
  const fn = new Function('scope', `with (scope) { ${psImpl}; ${extras} return (${prep(expr)}); }`)
  return fn(scoped)
}

// 真实的 ps / relaunchPrelude 实现（用于下面的真机行为验证）
const realPs = new Function(`${psImpl}; return ps;`)()
// 2026-09-26：relaunchPrelude 现在会自己判定宿主形态（外壳托管时生成"拒绝拉起"的脚本），
// 抠出来的源码片段必须把 domain/framework.js#detectHostShape 作为依赖喂进去（本沙箱是纯 node，判为独立实例）。
const makePrelude = relaunchPreludeSrc === '' ? null : new Function('join', 'detectHostShape', `${relaunchPreludeSrc}; return relaunchPrelude;`)(join, () => ({ hosted: false, kind: 'standalone', reasons: [], notice: null }))
// with(scope) 里 has() 恒真：函数声明会被 scope 对象环境遮蔽，必须把真实实现挂到 scope 上
if (makePrelude !== null) scope.relaunchPrelude = makePrelude
// 2026-09-24：升级脚本数组里现在是 fwIntegrityCheck({...}) 的返回值，把真实实现挂进 scope；
// 抠不到就退回一段合法 PowerShell 注释（不破坏语法校验），并让"抠不到"这件事在断言里可见
{
  const start = SRC_FWIS.indexOf('function fwIntegrityCheck')
  const end = SRC_FWIS.indexOf('\n}\n', start)
  if (start !== -1 && end !== -1) {
    scope.fwIntegrityCheck = new Function(`${SRC_FWIS.slice(start, end + 2)}; return fwIntegrityCheck;`)()
    check('能从源码抠出 fwIntegrityCheck（安装后结构校验生成器）', typeof scope.fwIntegrityCheck === 'function')
  } else {
    scope.fwIntegrityCheck = () => '# fwIntegrityCheck 源码未找到（结构校验未覆盖）'
    check('能从源码抠出 fwIntegrityCheck（安装后结构校验生成器）', false, '未找到函数定义')
  }
}
// 重启脚本数组里是 `${prelude}`（已生成好的整段），这里给一份真货，否则会生成 <stub:prelude> 破坏语法
if (makePrelude !== null) {
  scope.prelude = makePrelude({ nodePath: scope.nodePath, pluginDir: 'C:\\Users\\user\\.dsh\\profiles\\web\\node_modules\\@noob-stupid\\dsh-plugin-console', fwRoot: scope.fwRoot, target: scope.target, ps: realPs })
}

// 按**唯一**特征挑选块（升级脚本含 Install-Framework；一键回滚脚本含「一键回滚脚本启动」——
// 注意升级脚本内部也有 '全树回滚完成' 字样，用它选会误选到升级块，导致回滚脚本失去覆盖）
const allBlocks = extractBlocks()
check('源码里能找到升级脚本块', allBlocks.some((b) => b.includes('function Install-Framework')), `共 ${allBlocks.length} 个 lines 块`)
check('源码里能找到一键回滚脚本块', allBlocks.some((b) => b.includes('一键回滚脚本启动')), `共 ${allBlocks.length} 个 lines 块`)
const blocks = [
  ['升级脚本', allBlocks.find((b) => b.includes('function Install-Framework')) ?? ''],
  ['一键回滚脚本', allBlocks.find((b) => b.includes('一键回滚脚本启动')) ?? ''],
]
check('两个脚本块不是同一段（避免覆盖假象）', blocks[0][1] !== blocks[1][1])

// ── 转义丢失canary（v0.3.42）：模板串里的 `\d` `\s` 会被 JS 吃掉，生成出来的正则变成 `(d+)` ──
// 2026-09-11 复审抓到 5 处：版本数值比较（决定重链哪个框架版本！）、npmrc 缓存正则、隔离查重正则。
// 这类 bug 生成脚本语法完全合法、只有行为悄悄退化，所以必须单独设闸。
const EATEN = []
{
  const legal = new Set(['\\', '`', '$', 'n', 'r', 't', '0', 'b', 'f', 'v', 'u', 'x', "'", '"'])
  SRC.split(/\r?\n/u).forEach((line, i) => {
    if (!/^\s*`/u.test(line)) return // 只看「整行就是一个模板串」的生成行（JS 正则字面量因此被排除）
    for (let at = line.indexOf('\\'); at !== -1;) {
      const next = line[at + 1]
      if (next === undefined) break
      if (legal.has(next)) { at = line.indexOf('\\', at + 2); continue }
      EATEN.push(`L${i + 1}: …${line.slice(Math.max(0, at - 40), at + 20).trim()}…`)
      at = line.indexOf('\\', at + 1)
    }
  })
}
check('生成脚本的模板串里没有会被 JS 吃掉的转义', EATEN.length === 0, EATEN.slice(0, 4).join(' | ') || '（无）')

for (const [name, expr] of blocks) {
  let script = ''
  try {
    script = build(expr)
    check(`${name}：生成成功`, typeof script === 'string' && script.length > 200, `${script.length} 字符`)
  } catch (error) {
    check(`${name}：生成成功`, false, error.message)
    continue
  }
  // 转义丢失的行为级复查：生成出来的正则必须真的是正则
  check(`${name}：没有 (d+) / (s+) 这类丢转义残留`, !/\(d\+\)|\(s\+\)|caches\*=/u.test(script))
  if (name === '升级脚本') {
    check('升级脚本：版本比较正则是数值正则', script.includes("'^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(?:[a-z]+\\.)?(\\d+))?'"))
    check('升级脚本：npmrc 缓存正则是空白正则', script.includes("'^cache\\s*=\\s*(.+)$'"))
  }
  check(`${name}：无未替换的桩值（未知标识符已兜底，列出供核对）`, true, stubbed.size === 0 ? '（无未知标识符）' : [...stubbed].join(','))
  check(`${name}：路径未被 PowerShell 插值破坏（含 $ 的路径保持原样）`, script.includes('$weird') && !/\$\{/.test(script), script.split('\n').find((l) => l.includes('weird'))?.slice(0, 90))
  check(`${name}：不含空串字面量 '' 误用（$cp 类判空）`, !/=\s*'""'/u.test(script), script.split('\n').find((l) => /=\s*'""'/u.test(l)) ?? '（无）')
  // 2026-09-25 真机事故：生成器里写了 JS 风格注释 `//`，被原样写进 PowerShell —— PS 把 `//` 当命令名执行，
  // 报「无法将"//"项识别为 cmdlet…」→ 脚本异常终止、升级记录留一条吓人的失败（框架其实已经升好了）。
  // 这类错误 PowerShell 语法解析查不出来（裸命令是合法语法），只能靠这条规则拦。
  check(`${name}：没有把 JS 注释 // 写进 PowerShell（PS 会把 // 当命令执行）`,
    !script.split(/\r?\n/u).some((l) => l.trim().startsWith('//')),
    script.split(/\r?\n/u).find((l) => l.trim().startsWith('//'))?.slice(0, 90) ?? '（无）')
  if (name === '升级脚本') {
    check('升级脚本含启动失败隔离（Invoke-Quarantine）', script.includes('function Invoke-Quarantine') && script.includes('安全模式'))
    // 比较**调用点**顺序：隔离重试必须发生在回滚调用之前（函数定义在文件更前面，不能拿定义位置比）
    const qCall = script.indexOf('if (-not (Invoke-Quarantine))')
    const rCall = script.lastIndexOf('Invoke-Rollback')
    check('隔离重试在回滚之前', qCall !== -1 && qCall < rCall, `隔离调用@${qCall} 回滚调用@${rCall}`)
    // 2026-09-24 事故后补：安装后必须验「结构完整」，不能只对版本号（当天一次升级的 pnpm 安装被中断，
    // 顶层 @deepseek-ai\dsh 目录整个消失、.pnpm 实体只剩 lib 里几个硬链接）
    check('升级脚本含安装后结构校验（package.json + bin.js + CLI 自报版本）',
      script.includes('结构校验失败') && script.includes('结构校验通过')
      && script.includes('lib\\bin.js') && script.includes('--version'))
  }

  // ── v0.3.37 事故回归：拉起服务那一步崩在 `Test-Path $null` 上（$null -ne '' 是 true，守卫失效）──
  check(`${name}：拉起逻辑只有一份实现`, (script.match(/function Resolve-DshBin/gu) ?? []).length === 1 && (script.match(/function Invoke-DshRelaunch/gu) ?? []).length === 1,
    `Resolve=${(script.match(/function Resolve-DshBin/gu) ?? []).length} Invoke=${(script.match(/function Invoke-DshRelaunch/gu) ?? []).length}`)
  // 「拉起命令」只在助手函数里写一次（原先 5 处复制粘贴 → 同一个坑反复踩）
  check(`${name}：拉起命令只有一处（不再内联）`, (script.match(/ web >> /gu) ?? []).length === 1 && /Invoke-DshRelaunch '/u.test(script),
    `内联拉起命令 ${(script.match(/ web >> /gu) ?? []).length} 处；调用点 ${(script.match(/Invoke-DshRelaunch '/gu) ?? []).length} 个`)
  check(`${name}：崩溃写法已清除（不再有未归一化的 $binNow）`, !script.includes('$binNow'))
  // 只看拉起助手内部：对变量的 Test-Path 必须用在归一化之后的变量上
  // （助手块紧跟 trap 之前定义，用它作为结束边界最稳）
  const hStart = script.indexOf('function Resolve-DshBin')
  const hEnd = script.indexOf('trap {', hStart)
  const helperText = hStart === -1 ? '' : script.slice(hStart, hEnd === -1 ? script.length : hEnd)
  const helperVars = [...helperText.matchAll(/Test-Path\s+(?:-LiteralPath\s+)?\$(\w+)/gu)].map((m) => m[1])
  check(`${name}：拉起助手里对变量的 Test-Path 只用在归一化结果上`,
    helperVars.length > 0 && helperVars.every((v) => ['cand', 'c', 'bin'].includes(v)) && helperText.includes("if ($cand -isnot [string]) { $cand = '' }"),
    `变量: ${[...new Set(helperVars)].join(',') || '（无）'}`)
  check(`${name}：解析有回退链（目标版本 .pnpm → 顶层链接 → 最新 .pnpm）`,
    script.includes("-Filter '@deepseek-ai+dsh@") && (script.match(/@deepseek-ai\\dsh\\lib\\bin\.js/gu) ?? []).length >= 2,
    `bin.js 路径 ${(script.match(/@deepseek-ai\\dsh\\lib\\bin\.js/gu) ?? []).length} 处`)

  const file = join(OUT, `gen-${name === '升级脚本' ? 'upgrade' : 'rollback'}.ps1`)
  writeFileSync(file, `\uFEFF${script}`, 'utf8')
  // PowerShell 解析器校验（只解析、不执行）。CI（ubuntu）只有 pwsh，没有 powershell.exe —— 找不到就 SKIP。
  const shell = findPowerShell()
  if (shell === null) {
    console.log(`SKIP ${name}：PowerShell 语法校验（本机无 powershell.exe / pwsh）`)
  } else {
    try {
      execFileSync(shell, ['-NoProfile', '-Command', `$t = Get-Content -Raw -Encoding UTF8 '${file}'; $null = [scriptblock]::Create($t); 'PARSE OK'`], { encoding: 'utf8', timeout: 60000 })
      check(`${name}：PowerShell 语法校验`, true, shell)
    } catch (error) {
      const msg = String(error.stdout ?? '') + String(error.stderr ?? '') + String(error.message ?? '')
      check(`${name}：PowerShell 语法校验`, false, msg.split('\n').filter((l) => l.trim() !== '').slice(-3).join(' | ').slice(0, 300))
    }
  }
  rmSync(file, { force: true })
}

// ── 真机行为验证：把脚本里的拉起实现抽出来真跑（不是只看语法）────────────────
// 三种场景：① 正常 → 解析到真实 bin.js；② 解析探针坏掉（复现 2026-09-11 崩溃现场）→ 回退链必须兜住；
// ③ 连框架根都是假的 → 只报告失败、**绝不抛错**（旧代码在这里 Test-Path $null 直接干掉整个脚本）。
const shell = findPowerShell()
const realProfile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web')
let realFwRoot = null
let realTarget = null
let realPluginDir = join(realProfile, 'node_modules', '@noob-stupid', 'dsh-plugin-console')
try {
  const req = createRequire(join(realProfile, 'package.json'))
  const pkgPath = realpathSync(req.resolve('@deepseek-ai/dsh/package.json'))
  realTarget = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  let dir = dirname(pkgPath)
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.pnpm'))) { realFwRoot = dir; break }
    dir = dirname(dir)
  }
} catch {}
if (shell === null || makePrelude === null || realFwRoot === null || !existsSync(realPluginDir)) {
  console.log('SKIP 拉起实现真机行为验证（需要 PowerShell + 本机框架安装 + 插件目录；CI 环境正常跳过）')
} else {
  const workLog = join(OUT, 'relaunch-selftest.log')
  rmSync(workLog, { force: true })
  const runCase = (label, opts) => {
    const prelude = makePrelude({ nodePath: opts.nodePath, pluginDir: realPluginDir, fwRoot: opts.fwRoot, target: realTarget, ps: realPs })
    const ps1 = join(OUT, `relaunch-case-${label}.ps1`)
    // $state 必须给：拉起前导块带心跳（$hb = $state + '.hb'），缺了会在当前目录写出一个 .hb
    writeFileSync(ps1, `\uFEFF$log = '${workLog}'\r\n$state = '${join(OUT, 'relaunch-state.txt')}'\r\nfunction Log($m) { try { Add-Content -Path $log -Value $m -Encoding UTF8 } catch {} }\r\n${prelude}\r\n` +
      `function Start-Process { param([string]$FilePath, $ArgumentList, [string]$WindowStyle) $script:cmd = $FilePath + ' :: ' + ($ArgumentList -join ' ') }\r\n` +
      `$r = Resolve-DshBin\r\nWrite-Output ('RESOLVE=' + $r)\r\nWrite-Output ('EXISTS=' + $(if ($r -eq '') { 'False' } else { Test-Path -LiteralPath $r }))\r\n` +
      `$ok = Invoke-DshRelaunch 'selftest'\r\nWrite-Output ('RELAUNCH=' + $ok)\r\nWrite-Output ('CMD=' + $script:cmd)\r\n`, 'utf8')
    const out = execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8', timeout: 90000 })
    rmSync(ps1, { force: true })
    const get = (k) => (out.match(new RegExp(`^${k}=(.*)$`, 'mu')) ?? [])[1] ?? ''
    return { resolve: get('RESOLVE').trim(), exists: get('EXISTS').trim(), relaunch: get('RELAUNCH').trim(), cmd: get('CMD').trim() }
  }
  const okCase = runCase('ok', { nodePath: process.execPath, fwRoot: realFwRoot })
  check('拉起：正常情况解析到真实 bin.js', okCase.exists === 'True' && /bin\.js$/u.test(okCase.resolve), okCase.resolve.slice(-70))
  check('拉起：正常情况真的发起了服务进程', okCase.relaunch === 'True' && okCase.cmd.includes('cmd.exe') && okCase.cmd.includes('web'), okCase.cmd.slice(0, 110))
  // 崩溃现场复现：node 解析探针不可用（等价于当天那一瞬间 resolve 失败）
  const brokenProbe = runCase('probe-broken', { nodePath: join(OUT, 'no-such-node.exe'), fwRoot: realFwRoot })
  check('拉起：解析探针坏掉时回退链兜住（当天就是这里崩的）', brokenProbe.exists === 'True' && /bin\.js$/u.test(brokenProbe.resolve), brokenProbe.resolve.slice(-70))
  check('拉起：回退后依然发起了服务进程', brokenProbe.relaunch === 'True', brokenProbe.cmd.slice(0, 110))
  // 全坏：必须只报告、不抛错（旧代码会在这里 Test-Path $null 崩掉整个脚本）
  const allBad = runCase('all-bad', { nodePath: join(OUT, 'no-such-node.exe'), fwRoot: join(OUT, 'no-such-fwroot') })
  check('拉起：全找不到时返回空串而不抛错', allBad.exists === 'False' && allBad.resolve === '', `resolve=[${allBad.resolve}]`)
  check('拉起：全找不到时函数返回 False 且留下可读日志', allBad.relaunch === 'False' && readFileSync(workLog, 'utf8').includes('三种方式都找不到'))
  rmSync(workLog, { force: true })
}

// ── 重启路径（2026-10-10 改错）："端口无监听就 spawn 拉起"的守护路径必须**不存在** ──────
// 用户红线原话：「桌面端重启必须走官方的那种不报错重启，如果你走手动拉起之类的等等很可能会出现
// 那种报错，这是一定不能的」＋「有时候控制台代理重启啥的会出现《应用无法启动或已意外停止》」。
// 现场（<DSH_HOME>/plugin-console，2026-10-10 15:27–15:33，实测原文）：
//   console-restart.log：`[guard] 端口 3080 无监听，第 1..5 次拉起`
//                        `[guard] 已尝试 5 次仍拉不起来，放弃并自删（请手动启动，或看 …）`
//   fw-relaunch.log：    `拉起(守护第 N 次): <npx 缓存>\@deepseek-ai\dsh\lib\bin.js`
// ⇒ 旧实现在这条路由里生成**自杀脚本 + 每分钟跑一次的计划任务**，端口无监听就手动拉起 dsh，
//   第 6 次还会自删计划任务（危险动作）。同时 /framework-relaunch（悬浮「拉起服务」）也在
//   `Start-Process node bin.js web`。
// 本段把「旧路径已彻底消失」+「新判据只有一个承担者」钉死（纯源码静态断言，全离线）。
// 去行注释：禁词扫描必须只看**可执行代码**（改错的注释里正当地引用了那些旧名词作证据）。
const codeOnly = (source) => source.split('\n').map((line) => {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quote !== null) {
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}).join('\n')
const routeBodyOf = (source, name) => {
  const from = source.indexOf(`async function ${name}(`)
  if (from === -1) return ''
  const end = source.indexOf('\n}', from)
  return end === -1 ? source.slice(from) : source.slice(from, end + 2)
}
{
  check('重启路由不再生成自杀/守护脚本（mainLines / guardLines 都没了）',
    !SRC_FR.includes('const mainLines = [') && !SRC_FR.includes('const guardLines = ['))
  const forbidden = ['DSH-RestartGuard-', 'DSH-Restart-', 'Invoke-DshRelaunch', 'console-restart.log', 'restart-guard-', 'Start-Process', 'Stop-Process', 'schtasks', 'execFile', 'spawn(']
  for (const name of ['routeRestart', 'routeFrameworkRelaunch']) {
    const body = routeBodyOf(SRC_FR, name)
    const code = codeOnly(body).replace(/\s+$/u, '')
    check(`${name}：路由体存在且已改走唯一判据 restartPathDecision`, body !== '' && code.includes('restartPathDecision('), `${code.split('\n').length} 行`)
    const hits = forbidden.filter((t) => code.includes(t))
    check(`${name}：可执行代码里 0 处 kill / spawn / 计划任务 / 自删（扫 ${forbidden.length} 个禁词）`, hits.length === 0, hits.join(', ') || '0 处')
  }
  const restartDomain = readSrc(join(ROOT, '..', 'lib', 'server', 'domain', 'restart.js'))
  check('判据是唯一承担者：两条路由都走同一个 restartPathDecision',
    (SRC_FR.match(/restartPathDecision\(/gu) ?? []).length === 2 && SRC_FR.includes("import { restartPathDecision } from '../domain/restart.js'"))
  check('红线判据在 domain 里写死（spawns / kill / scheduledTask / selfDelete 恒为 false）',
    ['spawns: false', 'kill: false', 'scheduledTask: false', 'selfDelete: false'].every((k) => restartDomain.includes(k)))
  check('官方路径文案在 domain/restart.js 里（桌面端客户端重启 / 独立实例手动重启，都给出路）',
    restartDomain.includes('请在桌面端客户端里重启') && restartDomain.includes('请手动重启这个 dsh web 进程')
    && restartDomain.includes('guide'))
  check('官方路径的原文出处写在模块头（Electron app.relaunch / DESKTOP_IPC 无 restart 通道）',
    restartDomain.includes('app.relaunch()') && restartDomain.includes('dsh-desktop-host'))
  check('client.js 不自己决定重启方式（不再拼"拉起"说法）', !readSrc(join(ROOT, '..', 'lib', 'client.js')).includes('node bin.js web'))
}
check('启动时会清理僵尸计划任务（含重启/守护任务）——既有清残留能力保留', [SRC, SRC_FR, SRC_RFU, SRC_FW].some((s) => s.includes('cleanupStaleFwTasks()')) && [SRC, SRC_FR, SRC_RFU, SRC_FW].some((s) => /DSH-\(\?:FW-|RestartGuard/u.test(s)))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
