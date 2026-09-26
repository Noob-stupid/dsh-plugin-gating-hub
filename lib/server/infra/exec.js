// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra

import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** git 可执行名（跨平台）。事故（2026-09-20，另一位用户：Android + proot Ubuntu）：
 * 「仓库落地」硬编码 `git.exe` → 非 Windows 环境 spawn git.exe ENOENT，克隆必然失败。 */
function gitBin() {
  return process.platform === 'win32' ? 'git.exe' : 'git'
}

/** pnpm 执行方式定位（跨平台，纯函数便于单测 → 按优先级返回列表，逐个尝试）。
 * 事故（2026-09-20，同一位用户，node v24 + Linux）：只按 Windows 布局找 corepack.js
 * （`<node bin>/node_modules/corepack/dist/corepack.js`），而 Linux 的 npm 全局布局在
 * `<prefix>/lib/node_modules/corepack/...` → AI 赋能的 install-npm 生成
 * `node /usr/local/bin/node_modules/corepack/dist/corepack.js pnpm add …` →
 * `Error: Cannot find module …`（MODULE_NOT_FOUND）。这里把三种布局 + PATH 兜底都列出来。 */
function resolvePnpmRunners({ platform = process.platform, execPath = process.execPath, comspec = process.env.ComSpec ?? 'cmd.exe', exists = existsSync } = {}) {
  const binDir = dirname(execPath)
  const corepackCandidates = [
    join(binDir, 'node_modules', 'corepack', 'dist', 'corepack.js'), // Windows 官方安装器 / nvm-windows
    join(binDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'), // Linux/macOS npm 全局
    join(binDir, '..', 'libexec', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'), // brew / 自编译布局
  ]
  const runners = []
  for (const js of corepackCandidates) {
    if (exists(js)) {
      runners.push({ kind: 'node-corepack', note: `node ${js} pnpm`, run: (args) => ({ bin: execPath, argv: [js, 'pnpm', ...args] }) })
    }
  }
  if (platform === 'win32') {
    // .cmd 批处理不能直接 execFile（EINVAL）→ 经 cmd.exe 调用（整条命令作为一个参数）
    runners.push({
      kind: 'cmd-corepack',
      note: 'cmd /c corepack pnpm',
      run: (args) => ({ bin: comspec, argv: ['/d', '/s', '/c', ['corepack', 'pnpm', ...args].map((a) => JSON.stringify(a)).join(' ')] }),
    })
  } else {
    runners.push({ kind: 'corepack', note: 'corepack pnpm', run: (args) => ({ bin: 'corepack', argv: ['pnpm', ...args] }) })
    runners.push({ kind: 'pnpm', note: 'pnpm', run: (args) => ({ bin: 'pnpm', argv: args }) })
  }
  return runners
}

/** 依次尝试各执行方式；只有"执行方式本身不可用"（ENOENT / MODULE_NOT_FOUND）才换下一个，
 * 真正的安装失败（网络、依赖冲突等）立即抛出，并附上已尝试的清单便于排查。
 *
 * 2026-09-24：抛错时必须**带上 pnpm 的原始 stderr** —— 之前只留 `Command failed: <命令行>`，
 * 界面与测试里都看不到真实原因（CI 的「真装真卸冒烟」就是这么红的：只知道失败、不知道为什么）。
 *
 * 2026-09-26（本次）：执行器由 `execFileAsync` 换成 `execFileWithKillTree`（**只换失败路径的实现**）——
 * pnpm 的 fetch 超时以前只 kill 父进程，pnpm 派生的 git / tar / node-gyp / 子 pnpm 会变成孤儿继续跑，
 * 占着 node_modules 与 .git 里的文件；现在超时/中断即杀整棵树。成功路径返回值与异常形状不变。
 * `exec` 是给单测留的注入口（默认真实实现），生产调用方不需要传。 */
async function runPnpmWithFallback(args, { execOpts = {}, runners = resolvePnpmRunners(), exec = execFileWithKillTree } = {}) {
  let lastError = null
  const withStderr = (error) => {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    if (stderr === '' && stdout === '') return error
    const detail = [stderr, stdout].filter((s) => s !== '').join(' / ').split(/\r?\n/u).slice(-6).join(' ⏎ ').slice(0, 800)
    const wrapped = new Error(`${String(error?.message ?? 'pnpm 执行失败')}｜真实输出：${detail}`)
    // 保真：包装新 Error 时别把"结构性信息"丢掉（是不是超时/被杀、哪个 pid、哪个退出码）。
    // 丢了这些字段，上层就无法只对"网络类超时"做定向长超时重试（见 domain/install-diagnose.js）。
    for (const key of ['killed', 'timedOut', 'timeoutMs', 'signal', 'code', 'pid', 'cmd']) {
      if (error?.[key] !== undefined) wrapped[key] = error[key]
    }
    return wrapped
  }
  for (const runner of runners) {
    const { bin, argv } = runner.run(args)
    try {
      // eslint-disable-next-line no-await-in-loop
      await exec(bin, argv, execOpts)
      return { runner }
    } catch (error) {
      lastError = withStderr(error)
      const message = String(error?.message ?? '')
      if (!/ENOENT|Cannot find module/u.test(message)) throw lastError
    }
  }
  const tried = runners.map((r) => r.note).join(' → ')
  throw new Error(`${lastError?.message ?? 'pnpm 执行失败'}（已尝试：${tried}）`)
}

/** git 非交互环境：禁止任何登录/凭据窗口弹出（私有仓库或不可达源直接失败，不做交互式重试）。 */

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
  }
}
function processAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}
const execFileAsync = promisify(execFile)

