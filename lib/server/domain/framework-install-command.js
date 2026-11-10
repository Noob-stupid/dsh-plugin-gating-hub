// L1 · domain —— 「按安装布局生成安装通道 + 装后版本核对」（纯函数；2026-11-06 真机遗留问题）
//
// 上一轮（commit 673f67d / domain/framework-root-gate.js）只把**门闸**放宽了：
//   真机 resolveFrameworkRootNodeModules(dshDir) = "D:/node_cache/_npx/<hash>/node_modules"
//        judgeFrameworkRoot(...) = { ok: true, layout: "hoisted" }
// 那个目录里 @deepseek-ai/dsh（0.2.1-rc.5，真实目录）在、但**没有 .pnpm**；
// 放 `package.json` 的是它的**父目录** `D:/node_cache/_npx/<hash>/`。
//
// 于是门开了、安装步骤还是老的：
//   `corepack pnpm install @deepseek-ai/dsh@<target> --force` + `Set-Location` 到那层 node_modules
// ⇒ 扁平树里 pnpm 找不到 package.json（ERR_PNPM_NO_PKG_MANIFEST），或者干脆混装：
//   **升不到 0.2.2-rc.1**。本次把「按布局分流」落在这一份纯函数里：
//   · layout === 'pnpm'    ⇒ 命令与 0.5.110 之前**逐字相同**（一个字符都不许变 —— 回归要求）
//   · layout === 'hoisted' ⇒ 走 npm：`npm install @deepseek-ai/dsh@<target> --prefix <含 package.json 的那一层>`
//   两条通道装完都必须**读回核对** `<fwRoot>/@deepseek-ai/dsh/package.json` 的 version === target，
//   不符如实失败（调用方走既有 CLI 备份回滚），**绝不报成功**。
//
// 纪律：本模块不读全局、**不写盘**、不抛错（读版本那一步可注入 `readVersion`，且全部 try/catch，
// 读不到就算「读不到」并判失败）；生成物全是字符串，让调用方
// （routes/framework-upgrade.js，那文件有 700 行硬顶）保持精简 —— 本次路由 699 → 696（净减 3 行）。
//
// 2026-11-09 发版前实测补丁（上一单 164aba5 的硬伤）：
//   164aba5 给扁平布局加的 npm 通道把 CLI 写死成 `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js`，
//   而 **DSH 桌面端运行时那套 node 里根本没有 npm**：
//     D:\dsh-desktop\resources\runtime\primary-runtime\dependencies\node\node_modules\ → 只有 README.txt
//   ⇒ 扁平（hoisted）用户会「过了门闸、到安装那一步才因为找不到 npm 失败」—— 最差的失败位置。
//   本机实测可用的两条路：PATH 上的 npm.cmd（D:\nvm4w\nodejs\npm.cmd，node 24.13.0）、corepack.cmd（npm 12.2.2）。
//   ⇒ 新增 resolveNpmCli（纯函数，exists/which 注入）：node 自带 → PATH npm → corepack npm → none；
//     npm 来源写进安装日志与升级步骤；`none` 由 frameworkUpgradeCliBlocker 在 **preflight** 就拒（不留到安装步骤）。
//   ⇒ pnpm 分支（命令、预检文案、步骤）一个字符都没变。
//
// 2026-11-10 发射位置契约（**生成物一个字节都没改，只改它在脚本里的位置**）：
//   上一单（164aba5）把 `Set-Location` + `$cmdLine = …` 这块抽成 frameworkInstallSetupBlock 时，是把它当
//   **数组元素吐在脚本作用域**的 —— 而 `$cmdLine` 拼的是 `' + $reg + … > ' + $marker + '"'`，这两个是
//   `function Install-Framework($reg)` 的**函数内变量**：
//     脚本作用域拼接 ⇒ $reg / $marker 都是 $null ⇒ `--registry` 为空、cmd 的重定向目标为空
//     ⇒ marker 文件永远写不出来 ⇒ Install-Framework 轮询 15 分钟超时 ⇒ `$code=1` ⇒ 回滚。
//   pnpm / hoisted **两条通道都会中招**（只有 $reg/$marker 的拼接部分是共用的）。
//   ⇒ 契约：本模块返回的这块**只能作为 Install-Framework 函数体内的数组元素发射**
//     （`$marker = $log + '.pnpm.marker'` 赋值之后、`$proc = Start-Process` 之前）；
//     回归由 tests/test-upgrade-script-syntax.mjs 的「安装块作用域」段钉死（顺序 / 函数前零引用 /
//     $marker 先于 $cmdLine / 真 PowerShell 语法 / marker 真被写出的行为级证据）。
//   本模块是**纯函数**：它不知道也不负责自己会被插到哪 —— 位置由调用方（routes/framework-upgrade.js）保证，
//   所以这里只把契约写清楚，绝不靠"挪一行字"去猜。
import { existsSync, readFileSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'

/** 框架包在安装根里的相对位置（装后核对读的就是它）。 */
const FRAMEWORK_PKG_SEGMENTS = ['@deepseek-ai', 'dsh', 'package.json']

/**
 * 该布局用哪条安装通道（日志/步骤里就写这个名字）。
 * 只认 'pnpm' 为 pnpm；其余（含 'hoisted' / null）都是 npm —— 宁可走能装上的那条，也不许假装 pnpm 能用。
 */
function frameworkInstallChannel(layout) {
  return layout === 'pnpm' ? 'pnpm' : 'npm'
}

/**
 * 「含 package.json 的那一层」= npm 的 --prefix / Set-Location 目标。
 *   · …\_npx\<hash>\node_modules ⇒ …\_npx\<hash>（真机就是这一层放 package.json）
 *   · 传进来的不是 node_modules（已是项目根）⇒ 原样返回
 */
function frameworkInstallHome(fwRoot) {
  if (typeof fwRoot !== 'string' || fwRoot === '') return null
  return basename(fwRoot) === 'node_modules' ? dirname(fwRoot) : fwRoot
}

/** 装后核对要读的那个 package.json 绝对路径（缺 fwRoot 时返回 null，不抛）。 */
function frameworkInstallPackageJson(fwRoot) {
  if (typeof fwRoot !== 'string' || fwRoot === '') return null
  return join(fwRoot, ...FRAMEWORK_PKG_SEGMENTS)
}

/** 默认 `which`：按 PATH（Windows 上再叠加后缀）找可执行文件；找不到返回 null（不抛、不写盘）。 */
function pathWhich(name) {
  if (typeof name !== 'string' || name === '') return null
  const dirs = String(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter((d) => d !== '')
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.com'] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      // name 自带后缀（npm.cmd / corepack.cmd）时不再叠加，避免 npm.cmd.COM 这种鬼路径
      if (ext !== '' && name.toLowerCase().endsWith(ext)) continue
      const candidate = join(dir, name + ext)
      try { if (existsSync(candidate)) return candidate } catch {}
    }
  }
  return null
}

