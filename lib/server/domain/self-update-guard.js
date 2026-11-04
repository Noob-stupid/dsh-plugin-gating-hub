// L1 · domain —— self-update-guard.js（自更新兜底：更新前备份自身目录 → 更新后按同一判据校验 → 不过就自愈；2026-11-03 加法）
//
// ── 现场（真机两次，用户 2026-11-03 报告，已确认）──────────────────────────────────
//   用户用控制台自带的「更新」把控制台自己更新，pnpm 装包**中途被打断**（宿主正在读插件自己的文件 ⇒ EPERM，
//   本次还有外部杀进程干扰）。pnpm 的安装是"先删旧目录、再解包新目录"，删到一半失败就留下半棵树：
//       node_modules/@noob-stupid/dsh-plugin-console/ 只剩 scripts/ 与 SECURITY.md，package.json 没了
//   ⇒ 宿主解析不出 profile bundle ⇒ 面板显示「异常 / 包不可用」⇒ 只能手工把 npm tarball 解回原位（一天两次）。
//
// ── 这不是"自更新逻辑有 bug" ───────────────────────────────────────────────────
//   用户此前长期正常更新。缺的是**中途被打断之后的自愈**：既有 gateVersion（0.5.87）只核对"落地版本是不是
//   目标版本"，目录被删空时它读到的是"没装"，既没有恢复动作、也没人替用户把旧版放回去。所以本模块是**加法**：
//   不改既有安装通道、不改版本闸、不改作业状态机，只在"被安装的包名 === 本插件自己"时多加一层保护。
//
// ── 六条硬规矩（改代码时别越线）────────────────────────────────────────────────
//   ① **只对本插件自己生效**：`isSelfUpdate()` 不成立时 `beginSelfUpdateGuard()` 直接返回 null，
//      调用方走原路径、一个字节都不变（tests/test-self-update-guard.mjs ⑤ 钉住：别的包不备份、不出字段）。
//   ② 只有"磁盘上本来就有**一份能解析的**自身副本"才算自更新（= 真的在更新，而不是首次安装）。
//      目录不存在 / 清单读不出来 ⇒ 不接管 ⇒ 首次安装、坏目录重装的既有行为原样保留。
//   ③ 备份是**复制**不是移动（正在运行的目录不能被搬走，宿主还要继续读它）；备份失败**不阻断**更新，
//      只如实记下来，等校验那一步再一起报。
//   ④ 校验只认磁盘、不认"通道说成功"：清单存在 + 能解析 + 包名是本插件 + 声明的入口文件在 + version === 期望
//      （没点名版本时只要求"是一份完整的自身副本"）。**同一判据**在自愈之后还要再跑一次。
//   ⑤ 自愈：残缺目录**改名挪开**（`<dir>.broken-<ts>`，绝不删除 —— 用户可能还要从里面捞东西）→
//      从备份复制回来 → 用同一判据再校验。Windows 上改名会因占用失败（EPERM/EBUSY），此时降级为
//      **就地覆盖复制**，并用 `isLockFailure` 把"占用类失败"与"普通异常"分开说。
//   ⑥ 绝不静默：`verified !== true` 的每一次都带 `reason` 与**可直接复制运行**的 `manualCommand`
//      （全绝对路径，见 manualRestoreCommand），由调用方写进作业错误，绝不报"更新成功"。
//
// 分层：L1 · domain（不认识 cordis，不联网；文件系统读写全部走 node:fs 与 infra/fsx.js 的既有件）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { copyTree, isLockFailure } from '../infra/fsx.js'
import { pluginRoot, resolvePackageJson } from '../infra/paths.js'

/** 本插件包名的**兜底**常量（与 domain/selfupdate.js#CONSOLE_PACKAGE、routes/plugins.js 里的同名常量一致）。
 *  为什么这里还要再写一份、而不是 import 过来：识别"我是谁"绝不能依赖**会消失的那个文件**——
 *  事故现场正是自身清单一度不见；而 import selfupdate.js 还会让本模块与它成环（那边要 import 本模块）。
 *  正常路径上一律优先读**正在运行的包根** package.json（见 readOwnName），常量只兜底。 */
const SELF_PACKAGE_FALLBACK = '@noob-stupid/dsh-plugin-console'

