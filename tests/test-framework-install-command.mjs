// 「按安装布局分流安装通道」—— 0.5.110 的本体（2026-11-06 真机遗留问题）
//
// ── 上一轮留下的洞（真机实测，不是推测）──────────────────────────────────────────────
//   resolveFrameworkRootNodeModules(dshDir) = "D:/node_cache/_npx/1e7f6d9597241db0/node_modules"
//   judgeFrameworkRoot(...) = { ok: true, layout: "hoisted" }          ← 门已经开了（commit 673f67d）
//   但那层 node_modules 里**没有 .pnpm**；放 package.json 的是它的父目录
//   "D:/node_cache/_npx/1e7f6d9597241db0/"。安装步骤却仍是
//   `corepack pnpm install @deepseek-ai/dsh@<target> --force` + `Set-Location` 到那层 node_modules
//   ⇒ ERR_PNPM_NO_PKG_MANIFEST / 混装，**升不到 0.2.2-rc.1**。
//
// ── 本套钉死的五段（全离线；私有临时目录 + 私有 DSH_HOME；绝不真升级、绝不联网）────────────
//   ① 布局 → 通道 / 前缀：'pnpm' ⇒ pnpm 通道 + fwRoot 本身；'hoisted' ⇒ npm 通道 +
//      `basename(fwRoot)==='node_modules'` 时取**父目录**（含 package.json 的那一层）
//   ② 命令生成纯函数：pnpm 分支与改动前**逐字相同**（旧模板硬编码在断言里）；
//      hoisted 分支是 npm + `--prefix <含 package.json 的那一层>` + 目标版本
//   ③ 装后核对：读回版本 ≠ target ⇒ **判失败**（含读不到、注入的读盘抛错两种）；相等 ⇒ 通过；
//      且 PowerShell 核对块 pnpm 分支逐字不变、hoisted 分支只把通道名换成 npm
//   ④ 路由层（子进程探针，脚本落盘被挡在 tmpdir 同名目录上 ⇒ 绝不走到 schtasks）：
//      hoisted 夹具 ⇒ steps 里出现 `框架安装通道：npm` + 布局 + 安装前缀 + 目标版本；
//      pnpm 夹具 ⇒ steps **与改动前逐字相同**（golden 快照，时间戳/运行模式那条已归一化）
//   ⑤ 静态接线 + 行数棘轮：路由只在非 pnpm 时推通道步骤、旧的内联 pnpm 命令已抽走、
//      framework-upgrade.js 不超 700（本次 699 → 696，净减）、新模块 ≤600 且只 import node: 内置
//
// ── 2026-11-09 发版前实测补的两段（上一单 164aba5 的硬伤）──────────────────────────────────
//   **DSH 桌面端运行时那套 node 里根本没有 npm**（…\dependencies\node\node_modules\ 只有 README.txt），
//   而 164aba5 把扁平布局的 CLI 写死成 `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js`
//   ⇒ 扁平用户会「过了门闸、到安装那一步才因为找不到 npm 失败」= 最差的失败位置。
//   本机实测可用来源：PATH 上的 npm.cmd（D:\nvm4w\nodejs\npm.cmd）、corepack.cmd（`corepack npm` 能跑）。
//   ②b npm 来源解析（resolveNpmCli，exists/which 注入）：① node 自带（含 <root>/bin/ 父目录兜底）
//      → ② PATH npm → ③ corepack npm → ④ none；②③ 命中时命令**不再拼 nodePath**，① 命中时逐字不变；
//      安装日志与升级步骤都写明实际来源（换 npm 不许静默）。pnpm 分支传了 npm 也一个字符都不变。
//   ②c preflight 门（frameworkUpgradeCliBlocker）：扁平布局解析不到 npm ⇒ **在 preflight 就拒**
//      （文案点名三类来源）；pnpm 的判据/文案/顺序逐字不变。④ 段还有一条端到端用例：
//      子进程探针里桩 resolveNpmCli=none ⇒ 200 + upgraded:false + 不出升级脚本。
//   ②d/②e 真机取数：真实 process.execPath + 真实 PATH 解析必须非 none；**病根现场**再用
//      DSH 桌面端运行时那套 node 解析一次（可用 DSH_RUNTIME_NODE 指向），必须是 ② 或 ③。
//      探测不到就显式 SKIP 并写清理由，不假装 PASS。
//
// 变异（我已实跑，见提交说明）：
//   · 把 hoisted 也走 pnpm ⇒ ②/④ 必须红；去掉版本核对 ⇒ ③ 必须红；
//   · 回退链砍成只剩 ① ⇒ ②b(②③)/②e/升级步骤来源 必须红（8 条，含 ③ 与病根现场）；
//   · 拆掉 preflight 的 npm 门 ⇒ ②c + ④ 端到端必须红（4 条）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(ROOT, '..')
const SANDBOX = join(ROOT, '.testdir', 'fw-install-command')
process.env.DSH_HOME = join(SANDBOX, 'home')
const HOME = process.env.DSH_HOME
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
delete process.env.ELECTRON_RUN_AS_NODE // 否则路由会被判成「外壳托管」直接 409

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const {
  frameworkInstallChannel, frameworkInstallCommand, frameworkInstallHome, frameworkInstallPackageJson,
  frameworkInstallReadback, frameworkInstallSetupBlock, frameworkInstallStepText, frameworkInstallVerdict,
  frameworkUpgradeCliBlocker, frameworkVersionVerifyBlock, resolveNpmCli,
} = await import('../lib/server/domain/framework-install-command.js')

