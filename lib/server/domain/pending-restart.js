// L1 · domain —— 「已安装·待重启」的**持久化**（0.5.70 加法）
//
// 用户 2026-10-18：「那个重启后生效徽章你不是有吗…memory 插件不就是这样的吗之前」
//   —— 徽章确实早就有（revoke.js#pendingRestartJobs），但它的数据源是**内存里的 installJobs**，
//   宿主一重启就清空 ⇒ 更新完插件、重启一次之后，徽章连同那条记录一起消失，插件看起来"没了"。
//   实测：installJobs=0 / pendingRestart=0 / recentFailures=0，而包其实已经更新成功（0.7.2 → 0.7.8）。
//
// 本模块把"待重启"落成一份**小文件**（按包名），于是它能活过重启：
//   · 写入：/state 计算时，若某条 done 作业的包**不在运行中的 entries**，就记下来（仅在集合变化时写盘）；
//   · 读取：重启后从文件里读回来，仍然显示徽章；
//   · 清除：一旦该包出现在 entries 里（说明已经加载生效），自动从文件里删掉 —— 不留陈旧记录。
//
// 严格只读原则的例外说明：这里确实写盘，但写的是**控制台自己的状态文件**（不是 profile、不是 lock），
// 且只在集合变化时写一次；任何异常都不抛出，降级为"没有持久记录"（徽章退化到旧行为，不比现在更差）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'

const PENDING_RESTART_FILE = 'pending-restart.json'

function pendingRestartPath(home = undefined) {
  return join(home ?? dshHome(), 'plugin-console', PENDING_RESTART_FILE)
}

const readJsonSafe = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 读持久记录 → [{ packageName, version, at }]（读不到/坏文件 = 空数组）。 */
function readPendingRestart({ home = undefined } = {}) {
  const value = readJsonSafe(pendingRestartPath(home))
  const list = value !== null && typeof value === 'object' && Array.isArray(value.items) ? value.items : []
  return list
    .filter((x) => x !== null && x !== undefined && typeof x.packageName === 'string' && x.packageName !== '')
    .map((x) => ({ packageName: x.packageName, version: typeof x.version === 'string' ? x.version : null, at: Number.isFinite(Number(x.at)) ? Number(x.at) : null }))
}

/**
 * 把当前"待重启"集合写穿到文件（**集合不变就不写盘**）。
 * @returns {{ changed: boolean, items: Array }}
 */
function syncPendingRestart(items, { home = undefined } = {}) {
  const next = (Array.isArray(items) ? items : [])
    .filter((x) => x !== null && x !== undefined && typeof x.packageName === 'string' && x.packageName !== '')
    .map((x) => ({ packageName: x.packageName, version: typeof x.version === 'string' ? x.version : null, at: Number.isFinite(Number(x.at)) ? Number(x.at) : Date.now() }))
  const prev = readPendingRestart({ home })
  const key = (list) => list.map((x) => `${x.packageName}@${x.version ?? '?'}`).sort().join('|')
  if (key(prev) === key(next)) return { changed: false, items: prev }
  try {
    const file = pendingRestartPath(home)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ items: next }, null, 2)}\n`, 'utf8')
    return { changed: true, items: next }
  } catch {
    // 写不进去就如实退化：本次仍返回新集合（界面照常显示），只是活不过重启
    return { changed: false, items: next, writeError: true }
  }
}

/**
 * 合并：内存里刚判定的待重启 + 文件里历史遗留的（**已经在 entries 里出现过的一律丢弃**）。
 * @param {Array} fresh 内存判定结果（pendingRestartJobs 的输出）
 * @param {Set<string>} liveNames 当前运行中的包名集合
 */
function mergePendingRestart(fresh, liveNames, { home = undefined } = {}) {
  const live = liveNames instanceof Set ? liveNames : new Set()
  const persisted = readPendingRestart({ home }).filter((x) => !live.has(x.packageName))
  const merged = new Map()
  for (const x of persisted) merged.set(x.packageName, { packageName: x.packageName, version: x.version ?? null, at: x.at ?? null, persisted: true })
  for (const x of Array.isArray(fresh) ? fresh : []) {
    if (live.has(x.packageName)) continue
    merged.set(x.packageName, { ...x, at: Date.now(), persisted: false })
  }
  const items = [...merged.values()]
  // 写穿：把"合并后的待重启集合"作为新基线（集合不变则不写盘）
  syncPendingRestart(items.map((x) => ({ packageName: x.packageName, version: x.version ?? null, at: x.at ?? null })), { home })
  return items
}

export { PENDING_RESTART_FILE, pendingRestartPath, readPendingRestart, syncPendingRestart, mergePendingRestart }
