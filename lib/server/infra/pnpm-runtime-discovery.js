// L0 · infra —— 「本机自带那份 pnpm 在哪」的候选发现（0.5.48 加法；从 exec.js 抽出）
//
// 为什么单开一个模块：exec.js 贴着 tests/test-architecture-guard.mjs 的 **单文件 ≤ 600 行**硬顶，
// 而"从桌面端运行时 / DSH 运行时装 / PATH 里找出那份 pnpm"是自洽的一块只读探测逻辑。
//
// 两类被发现的 pnpm（形态不同，**绝不能混**）：
//   · `desktop-pnpm-mjs`：桌面端（Electron）自带运行时那份。用 **Electron 二进制**跑，
//     必须显式带 `ELECTRON_RUN_AS_NODE=1` —— 不带它，Electron 会当 **GUI 应用**启动
//     （等于弹一个新窗口，而且退出码可能是 0，"假成功"比失败更糟）。
//   · `runtime-pnpm-mjs`：DSH **运行时装**那份（0.5.48 新增）。用普通 **node** 跑，**不带**那个 env。
//
// ★ 为什么必须有 `runtime-pnpm-mjs`（这条就是缺陷②的正解）：
//   原来只有两条线索能找到本机那份 pnpm —— ① Electron 的 `process.resourcesPath`；
//   ② PATH 里的 `<…>\runtime\pnpm\bin` / `<…>\runtime\bin`。**两条都只在桌面端宿主成立**。
//   而控制台的安装动作跑在**普通 node 服务进程**里 ⇒ 两条都没有 ⇒ 落到候选表最前面的
//   `node-corepack` ⇒ 跑 corepack 自己解析出的那版（本机实测 11.21.0），
//   而 profile 的 node_modules 是**声明的那版**建的（`.modules.yaml` 写着 pnpm@11.7.0）
//   ⇒ 版本错配 ⇒ Windows 上 rename 覆盖已存在目录 ⇒ ERR_PNPM_EPERM。
//   本机实据（两份都在，且都是 profile 声明的那版 11.7.0）：
//     · ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm
//     · <桌面端安装目录>/resources/runtime/pnpm
//
// 全部探测只走注入的 `exists`（生产默认值 = 进程事实）；本模块**不 spawn 任何东西**。
//
// 分层：L0 · infra（不得 import domain/routes/index —— tests/test-architecture-guard.mjs 断言②）。

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** PATH 条目里的 `<…>\runtime\pnpm\bin` 形态（桌面端 host 就是把它拼进 profile 的 PATH 的）。 */
const RUNTIME_PNPM_BIN_RE = /[\\/]runtime[\\/]pnpm[\\/]bin[\\/]?$/u
/** PATH 条目里的 `<…>\runtime\bin` 形态（其同级就是 `runtime\pnpm\bin\pnpm.mjs`）。 */
const RUNTIME_BIN_RE = /[\\/]runtime[\\/]bin[\\/]?$/u

/** 桌面端（Electron）自带运行时的 pnpm 入口候选（resourcesPath + PATH 两条线索）。 */
function desktopRuntimeCandidates({ resourcesPath, pathDirs, delimiter }) {
  const out = []
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    out.push(join(resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'))
  }
  void delimiter
  for (const dir of pathDirs) {
    if (RUNTIME_PNPM_BIN_RE.test(dir)) out.push(join(dir, 'pnpm.mjs'))
    else if (RUNTIME_BIN_RE.test(dir)) out.push(join(dirname(dir), 'pnpm', 'bin', 'pnpm.mjs'))
  }
  return out
}

/** DSH 运行时装那份 pnpm 的入口候选（**普通 node 进程也找得到**，0.5.48 新增）。
 * 位置：`<dshHome>/dsh-runtimes/<runtime>/dependencies/pnpm/bin/pnpm.mjs`。
 * `env.DSH_PNPM_HINT` 是显式注入点（单测用，也允许用户指定）。 */
function dshRuntimeCandidates({ env, home = homedir() }) {
  const dshHomeDir = typeof env?.DSH_HOME === 'string' && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : join(home, '.dsh')
  const out = []
  if (typeof env?.DSH_PNPM_HINT === 'string' && env.DSH_PNPM_HINT !== '') out.push(env.DSH_PNPM_HINT)
  for (const rt of ['dsh-primary-runtime', 'dsh-runtime']) {
    out.push(join(dshHomeDir, 'dsh-runtimes', rt, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  }
  return out
}

export { RUNTIME_PNPM_BIN_RE, RUNTIME_BIN_RE, desktopRuntimeCandidates, dshRuntimeCandidates }
