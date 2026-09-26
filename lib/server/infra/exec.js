// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra

import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

/** POSIX 兜底用：读 /proc 列出某 pid 的**全部后代**（按 `/proc/<pid>/stat` 的 ppid 字段建索引 + BFS）。
 * 只有"进程组 kill 失败"时才走它，所以是纯读：任何一步读不到就返回 []，绝不抛。
 * 为什么不用 `pkill -P <pid>`：slim 容器/最小镜像里未必装了 procps，而 /proc 是内核接口
 * （Linux / Android 都有）；macOS 没有 /proc → 返回 []，调用方就退化成"只杀直接子进程"（不比旧行为差）。
 * deps（procDir/readdir/readFile）只为单测注入，生产调用不传。 */
function posixDescendants(pid, { procDir = '/proc', readdir = readdirSync, readFile = readFileSync } = {}) {
  let entries
  try { entries = readdir(procDir) } catch { return [] }
  const childrenOf = new Map()
  for (const name of entries) {
    if (!/^\d+$/u.test(String(name))) continue
    let stat
    try { stat = String(readFile(join(procDir, String(name), 'stat'), 'utf8')) } catch { continue }
    // 形如 `1234 (comm 里可能有空格/括号) S 5678 …`：进程名不可信 → 从**最后**一个 ')' 之后切
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)
    const ppid = Number(rest[1]) // rest[0]=state，rest[1]=ppid
    if (!Number.isInteger(ppid)) continue
    const list = childrenOf.get(ppid)
    if (list === undefined) childrenOf.set(ppid, [Number(name)])
    else list.push(Number(name))
  }
  const out = []
  const queue = [pid]
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      if (child === pid || out.includes(child)) continue // 防 /proc 读歪了造出自环
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

/** 结束**整棵**进程树（2026-09-26 从 domain/repoland.js 移入 infra —— pnpm 通道也要用同一份实现，
 * 不能让 git 通道和 pnpm 通道各写一份、同一个坑各踩一次）。
 * 超时/中断后必须做：git 会派生 remote-https / index-pack，pnpm 会派生 git / tar / node-gyp / 子 pnpm，
 * 只 kill 父进程会留下孤儿继续占着 .git 与 node_modules 里的文件（2026-09-26 真机实测占住
 * pack 临时文件与 shallow.lock，Windows 下直接导致目录删不掉）。
 * Windows：`taskkill /F /T /PID`（/T 连整棵子树）；POSIX：`kill(-pid)`（依赖 spawn 时 detached 自成进程组）。
 * 导入点不变：domain/repoland.js 继续 re-export 这个名字，老调用方一个字都不用改。
 *
 * 2026-09-26（本次改错）：POSIX 分支的兜底以前是"进程组杀不掉就直接 `kill(pid)`"——那等于承认
 * **孙进程必然残留**（-pid 抛错只说明这个进程组不存在：子进程没成组、或已 setsid 带走了自己）。
 * 现在兜底改成"按 /proc 的 ppid 链**从叶子往根**逐个 SIGKILL"，杀不掉任何一个才返回 false
 * （返回值语义不变：仍然是"有没有成功发出过 kill"）。Windows 分支一个字没动。
 * deps（platform/kill/…）只为单测注入 POSIX 分支，生产调用不传 → 行为与旧代码一致。 */
function killProcessTree(pid, deps = {}) {
  if (typeof pid !== 'number' || pid <= 0) return false
  const platform = deps.platform ?? process.platform
  const kill = deps.kill ?? process.kill
  try {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 15000 })
      return true
    }
    try { kill(-pid, 'SIGKILL'); return true } catch {}
    // 进程组不存在/无权限 → 兜底按进程树逐个杀（叶子先杀，父最后杀）
    let killed = false
    for (const child of posixDescendants(pid, deps).reverse()) {
      try { kill(child, 'SIGKILL'); killed = true } catch {}
    }
    try { kill(pid, 'SIGKILL'); killed = true } catch {}
    return killed
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
  const { killTree = killProcessTree, spawnFn = spawn, platform = process.platform } = deps
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
        detached: platform !== 'win32', // POSIX：自成进程组，-pid 才杀得掉整棵树（platform 可注入，见单测）
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

/** pnpm 健壮性环境覆盖（纯函数，单测可直接断言；2026-09-26 新增）。
 * 只**追加**覆盖项，不动其它 env —— registry/镜像与 gitEnv() 的禁交互逻辑照旧，
 * 用户自定义源/内网源不受影响：
 *   · npm_config_fetch_timeout=60000：单次 fetch 60s 封顶（避免被环境里的 0/极大值带成"卡到天荒地老"）；
 *   · npm_config_fetch_retries=1：抖动重试 1 次（真正的兜底是超时后由 domain/install-diagnose.js
 *     判定的**一次**定向长超时重试）；
 *   · CI=true：非交互（无 TTY 的桌面壳/子进程里，pnpm 的交互提示等不到输入就会一直挂住）。
 *
 * ⚠️ 实测（2026-09-26，pnpm 11.21.0 + 本地"只挂连接、永不响应"的假 registry，见 tests/test-pnpm-env.mjs）：
 *   这两个 `npm_config_fetch_*` 键 pnpm 11 **不读**（同环境下 `npm_config_registry` 会被读到，
 *   所以不是 env 前缀的问题，是这两个键不在 pnpm 的 env 白名单里）；
 *   真正生效的是 `pnpm add --fetch-timeout / --fetch-retries` 两个 CLI 选项（见 pnpmFetchArgs）。
 *   仍然照需求注入这三个 env（CI 与非交互确实有用、registry 镜像照旧、fetch_* 是 npm 系标准写法，
 *   对 npm/后续 pnpm 版本仍可能生效），但**不把健壮性只押在 env 上**。 */
