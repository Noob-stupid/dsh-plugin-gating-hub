// OS 边界探针（**测试不许弹窗口**的红线取证工具；不是测试套，run-all.mjs 不会收它）
//
// 用法（预载到**每一个** node 进程，早于任何应用模块实例化）：
//   NODE_OPTIONS="--require <repo>/tests/probe-no-spawn.cjs" node tests/run-all.mjs
//   · 日志路径由 DSH_NOSPAWN_LOG 指定（缺省 <cwd>/no-spawn-probe.log，一行一条 JSON）。
//
// 它做什么：在**进程边界**挂钩 node:child_process 的八个入口（spawn/execFile/exec/fork 与其 *Sync 版本）。
//   · 只拦**文件管理器**（explorer.exe / open / xdg-open / …）—— 那正是会在用户桌面弹窗的东西：
//     命中 ⇒ 记一条带调用栈的日志 + **当场抛错**（探针自带"即将真 spawn ⇒ 红"，不依赖被测代码任何标志）；
//   · 其余命令（git / pnpm / node / curl…）原样放行，只计数 —— 探针不是"禁止一切子进程"。
//
// 为什么不用 ESM 命名空间补丁（上一批的死因）：`import * as cp from 'node:child_process'` 之后
// `Object.defineProperty(cp, 'execFile', …)` 会让 `util.promisify(execFile)` 丢掉
// `promisify.custom` 形状 ⇒ 假红（本仓已踩过）。这里改在**模块导出对象**上替换（--require 发生在
// 任何应用模块 import 之前 ⇒ 之后拿到的具名导入就是被包装过的那个），并且**逐符号复制**原函数的
// 全部属性符号（含 `promisify.custom`）⇒ 形状与真实实现一致。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const util = require('node:util')

const LOG = process.env.DSH_NOSPAWN_LOG || path.join(process.cwd(), 'no-spawn-probe.log')

/** 文件管理器可执行名（Windows=explorer.exe；macOS=open；Linux=xdg-open/文件管理器）。 */
const FILE_MANAGER_RE = /^(?:explorer(?:\.exe)?|open|xdg-open|nautilus|dolphin|thunar|pcmanfm|caja|nemo|gio)$/i

/** 从参数里取出"要执行的程序名"：exec/execSync 传的是命令行字符串，其余传 argv[0]。 */
function commandOf(args, name) {
  const first = args[0]
  if (typeof first !== 'string') return ''
  const text = name === 'exec' || name === 'execSync' ? first.trim().split(/\s+/u)[0] : first.trim()
  return String(text ?? '').replace(/^["']|["']$/gu, '')
}

function isFileManager(name, args) {
  const command = commandOf(args, name)
  if (command === '') return false
  const base = command.replace(/\\/gu, '/').split('/').pop()
  return FILE_MANAGER_RE.test(base)
}

function record(entry) {
  const line = `${JSON.stringify(entry)}\n`
  try {
    fs.appendFileSync(LOG, line)
  } catch {}
}

function patch(name) {
  const original = cp[name]
  if (typeof original !== 'function') return false
  const wrapped = function patched(...args) {
    if (isFileManager(name, args)) {
      const error = new Error(`OS 边界探针：拦截文件管理器启动（${name} ${commandOf(args, name)}）—— 测试期间不许真的打开文件管理器`)
      error.code = 'DSH_NO_SPAWN_PROBE'
      record({
        kind: 'blocked', api: name, command: commandOf(args, name), argv: args.slice(1).map((a) => String(a)).slice(0, 6), pid: process.pid, entry: process.argv[1] ?? '',
        stack: String(error.stack ?? '').split('\n').slice(1, 10),
      })
      throw error
    }
    record({ kind: 'pass', api: name, command: commandOf(args, name), pid: process.pid, entry: process.argv[1] ?? '' })
    return original.apply(this, args)
  }
  // 保持函数形状：名称/长度/全部属性符号（含 promisify.custom —— 丢了就是假红）
  for (const symbol of Object.getOwnPropertySymbols(original)) {
    try {
      wrapped[symbol] = original[symbol]
    } catch {}
  }
  try {
    if (original[util.promisify.custom] !== undefined) wrapped[util.promisify.custom] = original[util.promisify.custom]
  } catch {}
  try {
    Object.defineProperty(wrapped, 'name', { value: name, configurable: true })
    Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true })
  } catch {}
  try {
    Object.defineProperty(cp, name, { configurable: true, writable: true, value: wrapped })
  } catch {
    return false
  }
  return true
}