/**
 * 「本机的 npm 从哪来」—— **真机实测（2026-11-09），不是推测**：
 *   D:\dsh-desktop\resources\runtime\primary-runtime\dependencies\node\node_modules\ 里只有 README.txt
 *   ⇒ 运行时 node 目录下的 npm 实体与 corepack 实体**都不存在**
 *   ⇒ 上一版只按 `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js` 解析，
 *     扁平（hoisted）用户会**过了门闸、到安装那一步才因为找不到 npm 失败**（最差的失败位置）。
 * 本机实测可用来源：PATH 上的 npm.cmd（D:\nvm4w\nodejs\npm.cmd，node 24.13.0）、
 * corepack.cmd（`corepack npm --version` → 12.2.2，有版本告警但能跑）。
 *
 * 于是按序退让，**只认真正存在的东西**（exists / which 全部注入 ⇒ 纯函数、可单测、不读全局目录）：
 *   ① node 自带 `<nodeRoot>/node_modules/npm/bin/npm-cli.js`（execPath 在 bin/ 下时再试其父目录）
 *   ② PATH 上的 `npm.cmd`（Windows）/ `npm`（其它）
 *   ③ `corepack npm`（`corepack.cmd` / `corepack`）
 *   ④ 都没有 ⇒ `none` —— 调用方（frameworkUpgradeCliBlocker）**必须在 preflight 就失败**，
 *      不许留到安装步骤才炸。
 *
 * `command` 是「命令行里的 CLI 调用串」：①②③ 都已经**自带自己的解释器**，
 * 调用方不许再往前面拼 nodePath（拼了就正好拼出那个不存在的路径）。
 * @returns {{ kind: 'node-bundled'|'path'|'corepack'|'none', command: (string|null), note: string }}
 */