function pnpmEnvOverrides(registry) {
  const overrides = {
    npm_config_fetch_timeout: '60000',
    npm_config_fetch_retries: '1',
    CI: 'true',
  }
  if (typeof registry === 'string' && registry !== '') overrides.COREPACK_NPM_REGISTRY = registry
  return overrides
}

/** pnpm 调用的完整 env（在调用方 base 之上覆盖；默认取 process.env）。
 * registry 只在是**非空字符串**时才写 COREPACK_NPM_REGISTRY（git 通道不传 registry，写 undefined 无意义）。 */
function buildPnpmEnv(registry, base = process.env) {
  return {
    ...base,
    // git 通道禁止交互式凭据（与 gitEnv 同一语义）：避免 Git Credential Manager 弹登录窗
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...pnpmEnvOverrides(registry),
  }
}

/** pnpm add 的健壮性选项。**只给 add**：实测 `pnpm remove --fetch-timeout=…` 会
 * `[ERROR] Unknown options: 'fetch-timeout', 'fetch-retries'`（exit 1），所以绝不能全局加。
 * 实测有效性：指向「只挂连接不响应」的假 registry 时，带 `--fetch-timeout=4000` 约 4.8s 退出，
 * 不带给到 25s 仍未退出（走 pnpm 默认 60s）；仅靠 env 在 pnpm 11 上无效（见 pnpmEnvOverrides 注释）。 */
function pnpmFetchArgs(timeoutMs = 60000, retries = 1) {
  return [`--fetch-timeout=${timeoutMs}`, `--fetch-retries=${retries}`]
}

/** pnpm add 的完整参数（纯函数，单测覆盖）。registry 只在是**非空字符串**时才拼 ——
 * 旧代码无条件拼 `--registry ${registry}`，`git:` 规格那条路传的是 undefined，命令行长成
 * `--registry undefined`（今天恰好还能装，但那是"垃圾参数被忽略"，不是设计）。 */
function pnpmAddArgs(spec, registry, { fetchFlags = true, fetchTimeoutMs = 60000, fetchRetries = 1 } = {}) {
  const args = ['add', spec]
  if (typeof registry === 'string' && registry !== '') args.push('--registry', registry)
  if (fetchFlags) args.push(...pnpmFetchArgs(fetchTimeoutMs, fetchRetries))
  return args
}

/** 该版本 pnpm 不认识我们加的选项（真实文案：`[ERROR] Unknown options: 'fetch-timeout', 'fetch-retries'`）。
 * 加固**绝不能让用户装不上**：调用方看到这个错误就去掉加固选项重试一次（见 runPnpmAdd）。 */
function unknownPnpmOption(message) {
  return /Unknown option/iu.test(String(message ?? ''))
}

/** 跑一次 `pnpm add`（本控制台所有安装通道的唯一入口）—— 2026-09-26 新增。
 * 相对旧的 `runPnpmWithFallback(['add', spec, '--registry', registry], { execOpts })`，只加三样：
 *   ① env 走 buildPnpmEnv（追加 fetch 超时/重试 + CI=true；registry 镜像与禁交互照旧）；
 *   ② 参数走 pnpmAddArgs（追加 `--fetch-timeout/--fetch-retries`：实测 pnpm 11 不读同名 env，只认这两个选项）；
 *   ③ 遇到 `Unknown options` 就去掉加固选项重试一次 —— 加固不允许变成"装不上"。
 * 失败语义不变：真实失败照旧抛出（含 pnpm 原始 stderr），成功不返回值。
 * `deps.run` 只是单测注入口（默认 runPnpmWithFallback），生产调用方不传。 */
async function runPnpmAdd({ profileDir, spec, registry, timeout = 90000, signal = null, deps = {} } = {}) {
  const run = typeof deps.run === 'function' ? deps.run : runPnpmWithFallback
  const execOpts = (ms) => ({
    cwd: profileDir,
    timeout: ms,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: buildPnpmEnv(registry),
    ...(signal ? { signal } : {}),
  })
  try {
    await run(pnpmAddArgs(spec, registry), { execOpts: execOpts(timeout) })
  } catch (error) {
    if (!unknownPnpmOption(error?.message)) throw error
    await run(pnpmAddArgs(spec, registry, { fetchFlags: false }), { execOpts: execOpts(timeout) })
  }
}

/** gh CLI 通道：api.github.com 黑洞期（node:https 全部超时）时的最后兜底。
 * 服务进程 PATH 可能不含 gh（桌面壳环境）：依次尝试 gh、常见安装路径。 */
const GH_BIN_CANDIDATES = [
  'gh',
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
  join(homedir(), 'scoop', 'shims', 'gh.exe'),
]

export { GH_BIN_CANDIDATES, gitEnv, gitBin, processAlive, execFileAsync, resolvePnpmRunners, runPnpmWithFallback, killProcessTree, posixDescendants, execFileWithKillTree, pnpmEnvOverrides, buildPnpmEnv, pnpmFetchArgs, pnpmAddArgs, unknownPnpmOption, runPnpmAdd }