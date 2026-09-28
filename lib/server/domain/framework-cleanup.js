// L1 · domain —— framework-cleanup.js（框架树残留的**动作**层：顶层版本漂移 / 框架备份保留；0.5.30 加法）
//
// 判据在 domain/framework-residuals.js（纯函数）；这里只负责「读现场 → 执行 → 如实回报」。
// 真机背景见该模块头注释（顶层 239 个 0.1.5-rc.2 真实目录；framework-backups 12 条快照约 5.1 GB）。
//
// 三条安全约定（对齐仓库既有纪律）：
//   ① **一律先改名备份**：顶层旧目录 → `<name>.stale-<ver>-<ts>`，绝不直接删（可回滚）。
//   ② 重建 junction 只在**目标确实存在**时做：目标从 `dsh` junction 的同级目录推（运行树的真实位置）；
//      推不到或目标不存在就只改名，并如实记进 `relinkSkipped`（不假装成功）。
//   ③ 框架备份只删 `fw-tree/<ts>` 目录，**绝不碰** `dsh-package-backup` 与目录下的快照文件。

import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { removeDirVerifiedAsync } from '../infra/fsx.js'
import { dshHome, resolvePackageJson } from '../infra/paths.js'
import { classifyTopLevel, planBackupRetention } from './framework-residuals.js'

/** 目录体积（失败返回 0；只用于报告「能释放多少」）。 */
function dirSizeBytes(dir) {
  let total = 0
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(d, entry.name)
      try {
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) total += statSync(full).size
      } catch {}
    }
  }
  walk(dir)
  return total
}

/** 是不是链接（Windows 的 junction 在 dirent 上不一定报 symbolic link → readlink 兜底）。 */
function isLinkEntry(full, dirent, readLink = readlinkSync) {
  try { if (dirent.isSymbolicLink()) return true } catch {}
  try { readLink(full); return true } catch { return false }
}

/**
 * A 档：顶层投影里的旧版本真实目录 → 改名备份（+ 可选重建 junction）。
 * `topScopeDir` = `<frameworkRoot>/node_modules/@deepseek-ai`；`dshLinkPath` = 同目录下的 `dsh`（运行树入口）。
 */
async function cleanFrameworkTopLevel({ topScopeDir, dshLinkPath = null, runningVersion = null, relink = true, dryRun = false, stamp = null, deps = {} } = {}) {
  const {
    exists = existsSync, readdir = readdirSync, readText = (f) => readFileSync(f, 'utf8'),
    rename = renameSync, link = symlinkSync, readLink = readlinkSync,
  } = deps
  if (topScopeDir === null || topScopeDir === undefined || !exists(topScopeDir)) {
    return { ok: false, error: '框架顶层目录不存在（拿不到 @deepseek-ai/* 的真实位置）', renamed: [], relinked: [], relinkSkipped: [], failed: [] }
  }
  const entries = []
  for (const dirent of readdir(topScopeDir, { withFileTypes: true })) {
    const full = join(topScopeDir, dirent.name)
    let version = null
    try { version = JSON.parse(readText(join(full, 'package.json'))).version ?? null } catch { version = null }
    entries.push({
      name: dirent.name,
      version,
      isLink: isLinkEntry(full, dirent, readLink),
      sizeBytes: dirSizeBytes(full),
    })
  }
  const classified = classifyTopLevel(entries, { runningVersion })
  const runningScopeDir = (() => {
    if (dshLinkPath === null) return null
    try { return dirname(readLink(dshLinkPath)) } catch { return null }
  })()
  const ts = stamp === null ? String(Date.now()) : String(stamp)
  const renamed = []
  const relinked = []
  const relinkSkipped = []
  const failed = []
  for (const item of (dryRun === true ? [] : classified.stale)) {
    const backupName = item.name + '.stale-' + item.version + '-' + ts
    try {
      rename(join(topScopeDir, item.name), join(topScopeDir, backupName))
    } catch (error) {
      failed.push({ name: item.name, error: String(error?.message ?? error) })
      continue
    }
    renamed.push({ name: item.name, version: item.version, backup: backupName, sizeBytes: item.sizeBytes ?? null })
    if (relink !== true) { relinkSkipped.push({ name: item.name, reason: 'relink-off' }); continue }
    if (runningScopeDir === null) { relinkSkipped.push({ name: item.name, reason: 'no-running-scope' }); continue }
    const target = join(runningScopeDir, item.name)
    let targetExists = false
    try { targetExists = exists(target) } catch { targetExists = false }
    if (!targetExists) { relinkSkipped.push({ name: item.name, reason: 'target-missing' }); continue }
    try {
      link(target, join(topScopeDir, item.name), 'junction')
      relinked.push({ name: item.name, target })
    } catch (error) {
      failed.push({ name: item.name, error: '已改名但重建链接失败：' + String(error?.message ?? error) })
    }
  }
  return {
    ok: failed.length === 0,
    renamed,
    relinked,
    relinkSkipped,
    failed,
    staleCount: classified.stale.length,
    sameVersionCount: classified.sameVersion.length,
    missingVersion: classified.missingVersion,
    dryRun,
    planned: classified.stale.map((s) => ({ name: s.name, version: s.version, sizeBytes: s.sizeBytes ?? null })),
  }
}

