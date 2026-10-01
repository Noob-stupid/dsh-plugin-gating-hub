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
//   · `classifyTopLevel`      → 哪些顶层真实目录属于"旧版本残留"（同版本/链接/备份一律不动 —— 宁可少动）
//   · `planBackupRetention`   → 保留「回滚点那一条 ∪ 最近 N 条」，其余进删除清单 + 可释放字节
//   · `relinkTargetCandidates` → 改名之后该把 junction 指回哪里（多基准候选，按优先级）
//   · `isStaleBackupName`     → 备份目录名判据（幂等：备份绝不能再被当成残留改名）
//
// 行数预算：独立模块，留在 600 行架构硬顶内。

import { join } from 'node:path'

/**
 * `.stale-*` 备份目录名判据（**幂等必需**）。
 *
 * 动作层把旧目录改名成 `<name>.stale-<version>-<ts>`；那些备份里**还带着 package.json**
 * （version = 被备份的那个版本），所以不排除的话：
 *   第二次运行 → 备份自己又被判成"旧版本残留" → 改成 `<...>.stale-<v>-<ts2>`（越堆越深），
 *   而且会给这个根本不存在的名字建 junction。旧行为正是如此（真机 `cordis.stale-4.0.4-<ts>` 一眼可见）。
 * 误判方向是**保守**的：真有一个叫 `foo.stale-bar` 的包时我们只会"不动它"，不做危险动作。
 */
const STALE_BACKUP_RE = /\.stale-/u
function isStaleBackupName(name) {
  return typeof name === 'string' && STALE_BACKUP_RE.test(name)
}

/**
 * 框架**启动关键包**（相对 scope 目录名）：整批改名结束后必须仍能解析，否则全量回滚。
 * 这两个就是 2026-10-01 停机事故现场：`dsh-app-boot` 顶层 `import '@deepseek-ai/cordis'` 解析不到
 * ⇒ web 服务进程 exit code=1。判据只认"能解析"这件事，与版本号无关。
 */
const FRAMEWORK_BOOT_PACKAGES = ['cordis', 'dsh-app-boot']

/**
 * 顶层条目分类（纯函数）。
 * `entries` 形如 `[{ name, version, isLink, sizeBytes }]`；`isLink` 为真表示已被 junction/符号链接接管。
 * **保守取舍**：同版本保留；缺版本（读不到 package.json）保留并单列；`.stale-*` 备份一律不碰 —— 判不准就不动。
 */
function classifyTopLevel(entries, { runningVersion = null } = {}) {
  const stale = []
  const sameVersion = []
  const missingVersion = []
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name === '') continue
    if (entry.name.startsWith('.')) continue
    if (entry.isLink === true) continue
    if (isStaleBackupName(entry.name)) continue // 备份（含备份的备份）永不参与判断 —— 见 isStaleBackupName
    const version = entry.version === undefined || entry.version === null ? '' : String(entry.version)
    if (version === '') { missingVersion.push({ name: entry.name, sizeBytes: entry.sizeBytes ?? null }); continue }
    if (runningVersion !== null && version === String(runningVersion)) { sameVersion.push({ name: entry.name, version }); continue }
    stale.push({ name: entry.name, version, sizeBytes: entry.sizeBytes ?? null })
  }
  return { stale, sameVersion, missingVersion }
}

/**
 * 改名之后 junction 该指向哪里（纯函数：只**列候选**，存不存在由动作层问 IO）。
 *
 * 多基准（真机实证：2026-10-01 事故里 `dsh` 顶层是**真实目录**而不是 junction，
 * 老判据只从 `dsh` junction 推运行树 → `runningScopeDir = null` → 10 条包全部"只改名、没重建"）：
 *   ① `runningScopeDir/<name>` —— `dsh` 是 junction 时的运行树同级目录（老语义，保留）
 *   ② `<fwRoot>/.pnpm/node_modules/<scope>/<name>` —— pnpm store 的 hoisted 投影
 *      （真机 10 条手工补回的 junction 指的正是这里，逐条读过 Target）
 *   ③ `<fwRoot>/.pnpm/node_modules/<name>` —— 非作用域名的同款投影（防御性兜底）
 * 顺序即优先级：先运行树（框架自己正在用的那份），再 store 投影。返回 `[{ path, via }]`。
 */
function relinkTargetCandidates({ runningScopeDir = null, storeHoistDir = null, scopeName = null, name = null } = {}) {
  if (typeof name !== 'string' || name === '') return []
  const out = []
  if (typeof runningScopeDir === 'string' && runningScopeDir !== '') out.push({ path: join(runningScopeDir, name), via: 'running-scope' })
  if (typeof storeHoistDir === 'string' && storeHoistDir !== '') {
    if (typeof scopeName === 'string' && scopeName !== '') out.push({ path: join(storeHoistDir, scopeName, name), via: 'pnpm-hoist' })
    out.push({ path: join(storeHoistDir, name), via: 'pnpm-hoist-flat' })
  }
  const seen = new Set()
  return out.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)))
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

export { FRAMEWORK_BOOT_PACKAGES, classifyTopLevel, isStaleBackupName, planBackupRetention, relinkTargetCandidates }