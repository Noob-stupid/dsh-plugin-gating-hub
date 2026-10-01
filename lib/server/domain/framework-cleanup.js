// L1 · domain —— framework-cleanup.js（框架树残留的**动作**层：顶层版本漂移 / 框架备份保留；0.5.30 加法）
//
// 判据在 domain/framework-residuals.js（纯函数）；这里只负责「读现场 → 执行 → 如实回报」。
// 真机背景见该模块头注释（顶层 239 个 0.1.5-rc.2 真实目录；framework-backups 12 条快照约 5.1 GB）。
//
// 三条安全约定（对齐仓库既有纪律）：
//   ① **一律先改名备份**：顶层旧目录 → `<name>.stale-<ver>-<ts>`，绝不直接删（可回滚）。
//   ② 改名与重建 junction **原子化**（0.5.34 改错，见下）；重建失败 → 立刻把改名改回去。
//   ③ 框架备份只删 `fw-tree/<ts>` 目录，**绝不碰** `dsh-package-backup` 与目录下的快照文件。
//
// ── 0.5.34 改错（**真机停机事故 2026-10-01**：web 服务进程 exit code=1，起不来）──────────────
// 现场：框架树顶层 `@deepseek-ai/cordis` 被改名成 `cordis.stale-4.0.4-<ts>`，**但没重建 junction**
//   ⇒ 启动包 `dsh-app-boot` 的 `import '@deepseek-ai/cordis'` 解析失败 ⇒ 服务进程退出。
// 真根因（`git blame` 定位到旧 `:77` 改名 / 旧 `:92` 本应重建）：重建链接只在
//   「`dsh` junction 推得出运行树 **且** 目标存在」时才做，其余分支（`no-running-scope` /
//   `target-missing`）**只改名不重建**；真机上顶层 `dsh` 是**真实目录**而非 junction
//   ⇒ `runningScopeDir = null` ⇒ 10 条包全部落进这条"只改名"的支路，且只在 `relinkSkipped` 里
//   留一行 JSON（面板不留痕、用户看不到），框架就再也起不来了。
// 现在（四条硬规则，全部有离线测试钉死）：
//   ① **改名后立刻重建 junction**；重建失败 → **立刻回滚改名**（改回原名）→ 记 `failed` 并写明原因。
//      `relink:false`（显式关闭重建）不再"只改名"——那种模式正是事故本体，一律不改名并如实记 `relink-off`。
//   ② 找不到任何可重建目标（多基准候选全不存在）→ **连名字都不动**（先探目标、再改名），记
//      `relinkSkipped`（带原因 + 试过哪些基准）—— 宁可什么都不做，也不让框架顶层少一个包名。
//   ③ 整批结束后做一次**框架可解析性验证**（至少 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-app-boot`，
//      多基准：框架树顶层 + `.pnpm/node_modules`；解析结果必须落在框架树内）→ **验证失败则把本轮所有
//      改名回滚**（恢复到操作前状态）并返回失败原因。这条就是"防止把服务搞到起不来"的硬闸。
//   ④ **绝不删除**任何 `.stale-*` 备份；**幂等**：`.stale-*` 不再参与判据（见 framework-residuals.js），
//      已建好的 junction 与同 stamp 的备份名都会让重复运行零改名、零新建链接。
// 返回值：`renamed`（**留在原地**的改名，含 target/via）/ `relinked` / `relinkSkipped`（含原因）/
//   `rolledBack`（含哪些与为什么）/ `verify`（多基准解析验证结果）/ `failed`（可读原因，绝不静默吞）。

import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { removeDirVerifiedAsync } from '../infra/fsx.js'
import { dshHome, resolvePackageJson } from '../infra/paths.js'
import { FRAMEWORK_BOOT_PACKAGES, classifyTopLevel, planBackupRetention, relinkTargetCandidates } from './framework-residuals.js'

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

/** 删掉一个**链接**（Windows 的 junction 用 rmdir 拆；符号链接用 unlink 兜底）。绝不删真实目录。 */
function removeLinkSafe(full, deps = {}) {
  const { rmdir = rmdirSync, unlink = unlinkSync } = deps
  const errors = []
  try { rmdir(full); return { ok: true, via: 'rmdir' } } catch (error) { errors.push(String(error?.message ?? error)) }
  try { unlink(full); return { ok: true, via: 'unlink' } } catch (error) { errors.push(String(error?.message ?? error)) }
  return { ok: false, error: errors.join(' / ') }
}

function errText(error) {
  return String(error?.message ?? error)
}