const patched = ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync'].filter((name) => patch(name))
// 形状自检（探针自身的正控）：包装后 `util.promisify(execFile)` 仍必须拿到原实现的 custom 形状。
let shape = { execFileCustomKept: null, promisifyUsable: null }
try {
  shape.execFileCustomKept = cp.execFile[util.promisify.custom] !== undefined
  const fn = util.promisify(cp.execFile)
  shape.promisifyUsable = typeof fn === 'function'
} catch (error) {
  shape.promisifyUsable = String(error?.message ?? error)
}

// ── 出网边界（同一支探针的第二个面：进程 + 网络各收一个 OS 边界）────────────────────────────
// 为什么在 net/tls 这一层：http / https / fetch(undici) 最终都落到 `net.connect` / `tls.connect`，
// 在这里记账才是"真出网"的判据（而不是"调了某个函数"）。**默认只记账**（真网络测试要照常跑）；
// `DSH_PROBE_BLOCK_EGRESS=1` 时非回环目标**当场抛错** —— 离线测试套用它证明"一个真请求都没发"。
const net = require('node:net')
const tls = require('node:tls')
const BLOCK_EGRESS = process.env.DSH_PROBE_BLOCK_EGRESS === '1'
const LOOPBACK = /^(?:127(?:\.\d+){3}|::1|\[::1\]|localhost|0\.0\.0\.0|::)$/i

function hostOf(args) {
  const first = args[0]
  if (typeof first === 'string') return first                 // net.connect(path) —— Unix socket
  if (first !== null && typeof first === 'object') return String(first.host ?? first.hostname ?? first.path ?? '')
  return String(args[1] ?? '')                                // net.connect(port, host)
}

function patchConnect(mod, name) {
  const original = mod[name]
  if (typeof original !== 'function') return false
  const wrapped = function patched(...args) {
    const host = hostOf(args)
    const local = host === '' || LOOPBACK.test(host) || host.startsWith('/') || /^\\\\/u.test(host)
    if (!local) {
      record({ kind: BLOCK_EGRESS ? 'egress-blocked' : 'egress', api: `net.${name}`, host, pid: process.pid, entry: process.argv[1] ?? '', stack: String(new Error().stack ?? '').split('\n').slice(1, 8) })
      if (BLOCK_EGRESS) {
        const error = new Error(`OS 边界探针：拦截真实出网（net.${name} → ${host}）—— DSH_PROBE_BLOCK_EGRESS=1 下只允许回环`)
        error.code = 'DSH_NO_EGRESS_PROBE'
        throw error
      }
    }
    return original.apply(this, args)
  }
  for (const symbol of Object.getOwnPropertySymbols(original)) {
    try {
      wrapped[symbol] = original[symbol]
    } catch {}
  }
  try {
    Object.defineProperty(mod, name, { configurable: true, writable: true, value: wrapped })
  } catch {
    return false
  }
  return true
}

const egressPatched = [
  patchConnect(net, 'connect'),
  net.createConnection === net.connect ? false : patchConnect(net, 'createConnection'),
  patchConnect(tls, 'connect'),
].filter((x) => x === true).length

record({
  kind: 'probe-installed', pid: process.pid, entry: process.argv[1] ?? '', patched, cwd: process.cwd(), shape,
  egressPatched, blockEgress: BLOCK_EGRESS,
})
