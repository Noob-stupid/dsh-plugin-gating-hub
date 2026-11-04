// L1 · domain —— install-recovery.js（安装过程把**已有副本**弄坏之后的复核与恢复；2026-11-04 加法）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言；不认识 cordis ctx）
//
// ── 现场（真机 2026-11-04，用户提供的原始日志）────────────────────────────────────
//   一次「详情页更新控制台自己」失败：pnpm 被 180s 超时**杀整棵进程树**（`已终止整棵进程树 pid=25340`），
//   同一个进程还在把 `@noob-stupid/dsh-plugin-console_tmp_13796_2` 之类的目录往 `.ignored` 里搬。
//   杀掉之后没人收尾 ⇒ pnpm 那一套"先把正式目录改名成 `_tmp_`、再解包新内容"停在中途：
//       node_modules/@noob-stupid/dsh-plugin-console/  只剩 1 个文件，package.json 没了
//   ⇒ 宿主解析不出这个包 ⇒ 面板显示「异常 / 包不可用」。同一次里 `.ignored` 已经堆到 **118 项 / 335 MB**，
//   其中 `dsh-workbuddy-connect_tmp_*` 六十多个 —— 说明这个失败模式**长期存在**，只是以前没人收口。
//
// ── 本模块补的是什么（用户原话：「杀进程后立刻复核目标目录，发现 package.json 缺失或空壳就从备份恢复；
//    恢复不了就如实报，绝不允许报成功」）────────────────────────────────────────────
//   ① **杀进程前**先把"这个目录里原来是什么"记下来（有没有清单、版本是多少）；
//   ② 通道**每次**抛"被杀/超时/占用"类错误之后**立刻**复核 + 恢复（不等整条通道序列走完 —— 否则后面
//      每条通道都在一个空目录上继续施工，越走越远）；
//   ③ 整条序列结束时（成功、失败、抛异常都算）再复核一次：结构坏了 ⇒ 先试**更新前的备份**，
//      没有再试 **pnpm 的暂存目录**（`<pkg>_tmp_*`，那里面通常是一份完整副本 ⇒ 这正是"从暂存目录恢复"）；
//   ④ 恢复不了 ⇒ 报告里带**绝对路径** + 可直接复制运行的修复命令，并且**绝不报成功**
//      （调用方据此把这次尝试改判成"没装上"）。
//
// ── 与既有实现的关系（复用，不另造一套）────────────────────────────────────────────
//   · 备份/恢复/校验/手动命令**全部复用** domain/self-update-guard.js 的现成实现：
//     `backupSelfPackageDir` / `restoreSelfPackageDir` / `pruneSelfBackups` / `dropBackupOf` /
//     `manualRestoreCommand` / `verifySelfPackageDir`。那套判据本来是给"控制台自己"写的，
//     但它的判据函数都接受一个包名（通过既有注入缝 `deps.selfName`），所以这里**不改它一个字节**，
//     只是把包名传进去 —— 于是同一套备份命名（`.pre-update-<ts>`）、同一套"改名挪开不删"、
//     同一份手动命令，对本模块覆盖的所有包都成立。
//   · 本模块**只管"目录被弄坏之后的复核与恢复"**：不判断安装成功与否、不改版本闸、不改任何通道。
//
// ── 什么时候**不**接管（边界写死在这里，别越线）──────────────────────────────────
//   ① 包名/目录算不出来 ⇒ 不接管（既有行为一个字节都不变）。
//   ② 目标目录不在 `node_modules` 里（源码检出 / 开发树）⇒ 不接管（与 self-update-guard 的 looksInstalled 同源）。
//   ③ 目标目录本身是**链接**（`link:` / junction 安装）⇒ **不接管**：那是用户自己的源码树，把它恢复成"真目录"
//      会让"改了源码不生效"变成常态。宁可不动手，也要在报告里说清为什么不动手。
//   ④ 安装**之前**目录就已经不是一份完整副本（首次安装、本来就坏着）⇒ 不接管：
//      没有"原来那版"可回滚，接管只会把既有失败路径改一遍。
//   ⑤ 备份成败都不阻断安装：备份失败只记原因（真机 EPERM 时连读都读不出来），恢复永远排在校验之后。
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { compareSemverText, parseSemverText } from '../infra/semver.js'
import { alreadyInstalledTarget } from './install-verify.js'
import {
  PRE_UPDATE_SUFFIX, backupSelfPackageDir, dropBackupOf, looksInstalled, manualRestoreCommand,
  pruneSelfBackups, restoreSelfPackageDir, verifySelfPackageDir,
} from './self-update-guard.js'