/**
 * 把「改名 → 重建链接」这一步回滚：先拆掉本轮建的链接（若已建），再把备份名改回原名。
 * 返回 `{ ok, problem }`；**失败必须带可读原因**（回滚失败是最严重的一类，绝不能假装成功）。
 */
function rollbackRename({ full, backupFull, linkAtName = false, deps = {} } = {}) {
  const { exists = existsSync, rename = renameSync, readLink = readlinkSync, removeLink = removeLinkSafe } = deps
  const problems = []
  let occupied = false
  try { occupied = exists(full) } catch (error) { problems.push('检查原位置失败：' + errText(error)) }
  if (occupied) {
    // 原位置此刻只可能是**本轮刚建的链接**（原名一刻前才被改名让出）。
    // 真实目录一律不动 —— 宁可留下链接并如实报错，也绝不误删用户数据。
    let linkNow = linkAtName
    if (!linkNow) { try { readLink(full); linkNow = true } catch { linkNow = false } }
    if (!linkNow) problems.push('原位置出现了非链接目录，拒绝覆盖')
    else {
      const rm = removeLink(full)
      if (rm?.ok !== true) problems.push('拆除本轮链接失败：' + String(rm?.error ?? '未知'))
    }
  }
  if (problems.length === 0) {
    try { rename(backupFull, full) } catch (error) { problems.push('改回原名失败：' + errText(error)) }
  }
  return { ok: problems.length === 0, problem: problems.join('；') }
}

/** 解析一条残留该重建到哪个真实目录（多基准；第一个存在的候选胜出），或如实说明为什么不能重建。 */
function resolveRelinkTarget({ fwRoot, scopeName, name, version, runningScopeDir, deps = {} } = {}) {
  const { exists = existsSync, readdir = readdirSync } = deps
  const storeHoistDir = fwRoot === null ? null : join(fwRoot, '.pnpm', 'node_modules')
  const tried = []
  for (const candidate of relinkTargetCandidates({ runningScopeDir, storeHoistDir, scopeName, name })) {
    tried.push({ path: candidate.path, via: candidate.via })
    let hit = false
    try { hit = exists(candidate.path) } catch { hit = false }
    if (hit) return { target: candidate.path, via: candidate.via, tried }
  }
  // 兜底：pnpm 虚拟 store 里的实体本体 `<scope>+<name>@<version>*`（版本必须**与刚改名的那份相同**，
  // 绝不借机换版本；同版本多个 hash 时按目录名排序取第一个，确定性且语义等价）。
  const storeDir = fwRoot === null ? null : join(fwRoot, '.pnpm')
  if (storeDir !== null && version !== null && version !== undefined && String(version) !== '') {
    const prefix = `${scopeName}+${name}@${version}`
    let dirs = []
    try { dirs = readdir(storeDir, { withFileTypes: true }).filter((d) => d.isDirectory() && (d.name === prefix || d.name.startsWith(prefix + '_'))).map((d) => d.name).sort() } catch (error) { tried.push({ path: join(storeDir, prefix + '*'), via: 'pnpm-store-entity', error: errText(error) }) }
    for (const dir of dirs) {
      const candidate = join(storeDir, dir, 'node_modules', scopeName, name)
      tried.push({ path: candidate, via: 'pnpm-store-entity' })
      let hit = false
      try { hit = exists(candidate) } catch { hit = false }
      if (hit) return { target: candidate, via: 'pnpm-store-entity', tried }
    }
  }
  return { target: null, via: null, tried }
}

/**
 * 框架**可解析性**验证（多基准，只读）：从「框架树顶层」与「`.pnpm/node_modules`」两个基准分别解析
 * 关键启动包，且要求解析结果**落在框架树内**（否则是从上层别处的同名包，等于框架自己还是解析不到）。
 * 默认用 `createRequire(base).resolve(name)` 真解析；`deps.resolveFrom` 可注入（离线测试用）。
 */
