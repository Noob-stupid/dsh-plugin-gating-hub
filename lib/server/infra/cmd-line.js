// L0 · infra —— cmd.exe 命令行拼装（0.5.48 从 exec.js 抽出：本文件贴着
// tests/test-architecture-guard.mjs 的"单文件 ≤ 600 行"硬顶；**只搬移，不改逻辑**）。
//
// 为什么 Windows 上要这么绕（2026-09-27 改错，桌面端实例"所有 pnpm 操作都跑不了"的两处根因之一）：
//   旧代码是 `['corepack','pnpm',...args].map((a) => JSON.stringify(a)).join(' ')` —— JSON.stringify
//   加的是**真引号**，而这一整串又是作为一个 argv 元素交给 Node 的 spawn；Windows 上 Node/libuv 按
//   MSVCRT 规则把参数里的 `"` 转义成 `\"`，cmd 实际收到 `\"corepack\" \"pnpm\"`
//   → `'\"corepack\"' 不是内部或外部命令`。
//   本机对着一个只回显参数的 .cmd 实测三种形态：
//     · `"a" "b"`   + 默认转义            → 收到 `\"a\" \"b\"` → 失败（旧缺陷）
//     · `"a" "b"`   + windowsVerbatimArguments → `/s` 会把首尾两个引号一起剥掉 → 也失败
//     · `""a" "b""` + windowsVerbatimArguments → 正确解析成两个参数 ✓
//   所以本模块产出的是"**内层**命令字符串"（形如 `corepack pnpm add x`，**永不含 `\"`**），
//   最外层那对引号由 cmdShellArgv 负责加。
//
// 已知边界（如实记，不假装覆盖）：`%VAR%` 与开启延迟展开时的 `!VAR!` 是 cmd 自己的展开，
//   **任何引号/`^` 都挡不住**；我们生成的 argv（包名、registry、布尔选项、绝对路径）不含这两个字符，
//   真出现时该通道会失败并如实报错（不会静默跑成别的命令）。
//
// 分层：L0 · infra（不得 import domain/routes/index —— tests/test-architecture-guard.mjs 断言②）。

/** cmd.exe 的元字符：`^` 是 cmd 自己的转义符（**引号内照样生效** —— 本机实测 `"a^b"` 到程序手里变成 `ab`），
 *  `& | < > ( )` 在引号内**仍然是 cmd 的操作符**（实测 `"a&b"` 会在 `&` 处断开，把 `b` 当命令执行）。
 *  所以段内这些字符必须逐个加 `^` 转义。 */
const CMD_META_RE = /[\^&|<>()]/gu

/** 把一串命令段拼成**一条 cmd.exe 命令字符串**（纯函数，导出给单测）。
 *  2026-09-28 改错（真机：`cmd-corepack` 一条都跑不动 → pnpm-runners / suite-fallback /
 *  install-smoke 三套红，报 `cmd-corepack :: status=1 out=""`）：
 *    `corepack` 在 Windows 上常是 **cmd 批处理 shim**（`<node 安装目录>\corepack.cmd` →
 *    `node …\corepack\dist\corepack.js %*`）。对批处理，cmd **不会剥掉参数外层的引号**，
 *    引号会随 `%*` 一路进到 node 的 argv —— 于是 corepack 收到的是 `"pnpm"` / `"--version"`
 *    （带引号当成了包管理器名）→ 直接崩：status=1、stdout 空。真 cmd.exe 实测：
 *      · `""corepack" "pnpm" "--version""` → status=1、stdout=""（旧形态，坏）
 *      · `"corepack pnpm --version"`      → status=0、stdout="11.21.0"（按需引号，好）
 *    所以**只为含空白的段加引号**；其余裸串 + `^` 转义 cmd 元字符。
 *  只有「干净 token」（无空白、无 cmd 元字符）能去引号：含 `& | < > ( ) ^` 的段，实测
 *  **裸串 + `^` 转义会失效**（真机 ⑥：裸的 `a^&b` 被 cmd 当分隔符断开，收到 `[a`），
 *  必须沿用「引号 + 段内 ^」的既有形态。 */
function cmdCommandLine(parts) {
  return parts
    .map((part) => String(part))
    .map((text) => {
      const clean = !/[\s]/u.test(text) && !/[\^&|<>()]/u.test(text)
      if (clean) return text
      return `"${text.replace(CMD_META_RE, (ch) => `^${ch}`)}"`
    })
    .join(' ')
}

/** corepack 形态的命令字符串（纯函数，导出给单测断言"不含 `\"` 转义"）。 */
function cmdCorepackCommand(args) {
  return cmdCommandLine(['corepack', 'pnpm', ...args])
}

/** 交给 cmd.exe 的完整 argv（`/d /s /c` + **整条再包一层引号**的内层命令字符串）。
 *  必须与 `verbatim: true`（windowsVerbatimArguments）配套：Node 不再做任何引号转义，
 *  cmd 的 `/s` 剥掉最外层那一对，剩下的正好是我们要的命令行。 */
function cmdShellArgv(commandLine) {
  return ['/d', '/s', '/c', `"${commandLine}"`]
}

export { CMD_META_RE, cmdCommandLine, cmdCorepackCommand, cmdShellArgv }