function resolveNpmCli({ nodePath, exists, which } = {}) {
  const has = typeof exists === 'function' ? exists : existsSync
  const find = typeof which === 'function' ? which : pathWhich
  // ① node 自带（与 0.5.110 同一个入口：npm 的 lib/cli.js 是函数模块，直跑 = 假成功 exit 0）
  if (typeof nodePath === 'string' && nodePath !== '') {
    const nodeDir = dirname(nodePath)
    const roots = [nodeDir]
    if (basename(nodeDir).toLowerCase() === 'bin') roots.push(dirname(nodeDir)) // 运行时 node 常在 <root>/bin/ 下
    for (const root of roots) {
      const cli = join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      try {
        if (has(cli) === true) return { kind: 'node-bundled', command: `${nodePath} ${cli}`, note: `node-bundled（${cli}）` }
      } catch {}
    }
  }
  // ② PATH 上的 npm（真机就命中这一条）
  const npmFound = find(process.platform === 'win32' ? 'npm.cmd' : 'npm')
  if (typeof npmFound === 'string' && npmFound !== '') return { kind: 'path', command: npmFound, note: `path（${npmFound}）` }
  // ③ corepack npm（真机也有；有版本告警但能跑）
  const corepackFound = find(process.platform === 'win32' ? 'corepack.cmd' : 'corepack')
  if (typeof corepackFound === 'string' && corepackFound !== '') {
    return { kind: 'corepack', command: `${corepackFound} npm`, note: `corepack（${corepackFound}）` }
  }
  return { kind: 'none', command: null, note: 'none（已尝试 node 自带 / PATH / corepack）' }
}

/**
 * 生成 npm 命令里的「CLI 调用串」（唯一份，命令模板只拼它）。
 * 传了解析结果就用它（node-bundled 的 command 就是 `<node> <npm-cli.js>`，与改动前**逐字相同**）；
 * 没传（老的调用方/夹具）⇒ 退回改动前的 `${nodePath} ${npmCli}`，一个字符都不变。
 */
function npmInvocation({ npm, nodePath, npmCli }) {
  if (npm !== null && typeof npm === 'object' && npm.kind !== 'none' && typeof npm.command === 'string' && npm.command !== '') return npm.command
  return `${nodePath} ${npmCli}`
}

/**
 * **preflight 门**：安装通道缺 CLI ⇒ 拒绝生成升级脚本（服务保持运行），返回拒绝文案；放行返回 null。
 *   · pnpm 布局：判据与文案与改动前**逐字相同**（corepack 优先，其次 dsh bin.js）—— pnpm 通道零变化；
 *   · 扁平（hoisted）布局：改判 npm 解析结果（DSH 运行时 node 里没有 npm 是已知事实，
 *     再拿 corepack 当 hoisted 的门就是「不是它需要的东西」）；
 *   · 布局未判定（null：框架根门在下面拦）⇒ 沿用原判据，行为与改动前一致。
 * npm 解析不到时**在这里**就失败，文案如实写出三类来源 —— 绝不拖到安装步骤才炸。
 * @returns {string|null}
 */
function frameworkUpgradeCliBlocker({ layout, binPath, corepackJs, npm, exists } = {}) {
  const has = typeof exists === 'function' ? exists : existsSync
  const binMissing = typeof binPath !== 'string' || binPath === '' || has(binPath) !== true
  const cancel = (what) => `升级已取消：无法定位 ${what}（框架安装可能不完整），服务保持运行；请先修复框架再升级`
  if (layout !== 'hoisted') {
    if (!has(corepackJs)) return cancel('corepack（pnpm 通道）')
    return binMissing ? cancel('dsh bin.js') : null
  }
  if (binMissing) return cancel('dsh bin.js')
  const kind = npm !== null && typeof npm === 'object' ? npm.kind : 'none'
  if (kind === 'none' || kind === undefined || kind === null) {
    return '升级已取消：本机找不到 npm（已尝试：node 自带 / PATH / corepack），扁平（hoisted）布局升级需要 npm；服务保持运行，请先在本机装好 npm（或让 corepack 可用）后重试'
  }
  return null
}