/** 备份的体积上限（默认 256 MB）：超了就**跳过备份并如实记下原因**（一次更新不该顺带拷几百 MB）。
 *  真机量级参考：本机 desktop profile 里的控制台 2.7 MB / 161 个文件，普通插件都在个位数 MB。 */
const MAX_BACKUP_BYTES = 256 * 1024 * 1024
/** pnpm 的暂存目录前缀：`<包目录名>_tmp_<pid>_<序号>`（真机日志里就是这个形状）。 */
const STAGING_MARK = '_tmp_'
/** 备份最多留几份（与 self-update-guard 的 KEEP_BACKUPS 同口径：这里只收口"本模块造的"那一族）。 */
const KEEP_BACKUPS = 1

/** `<profileDir>/node_modules/<包名>`（作用域包按 `/` 分段）。 */
function packageDirOf(profileDir, packageName) {
  const name = typeof packageName === 'string' ? packageName.trim() : ''
  const dir = typeof profileDir === 'string' ? profileDir.trim() : ''
  if (name === '' || dir === '') return ''
  return join(dir, 'node_modules', ...name.split('/'))
}

/** 目录是不是**链接**（junction 在 lstat 上也表现为符号链接）—— 见边界③。只读，失败按"不是链接"处理。 */
function isLinkedDir(dir) {
  try { return lstatSync(dir).isSymbolicLink() === true } catch { return false }
}

/** 目录体积（有上限地递归统计：一旦超过 `limit` 立刻返回，不把一次更新变成一次全盘扫描）。 */
function dirBytes(dir, { limit = MAX_BACKUP_BYTES, readdir = readdirSync, stat = statSync } = {}) {
  let total = 0
  const walk = (current) => {
    let entries = []
    try { entries = readdir(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (total > limit) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) continue
      try { total += stat(full).size } catch {}
    }
  }
  try { if (existsSync(dir)) walk(dir) } catch {}
  return total
}

/** 一次"这个目录现在是什么"的只读快照（结构判据复用 verifySelfPackageDir，包名走既有注入缝）。 */
function inspectPackageDir(packageDir, packageName, deps = {}) {
  const dir = String(packageDir ?? '')
  const name = typeof packageName === 'string' ? packageName.trim() : ''
  const exists = typeof deps.exists === 'function' ? deps.exists : existsSync
  const out = { path: join(dir, 'package.json'), exists: exists(dir) === true, linked: false, ok: false, hasManifest: false, version: null, packageName: null, reason: null }
  if (dir === '' || name === '') { out.reason = '包名或目录为空'; return out }
  out.linked = isLinkedDir(dir)
  if (exists(dir) !== true) { out.reason = '目录不存在（安装过程把它删掉/搬走了）'; return out }
  const verdict = verifySelfPackageDir(dir, null, { ...deps, selfName: name })
  out.ok = verdict.ok === true
  out.version = verdict.version ?? null
  out.packageName = verdict.packageName ?? null
  out.reason = verdict.reason ?? null
  out.hasManifest = exists(out.path) === true
  return out
}

/** 判断"这个错误是不是'进程被杀/目录被占用'那一类"（只认明确的证据，宁窄勿宽）。 */
function looksInterrupted(error) {
  if (error === null || error === undefined) return false
  if (error.timedOut === true || error.killed === true) return true
  const text = `${error.code ?? ''} ${error.message ?? ''}`
  return /已终止整棵进程树|SIGTERM|SIGKILL|EPERM|EACCES|EBUSY|ENOTEMPTY|operation not permitted|being used by another process|maxBuffer/iu.test(text)
}

