// pnpm 执行方式定位（2026-09-27 改错 + 加法），进 CI Unit 硬门槛
//
// 背景（官方桌面端实例：**所有** pnpm 操作都跑不了）——两处根因，本套逐个钉死：
//   ① 形态缺陷：cmd-corepack 分支把带真引号的命令串作为 argv 元素交给 Node → Windows 上被转义成
//      `\"corepack\" \"pnpm\"` → cmd 解析不到（"不是内部或外部命令"）。修法：段内引号 + cmd 元字符
//      `^` 转义 + **整条外包裹一层引号** + `windowsVerbatimArguments`（见 infra/exec.js#cmdCommandLine）。
//      断言的核心：拼出来的命令字符串**永不含 `\"`**，且真 cmd.exe 上能把参数原样送到程序手里。
//   ② 认不出桌面端自带运行时：桌面端 host 用 `execPath（Electron 二进制）+ --expose-internals +
//      <resources>\runtime\pnpm\bin\pnpm.mjs` 跑 pnpm，而候选只有三种 corepack.js 布局 + cmd corepack
//      + PATH 上的 pnpm → 桌面端三条全落空（host 的 exe 旁边没有 corepack.js，PATH 里只有 runtime\bin）。
//      加法：把桌面端运行时（resourcesPath / PATH+env 线索）与 PATH 扫描插在既有候选**之后**、
//      cmd-corepack **之前**，既有候选与顺序一个不动、兜底语义不变（本套 ④ 是回归断言）。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildPnpmEnv, cmdCommandLine, cmdCorepackCommand, cmdShellArgv, resolvePnpmRunners, runPnpmWithFallback,
} from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
const kinds = (runners) => runners.map((r) => r.kind).join(',')

// ── ① 纯函数：命令字符串永不含 `\"`，argv 形如 ['/d','/s','/c', <命令串>] ──────────────
{
  const command = cmdCorepackCommand(['add', 'left-pad', '--registry', 'https://registry.npmmirror.com'])
  // 「不含 \"」就是本轮的判据：旧实现用 JSON.stringify 拼串 → Node 再转义 → cmd 收到 \"corepack\"
  check('① cmdCorepackCommand 不含 \\" 转义（也不含任何反斜杠）', !command.includes('\\"') && !command.includes('\\'), JSON.stringify(command))
  check('① 段内各段都正确加了引号（无空格裸串）', command === '"corepack" "pnpm" "add" "left-pad" "--registry" "https://registry.npmmirror.com"', command)
  const argv = cmdShellArgv(command)
  check('① argv 形如 [\'/d\',\'/s\',\'/c\', <命令串>]（4 段、前 3 段是 cmd 开关）',
    argv.length === 4 && argv[0] === '/d' && argv[1] === '/s' && argv[2] === '/c' && typeof argv[3] === 'string', JSON.stringify(argv))
  check('① argv[3] 不含 \\" 且是"整条再包一层引号"的形态（/s 会剥掉最外层）',
    !argv[3].includes('\\"') && argv[3] === `"${command}"` && argv[3].startsWith('""corepack"') && argv[3].endsWith('"'), JSON.stringify(argv[3]))
  // cmd 元字符：`& | < > ( )` 在引号内仍是 cmd 的操作符（实测 "a&b" 会在 & 处断开），必须 ^ 转义；
  // `^` 自身在引号内也生效（实测 "a^b" → 到程序手里变 "ab"）→ 写成 ^^
  const meta = cmdCommandLine(['a&b', 'c|d', 'e<f', 'g>h', 'i(j)', 'k^l'])
  check('① cmd 元字符逐个 ^ 转义（& | < > ( ) 与 ^ 自身）',
    meta === '"a^&b" "c^|d" "e^<f" "g^>h" "i^(j^)" "k^^l"', meta)
  // 已知边界（如实断言当前行为，别假装覆盖）：% 变量展开任何引号/^ 都挡不住
  check('① 已知边界：%VAR% 不做（也无法做）转义 —— 我们生成的 argv 本身不含 % 与 !',
    cmdCommandLine(['x%y%']) === '"x%y%"'
    && !/[%!]/u.test(command)
    && !/[%!]/u.test(cmdCommandLine(['add', 'left-pad', '--registry', 'https://registry.npmmirror.com', '--fetch-timeout=60000'])), cmdCommandLine(['x%y%']))
}