/**
 * 安装命令行（生成的是一行 PowerShell 语句 `$cmdLine = '…'`，由 Install-Framework 交给 cmd.exe 跑）。
 *
 * ★ pnpm 分支**逐字**等于 0.5.110 之前的原文（test-framework-install-command.mjs 把旧模板硬编码进断言）：
 *   `start "DSH-Upgrade" cmd /c "title DSH-Upgrade && <node> <corepack> pnpm install … --registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"`
 *   —— `$reg` / `$marker` 是生成物里的 PowerShell 变量（三段单引号串拼接），不是 JS 插值。
 *   其中 `--force` 是必须的：显式指定版本、但该版本已在 package.json 的 semver 范围内时 pnpm 会**跳过安装**
 *   并 exit 0（假成功）；`--config.dangerouslyAllowAllBuilds=true` 放开构建脚本（否则原生模块不编译）。
 *
 * ★ npm 分支：`npm install @deepseek-ai/dsh@<target> --prefix <含 package.json 的那一层>`。
 *   - CLI 调用串由 npmInvocation 给（resolveNpmCli 的解析结果）：node-bundled 用 `<node> <bin/npm-cli.js>`，
 *     path / corepack 用它自己的入口、**不再拼 nodePath**（真机运行时 node 里没有 npm，拼了就必然找不到）；
 *   - `--prefix` 显式指到含 package.json 的那一层（schtasks 的 cwd 是 system32，不指就装错地方）；
 *   - `--save-exact`：把那层的 package.json 钉成目标版本（真机 npx 缓存原来就是精确版本）；
 *   - `--no-audit --no-fund`：CI/计划任务里不联网做审计、不打印募捐信息（少两段可能卡住的网络请求）。
 *   不加 `--force`：npm 对「精确版本 ≠ 已装版本」一定会真装，`--force` 只会把冲突检查关掉、掩盖真问题。
 */
function frameworkInstallCommand({ layout, fwRoot, target, nodePath, corepackJs, npmCli, npm }) {
  // 两条通道唯一的区别 = 「用哪个 CLI + 装到哪」；cmd 的收尾（`DSH-DONE:%ERRORLEVEL%` 写 $marker）必须一模一样，
  // 因为 Install-Framework 靠 marker 判完成、靠 marker 里的退出码判成败。
  if (frameworkInstallChannel(layout) === 'pnpm') {
    return `    $cmdLine = 'start "DSH-Upgrade" cmd /c "title DSH-Upgrade && ${nodePath} ${corepackJs} pnpm install @deepseek-ai/dsh@${target} --force --config.dangerouslyAllowAllBuilds=true --registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"'`
  }
  const prefix = frameworkInstallHome(fwRoot) ?? fwRoot
  return `    $cmdLine = 'start "DSH-Upgrade" cmd /c "title DSH-Upgrade && ${npmInvocation({ npm, nodePath, npmCli })} install @deepseek-ai/dsh@${target} --prefix "${prefix}" --no-audit --no-fund --save-exact --registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"'`
}

/**
 * 安装前的「cwd + 命令行」整块（多行字符串，作为一个数组元素塞进 lines）。
 * pnpm 分支与原文逐字相同（`Set-Location -Path <fwRoot>` + 上面的命令）；
 * hoisted 分支把 cwd 挪到**含 package.json 的那一层**，并先 Log 一行「通道 / npm 来源 / 前缀 / 目标版本」
 * （不静默换通道，也不静默换 npm —— 排查时一眼看出这次用的是 node 自带 / PATH / corepack 哪一路）。
 */
function frameworkInstallSetupBlock({ layout, fwRoot, target, nodePath, corepackJs, npmCli, npm, ps }) {
  const channel = frameworkInstallChannel(layout)
  const cmd = frameworkInstallCommand({ layout, fwRoot, target, nodePath, corepackJs, npm, npmCli })
  if (channel === 'pnpm') return `Set-Location -Path ${ps(fwRoot)}\r\n${cmd}`
  const home = frameworkInstallHome(fwRoot) ?? fwRoot
  const npmSource = npm !== null && typeof npm === 'object' && typeof npm.note === 'string' ? npm.note : `node-bundled（未提供解析结果，沿用 ${nodePath} ${npmCli}）`
  return [
    `Set-Location -Path ${ps(home)}`,
    `    Log ('安装通道：npm（hoisted 布局，无 .pnpm store）；npm 来源：' + ${ps(npmSource)} + '；安装前缀：' + ${ps(home)} + '；目标版本：${target}')`,
    cmd,
  ].join('\r\n')
}

/**
 * 装后核对**唯一判据**（JS 侧）：读回的版本必须 === target。
 * 返回的文案同时被 PowerShell 核对块复用，避免「脚本里的判据」与「JS 里的判据」各写一份而分叉。
 */