/** 结束**整棵**进程树（2026-09-26 从 domain/repoland.js 移入 infra —— pnpm 通道也要用同一份实现，
 * 不能让 git 通道和 pnpm 通道各写一份、同一个坑各踩一次）。
 * 超时/中断后必须做：git 会派生 remote-https / index-pack，pnpm 会派生 git / tar / node-gyp / 子 pnpm，
 * 只 kill 父进程会留下孤儿继续占着 .git 与 node_modules 里的文件（2026-09-26 真机实测占住
 * pack 临时文件与 shallow.lock，Windows 下直接导致目录删不掉）。
 * Windows：`taskkill /F /T /PID`（/T 连整棵子树）；POSIX：`kill(-pid)`（依赖 spawn 时 detached 自成进程组）。
 * 导入点不变：domain/repoland.js 继续 re-export 这个名字，老调用方一个字都不用改。 */
function killProcessTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 15000 })
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { return false } }
    }
    return true
  } catch { return false }
}

/** 带"超时/中断即杀整棵进程树"的 execFile 替身（2026-09-26 新增，**只加不改**：`execFileAsync` 原样保留，
 * curl / tar / gh 等调用点继续用它）。
 * 与 execFileAsync 的差别**只在失败路径**：① 超时（opts.timeout）② AbortSignal 中断 —— 两条都先
 * `killProcessTree(child.pid)` 收掉整棵树，再把"超时多少毫秒 + 已终止的 pid"写进错误消息
 * （旧代码超时只 kill 父进程，报错也只有一句 `Command failed: …`，用户与日志都看不出发生了什么）。
 * 成功路径的 resolve 形状（{stdout, stderr}）与既有异常字段（message/stderr/stdout/code/killed/signal）
 * 保持一致，调用方无需改动；`detached` 仅为 POSIX 成组（Windows 上保持 false，避免弹新控制台窗口）。 */
function execFileWithKillTree(bin, argv, opts = {}, deps = {}) {
  const { killTree = killProcessTree, spawnFn = spawn } = deps
  const timeout = Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : 0
  const maxBuffer = Number.isFinite(opts.maxBuffer) && opts.maxBuffer > 0 ? opts.maxBuffer : 1024 * 1024
  const signal = opts.signal ?? null
  return new Promise((resolve, reject) => {
    const cmd = `${bin} ${argv.join(' ')}`
    let child = null
    let timer = null
    let settled = false
    let stdout = ''
    let stderr = ''
    const baseError = () => {
      const err = new Error(stderr.trim() === '' ? `Command failed: ${cmd}` : `Command failed: ${cmd}\n${stderr.trim()}`)
      err.cmd = cmd
      err.stdout = stdout
      err.stderr = stderr
      return err
    }
    const killTreeNow = () => {
      try { return killTree(child?.pid) } catch { return false }
    }
    /** 超时/中断错误：必须说清"已经终止了整棵树、pid 是多少"，否则用户只能看到一句 Command failed。 */
    const killedError = (reason) => {
      const err = baseError()
      err.killed = true
      err.signal = 'SIGTERM'
      err.timedOut = reason === 'timeout'
      err.timeoutMs = timeout
      err.pid = child?.pid ?? null
      err.message += `\n（${reason === 'timeout' ? `超时 ${timeout}ms` : '收到中断信号'}：已终止整棵进程树 pid=${child?.pid ?? '?'}）`
      return err
    }
    const cleanup = () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (signal !== null && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error === null) resolve(value)
      else reject(error)
    }
    const onAbort = () => { killTreeNow(); finish(killedError('abort'), null) }
    if (signal !== null) {
      if (signal.aborted === true) { finish(killedError('abort'), null); return }
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      child = spawnFn(bin, argv, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: opts.windowsHide !== false,
        detached: process.platform !== 'win32', // POSIX：自成进程组，-pid 才杀得掉整棵树
      })
    } catch (error) { finish(error, null); return }
    const overflow = () => {
      killTreeNow()
      const err = baseError()
      err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      err.message = `stdout maxBuffer length exceeded\n${err.message}`
      finish(err, null)
    }
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk); if (stdout.length + stderr.length > maxBuffer) overflow() })
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); if (stdout.length + stderr.length > maxBuffer) overflow() })
    child.on('error', (error) => { finish(error, null) })
    child.on('close', (code) => {
      if (code === 0) { finish(null, { stdout, stderr }); return }
      const err = baseError()
      err.code = typeof code === 'number' ? code : null
      err.killed = false
      err.signal = null
      finish(err, null)
    })
    if (timeout > 0) timer = setTimeout(() => { killTreeNow(); finish(killedError('timeout'), null) }, timeout)
  })
}

/** gh CLI 通道：api.github.com 黑洞期（node:https 全部超时）时的最后兜底。
 * 服务进程 PATH 可能不含 gh（桌面壳环境）：依次尝试 gh、常见安装路径。 */
const GH_BIN_CANDIDATES = [
  'gh',
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
  join(homedir(), 'scoop', 'shims', 'gh.exe'),
]

export { GH_BIN_CANDIDATES, gitEnv, gitBin, processAlive, execFileAsync, resolvePnpmRunners, runPnpmWithFallback, killProcessTree, execFileWithKillTree }