/** 版本比较（只用来**记录**"有没有退回"，不参与任何成功判定；解析不了就返回 null）。 */
function versionDirection(before, after) {
  const a = parseSemverText(before ?? '')
  const b = parseSemverText(after ?? '')
  if (a === null || b === null) return null
  const diff = compareSemverText(b, a)
  return diff < 0 ? 'regressed' : (diff > 0 ? 'advanced' : 'same')
}

/**
 * 找 pnpm 留下的**可用暂存副本**：`node_modules/<父>/<包目录名>_tmp_*` 里含同一包名清单的那些，
 * 按版本取最高的一个（都没有版本号就按名字排序取最后一个）。返回绝对路径或 null。
 * 为什么值得一试：真机日志里 pnpm 正是把正式目录改名成 `_tmp_<pid>_<n>` 再搬去 `.ignored`，
 * 所以**正式目录空掉时，完整的那一份很可能就在这几个 `_tmp_` 里**。
 */
function findStagingDir(profileDir, packageName, deps = {}) {
  const dir = packageDirOf(profileDir, packageName)
  if (dir === '') return null
  const parent = dirname(dir)
  const base = basename(dir)
  const readdir = typeof deps.readdir === 'function' ? deps.readdir : readdirSync
  const name = typeof packageName === 'string' ? packageName.trim() : ''
  let names = []
  try { names = readdir(parent).filter((entry) => typeof entry === 'string' && entry.startsWith(`${base}${STAGING_MARK}`)).sort() } catch { return null }
  const usable = []
  for (const entry of names) {
    const candidate = join(parent, entry)
    const verdict = verifySelfPackageDir(candidate, null, { ...deps, selfName: name })
    if (verdict.ok === true) usable.push({ path: candidate, version: verdict.version ?? null })
  }
  if (usable.length === 0) return null
  usable.sort((x, y) => {
    const a = parseSemverText(x.version ?? '')
    const b = parseSemverText(y.version ?? '')
    if (a !== null && b !== null) return compareSemverText(b, a)
    return String(x.path) < String(y.path) ? 1 : -1
  })
  return usable[0]
}

/** 备份一族（`<pkg>.pre-update-*`）里最新的一份（本模块只在"本次备份没建成功"时用它兜底）。返回绝对路径或 null。 */
function findLatestBackup(packageDir) {
  const dir = String(packageDir ?? '')
  if (dir === '') return null
  const parent = dirname(dir)
  const prefix = `${basename(dir)}${PRE_UPDATE_SUFFIX}`
  try {
    const names = readdirSync(parent).filter((entry) => typeof entry === 'string' && entry.startsWith(prefix)).sort()
    return names.length === 0 ? null : join(parent, names[names.length - 1])
  } catch { return null }
}

/**
 * 开始一次"更新已有副本"的保护（**唯一入口**）。不满足边界 ①–④ 时返回 null：
 * 调用方据此走原路径，一个字节都不多走（这就是"别的行为不变"的实现方式）。
 * 返回的 session 只装现场事实与备份结果，**不动任何文件**（除了复制出一份备份）。
 */