function verifyFrameworkTreeResolvable({ fwRoot, packages = FRAMEWORK_BOOT_PACKAGES, deps = {} } = {}) {
  const { resolveFrom = (baseFile, name) => createRequire(baseFile).resolve(name), real = realpathSync } = deps
  const treeRoot = fwRoot === null || fwRoot === undefined ? null : dirname(fwRoot)
  const bases = treeRoot === null ? [] : [
    { id: 'framework-top', dir: treeRoot, file: join(treeRoot, 'package.json') },
    { id: 'pnpm-store', dir: join(fwRoot, '.pnpm', 'node_modules'), file: join(fwRoot, '.pnpm', 'node_modules', 'package.json') },
  ]
  const norm = (p) => {
    try { return real(p) } catch { return resolve(p) }
  }
  const inside = (child, parent) => {
    const c = norm(child)
    const p = norm(parent)
    return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
  }
  const checks = []
  for (const base of bases) {
    for (const short of packages) {
      const name = short.includes('/') ? short : `@deepseek-ai/${short}`
      try {
        const resolved = resolveFrom(base.file, name)
        if (typeof resolved !== 'string' || resolved === '') throw new Error('解析器没有返回路径')
        if (treeRoot !== null && !inside(resolved, treeRoot)) {
          checks.push({ base: base.id, name, ok: false, path: resolved, error: `解析到框架树之外（${resolved}）——框架自己仍然解析不到它` })
          continue
        }
        checks.push({ base: base.id, name, ok: true, path: resolved, error: null })
      } catch (error) {
        checks.push({ base: base.id, name, ok: false, path: null, error: errText(error) })
      }
    }
  }
  const bad = checks.filter((c) => c.ok !== true)
  const ok = bases.length > 0 && bad.length === 0
  return {
    ok,
    phase: 'post',
    bases: bases.map((b) => ({ id: b.id, dir: b.dir })),
    packages: packages.map((s) => (s.includes('/') ? s : `@deepseek-ai/${s}`)),
    checks,
    error: ok ? null : (bases.length === 0
      ? '拿不到框架树根（无法验证可解析性）'
      : `框架可解析性验证失败：${bad.slice(0, 3).map((c) => `${c.name}@${c.base}（${c.error}）`).join('；')}${bad.length > 3 ? ` 等 ${bad.length} 条` : ''}`),
  }
}

/**
 * A 档：顶层投影里的旧版本真实目录 → 改名备份（+ **立刻**重建 junction；失败即回滚）。
 * `topScopeDir` = `<fwRoot>/<scope>`（如 `…/node_modules/@deepseek-ai`）；`dshLinkPath` = 同目录下的 `dsh`。
 * 可选 `frameworkRoot`（默认 `dirname(topScopeDir)`）、`verifyPackages`（默认启动关键包）。
 */
