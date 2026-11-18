// L1 · domain —— auto-preflight-child.js（把同步预检放进子进程，带硬超时；0.5.111 加法）
//
// 真机 2026-11-17：自动预检同步扫描阻塞宿主事件循环 5469ms，4s 超时无法打断。
// 本模块只做「起子进程 → 喂输入 → 收一行 marker → 超时杀」；判据仍在 auto-preflight-run.js。
//
// 硬约束：
//   · **绝不阻塞调用方**：返回 Promise；调用方（routes/compat.js）本来就不 await 它；
//   · **硬超时**：到点 `SIGKILL`，不等协作式取消（同步代码没有取消点）；
//   · 子进程只读、不联网（input.networkAllowed 仍由调用方给 false）；
//   · 找不到 node 时如实失败，不静默退回主线程（否则又卡回宿主）。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pluginRoot } from '../infra/paths.js'

// 不用 import.meta.url 算包根（架构守卫只允许 infra/paths.js 这么做）。
const WORKER = join(pluginRoot(), 'lib', 'server', 'domain', 'auto-preflight-worker.js')
const MARKER = '__DSH_PREFLIGHT__'
const DEFAULT_CHILD_TIMEOUT_MS = 15000
const MAX_OUTPUT = 8 * 1024 * 1024

/**
 * 找 Node 可执行文件：桌面端宿主是 Electron，`process.execPath` 不是 node。
 * 顺序：DSH_NODE_BIN → execPath 本身是 node → resources/runtime/.../node → execPath
 * （最后一种配 ELECTRON_RUN_AS_NODE=1 由 Electron 以 Node 模式跑）。
 */
function resolveNodeBinary({ env = process.env, execPath = process.execPath, resourcesPath = process.resourcesPath } = {}) {
  const fromEnv = typeof env?.DSH_NODE_BIN === 'string' ? env.DSH_NODE_BIN.trim() : ''
  if (fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  const base = basename(String(execPath ?? '')).toLowerCase()
  if (/^node(?:\.exe)?$/u.test(base)) return execPath
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    const candidates = [
      join(resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
      join(resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node'),
    ]
    for (const candidate of candidates) if (existsSync(candidate)) return candidate
  }
  return execPath
}

/**
 * 在子进程跑一次扫描。
 * @param {object} input 与 runAutoPreflightScan 相同的输入
 * @param {object} [deps]
 * @param {number} [deps.timeoutMs] 硬超时（默认 15s）
 * @param {string} [deps.execPath] 测试注入的 node 路径
 * @param {string} [deps.workerPath] 测试注入的 worker 脚本
 * @param {Function} [deps.spawnImpl] 测试注入的 spawn
 * @returns {Promise<object>} 扫描结果；失败时 `{ok:false,state:'timeout'|'failed',reason}`
 */
function runAutoPreflightScanInChild(input = {}, deps = {}) {
  const timeoutMs = Number.isFinite(Number(deps.timeoutMs)) && Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : DEFAULT_CHILD_TIMEOUT_MS
  const execPath = typeof deps.execPath === 'string' && deps.execPath !== '' ? deps.execPath : resolveNodeBinary(deps)
  const workerPath = typeof deps.workerPath === 'string' && deps.workerPath !== '' ? deps.workerPath : WORKER
  const spawnImpl = typeof deps.spawnImpl === 'function' ? deps.spawnImpl : spawn
  return new Promise((resolve) => {
    let child = null
    let timer = null
    let settled = false
    let timedOut = false
    let out = ''
    let err = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      resolve(value)
    }
    try {
      child = spawnImpl(execPath, [workerPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_AUTO_PREFLIGHT_WORKER: '1' },
      })
    } catch (error) {
      finish({ ok: false, state: 'failed', reason: `无法启动自动预检子进程：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
      finish({ ok: false, state: 'timeout', reason: `自动预检子进程超过 ${timeoutMs}ms 未完成（已硬终止；未阻塞状态查询）` })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
      if (out.length > MAX_OUTPUT) out = out.slice(-MAX_OUTPUT)
    })
    child.stderr?.on('data', (chunk) => {
      err += String(chunk)
      if (err.length > MAX_OUTPUT) err = err.slice(-MAX_OUTPUT)
    })
    child.on('error', (error) => finish({ ok: false, state: 'failed', reason: `自动预检子进程错误：${error instanceof Error ? error.message : String(error)}` }))
    child.on('close', (code) => {
      if (timedOut) return
      const at = out.lastIndexOf(MARKER)
      if (at < 0) {
        finish({ ok: false, state: 'failed', reason: `自动预检子进程未产出结论（exit ${code ?? '?'}）${err === '' ? '' : `：${err.slice(0, 500)}`}` })
        return
      }
      const line = out.slice(at + MARKER.length).split('\n')[0].trim()
      try {
        const value = JSON.parse(line)
        finish(value !== null && typeof value === 'object' ? value : { ok: false, state: 'failed', reason: '自动预检子进程返回了非对象结论' })
      } catch (error) {
        finish({ ok: false, state: 'failed', reason: `自动预检子进程结论不是合法 JSON：${error instanceof Error ? error.message : String(error)}` })
      }
    })
    try {
      child.stdin?.end(JSON.stringify(input ?? {}))
    } catch (error) {
      finish({ ok: false, state: 'failed', reason: `写入自动预检输入失败：${error instanceof Error ? error.message : String(error)}` })
    }
  })
}

export { DEFAULT_CHILD_TIMEOUT_MS, MARKER, WORKER, resolveNodeBinary, runAutoPreflightScanInChild }