/** 备份目录后缀（与 `<pkgDir>` 同父目录，同卷 rename/copy 才成立）。 */
const PRE_UPDATE_SUFFIX = '.pre-update-'
/** 残缺目录后缀（**只改名，不删除**）。 */
const BROKEN_SUFFIX = '.broken-'
/** 备份最多留几份（"别无限堆"，见 pruneSelfBackups）。 */
const KEEP_BACKUPS = 1
/** 时间戳等宽（Date.now() 13 位）——名字的字典序即时间序，prune 靠这一条挑"最新的那份"。 */
const STAMP_WIDTH = 13

/** 时间戳（名字用；`deps.now` 是单测注入缝）。 */
function stampOf(now = Date.now()) {
  const value = Number(now())
  return String(Number.isFinite(value) ? value : 0).padStart(STAMP_WIDTH, '0')
}

/** 正在运行的这一份插件自己的 package.json 里的 name（读不到返回 null —— 事故现场就是读不到）。 */
function readOwnName(deps = {}) {
  const read = typeof deps.readFile === 'function' ? deps.readFile : readFileSync
  try {
    const parsed = JSON.parse(read(join(pluginRoot(), 'package.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.name !== '') return parsed.name
  } catch {}
  return null
}

/** 本插件包名：注入 > 运行中清单 > 兜底常量。 */
function selfPackageNameOf(deps = {}) {
  if (typeof deps.selfName === 'string' && deps.selfName !== '') return deps.selfName
  return readOwnName(deps) ?? SELF_PACKAGE_FALLBACK
}

/** `pkgName` 是不是本插件自己（**纯函数**，判据的唯一入口）。 */
function isSelfUpdate(packageName, deps = {}) {
  if (typeof packageName !== 'string' || packageName === '') return false
  return packageName === selfPackageNameOf(deps)
}

/** 「这个目录是不是**真的装在 node_modules 里**的那一份」（自更新唯一允许动手的地方）。
 *  为什么必须有这道闸：Node 的**包自引用**让"仓库根/开发检出"也能解析出同名清单 —— 真机实测过
 *  一次测试夹具把 profile 建在仓库里面，`resolve()` 直接自指到仓库根，于是守卫把整棵源码树当成
 *  "安装副本"去做备份（几十万个文件、几分钟）。判据与 release-source.js#releaseInstallTarget 同源：
 *  `<…>/node_modules/<包名>` 或 `<…>/node_modules/@scope/<包名>`；其余（源码检出）一律不接管。 */
function looksInstalled(dir) {
  const parent = basename(dirname(dir))
  const grand = basename(dirname(dirname(dir)))
  if (parent === 'node_modules') return true
  return parent.startsWith('@') && grand === 'node_modules'
}

/** 被更新的那份**自身副本**在哪（绝对路径）。
 *  ① 调用方显式给了目录（测试/特例）就用它；
 *  ② `<profileDir>/node_modules/<包名>` —— pnpm / curl / 并行竞速三条通道的落点，事故现场就是它；
 *  ③ 解析得到的清单所在目录（宿主根层安装等布局）；
 *  ④ 正在运行的包根（npm 全局安装、profile 里没有副本时）。
 *  注：这里只负责"找路"，"敢不敢动手"由 beginSelfUpdateGuard 的 looksInstalled 闸决定。 */
function selfPackageDirOf({ profileDir = null, packageDir = null, deps = {} } = {}) {
  if (typeof packageDir === 'string' && packageDir !== '') return packageDir
  const name = selfPackageNameOf(deps)
  if (typeof profileDir === 'string' && profileDir !== '') {
    const profileCopy = join(profileDir, 'node_modules', ...name.split('/'))
    if (existsSync(profileCopy) === true) return profileCopy
    try {
      const resolved = resolvePackageJson(name, profileDir)
      if (typeof resolved === 'string' && resolved !== '') return dirname(resolved)
    } catch {}
    return profileCopy
  }
  return pluginRoot()
}

/** 读一份包清单（读不到返回 `{ parsed:null, version:null, error }`，永不抛）。 */
function readManifestOf(pkgDir, deps = {}) {
  const read = typeof deps.readFile === 'function' ? deps.readFile : readFileSync
  try {
    const parsed = JSON.parse(read(join(String(pkgDir ?? ''), 'package.json'), 'utf8'))
    const version = typeof parsed?.version === 'string' && parsed.version !== '' ? parsed.version : null
    return { parsed, version, error: null }
  } catch (error) {
    return { parsed: null, version: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 「这段报错是不是占用/权限类失败」（判据的唯一真源是 infra/fsx.js#isLockFailure —— 别在这里另立一把尺子）。
 *  占用类失败靠重试不会好，要做的是改名让开 / 事后恢复；说不清时按普通异常处理（不夸大）。 */
function occupiedReasonOf(error) {
  const text = error instanceof Error ? error.message : String(error ?? '')
  const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : ''
  return isLockFailure(`${code} ${text}`) === true
}

/**
 * 自更新的**唯一判据**：`<pkgDir>/package.json` 存在 + 能解析 + 包名是本插件 + 声明的入口文件在 +
 * version === `expectedVersion`。没给期望版本时只要求"是一份完整的自身副本"（版本号非空）——
 * "按 latest 更新"的请求本来就没有目标版本。入口文件那一条是"半棵树"的第二道探针：
 * pnpm 删到一半时也可能留下清单却丢了 lib/，这种状态宿主一样加载不起来。
 * 只读、永不抛。返回 `{ ok, reason, version, packageName, path, occupied }`。
 */
function verifySelfPackageDir(pkgDir, expectedVersion = null, deps = {}) {
  const wanted = selfPackageNameOf(deps)
  const dir = String(pkgDir ?? '')
  const path = join(dir, 'package.json')
  const out = { ok: false, reason: null, version: null, packageName: null, path, occupied: false }
  const exists = typeof deps.exists === 'function' ? deps.exists : existsSync
  if (exists(path) !== true) {
    out.reason = '目录里没有 package.json（安装中途被打断的典型现场：pnpm 先删旧目录再解包，Windows 上删到一半失败就只剩几个文件）'
    return out
  }
  const manifest = readManifestOf(dir, deps)
  if (manifest.parsed === null) {
    out.occupied = occupiedReasonOf(manifest.error)
    out.reason = `package.json 读不出来/无法解析${out.occupied ? '（文件被占用）' : ''}：${manifest.error ?? '未知原因'}`
    return out
  }
  out.packageName = typeof manifest.parsed.name === 'string' ? manifest.parsed.name : null
  out.version = manifest.version
  if (out.packageName !== wanted) {
    out.reason = `package.json 里的包名是 ${out.packageName ?? '（空）'}，不是本插件 ${wanted}`
    return out
  }
  if (out.version === null) {
    out.reason = 'package.json 里没有可用的 version 字段'
    return out
  }
  const entry = typeof manifest.parsed.main === 'string' && manifest.parsed.main !== '' ? manifest.parsed.main : null
  if (entry !== null && exists(join(dir, ...entry.split('/'))) !== true) {
    out.reason = `声明的入口文件不在了（main = ${entry}）：目录只剩半棵树`
    return out
  }
  const expect = typeof expectedVersion === 'string' && expectedVersion !== '' ? expectedVersion : null
  if (expect !== null && out.version !== expect) {
    out.reason = `落地版本是 ${out.version}，不是目标版本 ${expect}`
    return out
  }
  out.ok = true
  return out
}

/**
 * 更新前备份自身目录：**复制**到 `<pkgDir>.pre-update-<时间戳>`（同父目录）。
 * 复制而不是移动：宿主还在读这份目录，把它搬走等于把正在运行的服务从脚下抽掉。
 * 失败**不阻断**更新（本函数只回结果），原因留给校验那一步一起如实上报。
 * 返回 `{ ok, path, reason, previousVersion, occupied }`。
 */
function backupSelfPackageDir(pkgDir, deps = {}) {
  const dir = String(pkgDir ?? '')
  const out = { ok: false, path: null, reason: null, previousVersion: null, occupied: false }
  const exists = typeof deps.exists === 'function' ? deps.exists : existsSync
  const copy = typeof deps.copy === 'function' ? deps.copy : copyTree
  if (dir === '') {
    out.reason = '没有给出插件目录'
    return out
  }
  out.previousVersion = readManifestOf(dir, deps).version
  if (exists(dir) !== true) {
    out.reason = `插件目录不存在（${dir}）`
    return out
  }
  const target = join(dirname(dir), `${basename(dir)}${PRE_UPDATE_SUFFIX}${stampOf(deps.now ?? Date.now)}`)
  try {
    if (exists(target) === true) rmSync(target, { recursive: true, force: true })
    copy(dir, target)
    out.ok = true
    out.path = target
    return out
  } catch (error) {
    out.occupied = occupiedReasonOf(error)
    out.reason = `备份失败${out.occupied ? '（目录被占用）' : ''}：${error instanceof Error ? error.message : String(error)}`
    try { rmSync(target, { recursive: true, force: true }) } catch {}
    return out
  }
}

/**
 * 自愈：**先让开残缺目录（改名，不删）→ 再从备份复制回来**。
 * 改名挪不开（占用：目录里有 share=None 的句柄 / 是活进程的 cwd）时降级为**就地覆盖复制**——
 * 宁可留着残渣也别把用户的插件晾在半空；用哪种方式、挪到哪、为什么，全部如实记在返回值里。
 * 返回 `{ ok, mode:'renamed'|'in-place'|null, brokenPath, reason, occupied }`。
 */
function restoreSelfPackageDir(pkgDir, backupPath, deps = {}) {
  const dir = String(pkgDir ?? '')
  const out = { ok: false, mode: null, brokenPath: null, reason: null, occupied: false }
  const exists = typeof deps.exists === 'function' ? deps.exists : existsSync
  const copy = typeof deps.copy === 'function' ? deps.copy : copyTree
  const rename = typeof deps.rename === 'function' ? deps.rename : renameSync
  const messageOf = (error) => (error instanceof Error ? error.message : String(error))
  if (typeof backupPath !== 'string' || backupPath === '') {
    out.reason = '没有可用备份'
    return out
  }
  if (exists(backupPath) !== true) {
    out.reason = `备份目录不存在（${backupPath}）`
    return out
  }
  if (exists(dir) === true) {
    const broken = join(dirname(dir), `${basename(dir)}${BROKEN_SUFFIX}${stampOf(deps.now ?? Date.now)}`)
    try {
      rename(dir, broken)
      out.mode = 'renamed'
      out.brokenPath = broken
    } catch (error) {
      out.occupied = occupiedReasonOf(error)
      try {
        copy(backupPath, dir)
        out.mode = 'in-place'
        out.reason = `残缺目录改名挪不开${out.occupied ? '（目录被占用）' : ''}（${messageOf(error)}），已把备份内容就地覆盖回去`
      } catch (copyError) {
        out.occupied = out.occupied === true || occupiedReasonOf(copyError) === true
        out.reason = `残缺目录改名挪不开（${messageOf(error)}），就地覆盖也失败：${messageOf(copyError)}`
        return out
      }
    }
  } else {
    try { mkdirSync(dirname(dir), { recursive: true }) } catch {}
  }
  if (out.mode === 'renamed') {
    try {
      copy(backupPath, dir)
    } catch (error) {
      // 复制不可用时的最后一条腿：把备份**改名**到原位置（备份此后不再存在，但盘上有完整的一份）
      try {
        rename(backupPath, dir)
        out.reason = `从备份复制失败（${messageOf(error)}），已改用改名把备份搬回原位`
      } catch (renameError) {
        out.occupied = occupiedReasonOf(error) === true || occupiedReasonOf(renameError) === true
        out.reason = `从备份恢复失败：复制 ${messageOf(error)}；改名 ${messageOf(renameError)}`
        return out
      }
    }
  }
  out.ok = exists(join(dir, 'package.json')) === true
  if (out.ok !== true && out.reason === null) out.reason = `恢复后仍看不到 ${join(dir, 'package.json')}`
  return out
}

/** 备份只留最近 `keep` 份（名字里是等宽时间戳 ⇒ 字典序即时间序）。删不掉只记 note、绝不抛。 */
function pruneSelfBackups(pkgDir, { keep = KEEP_BACKUPS, deps = {} } = {}) {
  const out = { removed: [], kept: [], note: null }
  const dir = String(pkgDir ?? '')
  const parent = dirname(dir)
  const prefix = `${basename(dir)}${PRE_UPDATE_SUFFIX}`
  const readdir = typeof deps.readdir === 'function' ? deps.readdir : readdirSync
  let names = []
  try { names = readdir(parent).filter((n) => typeof n === 'string' && n.startsWith(prefix)).sort() } catch { return out }
  const keepCount = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : KEEP_BACKUPS
  for (const name of names.slice(0, Math.max(0, names.length - keepCount))) {
    try {
      rmSync(join(parent, name), { recursive: true, force: true })
      out.removed.push(name)
    } catch (error) {
      out.note = `旧备份没删掉（${name}）：${error instanceof Error ? error.message : String(error)}`
    }
  }
  out.kept = names.slice(Math.max(0, names.length - keepCount))
  return out
}

/** 去掉本次这一份备份（校验通过时用）。删不掉就留着交给 prune 收口，绝不抛。 */
function dropBackupOf(backupPath) {
  if (typeof backupPath !== 'string' || backupPath === '') return { removed: false, note: null }
  try {
    rmSync(backupPath, { recursive: true, force: true })
    return { removed: true, note: null }
  } catch (error) {
    return { removed: false, note: `本次备份没删掉（${backupPath}）：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** registry tarball 地址（npm 约定：作用域在路径里，文件名不带作用域）。 */
function registryTarballUrlOf(name, version) {
  const tail = String(name).split('/').pop()
  return `https://registry.npmmirror.com/${name}/-/${tail}-${version}.tgz`
}

/**
 * 失败时要给用户的那条**可直接复制运行**的命令（全绝对路径 —— 用户可能在任何目录下粘贴它）。
 *   ① 有备份 ⇒ 把备份整棵复制回来（Windows 用 robocopy：支持长路径，与本仓库回滚脚本同一手法）；
 *   ② 没有备份 ⇒ 从 registry 取一份解到原位（**正是用户手工救过两次的那套动作**）。
 * 落点全部选**已经存在**的目录（`<pkgDir>` 的父目录），所以粘贴即可跑，不必先建目录。
 */
function manualRestoreCommand({ pkgDir, backupPath = null, version = null, deps = {} } = {}) {
  const dir = String(pkgDir ?? '')
  if (dir === '') return null
  const win = (typeof deps.platform === 'string' ? deps.platform : process.platform) === 'win32'
  if (typeof backupPath === 'string' && backupPath !== '') {
    return win
      ? `robocopy "${backupPath}" "${dir}" /E /NFL /NDL /NJH /NJS /R:1 /W:1`
      : `cp -a "${backupPath}/." "${dir}/"`
  }
  const wanted = typeof version === 'string' && version !== '' ? version : 'latest'
  const url = registryTarballUrlOf(selfPackageNameOf(deps), wanted)
  const parent = dirname(dir)
  const tgz = join(parent, `${basename(dir)}-rescue.tgz`)
  const unpacked = join(parent, 'package')
  return win
    ? `curl.exe -sL -o "${tgz}" "${url}" ; tar -xzf "${tgz}" -C "${parent}" ; robocopy "${unpacked}" "${dir}" /E /NFL /NDL /NJH /NJS /R:1 /W:1`
    : `curl -sL -o "${tgz}" "${url}" && tar -xzf "${tgz}" -C "${parent}" && cp -a "${unpacked}/." "${dir}/"`
}

/**
 * 开始一次自更新的保护（**唯一入口**）：不是本插件 / 磁盘上还没有可解析的自身副本 ⇒ 返回 null
 * （调用方一个字节都不用走 —— 这就是"别的包行为不变"的实现方式）。
 * 否则：先备份，返回后续 settle 要用的现场（含备份结果）。
 */
function beginSelfUpdateGuard({ packageName = null, profileDir = null, packageDir = null, targetVersion = null, deps = {} } = {}) {
  if (isSelfUpdate(packageName, deps) !== true) return null
  const name = selfPackageNameOf(deps)
  const pkgDir = selfPackageDirOf({ profileDir, packageDir, deps })
  // 规矩②之前先过一道闸：只认**真的装在 node_modules 里**的那一份（源码检出/仓库根绝不动手，见 looksInstalled）
  if (looksInstalled(pkgDir) !== true) return null
  // 规矩②：只有"本来就有完整的一份"才算自更新（首次安装 / 坏目录重装 ⇒ 不接管，既有行为原样保留）
  const before = verifySelfPackageDir(pkgDir, null, deps)
  if (before.ok !== true) return null
  const backup = backupSelfPackageDir(pkgDir, deps)
  return {
    packageName: name,
    packageDir: pkgDir,
    targetVersion: typeof targetVersion === 'string' && targetVersion !== '' ? targetVersion : null,
    previousVersion: backup.previousVersion ?? before.version,
    backupPath: backup.path,
    backupReason: backup.reason,
    backedUp: backup.ok === true,
    deps,
  }
}

/**
 * 「每一步结束都过一遍校验」（**记录器**：只读盘、不写盘、不抛）。
 * 自更新的三条通道（pnpm update / pnpm add / curl 手铺）各自收尾时调一次 ⇒ `selfUpdate.steps` 里能查到
 * "第几步之后目录是好的、哪一步把它弄坏了"。刻意**不改既有步骤条件**（某一步成功也照走既有的下一步），
 * 真正的自愈留到收尾统一做：**全部走完仍不过才动手**（见 settleSelfUpdateGuard）。session 为 null 时返回 null。
 */
function noteGuardStep(session, step) {
  if (session === null || session === undefined || typeof session !== 'object') return null
  const io = session.deps ?? {}
  const verdict = verifySelfPackageDir(session.packageDir, session.targetVersion ?? null, io)
  const row = {
    step: typeof step === 'string' && step !== '' ? step : 'unknown',
    verified: verdict.ok === true,
    version: verdict.version ?? null,
    reason: verdict.reason ?? null,
  }
  session.steps = Array.isArray(session.steps) ? session.steps : []
  session.steps.push(row)
  return row
}

/**
 * 收尾（**无论通道报成功还是报失败都要跑**）：校验 → 不过就自愈（改名挪开 + 从备份恢复 + 同一判据复核）
 * → 备份收口（最多留 KEEP_BACKUPS 份）→ 产出如实报告。session 为 null 时原样返回 null。
 * 返回的报告就是作业里那个 `selfUpdate` 字段（只增字段，见 installJobView）。
 */
function settleSelfUpdateGuard(session, { targetVersion = undefined, deps = {} } = {}) {
  if (session === null || session === undefined || typeof session !== 'object') return null
  const io = { ...(session.deps ?? {}), ...(deps ?? {}) }
  const expected = targetVersion === undefined
    ? session.targetVersion
    : (typeof targetVersion === 'string' && targetVersion !== '' ? targetVersion : null)
  const pkgDir = session.packageDir
  const out = {
    packageName: session.packageName ?? null,
    packageDir: pkgDir ?? null,
    targetVersion: expected ?? null,
    previousVersion: session.previousVersion ?? null,
    backedUp: session.backedUp === true,
    backupPath: session.backupPath ?? null,
    backupNote: session.backupReason ?? null,
    verified: false,
    healed: false,
    restoredVersion: null,
    brokenPath: null,
    selfHeal: null,
    reason: null,
    manualCommand: null,
    backupCleanup: null,
    steps: Array.isArray(session.steps) ? session.steps : [],
  }
  const first = verifySelfPackageDir(pkgDir, expected, io)
  out.verified = first.ok === true
  out.restoredVersion = first.version ?? null
  if (first.ok !== true) {
    out.reason = first.reason
    out.selfHeal = { attempted: true, restored: false, reason: null, mode: null, brokenPath: null, restoredVersion: null }
    if (session.backedUp !== true) {
      // 规矩③/⑥：备份没建起来 ⇒ 如实说"没有可用备份"（再给出用户可以自己跑的命令）
      out.selfHeal.reason = `没有可用备份：${session.backupReason ?? '更新前的备份没能建立'}`
    } else {
      const restored = restoreSelfPackageDir(pkgDir, session.backupPath, io)
      out.selfHeal.mode = restored.mode ?? null
      out.selfHeal.brokenPath = restored.brokenPath ?? null
      out.brokenPath = restored.brokenPath ?? null
      if (restored.ok !== true) {
        out.selfHeal.reason = restored.reason ?? '从备份恢复失败'
      } else {
        // 规矩④：**同一判据**再校验一次（期望值 = 备份里那一版 = 更新前的那一版）
        const again = verifySelfPackageDir(pkgDir, out.previousVersion, io)
        out.selfHeal.restored = again.ok === true
        out.selfHeal.restoredVersion = again.version ?? null
        out.selfHeal.reason = again.ok === true
          ? `已从备份恢复成更新前的 v${out.previousVersion ?? '?'}`
          : `已从备份恢复，但恢复后仍不过校验：${again.reason}`
        out.healed = again.ok === true
        if (again.ok === true) out.restoredVersion = again.version ?? null
      }
    }
  }
  // 备份收口（成败都收口到"最多 KEEP_BACKUPS 份"）：通过 ⇒ 本次这份也删掉；没通过 ⇒ 留着它（那是唯一的旧版）
  const dropped = out.verified === true ? dropBackupOf(out.backupPath) : null
  const pruned = pruneSelfBackups(pkgDir, { keep: KEEP_BACKUPS, deps: io })
  out.backupCleanup = {
    removed: [...(dropped !== null && dropped.removed === true ? [out.backupPath] : []), ...pruned.removed],
    kept: pruned.kept,
    note: dropped?.note ?? pruned.note ?? null,
  }
  if (out.verified !== true) {
    out.manualCommand = manualRestoreCommand({
      pkgDir,
      backupPath: out.backedUp === true ? out.backupPath : null,
      version: expected ?? out.previousVersion,
      deps: io,
    })
  }
  return out
}

/**
 * `/self-update` 通路的**收尾段**（2026-11-03 从 domain/selfupdate.js#selfUpdateToLatest **原样搬出**：
 * 那边贴着 600 行架构棘轮，而这段"清单 spec 跟上 + note 组装 + 返回结构"本来就是自洽的一节）。
 * 搬移只换了绑定来源 —— `CONSOLE_PACKAGE` / `isRegistryRange` / `label` 三个符号由调用方传进来
 * （domain 层不许反向 import selfupdate.js：那会成环，见 selfupdate.js#defaultSetSpec 的同一顾虑），
 * 正文逐字未改。
 *
 * 本轮只**加**自更新兜底的三件事（规矩⑥，绝不静默）：
 *   · 返回结构多 `ok` / `reason` / `selfUpdate`（既有 9 个字段名与语义一个都没动）；
 *   · 校验没过时把那段失败文案同时推进 `errors` 与 `note`（面板/接口都看得见）；
 *   · `installedVersion` 在"已自愈"时改报**盘上真实那一版**（否则会留一个 null 让人以为目录还是空的）。
 */
function finishSelfUpdate({ profileDir, packageName, latest, spec, installed, method, command, errors, lockVersion, lockUpdated, lockNote, registryRange, selfUpdate = null, copy = null, tarball = null, lockPatch = null, modeNote = null }) {
  const CONSOLE_PACKAGE = packageName
  const isRegistryRange = registryRange
  const label = (e) => (e instanceof Error ? e.message : String(e))
  const sourceSwitch = spec !== null && !isRegistryRange(spec) ? `安装来源已从 ${spec} 变为 registry 版本 ${latest}` : null

  // ④ 清单 spec 也要跟上（2026-09-24 实测踩到：lock 写了、spec 还钉着 0.3.57，
  //    于是下一次 pnpm 操作会把控制台「降级」回 0.3.57 —— 包管理器通道 ①② 通常会顺手改写 spec，
  //    但手铺兜底不会，所以这里统一收口：装到哪版就把 spec 写成哪版（来源型 spec 除外，绝不丢来源）。
  let specUpdated = null
  if (installed === latest && (spec === null || isRegistryRange(spec))) {
    try {
      const manifestPath = join(profileDir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const deps = { ...(manifest.dependencies ?? {}) }
      if (deps[CONSOLE_PACKAGE] !== latest) {
        deps[CONSOLE_PACKAGE] = latest
        manifest.dependencies = deps
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        specUpdated = latest
      }
    } catch (error) {
      errors.push(`清单 spec 同步失败：${label(error)}`)
    }
  } else if (installed === latest && spec !== null && !isRegistryRange(spec)) {
    errors.push(`清单 spec 是来源型（${spec}），按约定保留不改写`)
  }

  const noteParts = [lockUpdated ? '已写入 pnpm-lock.yaml，重启服务后生效' : '已铺入文件但未写入 pnpm-lock.yaml：重启后可用，但会被 pnpm 还原']
  if (sourceSwitch !== null) noteParts.push(sourceSwitch)
  if (specUpdated !== null) noteParts.push(`清单 spec 已同步为 ${specUpdated}（防 pnpm 降级）`)
  // ★ 2026-11-04 加法：手铺那一步到底怎么铺的、lock 补没补上，都要让用户看得见（绝不静默）
  if (copy !== null && copy !== undefined && copy?.channel === 'overlay') {
    noteParts.push(`用预下载的 tarball 只覆盖了 ${copy.files ?? '?'} 个文件、**没有清空目录**（原地保留 ${copy.preserved ?? 0} 个不在 tarball 里的文件）`)
  }
  if (lockPatch !== null && lockPatch !== undefined && lockPatch?.attempted === true) {
    if (lockPatch.changed === true && lockPatch.verified === true) noteParts.push(`pnpm-lock.yaml 已补齐 ${latest} 的版本/完整性并通过 pnpm 只读校验`)
    else if (lockPatch.changed === true && lockPatch.verified === null) noteParts.push(`pnpm-lock.yaml 已补齐 ${latest} 的版本/完整性，但 pnpm 的只读校验**无法确认**（${lockPatch.verifyNote ?? '原因未知'}）`)
    else if (lockPatch.reason !== null && lockPatch.reason !== undefined) noteParts.push(`pnpm-lock.yaml 未补齐：${lockPatch.reason}`)
  }
  // ★ 2026-11-04 加法：本轮到底走的是哪条腿（manual-overlay = 不走包管理器）、lock 同步到什么程度，一句说清
  if (typeof modeNote === 'string' && modeNote !== '') noteParts.push(modeNote)

  // ★ 加法：自更新校验的结论（只有"本插件自己 + 更新前就有完整副本"时 selfUpdate 才非空）
  const verified = selfUpdate === null || selfUpdate === undefined ? true : selfUpdate.verified === true
  const reason = verified === true ? null : selfUpdateFailureText(selfUpdate)
  if (reason !== null) errors.push(reason)
  if (reason !== null) noteParts.push(reason)
  const installedVersion = verified !== true && typeof selfUpdate.restoredVersion === 'string' ? selfUpdate.restoredVersion : installed
  return { method, spec: specUpdated ?? spec, installedVersion, lockVersion, lockUpdated, lockNote, command, note: noteParts.join('；'), errors, ok: verified, reason, selfUpdate: selfUpdate ?? null, copy: copy ?? null, tarball: tarball ?? null, lockPatch: lockPatch ?? null }
}

/**
 * `/self-update` 通路的**响应视图**（2026-11-03 从 routes/plugins.js#routeSelfUpdate 的 sendJson 字面量**原样搬出**：
 * 那个路由文件贴着 600 行架构棘轮，而"这条接口下发什么"本来就是自洽的一节 —— 与 install.js#installJobView
 * 同一手法：view 归 domain，路由只管发送）。字段表达式逐字照搬，**只多了** selfUpdate / reason 两项。
 *
 * ★ 唯一一处取值修正：`updated`。旧代码恒写 `true`，于是"自更新没落地"时会下发 `{ok:false, updated:true}`
 *   这种自相矛盾的响应（凡是按 updated 判断的消费方都会读成"已更新"）。现在它就是 `ok` 的同一事实。
 *   面板（lib/client.js:7376）只认 `data.ok === true`，所以这处修正不改变既有 UI 行为。
 */
function selfUpdateView({ result, current = null, latest = null }) {
  const ok = result?.ok !== false
  return {
    ok,
    current,
    latest,
    updated: ok,
    version: result.installedVersion ?? latest,
    method: result.method,
    spec: result.spec,
    installedVersion: result.installedVersion,
    lockVersion: result.lockVersion,
    lockUpdated: result.lockUpdated,
    lockNote: result.lockNote,
    command: result.command,
    note: result.note,
    errors: result.errors,
    selfUpdate: result.selfUpdate ?? null,
    reason: result.reason ?? null,
    // ★ 2026-11-04 加法（手铺兜底）：这三项只增不减 —— 既有字段名与取值语义一个都没动
    copy: result.copy ?? null,
    tarball: result.tarball ?? null,
    lockPatch: result.lockPatch ?? null,
  }
}

/** 失败文案（作业 error / 面板提示共用同一份；通过校验时返回 null）。
 *  一次说清四件事：没通过的原因、自愈有没有成、残缺目录留在哪、手动命令是什么。 */
function selfUpdateFailureText(selfUpdate) {
  if (selfUpdate === null || selfUpdate === undefined || typeof selfUpdate !== 'object') return null
  if (selfUpdate.verified === true) return null
  const parts = [`自更新没有完成：${selfUpdate.reason ?? '校验未通过'}（插件目录 ${selfUpdate.packageDir ?? '未知'}）。`]
  if (selfUpdate.healed === true) {
    parts.push(`已从更新前的备份自动恢复成 v${selfUpdate.restoredVersion ?? '?'}，本次更新**没有生效**（这不是更新成功）。`)
  } else if (selfUpdate.backedUp !== true) {
    parts.push(`无法自动恢复：${selfUpdate.selfHeal?.reason ?? '更新前没能建立备份'}。`)
  } else {
    parts.push(`自动恢复也失败了：${selfUpdate.selfHeal?.reason ?? '原因未知'}。`)
  }
  if (typeof selfUpdate.brokenPath === 'string' && selfUpdate.brokenPath !== '') {
    parts.push(`残缺目录已改名保留在 ${selfUpdate.brokenPath}（未删除，可自行核对）。`)
  }
  if (typeof selfUpdate.manualCommand === 'string' && selfUpdate.manualCommand !== '') {
    parts.push(`要手动处理可直接复制运行：${selfUpdate.manualCommand}`)
  }
  return parts.join('')
}

export {
  SELF_PACKAGE_FALLBACK, PRE_UPDATE_SUFFIX, BROKEN_SUFFIX, KEEP_BACKUPS,
  selfPackageNameOf, isSelfUpdate, looksInstalled, selfPackageDirOf, verifySelfPackageDir,
  backupSelfPackageDir, restoreSelfPackageDir, pruneSelfBackups, dropBackupOf,
  manualRestoreCommand, registryTarballUrlOf,
  beginSelfUpdateGuard, noteGuardStep, settleSelfUpdateGuard, finishSelfUpdate, selfUpdateView, selfUpdateFailureText,
}