// 与路由里同一个 ps()：JSON.stringify → 反斜杠还原 → `"` 双引号字面量（$ / 反引号转义）
const ps = (s) => {
  const j = JSON.stringify(String(s)).replace(/\\\\/gu, '\\')
  if (j === '""') return "''"
  return j.replace(/`/gu, '``').replace(/\$/gu, '`$')
}
const TARGET = '0.2.2-rc.1'
const CURRENT = '0.2.1-rc.5'
const NODE_PATH = 'C:\\nodejs\\node.exe'
const COREPACK_JS = 'C:\\nodejs\\node_modules\\corepack\\dist\\corepack.js'
const NPM_CLI = 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
// 真机同形状：…\_npx\<hash>\node_modules（package.json 在上一层）
const FLAT_ROOT = join('D:', 'node_cache', '_npx', '1e7f6d9597241db0', 'node_modules')
const PNPM_ROOT = join('D:', '.dsh', 'profiles', 'web', 'node_modules')

/** 改动前的 pnpm 命令（原样抄自 673f67d 附近的 templates/`lines` 数组，硬编码当回归基线）。 */
const OLD_PNPM_CMD_LINE = `    $cmdLine = 'start "DSH-Upgrade" cmd /c "title DSH-Upgrade && ${NODE_PATH} ${COREPACK_JS} pnpm install @deepseek-ai/dsh@${TARGET} --force --config.dangerouslyAllowAllBuilds=true --registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"'`
/** 两条通道共用的收尾（`--registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"`）：
 *  从旧 pnpm 命令上量取（`--registry` 之后到行尾），避免在断言里手写那段带引号的尾巴。 */
const MARKER_TAIL = OLD_PNPM_CMD_LINE.slice(OLD_PNPM_CMD_LINE.lastIndexOf('--registry'))
/** 取一条命令的「marker 收尾」部分（与 MARKER_TAIL 同口径）。 */
const markerTailOf = (cmd) => cmd.slice(cmd.lastIndexOf('--registry'))

// ══ ① 布局 → 通道 / 前缀 ═══════════════════════════════════════════════════════════
{
  check('① pnpm 布局 ⇒ pnpm 通道（既有行为不变）', frameworkInstallChannel('pnpm') === 'pnpm')
  check('① hoisted 布局 ⇒ npm 通道（本次核心）', frameworkInstallChannel('hoisted') === 'npm')
  check('① 未知/空布局 ⇒ 不假装 pnpm 能用（默认 npm）',
    frameworkInstallChannel(null) === 'npm' && frameworkInstallChannel(undefined) === 'npm' && frameworkInstallChannel('') === 'npm')

  check('① 前缀 = 含 package.json 的那一层（…\\node_modules ⇒ 父目录；真机就是这层放 package.json）',
    frameworkInstallHome(FLAT_ROOT) === dirname(FLAT_ROOT) && frameworkInstallHome(PNPM_ROOT) === dirname(PNPM_ROOT),
    `${frameworkInstallHome(FLAT_ROOT)}`)
  check('① 传进来的不是 node_modules（已是项目根）⇒ 原样返回', frameworkInstallHome('C:\\proj\\app') === 'C:\\proj\\app')
  check('① 空/非字符串 fwRoot ⇒ null（不抛、不瞎猜）',
    frameworkInstallHome(null) === null && frameworkInstallHome('') === null && frameworkInstallHome(42) === null)
  check('① 装后核对读的是 <fwRoot>/@deepseek-ai/dsh/package.json',
    frameworkInstallPackageJson(FLAT_ROOT) === join(FLAT_ROOT, '@deepseek-ai', 'dsh', 'package.json')
    && frameworkInstallPackageJson(null) === null)
}

// ══ ② 命令生成纯函数 ═══════════════════════════════════════════════════════════════
{
  const pnpmCmd = frameworkInstallCommand({ layout: 'pnpm', fwRoot: PNPM_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npmCli: NPM_CLI })
  check('② pnpm 命令与改动前**逐字相同**（一个字符都不许变）', pnpmCmd === OLD_PNPM_CMD_LINE,
    pnpmCmd === OLD_PNPM_CMD_LINE ? undefined : `\n  实际：${pnpmCmd}\n  期望：${OLD_PNPM_CMD_LINE}`)

  const npmCmd = frameworkInstallCommand({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npmCli: NPM_CLI })
  check('② hoisted ⇒ 走 npm（bin/npm-cli.js，不是 pnpm/corepack）',
    npmCmd.includes(`${NODE_PATH} ${NPM_CLI} install @deepseek-ai/dsh@${TARGET}`) && !npmCmd.includes('pnpm') && !npmCmd.includes('corepack'),
    npmCmd.slice(0, 150))
  check('② hoisted ⇒ --prefix 指向**含 package.json 的那一层**（不是那层 node_modules）',
    npmCmd.includes(`--prefix "${dirname(FLAT_ROOT)}"`) && !npmCmd.includes(`--prefix "${FLAT_ROOT}"`), `prefix=${dirname(FLAT_ROOT)}`)
  check('② hoisted ⇒ 带目标版本号（显式精确版本，不是范围）', npmCmd.includes(`@deepseek-ai/dsh@${TARGET}`))
  check('② hoisted ⇒ 无审计/无募捐（计划任务里少两段可能卡住的网络请求）+ 精确版本写回',
    npmCmd.includes('--no-audit') && npmCmd.includes('--no-fund') && npmCmd.includes('--save-exact'))
  check('② 两条通道都以 cmd 退出码写 marker 结尾（脚本轮询判完成，不能被改掉）',
    [pnpmCmd, npmCmd].every((c) => c.endsWith(`' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"'`)))
  check('② 命令行仍然是「独立窗口 + 标题 DSH-Upgrade」的 start 形态（黑框进度观感不变）',
    [pnpmCmd, npmCmd].every((c) => c.includes('start "DSH-Upgrade" cmd /c "title DSH-Upgrade && ')))
}

// ══ ②b npm 从哪来：node 自带 → PATH → corepack → none（2026-11-09 真机实测补的硬伤）══════════
// 上一单（164aba5）把扁平布局的 CLI 写死成 `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js`，
// 而 **DSH 桌面端运行时那套 node 里根本没有 npm**（node_modules 里只有 README.txt）⇒
// 扁平用户会「过了门闸、到安装那一步才因为找不到 npm 失败」= 最差的失败位置。
// 本机实测可用来源：PATH 上的 npm.cmd（D:\nvm4w\nodejs\npm.cmd）、corepack.cmd（`corepack npm` 能跑）。
// 期望：本机命中 ② 或 ③，**不是** ④。
{
  const WIN = process.platform === 'win32'
  const NPM_ON_PATH = WIN ? 'npm.cmd' : 'npm'
  const COREPACK_ON_PATH = WIN ? 'corepack.cmd' : 'corepack'
  const existsIn = (list) => (p) => list.includes(p)
  const whichFrom = (map) => (name) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null)

  // ① node 自带（与改动前同一个入口 bin/npm-cli.js）
  let whichCalled = 0
  const bundled = resolveNpmCli({ nodePath: NODE_PATH, exists: existsIn([NPM_CLI]), which: (n) => { whichCalled += 1; return null } })
  check('②b ① 命中 node 自带：kind=node-bundled，命令 = `<node> <npm-cli.js>`（与改动前逐字相同，且不查 PATH）',
    bundled.kind === 'node-bundled' && bundled.command === `${NODE_PATH} ${NPM_CLI}` && whichCalled === 0,
    `kind=${bundled.kind} cmd=${bundled.command} whichCalls=${whichCalled}`)

  // ① 的第二候选：execPath 位于 <root>/bin/ 下 ⇒ 再试其父目录（运行时 node 就长这样）
  const rtNode = join('D:', 'rt', 'node', 'bin', 'node.exe')
  const rtCli = join('D:', 'rt', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const bundledBin = resolveNpmCli({ nodePath: rtNode, exists: existsIn([rtCli]), which: () => null })
  check('②b ① execPath 在 <root>/bin/ 下 ⇒ 退到父目录去找 node 自带 npm（<root>/node_modules/npm/…）',
    bundledBin.kind === 'node-bundled' && bundledBin.command === `${rtNode} ${rtCli}` && !bundledBin.command.includes(join('bin', 'node_modules')),
    `cmd=${bundledBin.command}`)

  // ② PATH 上的 npm（真机就命中这一条）
  const pathNpm = join('D:', 'nvm4w', 'nodejs', NPM_ON_PATH)
  const fromPath = resolveNpmCli({ nodePath: NODE_PATH, exists: () => false, which: whichFrom({ [NPM_ON_PATH]: pathNpm }) })
  check('②b ② 命中 PATH npm：kind=path，命令就是 npm 自己的入口（**不含 nodePath**）',
    fromPath.kind === 'path' && fromPath.command === pathNpm && !fromPath.command.includes(NODE_PATH),
    `kind=${fromPath.kind} cmd=${fromPath.command}`)

  // ③ corepack npm
  const corepackOnPath = join('D:', 'nvm4w', 'nodejs', COREPACK_ON_PATH)
  const fromCorepack = resolveNpmCli({ nodePath: NODE_PATH, exists: () => false, which: whichFrom({ [COREPACK_ON_PATH]: corepackOnPath }) })
  check('②b ③ 命中 corepack：kind=corepack，命令 = `<corepack> npm`（同样不含 nodePath）',
    fromCorepack.kind === 'corepack' && fromCorepack.command === `${corepackOnPath} npm` && !fromCorepack.command.includes(NODE_PATH),
    `kind=${fromCorepack.kind} cmd=${fromCorepack.command}`)

  // ④ 一个都没有
  const noNpm = resolveNpmCli({ nodePath: NODE_PATH, exists: () => false, which: () => null })
  check('②b ④ 全都没有 ⇒ kind=none、command=null，note 如实列出三类来源（不许瞎指一个）',
    noNpm.kind === 'none' && noNpm.command === null
    && noNpm.note.includes('node 自带') && noNpm.note.includes('PATH') && noNpm.note.includes('corepack'),
    `kind=${noNpm.kind} note=${noNpm.note}`)

  // ── 命令模板：②③ 命中时**不再拼 nodePath**；① 命中时保持现状 ──
  const cmdWith = (npm) => frameworkInstallCommand({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npm })
  const legacyCmd = frameworkInstallCommand({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npmCli: NPM_CLI })
  check('②b ① 命中时生成物与改动前**逐字相同**（CLI 串就是 `<node> <npm-cli.js>`）', cmdWith(bundled) === legacyCmd,
    cmdWith(bundled) === legacyCmd ? undefined : `\n  实际：${cmdWith(bundled)}\n  期望：${legacyCmd}`)

  const cmdPath = cmdWith(fromPath)
  check('②b ② 命中时命令走 PATH 的 npm.cmd 且**不再拼 nodePath**（拼了就是那个不存在的路径）',
    cmdPath.includes(`${pathNpm} install @deepseek-ai/dsh@${TARGET}`) && !cmdPath.includes(NODE_PATH) && !cmdPath.includes('npm-cli.js'),
    cmdPath.slice(0, 170))
  const cmdCorepack = cmdWith(fromCorepack)
  check('②b ③ 命中时命令走 `corepack npm install`（同样不拼 nodePath、不含 corepack 的 js 实体）',
    cmdCorepack.includes(`${corepackOnPath} npm install @deepseek-ai/dsh@${TARGET}`) && !cmdCorepack.includes(NODE_PATH),
    cmdCorepack.slice(0, 170))
  check('②b 换 npm 来源只换 CLI 串：前缀 / 精确版本 / 无审计无募捐 / marker 收尾全都不变',
    [cmdPath, cmdCorepack].every((c) => c.includes(`--prefix "${dirname(FLAT_ROOT)}"`) && c.includes('--no-audit') && c.includes('--no-fund')
      && c.includes('--save-exact') && markerTailOf(c) === MARKER_TAIL), MARKER_TAIL)

  // ── pnpm 通道：传进来的 npm 解析结果必须被彻底忽略（一个字符都不许变）──
  check('②b pnpm 命令：即使传了 npm 解析结果，仍与改动前**逐字相同**（npm 不许漏进 pnpm）',
    frameworkInstallCommand({ layout: 'pnpm', fwRoot: PNPM_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npm: fromPath }) === OLD_PNPM_CMD_LINE)
  check('②b pnpm 整块：即使传了 npm 解析结果，仍与不传时逐字相同（Set-Location + 旧命令）',
    frameworkInstallSetupBlock({ layout: 'pnpm', fwRoot: PNPM_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npm: fromPath, ps })
    === frameworkInstallSetupBlock({ layout: 'pnpm', fwRoot: PNPM_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npmCli: NPM_CLI, ps }))

  // ── 步骤/日志必须写明**实际使用的 npm 来源**（node-bundled / path / corepack）──
  const blockPath = frameworkInstallSetupBlock({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npm: fromPath, ps })
  check('②b 安装日志写明 npm 来源（path）+ 具体路径（换 npm 不许静默）',
    blockPath.includes('npm 来源：') && blockPath.includes('path（') && blockPath.includes(pathNpm), blockPath.split(/\r?\n/u)[1]?.slice(0, 190))
  const blockCorepack = frameworkInstallSetupBlock({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npm: fromCorepack, ps })
  check('②b 安装日志写明 npm 来源（corepack）+ corepack 路径',
    blockCorepack.includes('npm 来源：') && blockCorepack.includes('corepack（') && blockCorepack.includes(corepackOnPath))
  check('②b 安装日志里的 CLI 串同样不拼 nodePath', !blockPath.includes(`${NODE_PATH} ${pathNpm}`))
  const stepPath = frameworkInstallStepText({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, npm: fromPath, deps: { readVersion: () => CURRENT } })
  check('②b 升级步骤里也写明 npm 来源（与安装日志同一个解析结果，不是两套说法）',
    stepPath.includes('npm 来源：path（') && stepPath.includes(pathNpm) && stepPath.includes('框架安装通道：npm'), stepPath.slice(0, 200))

  // ── ②d 真机取数：本机真实 nodePath + 真实 PATH 解析一次 ──
  // 独立实现一遍 PATH 扫描（不用被测模块的 which）：这样「SKIP 的理由」也是独立证据。
  const scanPath = (name) => {
    const exts = WIN ? ['', '.cmd', '.exe', '.bat', '.com'] : ['']
    for (const dir of String(process.env.PATH ?? '').split(delimiter).filter((d) => d !== '')) {
      for (const ext of exts) {
        if (ext !== '' && name.toLowerCase().endsWith(ext)) continue
        const p = join(dir, name + ext)
        if (existsSync(p)) return p
      }
    }
    return null
  }
  const realNodeDir = dirname(process.execPath)
  const bundledProbe = [join(realNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  if (basename(realNodeDir).toLowerCase() === 'bin') bundledProbe.push(join(dirname(realNodeDir), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  const realExpected = bundledProbe.find((p) => existsSync(p)) !== undefined ? 'node-bundled'
    : (scanPath(NPM_ON_PATH) !== null ? 'path' : (scanPath(COREPACK_ON_PATH) !== null ? 'corepack' : null))
  const real = resolveNpmCli({ nodePath: process.execPath })
  if (realExpected === null) {
    // 显式 SKIP（并给出理由与证据），绝不假装 PASS：本机确实一个 npm 来源都没有
    console.log(`SKIP ②d 真机取数：本机探测不到任何 npm 来源（node 自带 ${bundledProbe.join(' / ')}、PATH 上的 ${NPM_ON_PATH}、${COREPACK_ON_PATH} 都不存在）`
      + ' ⇒ 解析结果如实为 none，无从断言「非 none」；这一条在装了 npm/corepack 的机器上才会真跑')
    check('②d SKIP 的前提成立：本机确实解析成 none（不是代码偷偷报了个错）', real.kind === 'none', `kind=${real.kind} note=${real.note}`)
  } else {
    check(`②d 真机取数：真实 nodePath + 真实 PATH ⇒ kind=${realExpected}（**不是** none）`,
      real.kind === realExpected && real.kind !== 'none', `kind=${real.kind} note=${real.note}`)
    // 「解析到的实体真实存在」比「字符串长得对」更强：不许凭空拼一个不存在的路径（上一单的病根）
    const resolvedEntity = real.kind === 'node-bundled'
      ? real.command.slice(process.execPath.length + 1)
      : (real.kind === 'corepack' ? real.command.slice(0, real.command.length - ' npm'.length) : real.command)
    check('②d 真机取数：解析到的 npm / corepack 可执行文件**真实存在于磁盘**', existsSync(resolvedEntity), resolvedEntity)
    check('②d 真机取数：只有 ① 才该带 nodePath；②③ 命中时命令里不出现 nodePath',
      real.kind === 'node-bundled' ? real.command.startsWith(process.execPath) : !real.command.includes(process.execPath),
      `kind=${real.kind} cmd=${real.command}`)
    check('②d 真机取数：拿去生成命令时不会拼出那个不存在的 npm-cli.js',
      !cmdWith(real).includes(join('bin', 'node_modules', 'npm', 'bin', 'npm-cli.js')), cmdWith(real).slice(0, 170))
  }

  // ── ②e 病根现场：**DSH 桌面端运行时那套 node**（正是「node_modules 里只有 README.txt」的那一套）──
  // 用它当 execPath 解析，必须落到 ② 或 ③；落到 none（没修）或 node-bundled（还在拼死路径）都算没修好。
  const DSH_RUNTIME_NODE = process.env.DSH_RUNTIME_NODE ?? join('D:', 'dsh-desktop', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
  if (!existsSync(DSH_RUNTIME_NODE)) {
    console.log(`SKIP ②e 病根现场取数：本机没有 DSH 桌面端运行时 node（${DSH_RUNTIME_NODE} 不存在；可用 DSH_RUNTIME_NODE 指向它）`
      + ' —— 没有那个现场就复现不了病根，这一条不假装通过')
  } else {
    const rtDir = dirname(DSH_RUNTIME_NODE)
    const rtNpmCandidates = [join(rtDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(rtDir), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    const rtResolved = resolveNpmCli({ nodePath: DSH_RUNTIME_NODE })
    check('②e 病根现场：运行时那套 node 里确实没有 npm-cli.js（上一单写死的正是这个不存在的路径）',
      rtNpmCandidates.every((p) => !existsSync(p)), rtNpmCandidates.join(' / '))
    check('②e 病根现场取数：用运行时 nodePath 解析 ⇒ 找到可用 npm（kind ≠ none；若只有 node 自带，那必须是**真存在**的那个）',
      rtResolved.kind !== 'none' && (rtResolved.kind !== 'node-bundled' || rtNpmCandidates.some((p) => existsSync(p))),
      `kind=${rtResolved.kind} note=${rtResolved.note}`)
    check('②e 病根现场：生成的命令不再是「运行时 node + 不存在的 npm-cli.js」',
      !cmdWith(rtResolved).includes(`${DSH_RUNTIME_NODE} ${rtNpmCandidates[0]}`) && !cmdWith(rtResolved).includes(join('bin', 'node_modules', 'npm', 'bin', 'npm-cli.js')),
      cmdWith(rtResolved).slice(0, 170))
  }
}

// ══ ②c preflight 门：找不到 npm ⇒ **在 preflight 就失败**（不许留到安装步骤才炸）══════════════
{
  const binOk = join('C:', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const nothing = () => false
  const everything = () => true
  const npmNone = { kind: 'none', command: null, note: 'none（已尝试 node 自带 / PATH / corepack）' }
  const OLD_REFUSAL = (what) => `升级已取消：无法定位 ${what}（框架安装可能不完整），服务保持运行；请先修复框架再升级`

  const refuse = frameworkUpgradeCliBlocker({ layout: 'hoisted', binPath: binOk, corepackJs: COREPACK_JS, npm: npmNone, exists: everything })
  check('②c 扁平布局 + npm 解析为 none ⇒ preflight 拒绝，且文案如实写出三类来源 + 为什么需要 npm',
    typeof refuse === 'string' && refuse.includes('本机找不到 npm（已尝试：node 自带 / PATH / corepack）')
    && refuse.includes('扁平（hoisted）布局升级需要 npm') && refuse.startsWith('升级已取消'), refuse ?? '(null)')
  check('②c 扁平布局：npm 命中就放行', frameworkUpgradeCliBlocker({ layout: 'hoisted', binPath: binOk, corepackJs: COREPACK_JS, npm: { kind: 'path', command: 'npm.cmd' }, exists: everything }) === null)
  check('②c 扁平布局：corepack 缺失**不再是**扁平布局的拒绝理由（那不是它需要的东西）',
    frameworkUpgradeCliBlocker({ layout: 'hoisted', binPath: binOk, corepackJs: join('C:', 'nope', 'corepack.js'), npm: { kind: 'path', command: 'npm.cmd' }, exists: (p) => p === binOk }) === null)
  check('②c 扁平布局：dsh bin.js 缺失优先拒绝（框架没装全先修），文案沿用旧口径',
    frameworkUpgradeCliBlocker({ layout: 'hoisted', binPath: join('C:', 'nope', 'bin.js'), corepackJs: COREPACK_JS, npm: npmNone, exists: nothing }) === OLD_REFUSAL('dsh bin.js'))

  // pnpm 通道：判据与文案**逐字不变**（这是本单硬要求）
  check('②c pnpm 布局：corepack 缺失的文案与改动前**逐字相同**（pnpm 通道零变化）',
    frameworkUpgradeCliBlocker({ layout: 'pnpm', binPath: binOk, corepackJs: join('C:', 'nope', 'corepack.js'), npm: npmNone, exists: (p) => p === binOk }) === OLD_REFUSAL('corepack（pnpm 通道）'))
  check('②c pnpm 布局：corepack 在、dsh bin.js 缺 ⇒ 旧文案 dsh bin.js（顺序也没变）',
    frameworkUpgradeCliBlocker({ layout: 'pnpm', binPath: join('C:', 'nope', 'bin.js'), corepackJs: COREPACK_JS, npm: npmNone, exists: (p) => p === COREPACK_JS }) === OLD_REFUSAL('dsh bin.js'))
  check('②c pnpm 布局：npm 解析为 none **不影响** pnpm（它压根不用 npm）',
    frameworkUpgradeCliBlocker({ layout: 'pnpm', binPath: binOk, corepackJs: COREPACK_JS, npm: npmNone, exists: everything }) === null)
  check('②c 布局未判定（null：框架根门在下面拦）⇒ 沿用旧判据，不误报 npm',
    frameworkUpgradeCliBlocker({ layout: null, binPath: binOk, corepackJs: COREPACK_JS, npm: npmNone, exists: everything }) === null
    && frameworkUpgradeCliBlocker({ layout: null, binPath: binOk, corepackJs: join('C:', 'nope', 'corepack.js'), npm: npmNone, exists: (p) => p === binOk }) === OLD_REFUSAL('corepack（pnpm 通道）'))

  // 静态接线：门必须在**生成升级脚本之前**，且直接 return（否则又滑回「到安装步骤才炸」）
  const upSrc = readFileSync(join(REPO, 'lib', 'server', 'routes', 'framework-upgrade.js'), 'utf8')
  check('②c 路由在生成升级脚本之前调用 preflight 门，并立即 return（不许滑到安装步骤）',
    /const cliBlocker = frameworkUpgradeCliBlocker\(\{/u.test(upSrc) && /if \(cliBlocker !== null\) \{/u.test(upSrc)
    && upSrc.indexOf('frameworkUpgradeCliBlocker(') !== -1
    && upSrc.indexOf('frameworkUpgradeCliBlocker(') < upSrc.indexOf('frameworkInstallSetupBlock('),
    `blocker@${upSrc.indexOf('frameworkUpgradeCliBlocker(')} setup@${upSrc.indexOf('frameworkInstallSetupBlock(')}`)
  check('②c 路由只在**扁平布局**时才解析 npm（pnpm 用户不被塞一份用不上的解析结果）',
    /const npm = fwLayout === 'hoisted' \? \(rc\.deps\.resolveNpmCli \?\? resolveNpmCli\)\(\{ nodePath \}\) : null/u.test(upSrc))
}

// ══ ③ cwd/命令行整块 + 装后核对 ═════════════════════════════════════════════════════
{
  const pnpmBlock = frameworkInstallSetupBlock({ layout: 'pnpm', fwRoot: PNPM_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npmCli: NPM_CLI, ps })
  check('③ pnpm 整块 = 旧的「Set-Location <fwRoot>」+ 旧命令，逐字不变',
    pnpmBlock === `Set-Location -Path ${ps(PNPM_ROOT)}\r\n${OLD_PNPM_CMD_LINE}`,
    JSON.stringify(pnpmBlock.split('\r\n')[0]))

  const npmBlock = frameworkInstallSetupBlock({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npmCli: NPM_CLI, ps })
  const npmLines = npmBlock.split('\r\n')
  check('③ hoisted 整块：第一行先把 cwd 挪到含 package.json 的那一层',
    npmLines[0] === `Set-Location -Path ${ps(dirname(FLAT_ROOT))}`, npmLines[0])
  check('③ hoisted 整块：日志行如实写出通道 / 安装前缀 / 目标版本（换通道不许静默）',
    npmLines.some((l) => l.includes('安装通道：npm') && l.includes('hoisted') && l.includes(dirname(FLAT_ROOT)) && l.includes(TARGET)),
    npmLines[1]?.slice(0, 160))
  check('③ hoisted 整块：第三行就是 npm 命令（顺序 = 先 cd、再 log、再跑）',
    npmLines[2] === frameworkInstallCommand({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, nodePath: NODE_PATH, corepackJs: COREPACK_JS, npmCli: NPM_CLI }))

  // ── 版本核对（唯一判据）──
  const ok = frameworkInstallVerdict({ layout: 'hoisted', target: TARGET, version: TARGET })
  const bad = frameworkInstallVerdict({ layout: 'hoisted', target: TARGET, version: CURRENT })
  const missing = frameworkInstallVerdict({ layout: 'hoisted', target: TARGET, version: null })
  check('③ 装后读回 === target ⇒ 通过', ok.ok === true && ok.channel === 'npm' && ok.version === TARGET, ok.message)
  check('③ 装后读回 ≠ target ⇒ **判失败**，文案点名通道/读回值/目标（不许报成功）',
    bad.ok === false && bad.message.includes('npm') && bad.message.includes(CURRENT) && bad.message.includes(TARGET) && bad.message.includes('绝不报成功'),
    bad.message)
  check('③ 装后读不到版本 ⇒ 同样判失败（缺证据不算成功）',
    missing.ok === false && missing.version === null, missing.message)
  check('③ pnpm 布局下判据同样生效（对照：换成 pnpm 通道名）',
    frameworkInstallVerdict({ layout: 'pnpm', target: TARGET, version: CURRENT }).ok === false
    && frameworkInstallVerdict({ layout: 'pnpm', target: TARGET, version: TARGET }).message.includes('pnpm'))

  // ── 读回（可注入 readVersion；桩出「装后版本不符」）──
  const stubBad = frameworkInstallReadback({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, deps: { readVersion: () => CURRENT } })
  const stubOk = frameworkInstallReadback({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, deps: { readVersion: () => TARGET } })
  check('③ readback（桩：装后版本不符）⇒ ok:false，且前缀/路径可读',
    stubBad.ok === false && stubBad.version === CURRENT && stubBad.prefix === dirname(FLAT_ROOT)
    && stubBad.packageJson === join(FLAT_ROOT, '@deepseek-ai', 'dsh', 'package.json'), stubBad.message)
  check('③ readback（桩：版本相符）⇒ ok:true', stubOk.ok === true && stubOk.version === TARGET)
  check('③ readback：读盘抛错不许把整次升级搞崩（投成「读不到」并判失败）',
    (() => {
      try { return frameworkInstallReadback({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, deps: { readVersion: () => { throw new Error('EACCES') } } }).ok === false } catch { return false }
    })())

  // 真磁盘夹具（绝对路径写入）：装前读回的是当前版本
  const diskHome = join(SANDBOX, 'disk-tree')
  const diskNm = join(diskHome, 'node_modules')
  mkdirSync(join(diskNm, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(diskNm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// fw\n', 'utf8')
  const writeVersion = (v) => writeFileSync(join(diskNm, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: v }), 'utf8')
  writeVersion(CURRENT)
  const diskBefore = frameworkInstallReadback({ layout: 'hoisted', fwRoot: diskNm, target: TARGET })
  check('③ 真磁盘：装前读回当前版本（步骤里的「装前读回版本」不是编的）',
    diskBefore.ok === false && diskBefore.version === CURRENT && diskBefore.prefix === diskHome, JSON.stringify({ v: diskBefore.version, p: diskBefore.prefix }))
  writeVersion(TARGET) // 模拟「装成功」
  const diskAfter = frameworkInstallReadback({ layout: 'hoisted', fwRoot: diskNm, target: TARGET })
  check('③ 真磁盘：装后读到 target ⇒ 通过（同一判据，不是两套代码）', diskAfter.ok === true && diskAfter.version === TARGET)

  // ── PowerShell 核对块 ──
  const pnpmVerify = frameworkVersionVerifyBlock({ layout: 'pnpm', fwRoot: PNPM_ROOT, target: TARGET, ps })
  const oldPnpmVerify = [
    `      $v = (Get-Content ${ps(join(PNPM_ROOT, '@deepseek-ai', 'dsh', 'package.json'))} -Raw | ConvertFrom-Json).version`,
    `      if ($v -ne '${TARGET}') { Log ('pnpm 退出码 0 但顶层可见版本未更新（顶层 ' + $v + '，目标 ${TARGET}），按失败处理'); $code = 1 }`,
    `    } catch { Log 'pnpm 退出码 0 但无法读取顶层版本，按失败处理'; $code = 1 }`,
  ].join('\r\n')
  check('③ 核对块（pnpm）与改动前逐字相同（含收尾的 }）', pnpmVerify === oldPnpmVerify,
    pnpmVerify === oldPnpmVerify ? undefined : `\n  实际：${pnpmVerify}\n  期望：${oldPnpmVerify}`)

  const npmVerify = frameworkVersionVerifyBlock({ layout: 'hoisted', fwRoot: FLAT_ROOT, target: TARGET, ps })
  check('③ 核对块（hoisted）：查的是那一层的 package.json，消息里点明 npm 通道',
    npmVerify.includes(`Get-Content ${ps(join(FLAT_ROOT, '@deepseek-ai', 'dsh', 'package.json'))}`)
    && npmVerify.includes("Log ('npm 退出码 0 但顶层可见版本未更新")
    && npmVerify.includes(`$v -ne '${TARGET}'`) && npmVerify.includes('$code = 1')
    && npmVerify.trimEnd().endsWith('$code = 1 }'),
    npmVerify.split('\r\n')[1]?.slice(0, 140))
  check('③ 核对块：不符就 $code = 1 ⇒ 调用方走既有回滚（绝不报成功）',
    (npmVerify.match(/\$code = 1/gu) ?? []).length === 2 && !npmVerify.includes('$code = 0'))
}

// ══ ④ 路由层（子进程探针；脚本落盘被挡 ⇒ 绝不真升级）══════════════════════════════════
const PROBE_DIR = join(SANDBOX, 'probe')
const PROBE_BIN = join(PROBE_DIR, 'bin.js')
mkdirSync(PROBE_DIR, { recursive: true })
writeFileSync(PROBE_BIN, `import { mkdirSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = { started: false }
try {
  if (process.platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, writable: true })
  const profile = process.env.PROBE_PROFILE
  // 第二道保险：同名目录 ⇒ 路由里的 writeFile(ps1) 必然 EISDIR ⇒ 永不走到 execFile(schtasks)。
  // 先清掉同 PID 的旧残留（上一次崩溃遗留的同名目录会让 mkdir 失败、整段探针退化成 SKIP）。
  const ps1 = join(tmpdir(), 'fw-upgrade-' + process.pid + '.ps1')
  try { rmSync(ps1, { recursive: true, force: true }) } catch {}
  try { rmdirSync(ps1) } catch {} // 空目录在 Windows 上 rmSync 会留着（实测）⇒ 补一刀，否则 PID 复用又假红
  let blocked = false
  try { mkdirSync(ps1); blocked = true } catch {}
  if (!blocked) { process.stdout.write(JSON.stringify({ skipped: 'ps1-blocker-unavailable', ps1 })); process.exit(0) }
  const { routeFrameworkUpgrade } = await import(pathToFileURL(process.env.PROBE_ROUTE).href)
  const cordisUrl = pathToFileURL(join(profile, 'cordis.yml')).href
  const ctx = {
    baseUrl: cordisUrl,
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } }] },
    webServer: { register: () => () => {} },
    effect: (fn) => { try { fn() } catch {}; return () => {} },
  }
  const res = { status: 0, body: null }
  res.writeHead = (s) => { res.status = s }
  res.end = (p) => { res.body = p }
  const req = {
    method: 'POST', url: '/plugin-console/framework-upgrade',
    socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
    signal: { aborted: false, addEventListener: () => {} },
    [Symbol.asyncIterator]() { let done = false; return { next: async () => (done ? { value: undefined, done: true } : ((done = true), { value: Buffer.from('{}'), done: false })) } },
  }
  const META = { 'dist-tags': { latest: '0.2.2-rc.1' }, versions: { '0.2.1-rc.5': {}, '0.2.2-rc.1': {} } }
  await routeFrameworkUpgrade(req, res, {
    ctx, url: new URL('/plugin-console/framework-upgrade', 'http://127.0.0.1:3080'), pathname: '/plugin-console/framework-upgrade', method: 'POST', body: {},
    deps: {
      fetchJson: async () => META,
      backupProfileSnapshot: () => join(process.env.PROBE_HOME, 'plugin-console', 'framework-backups', 'probe'),
      preflightDisableIncompatible: async () => ({ disabled: [], skipped: [] }),
      webPort: () => 3080,
      listEntries: () => [],
      // 2026-11-09：只在本套探针里桩「本机找不到 npm」——用来看 preflight 门是不是真的在**安装之前**把升级拦掉
      resolveNpmCli: process.env.PROBE_NPM_NONE === '1'
        ? () => ({ kind: 'none', command: null, note: 'none（已尝试 node 自带 / PATH / corepack）' })
        : undefined,
    },
  })
  out.started = true
  out.status = res.status
  try { out.json = res.body === null ? null : JSON.parse(res.body) } catch {}
  out.ps1 = ps1
  try { out.ps1StillDir = statSync(ps1).isDirectory() } catch { out.ps1StillDir = false }
  try { rmSync(ps1, { recursive: true, force: true }) } catch {}
  try { rmdirSync(ps1) } catch {} // 同上：空目录要靠 rmdirSync（否则每跑一次留一个 %TEMP% 空壳）
} catch (error) {
  out.error = String(error && error.stack ? error.stack : error)
}
process.stdout.write(JSON.stringify(out))
`, 'utf8')

const runProbe = (profile, extraEnv = {}) => {
  const env = { ...process.env, DSH_HOME: HOME, PROBE_HOME: HOME, PROBE_PROFILE: profile, PROBE_ROUTE: join(REPO, 'lib', 'server', 'routes', 'framework-upgrade.js'), ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const stdout = execFileSync(process.execPath, [PROBE_BIN], { env, cwd: REPO, encoding: 'utf8' })
  try { return JSON.parse(stdout) } catch { return { parseError: String(stdout).slice(0, 400) } }
}

const makeProfile = (name, { store }) => {
  const profile = join(HOME, 'profiles', name)
  const nm = join(profile, 'node_modules')
  mkdirSync(join(nm, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(nm, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: CURRENT, main: 'index.js' }), 'utf8')
  writeFileSync(join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// framework entry\n', 'utf8')
  if (store) mkdirSync(join(nm, '.pnpm'), { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '# stub\n', 'utf8')
  writeFileSync(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: probe\n      name: \'probe\'\n', 'utf8')
  return nm
}
const BACKUP = join(HOME, 'plugin-console', 'framework-backups', 'probe')
/** checkpoint 目录里的时间戳在快照里归一化成这个占位（保留 / 分隔形式，与 normalizeSteps 的输出一致）。 */
const TS_SLOT = `${join(BACKUP, 'fw-tree')}/<ts>`
/** 归一化：只去掉两条与布局无关、且随环境/跑次变化的部分（时间戳 / 运行模式自动切托管）。 */
const normalizeSteps = (steps) => (Array.isArray(steps) ? steps : [])
  .filter((s) => !String(s).startsWith('检测到使用本控制台的框架升级'))
  .map((s) => String(s).replace(/fw-tree[\\/]\d+/gu, 'fw-tree/<ts>'))
/** 改动前（673f67d）pnpm 夹具的 steps —— golden 快照，用于「pnpm 用户行为零变化」的回归。 */
const HEAD_PNPM_STEPS = (nm) => [
  `框架安装根：${nm}；布局：pnpm（含 .pnpm store）`,
  `框架全树 checkpoint 完成：${TS_SLOT}（镜像 0 个 @deepseek-ai 版本包；升级失败/拉起失败会自动全树回滚，也可用框架卡片的「回滚到上一版」一键回滚）`,
  `框架升级脚本已启动：${CURRENT} → ${TARGET}（在线下载安装，服务保持运行，成功后自动重启生效，约 1-3 分钟）`,
  `升级前配置已打包：${BACKUP}；框架本体回滚点：${join(BACKUP, 'dsh-package-backup')}`,
]
const HEAD_HOISTED_STEPS = (nm) => [
  `框架安装根：${nm}；布局：hoisted（扁平安装，无 .pnpm store —— 有 lib/bin.js 即视为装好）`,
  `框架全树 checkpoint 完成：${TS_SLOT}（镜像 0 个 @deepseek-ai 版本包；树里没有 .pnpm store（扁平安装），store 实体镜像已跳过、顶层 scope 与 lock 照常镜像；升级失败/拉起失败会自动全树回滚，也可用框架卡片的「回滚到上一版」一键回滚）`,
  `框架升级脚本已启动：${CURRENT} → ${TARGET}（在线下载安装，服务保持运行，成功后自动重启生效，约 1-3 分钟）`,
  `升级前配置已打包：${BACKUP}；框架本体回滚点：${join(BACKUP, 'dsh-package-backup')}`,
]
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const diffText = (got, want) => {
  const at = got.findIndex((x, i) => x !== want[i])
  return at === -1 ? `长度 ${got.length} vs ${want.length}` : `第 ${at + 1} 条不同：\n  实际：${got[at]}\n  期望：${want[at]}`
}
{
  const flatNm = makeProfile('flat', { store: false })
  const flatRun = runProbe(join(HOME, 'profiles', 'flat'))
  if (flatRun.skipped !== undefined) {
    check('④ 探针能跑（ps1 保险可建立）', false, `探针保险挡不住写盘（${flatRun.skipped}）——未跑路由，绝不冒险真升级`)
  } else {
    check('④ 探针跑起来了（不是桩把整段吞了）', flatRun.started === true && flatRun.error === undefined, String(flatRun.error ?? '').slice(0, 200))
    check('④ hoisted 夹具 ⇒ 200（过了门闸，走到安装步骤）', flatRun.status === 200 && flatRun.json?.ok === true,
      `status=${flatRun.status} err=${String(flatRun.json?.error ?? '').slice(0, 120)}`)
    const steps = normalizeSteps(flatRun.json?.steps)
    const channelStep = steps.find((s) => s.startsWith('框架安装通道：')) ?? ''
    check('④ hoisted ⇒ steps 里出现「框架安装通道：npm」+ 布局字样 + 安装前缀（用户/排查者一眼看出换了通道）',
      channelStep.startsWith('框架安装通道：npm')
      && channelStep.includes('hoisted')
      && channelStep.includes(dirname(flatNm))
      && channelStep.includes(TARGET),
      channelStep.slice(0, 200) || '（无通道步骤）')
    check('④ hoisted ⇒ 通道步骤写明装后核对什么（版本 + 那个 package.json 路径）',
      channelStep.includes(join(flatNm, '@deepseek-ai', 'dsh', 'package.json')) && channelStep.includes('绝不报成功'))
    check('④ hoisted ⇒ steps 仍是「长度合理的一行行字符串」（不许出现 [object Object]）',
      steps.length >= 4 && steps.every((s) => typeof s === 'string' && s.length > 0 && !s.includes('[object Object]')),
      `${steps.length} 条`)
    // 与 HEAD 的 hoisted 快照相比：**只多一条通道步骤**，其余逐字相同
    const want = [...HEAD_HOISTED_STEPS(flatNm)]
    want.splice(1, 0, channelStep)
    check('④ hoisted ⇒ 除新增的通道步骤外，其余 steps 与改动前逐字相同', sameList(steps, want), sameList(steps, want) ? `${steps.length} 条` : diffText(steps, want))
    check('④ 没有启动升级脚本（ps1 始终是那个目录 ⇒ 没走到 execFile，本套绝不真升级）', flatRun.ps1StillDir === true)

    // ── 端到端：扁平布局 + 本机解析不到 npm ⇒ **preflight 就拒**（不许走到安装步骤）──
    // 桩只换 resolveNpmCli（真实 Path/PATH 探测在这个进程里一定命中，没法自然造出 none）。
    const noneRun = runProbe(join(HOME, 'profiles', 'flat'), { PROBE_NPM_NONE: '1' })
    if (noneRun.skipped !== undefined) {
      check('④ npm 为 none 的探针能跑', false, `探针保险挡不住写盘（${noneRun.skipped}）`)
    } else {
      const noneSteps = normalizeSteps(noneRun.json?.steps)
      check('④ 扁平布局 + 找不到 npm ⇒ 200 但 upgraded:false（拒绝，不是假装成功）',
        noneRun.status === 200 && noneRun.json?.ok === true && noneRun.json?.upgraded === false,
        `status=${noneRun.status} upgraded=${String(noneRun.json?.upgraded)}`)
      check('④ 拒绝文案如实点名三类来源 + 为什么扁平布局需要 npm',
        noneSteps.some((s) => s.includes('本机找不到 npm（已尝试：node 自带 / PATH / corepack）') && s.includes('扁平（hoisted）布局升级需要 npm')),
        noneSteps.find((s) => s.includes('npm')) ?? `（无明显 npm 文案，共 ${noneSteps.length} 条）`)
      check('④ 拒绝发生在**安装之前**：steps 里没有「框架安装通道」/「升级脚本已启动」，也没落升级脚本',
        !noneSteps.some((s) => s.startsWith('框架安装通道：') || s.startsWith('框架升级脚本已启动')) && noneRun.ps1StillDir === true,
        noneSteps.map((s) => s.slice(0, 40)).join(' | '))
    }
  }

  const pnpmNm = makeProfile('pnpm', { store: true })
  const pnpmRun = runProbe(join(HOME, 'profiles', 'pnpm'))
  check('④ pnpm 夹具 ⇒ 200 + 布局 pnpm（既有路径没被碰坏）', pnpmRun.status === 200 && pnpmRun.json?.ok === true,
    `status=${pnpmRun.status} err=${String(pnpmRun.json?.error ?? pnpmRun.error ?? '').slice(0, 140)}`)
  const pnpmSteps = normalizeSteps(pnpmRun.json?.steps)
  check('④ pnpm 夹具 ⇒ steps **与改动前逐字相同**（golden：pnpm 用户行为零变化）',
    sameList(pnpmSteps, HEAD_PNPM_STEPS(pnpmNm)), sameList(pnpmSteps, HEAD_PNPM_STEPS(pnpmNm)) ? `${pnpmSteps.length} 条` : diffText(pnpmSteps, HEAD_PNPM_STEPS(pnpmNm)))
  check('④ pnpm 夹具 ⇒ steps 里**没有**任何 npm 通道字样（换通道只发生在扁平布局）',
    !pnpmSteps.some((s) => s.includes('框架安装通道') || s.includes('npm 通道')), pnpmSteps.find((s) => s.includes('npm')) ?? '（无）')

  // 纯函数的 JS 侧步骤文案也得对得上（与路由用的是同一个函数，防止两边各写一份）
  const stepText = frameworkInstallStepText({ layout: 'hoisted', fwRoot: flatNm, target: TARGET, deps: { readVersion: () => CURRENT } })
  check('④ 纯函数步骤文案：npm + hoisted + 前缀 + 目标 + 装前读回 + 装后核对（不缺任何一项）',
    ['框架安装通道：npm', 'hoisted', dirname(flatNm), TARGET, CURRENT, '装后核对', '绝不报成功'].every((k) => stepText.includes(k)), stepText.slice(0, 220))
}

// ══ ⑤ 静态接线 + 行数棘轮 ═══════════════════════════════════════════════════════════
{
  const upSrc = readFileSync(join(REPO, 'lib', 'server', 'routes', 'framework-upgrade.js'), 'utf8')
  const modSrc = readFileSync(join(REPO, 'lib', 'server', 'domain', 'framework-install-command.js'), 'utf8')
  const upLines = upSrc.split('\n').length
  check('⑤ 路由确实调用新模块（setup 块 + 核对块 + 通道步骤三处都在）',
    upSrc.includes('frameworkInstallSetupBlock({') && upSrc.includes('frameworkVersionVerifyBlock({') && upSrc.includes('frameworkInstallStepText({'))
  check('⑤ 路由里不再内联旧的 pnpm 命令与旧的三行核对（已抽到 domain，唯一份）',
    !upSrc.includes('corepackJs} pnpm install') && !upSrc.includes('corepackJs} pnpm install @deepseek-ai/dsh@') && !upSrc.includes("'pnpm 退出码 0 但顶层可见版本未更新"))
  check('⑤ 通道步骤**只在非 pnpm 布局**时推（所以 pnpm 的 steps 逐字不变）',
    /if \(fwGate\.layout !== 'pnpm'\) steps\.push\(frameworkInstallStepText\(/u.test(upSrc))
  check('⑤ framework-upgrade.js 行数棘轮：≤696（本次 699 → 696，净减 3；只允许往下调）', upLines <= 696, `${upLines} 行`)
  check('⑤ 新模块 ≤600 行（lib/server/** 通用上限）', modSrc.split('\n').length <= 600, `${modSrc.split('\n').length} 行`)
  check('⑤ 新模块只 import node: 内置（domain 不许依赖宿主/路由）',
    (modSrc.match(/^import\s[^\n]*from\s+'([^']+)'/gmu) ?? []).every((l) => /from '(?:node:)/u.test(l)))
  check('⑤ 新模块不写盘、不 spawn（纯函数；读盘只发生在 readback 且全 try/catch）',
    !modSrc.includes('writeFile') && !modSrc.includes('spawn') && !modSrc.includes('execFile') && !modSrc.includes('mkdir'))
  check('⑤ 架构守卫的上限没有被抬高（SIZE_EXCEPTIONS 仍是 700，且没有新增例外）',
    (readFileSync(join(ROOT, 'test-architecture-guard.mjs'), 'utf8').match(/'\/lib\/server\/routes\/framework-upgrade\.js': 700/gu) ?? []).length === 1)
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
