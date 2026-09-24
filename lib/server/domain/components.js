// L1 · domain —— components.js（服务器组件：注册表 / 增删改 / 进程启停 / 状态 / 自启动；分层 Step 4 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileAsync, processAlive } from '../infra/exec.js'
import { componentsFile } from '../infra/paths.js'

function findComponents() {
  try {
    const parsed = JSON.parse(readFileSync(componentsFile(), 'utf8'))
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.components) ? parsed.components : [])
  } catch {
    return []
  }
}

function saveComponents(list) {
  mkdirSync(dirname(componentsFile()), { recursive: true })
  writeFileSync(componentsFile(), JSON.stringify(list, null, 2), 'utf8')
}

function compFind(id) {
  return findComponents().find((c) => c.id === id) ?? null
}

/** 组件 UI 地址：显式 uiUrl 优先，否则从 healthUrl 去 /health 或按端口推断。 */
function compUiUrl(c) {
  if (typeof c?.uiUrl === 'string' && c.uiUrl !== '') return c.uiUrl
  if (typeof c?.healthUrl === 'string' && c.healthUrl !== '') return String(c.healthUrl).replace(/\/health$/u, '')
  if (c?.port) return `http://127.0.0.1:${c.port}/`
  return null
}

function compUpsert(record) {
  const list = findComponents()
  const idx = list.findIndex((c) => c.id === record.id)
  if (idx >= 0) list[idx] = { ...list[idx], ...record }
  else list.push(record)
  saveComponents(list)
  return record.id
}

function compRemove(id) {
  saveComponents(findComponents().filter((c) => c.id !== id))
}

/** 组件控制：启动。 */
async function compStart(id) {
  const record = compFind(id)
  if (!record) throw new Error('组件不存在')
  if (record.pid && processAlive(record.pid)) return { started: false, note: '已在运行' }
  if (!record.file || !Array.isArray(record.args)) throw new Error('该组件没有记录启动命令')
  const child = spawn(record.file, record.args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: record.cwd ?? homedir(), shell: false })
  child.unref()
  compUpsert({ id, pid: child.pid })
  return { started: true, pid: child.pid }
}

/** 组件控制：停止。 */
async function compStop(id) {
  const record = compFind(id)
  if (!record) throw new Error('组件不存在')
  if (record.pid) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(record.pid), '/F'], { timeout: 30000, windowsHide: true })
    } catch {}
  }
  compUpsert({ id, pid: null })
  return { stopped: true }
}

/** 组件控制：状态（进程存活 + 健康探测；无 pid 但健康通过按运行中处理）。 */
async function compStatus(id) {
  const record = compFind(id)
  if (!record) throw new Error('组件不存在')
  let healthy = null
  if (record.healthUrl) {
    try {
      const res = await fetch(record.healthUrl, { signal: AbortSignal.timeout(2500) })
      healthy = res.ok
    } catch {
      healthy = false
    }
  }
  const running = Boolean(record.pid && processAlive(record.pid)) || healthy === true
  return { id, name: record.name, running, healthy, pid: record.pid ?? null, port: record.port ?? null, autoStart: record.autoStart === true }
}

/** DSH 启动时自动拉起标记 autoStart 的组件（幂等：已健康/已运行则跳过）。 */
async function autostartComponents() {
  for (const c of findComponents()) {
    if (c.autoStart !== true) continue
    if (c.healthUrl) {
      try {
        const res = await fetch(c.healthUrl, { signal: AbortSignal.timeout(2500) })
        if (res.ok) continue
      } catch {}
    } else if (c.pid && processAlive(c.pid)) {
      continue
    }
    try { await compStart(c.id) } catch {}
  }
}

export { findComponents, saveComponents, compFind, compUiUrl, compUpsert, compRemove, compStart, compStop, compStatus, autostartComponents }