/**
 * C 档：`framework-backups/<版本>/fw-tree/<ts>` 快照按「回滚点那条 ∪ 最近 N 条」保留，其余删除。
 * 只删 fw-tree 快照目录；`dsh-package-backup` 与目录下的快照文件一律不碰。
 */
async function cleanFrameworkBackups({ backupsRoot, referenced = [], keep = 1, dryRun = false, deps = {} } = {}) {
  const { exists = existsSync, readdir = readdirSync, stat = statSync, remove = removeDirVerifiedAsync, sizeOf = dirSizeBytes } = deps
  if (backupsRoot === null || backupsRoot === undefined || !exists(backupsRoot)) {
    return { ok: false, error: '没有框架备份目录（无需清理）', snapshots: 0, kept: [], removed: [], failed: [], freedBytes: 0 }
  }
  const snapshots = []
  for (const versionDir of readdir(backupsRoot, { withFileTypes: true })) {
    if (!versionDir.isDirectory()) continue
    const fwTree = join(backupsRoot, versionDir.name, 'fw-tree')
    if (!exists(fwTree)) continue
    for (const snap of readdir(fwTree, { withFileTypes: true })) {
      if (!snap.isDirectory()) continue
      const full = join(fwTree, snap.name)
      let mtimeMs = 0
      try { mtimeMs = stat(full).mtimeMs } catch { mtimeMs = 0 }
      let sizeBytes = 0
      try { sizeBytes = sizeOf(full) } catch { sizeBytes = 0 }
      snapshots.push({ path: full, version: versionDir.name, id: snap.name, mtimeMs, sizeBytes })
    }
  }
  const plan = planBackupRetention(snapshots, { referenced, keep })
  const removed = []
  const failed = []
  for (const snap of (dryRun === true ? [] : plan.remove)) {
    try {
      const res = await remove(snap.path)
      if (res !== null && res !== undefined && res.ok === false) failed.push({ path: snap.path, error: res.error ?? '删除失败' })
      else removed.push({ path: snap.path, sizeBytes: snap.sizeBytes ?? 0 })
    } catch (error) {
      failed.push({ path: snap.path, error: String(error?.message ?? error) })
    }
  }
  const freedBytes = removed.reduce((sum, item) => sum + (Number.isFinite(item.sizeBytes) ? item.sizeBytes : 0), 0)
  return {
    ok: failed.length === 0,
    snapshots: snapshots.length,
    kept: plan.kept.map((s) => ({ path: s.path, reason: s.reason, sizeBytes: s.sizeBytes ?? 0 })),
    removed,
    failed,
    freedBytes,
    dryRun,
    plannedRemove: plan.remove.map((s) => ({ path: s.path, version: s.version, sizeBytes: s.sizeBytes ?? 0 })),
  }
}

