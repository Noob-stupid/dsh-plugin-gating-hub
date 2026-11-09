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
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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
 *   - 用 **bin/npm-cli.js**（与老注释同一个坑：npm 的 lib/cli.js 是函数模块，直跑 = 假成功 exit 0）；
 *   - `--prefix` 显式指到含 package.json 的那一层（schtasks 的 cwd 是 system32，不指就装错地方）；
 *   - `--save-exact`：把那层的 package.json 钉成目标版本（真机 npx 缓存原来就是精确版本）；
 *   - `--no-audit --no-fund`：CI/计划任务里不联网做审计、不打印募捐信息（少两段可能卡住的网络请求）。
 *   不加 `--force`：npm 对「精确版本 ≠ 已装版本」一定会真装，`--force` 只会把冲突检查关掉、掩盖真问题。
 */
function frameworkInstallCommand({ layout, fwRoot, target, nodePath, corepackJs, npmCli }) {
  // 两条通道唯一的区别 = 「用哪个 CLI + 装到哪」；cmd 的收尾（`DSH-DONE:%ERRORLEVEL%` 写 $marker）必须一模一样，
  // 因为 Install-Framework 靠 marker 判完成、靠 marker 里的退出码判成败。
  if (frameworkInstallChannel(layout) === 'pnpm') {
    return `    $cmdLine = 'start "DSH-Upgrade" cmd /c "title DSH-Upgrade && ${nodePath} ${corepackJs} pnpm install @deepseek-ai/dsh@${target} --force --config.dangerouslyAllowAllBuilds=true --registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"'`
  }
  const prefix = frameworkInstallHome(fwRoot) ?? fwRoot
  return `    $cmdLine = 'start "DSH-Upgrade" cmd /c "title DSH-Upgrade && ${nodePath} ${npmCli} install @deepseek-ai/dsh@${target} --prefix "${prefix}" --no-audit --no-fund --save-exact --registry ' + $reg + ' & echo DSH-DONE:%ERRORLEVEL% > ' + $marker + '"'`
}

/**
 * 安装前的「cwd + 命令行」整块（多行字符串，作为一个数组元素塞进 lines）。
 * pnpm 分支与原文逐字相同（`Set-Location -Path <fwRoot>` + 上面的命令）；
 * hoisted 分支把 cwd 挪到**含 package.json 的那一层**，并先 Log 一行「通道 / 前缀 / 目标版本」（不静默换通道）。
 */
function frameworkInstallSetupBlock({ layout, fwRoot, target, nodePath, corepackJs, npmCli, ps }) {
  const channel = frameworkInstallChannel(layout)
  const cmd = frameworkInstallCommand({ layout, fwRoot, target, nodePath, corepackJs, npmCli })
  if (channel === 'pnpm') return `Set-Location -Path ${ps(fwRoot)}\r\n${cmd}`
  const home = frameworkInstallHome(fwRoot) ?? fwRoot
  return [
    `Set-Location -Path ${ps(home)}`,
    `    Log ('安装通道：npm（hoisted 布局，无 .pnpm store）；安装前缀：' + ${ps(home)} + '；目标版本：${target}')`,
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
 * 升级步骤（JS 侧一行）：「用了哪条通道 / 目标版本 / 安装前缀 / 装前读回 / 装后核对什么」。
 * ★ 只有 hoisted 会推这一行 —— pnpm 用户的 steps 与改动前**逐字相同**（回归要求）。
 */
function frameworkInstallStepText({ layout, fwRoot, target, deps = {} }) {
  const channel = frameworkInstallChannel(layout)
  const before = frameworkInstallReadback({ layout, fwRoot, target, deps })
  const layoutText = channel === 'npm' ? 'hoisted（扁平安装，无 .pnpm store）' : 'pnpm（含 .pnpm store）'
  return `框架安装通道：${channel}；布局：${layoutText}；目标版本：${target}；安装前缀：${before.prefix ?? '（未找到）'}`
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
  frameworkVersionVerifyBlock,
}