// ── ② 桌面端形态：resourcesPath → node --expose-internals <pnpm.mjs>（照抄 host 的 packageManager）──
{
  const resourcesPath = join('D:', 'dsh-desktop', 'resources')
  const pnpmMjs = join(resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const execPath = join('D:', 'dsh-desktop', 'DeepSeek Harness.exe')
  const exists = (p) => p === pnpmMjs
  const runners = resolvePnpmRunners({ platform: 'win32', execPath, comspec: 'cmd.exe', exists, env: { PATH: '' }, resourcesPath })
  check('② 桌面端形态优先于 cmd-corepack（排在 node-corepack 之后）',
    runners[0]?.kind === 'desktop-pnpm-mjs' && kinds(runners) === 'desktop-pnpm-mjs,cmd-corepack', kinds(runners))
  const desktop = runners[0]?.run(['add', 'left-pad'])
  check('② 选中 pnpm.mjs 候选：bin = 宿主二进制（Electron），argv 里 pnpm.mjs 后面紧跟参数',
    desktop.bin === execPath && desktop.argv[desktop.argv.indexOf(pnpmMjs) + 1] === 'add'
    && desktop.argv[desktop.argv.indexOf(pnpmMjs) + 2] === 'left-pad', JSON.stringify(desktop.argv))
  check('② argv 是桌面端 host 的同款形态（--expose-internals + <pnpm.mjs>）',
    desktop.argv[0] === '--expose-internals' && desktop.argv[1] === pnpmMjs, JSON.stringify(desktop.argv))
  check('② 必须带 ELECTRON_RUN_AS_NODE=1（不带会把 Electron 当 GUI 应用启动 = 假成功）',
    desktop.env?.ELECTRON_RUN_AS_NODE === '1', JSON.stringify(desktop.env ?? null))
  // DSH_DESKTOP_NODE_EXECUTABLE 优先（桌面端运行时给自己 node 的声明）
  const desktopNodeExe = join('D:', 'dsh-desktop', 'runtime-node.exe')
  const viaEnv = resolvePnpmRunners({ platform: 'win32', execPath, comspec: 'cmd.exe', exists, env: { PATH: '', DSH_DESKTOP_NODE_EXECUTABLE: desktopNodeExe }, resourcesPath })
  check('② 有 DSH_DESKTOP_NODE_EXECUTABLE 时用它当 node（没有才回落 execPath）',
    viaEnv[0]?.run(['x']).bin === desktopNodeExe, viaEnv[0]?.run(['x']).bin)
  // 没有 resourcesPath / 文件不存在时一个候选都不新增（exists 注入为"什么都没有"）
  const none = resolvePnpmRunners({ platform: 'win32', execPath, comspec: 'cmd.exe', exists: () => false, env: { PATH: '' }, resourcesPath: '' })
  check('② resourcesPath 为空 + 文件不存在 → 不新增任何候选（仍是既有形态）',
    kinds(none) === 'cmd-corepack', kinds(none))
}

// ── ③ PATH 扫描（win: pnpm.cmd / posix: pnpm / 两者: <dir>\pnpm\bin\pnpm.mjs）+ 环境线索 ──
{
  const dirs = [join('C:', 'tools'), join('C:', 'tools', 'pnpm'), join('C:', 'other')]
  const winPath = dirs.join(';')
  const pnpmCmd = join('C:', 'tools', 'pnpm.cmd')
  const win = resolvePnpmRunners({
    platform: 'win32', execPath: join('C:', 'Program Files', 'nodejs', 'node.exe'), comspec: 'cmd.exe',
    exists: (p) => p === pnpmCmd, env: { PATH: winPath }, resourcesPath: '',
  })
  check('③ PATH 扫描命中 pnpm.cmd（经 cmd.exe，而不是直接 execFile —— 实测 .cmd 直接 spawn 是 EINVAL）',
    kinds(win) === 'cmd-pnpm,cmd-corepack' && win[0].run(['add', 'x']).bin === 'cmd.exe', kinds(win))
  const winArgv = win[0].run(['add', 'left-pad']).argv
  check('③ PATH 命中的 pnpm.cmd 也走修好的单字符串形态（无 \\"、verbatim）',
    !winArgv[3].includes('\\"') && winArgv[3] === `"${cmdCommandLine(['pnpm', 'add', 'left-pad'])}"` && win[0].run(['add', 'left-pad']).verbatim === true, JSON.stringify(winArgv))
  const mjs = join('C:', 'tools', 'pnpm', 'bin', 'pnpm.mjs')
  const win2 = resolvePnpmRunners({
    platform: 'win32', execPath: join('C:', 'Program Files', 'nodejs', 'node.exe'), comspec: 'cmd.exe',
    exists: (p) => p === mjs, env: { PATH: winPath }, resourcesPath: '',
  })
  check('③ PATH 扫描命中 <dir>\\pnpm\\bin\\pnpm.mjs（用 node 直跑，不经 cmd）',
    kinds(win2) === 'path-pnpm-mjs,cmd-corepack' && win2[0].run(['add', 'x']).argv.join(' ') === `${mjs} add x`, kinds(win2))
  const linuxPnpm = join('/usr/local/bin', 'pnpm')
  const linux = resolvePnpmRunners({
    platform: 'linux', execPath: '/usr/local/bin/node', exists: (p) => p === linuxPnpm,
    env: { PATH: '/usr/local/bin:/usr/bin' }, resourcesPath: '',
  })
  check('③ posix：PATH 命中 <dir>/pnpm 直接执行（不经 cmd）',
    kinds(linux) === 'path-pnpm,corepack,pnpm' && linux[0].run(['add', 'x']).bin === linuxPnpm, kinds(linux))
  // 环境线索（③）：桌面端 host 把 <…>\runtime\bin 拼进 PATH → 同级 runtime\pnpm\bin\pnpm.mjs
  const runtimeBin = join('D:', 'dsh-desktop', 'resources', 'runtime', 'bin')
  const siblingMjs = join('D:', 'dsh-desktop', 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const byEnv = resolvePnpmRunners({
    platform: 'win32', execPath: join('D:', 'dsh-desktop', 'DeepSeek Harness.exe'), comspec: 'cmd.exe',
    exists: (p) => p === siblingMjs, env: { PATH: runtimeBin }, resourcesPath: '',
  })
  check('③ 环境线索：PATH 里的 <…>\\runtime\\bin → 同级 runtime\\pnpm\\bin\\pnpm.mjs 也被认出来',
    kinds(byEnv) === 'desktop-pnpm-mjs,cmd-corepack' && byEnv[0].note.includes(siblingMjs), kinds(byEnv))
  const runtimePnpmBin = join('D:', 'dsh-desktop', 'resources', 'runtime', 'pnpm', 'bin')
  const byEnv2 = resolvePnpmRunners({
    platform: 'win32', execPath: join('D:', 'dsh-desktop', 'DeepSeek Harness.exe'), comspec: 'cmd.exe',
    exists: (p) => p === siblingMjs, env: { PATH: runtimePnpmBin }, resourcesPath: '',
  })
  check('③ 环境线索：PATH 里直接就是 <…>\\runtime\\pnpm\\bin 也认',
    kinds(byEnv2) === 'desktop-pnpm-mjs,cmd-corepack' && byEnv2[0].note.includes(siblingMjs), kinds(byEnv2))
}

// ── ④ 回归：既有候选与顺序、兜底语义、spawn 附加项只在 runner 明确要求时生效 ────────────
{
  const linuxNoCorepack = resolvePnpmRunners({ platform: 'linux', execPath: '/usr/local/bin/node', exists: () => false, env: { PATH: '' }, resourcesPath: '' })
  check('④ 回归：Linux 什么都没有时仍是 corepack → pnpm（与 test-suite-detect 同一条判据）',
    kinds(linuxNoCorepack) === 'corepack,pnpm', kinds(linuxNoCorepack))
  const winNoCorepack = resolvePnpmRunners({ platform: 'win32', execPath: join('C:', 'Program Files', 'nodejs', 'node.exe'), comspec: 'cmd.exe', exists: () => false, env: { PATH: '' }, resourcesPath: '' })
  check('④ 回归：Windows 什么都没有时首选仍是 cmd-corepack',
    winNoCorepack[0]?.kind === 'cmd-corepack' && winNoCorepack[0].run(['add', 'x']).bin === 'cmd.exe', kinds(winNoCorepack))
  const winNode = join('C:', 'Program Files', 'nodejs', 'node.exe')
  const winCorepack = join('C:', 'Program Files', 'nodejs', 'node_modules', 'corepack', 'dist', 'corepack.js')
  const winWithCorepack = resolvePnpmRunners({ platform: 'win32', execPath: winNode, comspec: 'cmd.exe', exists: (p) => p === winCorepack, env: { PATH: '' }, resourcesPath: '' })
  check('④ 回归：Windows 官方安装器布局仍是第一优先（node 直跑 corepack.js）',
    winWithCorepack[0]?.kind === 'node-corepack' && winWithCorepack[0].run(['add', 'x']).bin === winNode, kinds(winWithCorepack))
  const brewNode = join('/opt/homebrew/bin', 'node')
  const brewCorepack = join('/opt/homebrew/bin', '..', 'libexec', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js')
  const darwin = resolvePnpmRunners({ platform: 'darwin', execPath: brewNode, exists: (p) => p === brewCorepack, env: { PATH: '' }, resourcesPath: '' })
  check('④ 顺序不变：三个 corepack 布局 → 新候选 → cmd/corepack → pnpm（darwin 兜底 corepack,pnpm）',
    kinds(darwin) === 'node-corepack,corepack,pnpm' && darwin[0].run(['add', 'x']).argv[0] === brewCorepack, kinds(darwin))

  // 兜底语义：只有"执行方式本身不可用"（ENOENT / Cannot find module）才换下一个
  const tried = []
  const runners = [
    { kind: 'a', note: 'A', run: () => ({ bin: 'a', argv: [] }) },
    { kind: 'b', note: 'B', run: () => ({ bin: 'b', argv: [] }) },
  ]
  const enoent = async (bin) => { tried.push(bin); if (bin === 'a') throw Object.assign(new Error('spawn a ENOENT'), { code: 'ENOENT' }) }
  const won = await runPnpmWithFallback(['--version'], { runners, exec: enoent })
  check('④ ENOENT（执行方式不可用）→ 换下一个候选并成功', won.runner.kind === 'b' && tried.join(',') === 'a,b', tried.join(','))
  const tried2 = []
  const realFail = async (bin) => { tried2.push(bin); throw Object.assign(new Error('ERR_PNPM_FETCH_404 left-pad'), { stderr: 'ERR_PNPM_FETCH_404 left-pad' }) }
  const caught = await runPnpmWithFallback(['--version'], { runners, exec: realFail }).then(() => null, (e) => e)
  check('④ 真失败（非 ENOENT）→ 立即抛出，不换候选', tried2.join(',') === 'a' && /ERR_PNPM_FETCH_404/u.test(caught?.message ?? ''), tried2.join(','))
  const allGone = await runPnpmWithFallback(['--version'], { runners, exec: async (bin) => { throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }) } }).then(() => null, (e) => e)
  check('④ 候选全不可用 → 抛出并列出已尝试的清单（顺序可读）',
    /已尝试：A → B/u.test(allGone?.message ?? ''), allGone?.message)

  // spawn 附加项：只有 runner 明确给出 verbatim/env 才动 execOpts；既有候选拿到的还是同一个对象
  const execOpts = { cwd: 'X', env: { KEEP: '1' } }
  const seen = []
  const spy = async (bin, argv, opts) => { seen.push(opts) }
  await runPnpmWithFallback(['x'], { runners: [{ kind: 'plain', note: 'plain', run: () => ({ bin: 'p', argv: [] }) }], execOpts, exec: spy })
  check('④ 既有候选：exec 收到的就是原来那个 execOpts 对象（零行为变化）', seen[0] === execOpts, JSON.stringify(seen[0]))
  await runPnpmWithFallback(['x'], {
    runners: [{ kind: 'cmdish', note: 'cmdish', run: () => ({ bin: 'c', argv: ['/d'], verbatim: true, env: { ELECTRON_RUN_AS_NODE: '1' } }) }],
    execOpts, exec: spy,
  })
  check('④ runner 要求 verbatim → windowsVerbatimArguments=true；要求 env → 覆盖在既有 env 之上（不丢原键）',
    seen[1]?.windowsVerbatimArguments === true && seen[1]?.env?.ELECTRON_RUN_AS_NODE === '1' && seen[1]?.env?.KEEP === '1' && seen[1] !== execOpts,
    JSON.stringify(seen[1]))
}

// ── ⑤ 平台分支各断言一次（win32 / linux / darwin 的"最后一档"必须与平台相符）─────────────
{
  const last = (platform) => resolvePnpmRunners({ platform, execPath: '/usr/bin/node', comspec: 'cmd.exe', exists: () => false, env: { PATH: '' }, resourcesPath: '' }).at(-1).kind
  check('⑤ 平台分支：win32 末档 cmd-corepack（没有 bare corepack）', last('win32') === 'cmd-corepack', last('win32'))
  check('⑤ 平台分支：linux 末档 pnpm', last('linux') === 'pnpm', last('linux'))
  check('⑤ 平台分支：darwin 末档 pnpm', last('darwin') === 'pnpm', last('darwin'))
  const win = resolvePnpmRunners({ platform: 'win32', execPath: join('C:', 'PF', 'node.exe'), comspec: 'cmd.exe', exists: () => false, env: { PATH: '' }, resourcesPath: '' })
  check('⑤ 平台分支：win32 的 cmd-corepack 用的是修好的形态（argv 4 段、无 \\"）',
    win[0].run(['add', 'x']).argv.length === 4 && !win[0].run(['add', 'x']).argv[3].includes('\\"'), JSON.stringify(win[0].run(['add', 'x']).argv))
  const linuxBuild = resolvePnpmRunners({ platform: 'linux', execPath: '/usr/local/bin/node', exists: () => false, env: { PATH: '/usr/local/bin' }, resourcesPath: '' })
  check('⑤ 平台分支：linux 上 PATH 扫描不产生 cmd 形态（无 .cmd 概念）',
    linuxBuild.every((r) => r.kind !== 'cmd-pnpm' && r.kind !== 'cmd-corepack'), kinds(linuxBuild))
}

// ── ⑥ Windows 真 cmd.exe 自证（CI 在 Linux → 如实 SKIP，不假装 PASS）──────────────────
// 这一条是本轮"改对了吗"的真机判据：同一台机器上，旧形态必须失败、新形态必须把参数原样送到。
if (process.platform !== 'win32') {
  console.log(`SKIP ⑥ 真 cmd.exe 自证（当前平台 ${process.platform}，本套其余断言是纯离线形态断言）`)
} else {
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  // 目标用临时目录里一个"只回显参数"的 .cmd：echo 是 cmd 内建，而**引号包住的内建名**会被 cmd 当成
  // 可执行文件去找（`cmd /c ""echo" "hi""` 必失败）—— 那不是我们的形态问题，所以这里用真实 .cmd。
  const probeDir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-runners-'))
  const probe = join(probeDir, 'echoargs.cmd')
  writeFileSync(probe, '@echo off\r\n:loop\r\nif "%~1"=="" goto :eof\r\necho [%~1]\r\nshift\r\ngoto :loop\r\n', 'utf8')
  try {
    // 负对照：旧形态（JSON.stringify 拼串 + 不 verbatim）—— Node 会把段内引号转义成 \" → 失败
    const oldArgv = ['/d', '/s', '/c', [probe, 'add', 'x'].map((a) => JSON.stringify(a)).join(' ')]
    const oldRun = spawnSync(comspec, oldArgv, { encoding: 'utf8', windowsHide: true })
    const oldOut = `${oldRun.stdout ?? ''}${oldRun.stderr ?? ''}`
    check('⑥ 负对照：旧形态在真 cmd.exe 上跑不起来（复现本轮缺陷：段内引号被转义成 \\"）',
      oldRun.status !== 0 && !oldOut.includes('[add]') && /\\"/u.test(oldOut), `status=${oldRun.status} out=${JSON.stringify(oldOut.trim().slice(0, 70))}`)
    // 正对照：新形态 —— 参数（含空格）必须原样到达
    const newRun = spawnSync(comspec, cmdShellArgv(cmdCommandLine([probe, 'a b', 'x'])), { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
    check('⑥ 新形态：真 cmd.exe 上参数（含空格的 "a b"）原样到达',
      newRun.status === 0 && (newRun.stdout ?? '').includes('[a b]') && (newRun.stdout ?? '').includes('[x]'), `status=${newRun.status} out=${JSON.stringify((newRun.stdout ?? '').trim())}`)
    // 新形态 + 元字符：& 在引号内仍是 cmd 操作符 → 必须被 ^ 转义后原样到达
    const metaRun = spawnSync(comspec, cmdShellArgv(cmdCommandLine([probe, 'a&b'])), { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
    const metaOut = `${metaRun.stdout ?? ''}${metaRun.stderr ?? ''}`
    check('⑥ 新形态：cmd 元字符（&）被 ^ 转义后原样到达（不会被当命令分隔符）',
      metaRun.status === 0 && metaOut.includes('[a&b]'), `status=${metaRun.status} out=${JSON.stringify((metaRun.stdout ?? '').trim())}`)
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
  // 桌面端形态在本机（非 Electron）也要能真跑：resolvePnpmRunners 默认候选跑一次 --version
  const realRunners = resolvePnpmRunners()
  const r0 = realRunners[0]
  const spec0 = r0.run(['--version'])
  const ver = spawnSync(spec0.bin, spec0.argv, {
    encoding: 'utf8', windowsHide: true, ...(spec0.verbatim === true ? { windowsVerbatimArguments: true } : {}),
    env: { ...process.env, ...(spec0.env ?? {}) },
  })
  check('⑥ 本机默认首选候选真能跑 pnpm --version（真实 pnpm，不是桩）',
    ver.status === 0 && /^\d+\.\d+/u.test((ver.stdout ?? '').trim()), `${r0.kind} :: status=${ver.status} out=${JSON.stringify((ver.stdout ?? '').trim().slice(0, 40))}`)
}

console.log(fail === 0 ? `\nALL PASS（${pass} 条）` : `\n${fail} FAILED（共 ${pass + fail} 条）`)
process.exit(fail === 0 ? 0 : 1)