/**
 * B 档（**只报告，不删**）：`.pnpm` 里版本 ≠ 运行版本的框架包实体。
 * 手删 `.pnpm` 会让 lockfile 与实际不一致（真机教训：9/24 一个 package.json 缺失 → framework.version=null），
 * 所以这里只点名 + 给建议（用 pnpm 自己同步），不提供删除。
 */
function reportFrameworkEntities({ pnpmDir, runningVersion = null } = {}) {
  if (pnpmDir === null || pnpmDir === undefined || !existsSync(pnpmDir)) {
    return { ok: false, error: '拿不到 .pnpm 目录', groups: [], entityCount: 0 }
  }
  const groups = new Map()
  for (const dirent of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const m = dirent.name.match(/^@deepseek-ai\+dsh(?:-[a-z0-9]+)*@(\d+\.\d+\.\d+[^_]*)_/u)
    if (m === null) continue
    const version = m[1]
    if (runningVersion !== null && version === String(runningVersion)) continue
    if (!groups.has(version)) groups.set(version, [])
    groups.get(version).push(dirent.name)
  }
  const out = [...groups.entries()]
    .map(([version, names]) => ({ version, count: names.length, sample: names.slice(0, 3) }))
    .sort((a, b) => a.version.localeCompare(b.version))
  return {
    ok: true,
    groups: out,
    entityCount: out.reduce((sum, g) => sum + g.count, 0),
    hint: '这些是历史版本的虚拟 store 实体；建议用 pnpm 自己同步（在该框架根跑 pnpm install），不要手删目录',
  }
}


/** 框架布局推导（compat.js 同款取法）：找「含 .pnpm 的那层 node_modules」= 顶层投影目录。
 *  返回 { fwRoot, topScopeDir, dshLinkPath, pnpmDir } —— 顶层 239 个旧真实目录就在 topScopeDir 下。 */
function resolveFrameworkLayout({ baseDir, profileDir, deps = {} } = {}) {
  const { exists = existsSync, resolvePkg = resolvePackageJson } = deps
  let fwRoot = null
  try {
    const pkgPath = resolvePkg('@deepseek-ai/dsh', baseDir, profileDir)
    if (pkgPath !== null && pkgPath !== undefined) {
      let dir = dirname(dirname(pkgPath))
      for (let i = 0; i < 6; i += 1) {
        if (exists(join(dir, '.pnpm'))) { fwRoot = dir; break }
        const up = dirname(dir)
        if (up === dir) break
        dir = up
      }
    }
  } catch {}
  return {
    fwRoot,
    topScopeDir: fwRoot === null ? null : join(fwRoot, '@deepseek-ai'),
    dshLinkPath: fwRoot === null ? null : join(fwRoot, '@deepseek-ai', 'dsh'),
    pnpmDir: fwRoot === null ? null : join(fwRoot, '.pnpm'),
  }
}

/** 回滚点引用的路径（framework-rollback.json 的 checkpointDir / cliBackupDir）—— 这些永远不删。 */
function readRollbackReferenced({ home = undefined, deps = {} } = {}) {
  const { readText = (p) => readFileSync(p, 'utf8'), base = dshHome() } = deps
  try {
    const raw = JSON.parse(readText(join(home ?? base, 'plugin-console', 'framework-rollback.json')))
    return [raw?.checkpointDir, raw?.cliBackupDir].filter((p) => typeof p === 'string' && p !== '')
  } catch { return [] }
}
export { cleanFrameworkBackups, cleanFrameworkTopLevel, dirSizeBytes, isLinkEntry, readRollbackReferenced, reportFrameworkEntities, resolveFrameworkLayout }