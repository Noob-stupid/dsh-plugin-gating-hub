// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra

import { execFile } from 'node:child_process'
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
 * 界面与测试里都看不到真实原因（CI 的「真装真卸冒烟」就是这么红的：只知道失败、不知道为什么）。 */
async function runPnpmWithFallback(args, { execOpts = {}, runners = resolvePnpmRunners() } = {}) {
  let lastError = null
  const withStderr = (error) => {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    if (stderr === '' && stdout === '') return error
    const detail = [stderr, stdout].filter((s) => s !== '').join(' / ').split(/\r?\n/u).slice(-6).join(' ⏎ ').slice(0, 800)
    return new Error(`${String(error?.message ?? 'pnpm 执行失败')}｜真实输出：${detail}`)
  }
  for (const runner of runners) {
    const { bin, argv } = runner.run(args)
    try {
      // eslint-disable-next-line no-await-in-loop
      await execFileAsync(bin, argv, execOpts)
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
/** gh CLI 通道：api.github.com 黑洞期（node:https 全部超时）时的最后兜底。
 * 服务进程 PATH 可能不含 gh（桌面壳环境）：依次尝试 gh、常见安装路径。 */
const GH_BIN_CANDIDATES = [
  'gh',
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
  join(homedir(), 'scoop', 'shims', 'gh.exe'),
]

export { GH_BIN_CANDIDATES, gitEnv, gitBin, processAlive, execFileAsync, resolvePnpmRunners, runPnpmWithFallback }