function beginInstallRecovery({ packageName = '', profileDir = '', packageDir = null, targetVersion = null, job = null, deps = {} } = {}) {
  const name = typeof packageName === 'string' ? packageName.trim() : ''
  if (name === '') return null
  const dir = typeof packageDir === 'string' && packageDir !== '' ? packageDir : packageDirOf(profileDir, name)
  if (dir === '') return null
  // 边界⑤：这一次通道**根本不会动目录**（包已在盘上、且不是更新请求 ⇒ install-verify 的 alreadyInstalledTarget
  //   会直接短路"跳过重复下载"）⇒ 不备份、不接管：省掉一次整目录复制，语义与那条既有判据一致（不新造判据）。
  if (job !== null && job !== undefined && typeof profileDir === 'string' && profileDir !== ''
    && alreadyInstalledTarget(profileDir, name, job) !== null) return null
  // 边界②：只认"真的装在 node_modules 里"的那一份
  const installedShaped = typeof deps.looksInstalled === 'function' ? deps.looksInstalled(dir) === true : looksInstalled(dir) === true
  if (installedShaped !== true) return null
  // 边界③：链接安装（link:/junction）不动手
  if (isLinkedDir(dir) === true) return null
  // 边界④：安装前就必须是一份完整的副本（首次安装 / 本来就坏着 ⇒ 不接管）
  const before = inspectPackageDir(dir, name, deps)
  if (before.ok !== true) return null
  // 备份（复制；失败不阻断，只如实记）
  const limit = Number.isFinite(deps.maxBackupBytes) && deps.maxBackupBytes > 0 ? deps.maxBackupBytes : MAX_BACKUP_BYTES
  const bytes = typeof deps.sizeOf === 'function' ? Number(deps.sizeOf(dir)) || 0 : dirBytes(dir, { limit })
  let backup = { ok: false, path: null, reason: null, previousVersion: before.version, occupied: false }
  let backupSkipped = false
  if (bytes > limit) {
    backupSkipped = true
    backup.reason = `目录体积约 ${Math.round(bytes / (1024 * 1024))} MB，超过备份上限 ${Math.round(limit / (1024 * 1024))} MB：本次**没有**建备份（恢复时会退而使用 pnpm 暂存目录）`
  } else {
    try {
      const result = backupSelfPackageDir(dir, deps)
      if (result !== null && typeof result === 'object') backup = result
      else backup.reason = '备份实现没有返回结果'
    } catch (error) {
      backup.reason = `备份抛错：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    packageName: name,
    packageDir: dir,
    profileDir: typeof profileDir === 'string' ? profileDir : '',
    targetVersion: typeof targetVersion === 'string' && targetVersion !== '' ? targetVersion : null,
    before,
    previousVersion: backup.previousVersion ?? before.version,
    backupPath: backup.path,
    backedUp: backup.ok === true,
    backupReason: backup.reason,
    backupSkipped,
    deps,
  }
}

/** 恢复现场的"流水"（每次复核/恢复都记一条，供报告与面板显示；不参与判定）。
 *  `pendingHeal`：最近一次恢复之后**还没有**任何通道成功过 —— 也就是说盘上那一份是"恢复回来的旧版"，
 *  不能算这次安装的成果。后面有通道成功写入时它会被清掉（见 wrapChannelsWithRecovery）。 */
function makeRecoveryState(session) {
  return { session, timeline: [], healCount: 0, savedFrom: null, savedVersion: null, brokenPaths: [], pendingHeal: false }
}

/**
 * 立刻复核 + 必要时恢复（"杀进程后立刻复核"的那一步；幂等，可以反复调）。
 * 先试**更新前的备份**，再试 **pnpm 暂存目录**；都不行就如实返回原因（绝不假装恢复了）。
 */
function healPackageDir(state, { trigger = 'manual', deps = {} } = {}) {
  const session = state.session
  const io = { ...(session.deps ?? {}), ...(deps ?? {}) }
  const dir = session.packageDir
  const name = session.packageName
  const current = inspectPackageDir(dir, name, io)
  const row = { at: typeof io.now === 'function' ? io.now() : Date.now(), trigger, ok: current.ok === true, version: current.version ?? null, restored: false, restoredFrom: null, restoredVersion: null, brokenPath: null, reason: null }
  if (current.ok === true) {
    row.reason = '目录当前是完整的，无需恢复'
    state.timeline.push(row)
    return row
  }
  // ① 更新前的备份（本次这一份优先；本次没建成才用同目录里最新的那一份）
  const backupPath = session.backedUp === true && typeof session.backupPath === 'string' && existsSync(session.backupPath) ? session.backupPath : findLatestBackup(dir)
  if (backupPath !== null) {
    const restored = restoreSelfPackageDir(dir, backupPath, io)
    const again = inspectPackageDir(dir, name, io)
    if (restored.ok === true && again.ok === true) {
      row.restored = true
      row.restoredFrom = 'backup'
      row.restoredVersion = again.version ?? null
      row.brokenPath = restored.brokenPath ?? null
      row.version = again.version ?? null
      row.ok = true
      row.reason = `已从备份恢复（${backupPath}）`
      state.healCount += 1
      state.pendingHeal = true
      state.savedFrom = 'backup'
      state.savedVersion = again.version ?? null
      if (typeof restored.brokenPath === 'string') state.brokenPaths.push(restored.brokenPath)
      state.timeline.push(row)
      return row
    }
    row.reason = `从备份恢复失败：${restored.reason ?? '恢复后仍不过校验'}${restored.ok === true ? `（${again.reason ?? '结构不完整'}）` : ''}`
  } else {
    row.reason = session.backupSkipped === true ? `本次没有建备份（${session.backupReason ?? '体积超上限'}）` : `没有可用备份${session.backupReason ? `（${session.backupReason}）` : ''}`
  }
  // ② pnpm 暂存目录（`<pkg>_tmp_*`）：正式目录空掉时，完整的那一份常常就在这里
  const staging = session.profileDir === '' ? null : findStagingDir(session.profileDir, name, io)
  if (staging !== null) {
    const restored = restoreSelfPackageDir(dir, staging.path, io)
    const again = inspectPackageDir(dir, name, io)
    if (restored.ok === true && again.ok === true) {
      row.restored = true
      row.restoredFrom = 'staging'
      row.restoredVersion = again.version ?? null
      row.brokenPath = restored.brokenPath ?? null
      row.version = again.version ?? null
      row.ok = true
      row.reason = `已从 pnpm 暂存目录恢复（${staging.path}${staging.version ? `，v${staging.version}` : ''}）`
      state.healCount += 1
      state.pendingHeal = true
      state.savedFrom = 'staging'
      state.savedVersion = again.version ?? null
      if (typeof restored.brokenPath === 'string') state.brokenPaths.push(restored.brokenPath)
      state.timeline.push(row)
      return row
    }
    row.reason = `${row.reason}；从暂存目录也恢复失败：${restored.reason ?? '恢复后仍不过校验'}`
  }
  state.timeline.push(row)
  return row
}

/** 出错之后**立刻**复核的那一次（通道层每次"被杀/超时/占用"失败都会调它；幂等）。 */
function noteInterrupted(state, { trigger = 'channel', error = null, deps = {} } = {}) {
  if (state === null || state === undefined) return null
  if (looksInterrupted(error) !== true) return null
  return healPackageDir(state, { trigger, deps })
}

/**
 * 收尾（**成功、失败、抛异常三条路都要跑**）：复核 → 坏了就恢复（备份 → 暂存目录）→ 同一判据再复核 →
 * 备份收口（最多留 1 份）→ 产出如实报告。报告就是作业上的 `installRecovery` 字段。
 */
function settleInstallRecovery(state, { deps = {} } = {}) {
  if (state === null || state === undefined) return null
  const session = state.session
  const io = { ...(session.deps ?? {}), ...(deps ?? {}) }
  const after0 = inspectPackageDir(session.packageDir, session.packageName, io)
  let heal = null
  if (after0.ok !== true) heal = healPackageDir(state, { trigger: 'settle', deps: io })
  const after = inspectPackageDir(session.packageDir, session.packageName, io)
  const verified = after.ok === true
  const healed = state.healCount > 0
  // `landed` = 这次安装**真的落地了**：目录完整 **且** 盘上那份不是"恢复回来的旧版"。
  // 只看 verified 不够（真机现场：恢复完目录当然完整，但那一份是**更新前**的旧版）；
  // 只看 healed 也不够（"pnpm 超时被杀 → 恢复旧版 → curl 后来真的装上了"是成功，不能报失败）——
  // 两者之间的判据就是 `pendingHeal`：恢复之后有没有通道成功写入过。
  const landed = verified === true && state.pendingHeal !== true
  // `problem` = 到底坏在哪（如实描述现场）；`reason` = 收尾时的结论（含恢复动作的结果）
  const problem = after0.ok !== true
    ? (after0.reason ?? '目录里没有可读的 package.json')
    : (healed === true ? '目录在安装过程中被清空过（恢复动作发生在通道失败的那一刻，见 timeline）' : null)
  const reason = landed === true
    ? null
    : (problem ?? heal?.reason ?? '安装过程把目录弄坏了（目录已不可用）')
  const backupPath = session.backedUp === true ? session.backupPath : null
  // 备份收口（与 self-update-guard 同一口径）：这次更新**落地了**才删本次备份；失败/恢复过就留着（那是唯一旧版）
  const dropped = landed === true ? dropBackupOf(backupPath) : null
  const pruned = pruneSelfBackups(session.packageDir, { keep: KEEP_BACKUPS, deps: io })
  const report = {
    packageName: session.packageName,
    packageDir: session.packageDir,
    targetVersion: session.targetVersion ?? null,
    previousVersion: session.previousVersion ?? null,
    before: { ok: session.before.ok === true, version: session.before.version ?? null, hasManifest: session.before.hasManifest === true },
    after: { ok: after.ok === true, version: after.version ?? null, hasManifest: after.hasManifest === true },
    backedUp: session.backedUp === true,
    backupPath,
    backupNote: session.backupReason ?? null,
    backupSkipped: session.backupSkipped === true,
    verified,
    healed,
    landed,
    restoredFrom: state.savedFrom,
    restoredVersion: state.savedVersion ?? after.version ?? null,
    brokenPath: state.brokenPaths.length > 0 ? state.brokenPaths[state.brokenPaths.length - 1] : null,
    versionDirection: versionDirection(session.previousVersion, after.version ?? null),
    problem,
    reason,
    selfHeal: {
      attempted: heal !== null,
      restored: heal?.restored === true,
      reason: heal?.reason ?? null,
      mode: heal?.restoredFrom ?? null,
    },
    timeline: state.timeline,
    backupCleanup: { removed: [...(dropped !== null && dropped.removed === true ? [backupPath] : []), ...pruned.removed], kept: pruned.kept, note: dropped?.note ?? pruned.note ?? null },
    manualCommand: null,
  }
  if (verified !== true) {
    report.manualCommand = manualRestoreCommand({
      pkgDir: session.packageDir,
      backupPath,
      version: session.targetVersion ?? session.previousVersion,
      // 包名走既有注入缝（self-update-guard 的 selfName），这样命令里取的 tarball 是**这个包**的
      deps: { ...io, selfName: session.packageName },
    })
  }
  return report
}

/**
 * 通道代理：每次"被杀/超时/占用"类失败 ⇒ **立刻**复核 + 恢复，再把原错误抛回去
 * （既有语义不变：通道失败照旧被上层吞成"没装成"）。
 * 另外记一件事：恢复之后**只要还有通道成功写入**，就说明盘上那份不再是"恢复回来的旧版" ⇒
 * 清掉 `pendingHeal`（否则"pnpm 超时被杀 → 恢复旧版 → curl 后来装成功"会被误判成失败）。
 */
function wrapChannelsWithRecovery(ch, state, deps = {}) {
  if (ch === null || ch === undefined || typeof ch !== 'object') return ch
  const wrapped = { ...ch }
  for (const key of ['raceInstallChannels', 'pnpmInstall', 'curlManualInstall', 'githubReleaseInstall']) {
    if (typeof ch[key] !== 'function') continue
    wrapped[key] = async (...callArgs) => {
      let out = null
      try {
        out = await ch[key](...callArgs)
      } catch (error) {
        try { noteInterrupted(state, { trigger: `channel:${key}`, error, deps }) } catch {}
        throw error
      }
      // "通道成功"的判据：竞速通道返回非空才算有赢家；其余通道能正常返回就算写成功了
      const succeeded = key === 'raceInstallChannels' ? (out !== null && out !== undefined) : true
      if (succeeded === true) state.pendingHeal = false
      return out
    }
  }
  return wrapped
}

/**
 * 接线外壳（被 domain/install-channels.js#runSelfUpdateGuarded 调用）：
 *   · 不接管（session=null）⇒ `run(null)`，用**原来的**通道对象，一个字节都不多走；
 *   · 接管 ⇒ 通道换成带"被杀即复核"的代理，收尾统一 settle，并把报告挂到 `job.installRecovery`。
 * 返回值的语义与不改时**一样**（{ installedName, lastError, source }），唯一的例外是
 * "通道说装上了、但目录其实已经坏了" —— 那一条改判成没装上（绝不报成功）。
 */
async function withInstallRecovery({ job = null, name = '', profileDir = '', targetVersion = null, ch = null, deps = {} } = {}, run) {
  const session = beginInstallRecovery({ packageName: name, profileDir, targetVersion, job, deps })
  if (session === null) return await run(null)
  const state = makeRecoveryState(session)
  const guarded = wrapChannelsWithRecovery(ch, state, deps)
  let outcome = null
  let thrown = null
  try {
    outcome = await run(guarded)
  } catch (error) {
    thrown = error
  }
  const report = settleInstallRecovery(state, { deps })
  if (job !== null && job !== undefined && typeof job === 'object') job.installRecovery = report
  if (thrown !== null) throw thrown
  // 通道说"装上了"不算数：**目录完整 且 不是靠恢复旧版救回来的**才算这次真的落地。
  // （只看 verified 会把"恢复成旧版后的完整目录"当成更新成功 —— 那正是真机谎报的形状。）
  if (outcome !== null && outcome !== undefined && outcome.installedName !== null && outcome.installedName !== undefined && report.landed !== true) {
    return { installedName: null, lastError: new Error(installRecoveryFailureText(report) ?? '安装没有落地（目录已不可用）') }
  }
  return outcome
}

/**
 * 失败文案（作业 error / 面板提示共用一份；**这次真的落地了**才返回 null）。
 * 一次说清四件事：没通过的原因、自愈有没有成、残缺目录留在哪、手动命令是什么。
 */
function installRecoveryFailureText(report) {
  if (report === null || report === undefined || typeof report !== 'object') return null
  if (report.landed === true) return null
  const parts = [`安装没有落地：安装过程把 ${report.packageDir ?? '插件目录'} 弄坏了（${report.problem ?? report.reason ?? '目录里没有可读的 package.json'}）。`]
  if (report.healed === true) {
    const from = report.restoredFrom === 'staging' ? 'pnpm 暂存目录' : '更新前的备份'
    parts.push(`已从${from}自动恢复成 v${report.restoredVersion ?? '?'}，本次更新**没有生效**（这不是更新成功）。`)
  } else if (report.backedUp !== true) {
    parts.push(`无法自动恢复：${report.selfHeal?.reason ?? report.backupNote ?? '更新前没能建立备份'}。`)
  } else {
    parts.push(`自动恢复也失败了：${report.selfHeal?.reason ?? '原因未知'}。`)
  }
  if (typeof report.brokenPath === 'string' && report.brokenPath !== '') {
    parts.push(`残缺目录已改名保留在 ${report.brokenPath}（未删除，可自行核对）。`)
  }
  if (typeof report.manualCommand === 'string' && report.manualCommand !== '') {
    parts.push(`要手动处理可直接复制运行：${report.manualCommand}`)
  }
  return parts.join('')
}

export {
  MAX_BACKUP_BYTES,
  STAGING_MARK,
  KEEP_BACKUPS,
  packageDirOf,
  isLinkedDir,
  dirBytes,
  inspectPackageDir,
  looksInterrupted,
  versionDirection,
  findStagingDir,
  findLatestBackup,
  beginInstallRecovery,
  makeRecoveryState,
  healPackageDir,
  noteInterrupted,
  settleInstallRecovery,
  wrapChannelsWithRecovery,
  withInstallRecovery,
  installRecoveryFailureText,
}
