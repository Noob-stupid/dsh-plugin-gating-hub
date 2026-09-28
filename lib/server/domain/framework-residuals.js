// L1 · domain —— framework-residuals.js（框架树残留判据 + 备份保留策略；0.5.30 加法）
//
// 真机背景（2026-09-28）：
//   ① 框架树顶层 `@deepseek-ai/` 有 **239 个非 junction 的真实目录**，其中 230 个还停在
//      0.1.5-rc.2（npm 时代残留）：`dsh` 一个被 junction 到 0.2.0-rc.1 → 于是"从顶层解析"与
//      "从运行树解析"会拿到**不同版本**（9/10 桌面端扫描错配、9/24 schemastery 3.18.1 漂移同族）。
//   ② `~/.dsh/plugin-console/framework-backups` 堆了 12 条 fw-tree 快照（约 5.1 GB），
//      而回滚只需要**回滚点引用的那一条** + **最近 N 条**。
//
// 本模块只做纯判据（IO 全由调用方注入），动作在 routes/plugins.js 的 clean-residuals scope 里：
//   · `classifyTopLevel`      → 哪些顶层真实目录属于"旧版本残留"（同版本/链接一律不动 —— 宁可少动）
//   · `planBackupRetention`   → 保留「回滚点那一条 ∪ 最近 N 条」，其余进删除清单 + 可释放字节
//
// 行数预算：独立模块，留在 600 行架构硬顶内。

/**
 * 顶层条目分类（纯函数）。
 * `entries` 形如 `[{ name, version, isLink, sizeBytes }]`；`isLink` 为真表示已被 junction/符号链接接管。
 * **保守取舍**：同版本保留；缺版本（读不到 package.json）保留并单列 —— 判不准就不动。
 */
function classifyTopLevel(entries, { runningVersion = null } = {}) {
  const stale = []
  const sameVersion = []
  const missingVersion = []
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name === '') continue
    if (entry.name.startsWith('.')) continue
    if (entry.isLink === true) continue
    const version = entry.version === undefined || entry.version === null ? '' : String(entry.version)
    if (version === '') { missingVersion.push({ name: entry.name, sizeBytes: entry.sizeBytes ?? null }); continue }
    if (runningVersion !== null && version === String(runningVersion)) { sameVersion.push({ name: entry.name, version }); continue }
    stale.push({ name: entry.name, version, sizeBytes: entry.sizeBytes ?? null })
  }
  return { stale, sameVersion, missingVersion }
}

/**
 * 备份保留策略（纯函数）：保留集合 = 「回滚点引用的路径」∪「按 mtime 最近的 N 条」。
 * `keep` 非法/缺失时按 1 处理（最小保留）。返回 `{ kept, remove, freedBytes }`，
 * `kept` 每条带 `reason: 'rollback-point' | 'recent'`（面板要说清为什么留）。
 */
function planBackupRetention(snapshots, { referenced = [], keep = 1 } = {}) {
  const keepCount = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 1
  const pinned = new Set((Array.isArray(referenced) ? referenced : []).filter((p) => typeof p === 'string' && p !== ''))
  const list = (Array.isArray(snapshots) ? snapshots : [])
    .filter((s) => s !== null && typeof s === 'object' && typeof s.path === 'string' && s.path !== '')
    .sort((a, b) => (Number.isFinite(b.mtimeMs) ? b.mtimeMs : 0) - (Number.isFinite(a.mtimeMs) ? a.mtimeMs : 0))
  const kept = []
  const remove = []
  list.forEach((snap, index) => {
    if (pinned.has(snap.path)) { kept.push({ ...snap, reason: 'rollback-point' }); return }
    if (index < keepCount) { kept.push({ ...snap, reason: 'recent' }); return }
    remove.push(snap)
  })
  const freedBytes = remove.reduce((sum, snap) => sum + (Number.isFinite(snap.sizeBytes) ? snap.sizeBytes : 0), 0)
  return { kept, remove, freedBytes }
}

export { classifyTopLevel, planBackupRetention }