function frameworkInstallVerdict({ layout, target, version }) {
  const channel = frameworkInstallChannel(layout)
  const got = typeof version === 'string' && version !== '' ? version : null
  const want = target === null || target === undefined ? null : String(target)
  if (got !== null && want !== null && got === want) {
    return { ok: true, channel, version: got, target: want, message: `装后核对通过：${channel} 通道读回版本 ${got} = 目标 ${want}` }
  }
  return {
    ok: false,
    channel,
    version: got,
    target: want,
    message: `装后核对失败：${channel} 通道装完读回版本 ${got ?? '（读不到）'}，目标 ${want ?? '（未定）'} —— 按失败处理并回滚（绝不报成功）`,
  }
}

/**
 * 装后版本核对块（PowerShell，3 行；**含 try 的收尾 `}`**，调用方整块替换原来的三行）。
 * pnpm 分支与原文逐字相同；hoisted 分支只把消息里的通道名换成 npm（日志里能一眼看出是哪条通道判的失败）。
 */
function frameworkVersionVerifyBlock({ layout, fwRoot, target, ps }) {
  const channel = frameworkInstallChannel(layout)
  const pkg = frameworkInstallPackageJson(fwRoot)
  const targetText = target === null || target === undefined ? '' : String(target)
  return [
    `      $v = (Get-Content ${ps(pkg)} -Raw | ConvertFrom-Json).version`,
    `      if ($v -ne '${targetText}') { Log ('${channel} 退出码 0 但顶层可见版本未更新（顶层 ' + $v + '，目标 ${targetText}），按失败处理'); $code = 1 }`,
    `    } catch { Log '${channel} 退出码 0 但无法读取顶层版本，按失败处理'; $code = 1 }`,
  ].join('\r\n')
}

/**
 * 现在（安装前）读回 `<fwRoot>/@deepseek-ai/dsh/package.json` 的版本，并按上面的判据给结论。
 * `deps.readVersion` 可注入（测试用来桩「装后版本不符」）；读不到一律 version=null（不抛）。
 * @returns {{ ok: boolean, channel: string, version: string|null, target: string|null, prefix: (string|null), packageJson: (string|null), message: string }}
 */
function frameworkInstallReadback({ layout, fwRoot, target, deps = {} }) {
  const readVersion = deps.readVersion ?? ((p) => JSON.parse(readFileSync(p, 'utf8')).version)
  const pkg = frameworkInstallPackageJson(fwRoot)
  let version = null
  try { version = pkg === null ? null : (readVersion(pkg) ?? null) } catch { version = null }
  return { ...frameworkInstallVerdict({ layout, target, version }), prefix: frameworkInstallHome(fwRoot), packageJson: pkg }
}

/**
 * 升级步骤（JS 侧一行）：「用了哪条通道 / npm 从哪来 / 目标版本 / 安装前缀 / 装前读回 / 装后核对什么」。
 * ★ 只有 hoisted 会推这一行 —— pnpm 用户的 steps 与改动前**逐字相同**（回归要求）。
 */
function frameworkInstallStepText({ layout, fwRoot, target, npm, deps = {} }) {
  const channel = frameworkInstallChannel(layout)
  const before = frameworkInstallReadback({ layout, fwRoot, target, deps })
  const layoutText = channel === 'npm' ? 'hoisted（扁平安装，无 .pnpm store）' : 'pnpm（含 .pnpm store）'
  const npmSource = npm !== null && typeof npm === 'object' && typeof npm.note === 'string' ? `；npm 来源：${npm.note}` : ''
  return `框架安装通道：${channel}；布局：${layoutText}${npmSource}；目标版本：${target}；安装前缀：${before.prefix ?? '（未找到）'}`
    + `；装前读回版本：${before.version ?? '（读不到）'}；装后核对：${before.packageJson ?? '（无路径）'} 的 version 必须等于 ${target}，不符即按失败回滚（绝不报成功）`
}

export {
  FRAMEWORK_PKG_SEGMENTS,
  frameworkInstallChannel,
  frameworkInstallCommand,
  frameworkInstallHome,
  frameworkInstallPackageJson,
  frameworkInstallReadback,
  frameworkInstallSetupBlock,
  frameworkInstallStepText,
  frameworkInstallVerdict,
  frameworkUpgradeCliBlocker,
  frameworkVersionVerifyBlock,
  npmInvocation,
  resolveNpmCli,
}