async function cleanFrameworkTopLevel({ topScopeDir, dshLinkPath = null, runningVersion = null, relink = true, dryRun = false, stamp = null, frameworkRoot = null, verifyPackages = null, deps = {} } = {}) {
  const {
    exists = existsSync, readdir = readdirSync, readText = (f) => readFileSync(f, 'utf8'),
    rename = renameSync, link = symlinkSync, readLink = readlinkSync,
    resolveFrom = (baseFile, name) => createRequire(baseFile).resolve(name),
  } = deps
  const empty = { renamed: [], relinked: [], relinkSkipped: [], rolledBack: [], failed: [], verify: null }
  if (topScopeDir === null || topScopeDir === undefined || !exists(topScopeDir)) {
    return { ok: false, error: '框架顶层目录不存在（拿不到 @deepseek-ai/* 的真实位置）', ...empty }
  }
  const fwRoot = frameworkRoot ?? dirname(topScopeDir)
  const scopeName = basename(topScopeDir)
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
  const rolledBack = []
  const failed = []
  const hints = []
  if (runningScopeDir === null && dshLinkPath !== null) hints.push('顶层 `' + basename(dshLinkPath) + '` 不是 junction（推不出运行树）——重建链接改用 .pnpm 多基准候选')
  const io = { exists, rename, readLink }

  for (const item of classified.stale) {
    if (dryRun === true) break // 只出 planned（函数尾部统一填），一个字节都不动
    // 显式关闭重建（relink:false）：**一律不改名**。旧行为是"只改名不重建"，那正是 2026-10-01 停机事故本体。
    if (relink !== true) {
      relinkSkipped.push({ name: item.name, version: item.version, reason: 'relink-off', detail: '调用方显式关闭重建链接（relink:false）：改名后无法指回真实包体，故不改名（旧行为会只改名 → 框架解析不到包）' })
      continue
    }
    const backupName = item.name + '.stale-' + item.version + '-' + ts
    const backupFull = join(topScopeDir, backupName)
    const full = join(topScopeDir, item.name)
    let backupExists = false
    try { backupExists = exists(backupFull) } catch { backupExists = false }
    if (backupExists) {
      // 幂等护栏：同一个 stamp 的备份已经在 → 说明这一条早就改过名了，重复运行不产生新改名。
      relinkSkipped.push({ name: item.name, version: item.version, reason: 'backup-exists', detail: `备份 ${backupName} 已存在 —— 疑似重复运行，本次不改名、不改链接` })
      continue
    }
    // **先探目标再改名**：找不到可指回的真实包体时连名字都不动（少一个"名字短暂空缺"的窗口）。
    const resolvedTarget = resolveRelinkTarget({ fwRoot, scopeName, name: item.name, version: item.version, runningScopeDir, deps: { exists, readdir } })
    if (resolvedTarget.target === null) {
      relinkSkipped.push({ name: item.name, version: item.version, reason: 'no-target', detail: '多基准候选全不存在，无法重建链接 —— 不改名（判不准就不动）', tried: resolvedTarget.tried })
      continue
    }
    try {
      rename(full, backupFull)
    } catch (error) {
      failed.push({ name: item.name, error: '改名备份失败：' + errText(error) })
      continue
    }
    try {
      link(resolvedTarget.target, full, 'junction')
    } catch (error) {
      const rb = rollbackRename({ full, backupFull, deps: io })
      const why = `重建链接失败（目标 ${resolvedTarget.target}）：${errText(error)}`
      if (rb.ok) {
        rolledBack.push({ name: item.name, version: item.version, backup: backupName, reason: 'relink-failed' })
        failed.push({ name: item.name, error: `${why}；已把改名回滚（现场未变）` })
      } else {
        failed.push({ name: item.name, error: `${why}；**回滚改名也失败**（现场可能不一致）：${rb.problem}` })
      }
      continue
    }
    renamed.push({ name: item.name, version: item.version, backup: backupName, sizeBytes: item.sizeBytes ?? null, target: resolvedTarget.target, via: resolvedTarget.via })
    relinked.push({ name: item.name, target: resolvedTarget.target, via: resolvedTarget.via })
  }

  // ③ 整批验证（硬闸）：只在**本轮真的改过名**时才具回滚意义；没改过就只如实报告当前状态。
  const verify = verifyFrameworkTreeResolvable({ fwRoot, packages: verifyPackages ?? FRAMEWORK_BOOT_PACKAGES, deps: { resolveFrom } })
  verify.phase = dryRun === true ? 'pre' : 'post'
  if (verify.ok !== true && renamed.length > 0) {
    const all = [...renamed].reverse()
    renamed.length = 0
    relinked.length = 0
    for (const item of all) {
      const rb = rollbackRename({ full: join(topScopeDir, item.name), backupFull: join(topScopeDir, item.backup), linkAtName: true, deps: io })
      if (rb.ok) rolledBack.push({ name: item.name, version: item.version, backup: item.backup, reason: 'verify-failed' })
      else failed.push({ name: item.name, error: `验证失败后的回滚未完成（现场可能不一致）：${rb.problem}` })
    }
    verify.rolledBackAll = true
    verify.error = `${verify.error} → 已把本轮全部 ${all.length} 条改名回滚（恢复到操作前状态）`
  } else if (verify.ok !== true) {
    verify.rolledBackAll = false
    hints.push('本轮没有改名（dryRun / relink-off）：验证结果只反映**操作前**的现场状态，未触发回滚')
  }
  if (relinkSkipped.some((s) => s.reason === 'no-target')) hints.push(`有 ${relinkSkipped.filter((s) => s.reason === 'no-target').length} 条找不到可指回的真实包体：**连名字都没动**（判不准就不动）`)
  if (rolledBack.length > 0) hints.push(`本轮回滚 ${rolledBack.length} 条（原因见 rolledBack）`)
  const ok = failed.length === 0 && verify.ok !== false
  return {
    ok,
    renamed,
    relinked,
    relinkSkipped,
    rolledBack,
    failed,
    hints,
    staleCount: classified.stale.length,
    sameVersionCount: classified.sameVersion.length,
    missingVersion: classified.missingVersion,
    dryRun,
    planned: classified.stale.map((s) => ({ name: s.name, version: s.version, sizeBytes: s.sizeBytes ?? null })),
    verify,
    error: ok ? null : (failed.length > 0
      ? `有 ${failed.length} 条没能安全落地：${failed.slice(0, 3).map((f) => `${f.name}（${f.error}）`).join('；')}`
      : String(verify.error ?? '未知失败')),
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
export { cleanFrameworkBackups, cleanFrameworkTopLevel, dirSizeBytes, isLinkEntry, readRollbackReferenced, removeLinkSafe, reportFrameworkEntities, resolveFrameworkLayout, verifyFrameworkTreeResolvable }