// L1 · domain —— persist.js（「下载即持久」的**唯一判据** + **唯一收口动作**；0.5.38 加法）
//
// 用户诉求原话（2026-10-04）：「能不能插件下载下来就不用 lock、重启也不会消失」。
// 现场（desktop profile 的 dshmarket）：包确实下载了、node_modules 里有、bundle 行也挂着，
// 但 `dependencies` 里没有条目 ⇒ 之后任何一次 pnpm 操作都把它当多余包清掉，
// 而面板当时报的是「已安装并启用」——**装了没钉住**被报成了成功。
//
// 定案（本模块是唯一承担者，别处不许再各判一套）：
//   「安装完成」= 三处齐备，缺一不可：
//     ① `<profile>/package.json` 的 `dependencies` 里有该包，且 spec 与**磁盘真实形态**一致
//        （`node_modules/<包名>` 是指向 plugin-src 的链接 → `link:`；真实目录 → 版本号；
//         `file:`/`git+`/URL 来源 → 原样保留，绝不改写成版本号）；
//     ② `<profile>/pnpm-lock.yaml` 里有该包的条目，且与 ① 的 spec 同一形态
//        （link: 依赖必须也钉在 link:，版本号必须逐字相等）；
//     ③ 重启后真的会被**挂载**：用户补丁里有它的 insert 行，或它已在 `dsh.profile.bundles` 里
//        且它自己声明了 `dsh.bundle.patch`（bundle 层会装入它自己的行），或运行时已有行提供它。
//   三者任一不成立 ⇒ `persisted:false` + `missing` 明细 + 结构化「一键钉住」动作 —— 面板**不许**报成功。
//
// 为什么判据必须集中在这一处（两处判据 = 下次框架/包管理器一变只有一处被修好）：
//   · 读文件的三个入口全部复用既有唯一真源：`profileSpec` / `readInstalledVersion` / `lockVersion`
//     （domain/selfupdate.js）、`linkSpecIsIntact`（domain/dep-source.js）、`parseInsertNames`
//     （domain/patch.js）——本模块**不新写任何 lock / 清单 / 补丁解析器**。
//   · 写入同样复用既有写入器：`pinProfileDependency`（link: 形态）/ `declareProfileDependency`
//     （registry 探测决定形态）/ `reconcileLockfile`（lock 对账）/ `appendInsert`（补丁行）/
//     `addBundleToManifest`（bundle 层）——本模块**不新造第二套写入**。
//
// 非 registry 来源的既有规矩（照旧，绝不违反）：`link:` / `file:` / `tgz` / git / URL 来源
// **不经** registry 解析 —— 因此本模块的判据里**没有**任何 "registry 404" 判定：
//   ① 只比"清单写成什么形态 vs 磁盘是什么形态"，② 只比"lock 里的条目 vs ① 的 spec 形态"。
//
// 分层：L1 domain —— 不认识 cordis ctx；IO 与四个写入器都可注入（便于离线单测跑正控/负控）。
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_SRC_DIR, linkSpecFor, profileNameOf, linkSpecIsIntact, sameSourceSpec } from './dep-source.js'
import { isUnder } from '../infra/framework-root.js'
import { addBundleToManifest, declareProfileDependency, pinProfileDependency, setProfileDependency } from './manifest.js'
import { appendInsert, parseInsertNames } from './patch.js'
import { deriveEntryId } from './runtime.js'
import { lockVersion, profileSpec, readInstalledVersion, reconcileLockfile } from './selfupdate.js'
import { dshHome, packageNameOf } from '../infra/paths.js'

/** 三处缺口的**稳定名字**（面板文案与测试都按它们断言，不许改写）。 */
const PERSIST_PARTS = ['dependency', 'lock', 'mount']

// ── 0.5.84 判据降噪：把「不一致」分成两类（**只分类，不改判据强度**）─────────────────
// 用户反馈：面板上到处是红字「未持久化」，但绝大多数并不影响使用 —— 看一眼就想关掉，
// 真正要紧的那条也跟着被无视了。所以这里给每个缺口定一个**机器可读的原因码**
// （`parts.*.code`），再按「这个不一致会不会让插件在重启后消失」分成两档：
//
//   critical（会丢插件，必须红）—— 只有这两种：
//     ① 清单里**没有**这个条目（或清单写的版本在磁盘上根本不存在）：
//        pnpm 下一次任何操作都会把这个"多余包"清掉 → 插件真的没了。
//     ② 挂载行**不满足**：包在盘上，但重启后没有任何行会加载它 → 用户视角"插件消失了"。
//        注意这一条判的是"重启后会不会被挂上"，与"包是不是已经下载"无关。
//
//   warn（只是口径不一致，重启后照常加载，降级成可折叠提示）—— 其余全部：
//     · lock 条目缺失 / 形态不符 / 指向的目标不同：**清单才是事实来源**，pnpm 会按清单重算 lock，
//       插件本身不会被清掉（最坏情况是 lock 被重写成同样的结论）。
//     · 清单声明 link: 而磁盘是真实目录、或精确版本与磁盘版本不一致：包就在那里，
//       pnpm 会把它改写成清单说的形态/版本 —— 换的是那一份副本，不是"没有"。
//
// 为什么要在**服务端**分（而不是让面板各自判）：判据分两处必然分叉（本仓已多次踩过），
// 而"会不会丢"这件事需要同时看清单、lock 与挂载行的真实值 —— 只有这里同时握着这三份事实。
/** 会丢插件（必须红）的原因码。表里没有的码一律按 warn 处理（保守方向：宁可少报红）。 */
const PERSIST_CRITICAL_CODES = new Set([
  'dep-missing-entry',   // 清单 dependencies 里没有它 → pnpm 会当多余包清掉
  'dep-link-broken',     // 清单钉的 link 目标不存在 → 这份链接是断的，pnpm 只会把它当坏的
  'dep-version-missing', // 清单写了精确版本，但盘上根本没有这个包
  'dep-range-missing',   // 清单写了范围/dist-tag，但盘上没有这个包
])
/** 只是为了让人看得懂原因码说的是什么（面板不读它，测试与日志用它）。 */
const PERSIST_CODE_TEXT = {
  'dep-missing-entry': '清单 dependencies 里没有条目',
  'dep-link-broken': '清单钉的 link 目标不成立',
  'dep-version-missing': '盘上没有这个版本',
  'dep-range-missing': '盘上没有这个包',
  'dep-link-not-a-link': '清单是 link: 但盘上是真实目录',
  'dep-version-drift': '清单版本与磁盘版本不一致',
  'lock-missing-entry': 'lock 里没有条目',
  'lock-link-target-drift': 'lock 的 link 目标与清单不同',
  'lock-form-drift': 'lock 的形态与清单不同',
  'lock-version-drift': 'lock 的版本与清单不同',
  'lock-unverified': 'lock 写入后未被只读校验确认',
  'mount-bundle-no-patch': '在 bundles 里但没声明 bundle 补丁',
  'mount-bundle-patch-missing': '声明的 bundle 补丁文件不存在',
  'mount-bundle-patch-empty': 'bundle 补丁里没有任何 insert 行',
  'mount-no-row': '补丁/bundles/运行时都没有它的行',
}
/** `mount-*` 一律 critical（挂不上就是"重启后看不见"）；这里显式列出，避免靠前缀猜。 */
const PERSIST_CRITICAL_MOUNT = new Set(['mount-bundle-no-patch', 'mount-bundle-patch-missing', 'mount-bundle-patch-empty', 'mount-no-row'])

/** 某个原因码算不算"会丢插件"。 */
function isPersistCriticalCode(code) {
  return PERSIST_CRITICAL_CODES.has(code) || PERSIST_CRITICAL_MOUNT.has(code)
}


/** 精确版本号形态（`1.2.3` / `0.0.1-rc1`）：只有它才要求与磁盘版本逐字相等。 */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
/** 来源型 spec 前缀（协议）——这些形态**绝不**改写成版本号（改写等于丢来源）。 */
const SOURCE_SPEC_RE = /^(?:link:|file:|git\+|git:|github:|https?:|workspace:|portal:)/u

/** 读 profile 清单（读不到返回 null；绝不因为读不到就抛）。 */
function readManifestSync(profileDir) {
  try {
    return JSON.parse(readFileSync(join(String(profileDir), 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** `dsh.profile.bundles`（读不到就空数组）。 */
function readBundlesSync(profileDir) {
  const manifest = readManifestSync(profileDir)
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((x) => typeof x === 'string' && x !== '') : []
}

/**
 * 磁盘**真实形态**（不猜）：`node_modules/<包名>` 是指向别处的链接 → `link:<真实目标>`；
 * 真实目录 → 版本号；都没有 → missing。
 * Windows 的 junction 在 lstat 里同样是 symbolic link；`realpathSync` 拿到**规范化后的目标**
 * （与 `linkSpecIsIntact` 的判据同一把尺子，因此"清单写的绝对路径"不必与磁盘逐字相同也算数）。
 */
function diskFormOf(profileDir, packageName) {
  const dir = join(String(profileDir), 'node_modules', ...String(packageName).split('/'))
  const version = readInstalledVersion(profileDir, packageName)
  if (!existsSync(join(dir, 'package.json'))) return { form: 'missing', spec: null, version, target: null }
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      const target = realpathSync(dir)
      return { form: 'link', spec: linkSpecFor(target), version, target }
    }
  } catch {}
  return { form: 'version', spec: version, version, target: null }
}

/** ① 依赖声明：清单里的 spec 与磁盘真实形态是否一致。 */
function dependencyPart({ profileDir, packageName }) {
  const spec = profileSpec(profileDir, packageName)
  const disk = diskFormOf(profileDir, packageName)
  const out = { ok: false, spec, form: null, disk: { form: disk.form, version: disk.version }, reason: null, code: null }
  if (spec === null) {
    out.code = 'dep-missing-entry'
    out.reason = 'package.json 的 dependencies 里没有这个条目（pnpm 会把它当多余包清掉）'
    return out
  }
  const trimmed = spec.trim()
  if (trimmed.startsWith('link:')) {
    out.form = 'link'
    if (disk.form !== 'link') {
      out.code = 'dep-link-not-a-link'
      out.reason = `清单是 ${trimmed}，但 node_modules/${packageName} 不是指向它的链接（磁盘上实际是 ${disk.form === 'missing' ? '不存在' : '真实目录'}）`
      return out
    }
    if (!linkSpecIsIntact(profileDir, packageName, trimmed)) {
      out.code = 'dep-link-broken'
      out.reason = `清单是 ${trimmed}，但链接当前不成立（目标不存在或指向别处）`
      return out
    }
    out.ok = true
    return out
  }
  if (SOURCE_SPEC_RE.test(trimmed)) {
    // file: / git+ / URL / workspace: …：来源即事实，本地无法逐字校验 ⇒ 有条目即算就位（绝不改写成版本号）
    out.form = 'source'
    out.ok = true
    return out
  }
  if (EXACT_VERSION_RE.test(trimmed)) {
    out.form = 'version'
    if (disk.version === null) {
      out.code = 'dep-version-missing'
      out.reason = '清单写的是版本号，但 node_modules 里读不到该包的版本（没装或被还原）'
      return out
    }
    if (disk.version !== trimmed) {
      out.code = 'dep-version-drift'
      out.reason = `清单写 ${trimmed}，磁盘上是 ${disk.version} —— 两处对不上`
      return out
    }
    out.ok = true
    return out
  }
  // 版本范围（^1.2.3）或 dist-tag（latest/next）：registry 来源但非精确值 —— 有条目且装上了即算就位
  out.form = 'range'
  if (disk.version === null) {
    out.code = 'dep-range-missing'
    out.reason = `清单写 ${trimmed}，但 node_modules 里读不到该包（没装或被还原）`
    return out
  }
  out.ok = true
  return out
}

/** ② lock 条目：与 ① 的 spec 同一形态（link: ↔ link:；精确版本 ↔ 逐字相等）。 */
function lockPart({ profileDir, packageName, spec }) {
  const entry = lockVersion(profileDir, packageName)
  const out = { ok: false, entry: entry ?? null, reason: null, code: null }
  if (entry === null || entry === undefined) {
    out.code = 'lock-missing-entry'
    out.reason = 'pnpm-lock.yaml 里没有这个包的条目（任何一次 pnpm 操作都可能把它还原/清掉）'
    return out
  }
  const value = String(entry).trim()
  const s = typeof spec === 'string' ? spec.trim() : ''
  if (s.startsWith('link:')) {
    // 0.5.39 改错（Fix 2）：link 条目还必须**指向清单里的同一个目标** —— 只判"以 link: 开头"会把
    // 「清单指 A、lock 指 B」当成就位，而 pnpm 下一次操作会按 lock 把链接还原到 B（真实漂移）。
    if (value.startsWith('link:') && sameSourceSpec(profileDir, value, s)) {
      out.ok = true
      return out
    }
    out.code = value.startsWith('link:') ? 'lock-link-target-drift' : 'lock-form-drift'
    out.reason = value.startsWith('link:')
      ? `清单把该包钉在 ${s}，而 lock 里是 ${value}（**指向的目标不同**，对账后会被 pnpm 还原）`
      : `清单把该包钉在 ${s}，而 lock 里是 ${value}（对账后会被 pnpm 还原）`
    return out
  }
  if (EXACT_VERSION_RE.test(s)) {
    // lock 的 importer `version:` 对**带 peer 的**包会写成 `0.2.0-rc.2(@scope/peer@x)`（真机
    // `@deepseek-ai/dsh-experimental-schedule-bundle` 就是这个形态）—— 前导版本号相等即算同版，
    // 后缀是 pnpm 的 peer 解析记录，不是"另一个版本"。
    const core = value.replace(/\(.*$/u, '').replace(/_[^_]*$/u, '').trim()
    if (core === s || value === s) {
      out.ok = true
      return out
    }
    out.code = 'lock-version-drift'
    out.reason = `清单写 ${s}，lock 里是 ${value} —— 两处对不上`
    return out
  }
  // 范围 / dist-tag / 来源型：lock 有条目即算就位（形态由 pnpm 自己解析，本地不猜）
  out.ok = true
  return out
}

/** ③ 挂载行：用户补丁 insert 行 / bundle 层 / 运行时已有行，三者任一成立即算会挂载。 */
function mountPart({ profileDir, patchPath, packageName, patchText = null, bundles = null, entries = null }) {
  const out = { ok: false, via: 'none', rowId: null, bundlePatch: null, reason: null, code: null }
  // 运行时已有行提供它（例如聚合包里的行）：最直接的证据，先看
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const moduleName = String(entry?.moduleName ?? '')
      if (moduleName === packageName || packageNameOf(moduleName) === packageName) {
        return { ...out, ok: true, via: 'live-entry', rowId: entry.rowId ?? entry.entryId ?? null }
      }
    }
  }
  // 用户补丁里的 insert 行
  let text = patchText
  if (typeof text !== 'string') {
    try {
      text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    } catch {
      text = ''
    }
  }
  for (const [id, name] of parseInsertNames(text)) {
    if (String(name).trim() === packageName) return { ...out, ok: true, via: 'patch-row', rowId: id }
  }
  // bundle 层：只有"它自己声明了 dsh.bundle.patch"时框架才会装入它自己的行
  const list = Array.isArray(bundles) ? bundles : readBundlesSync(profileDir)
  if (list.includes(packageName)) {
    const pkgPath = join(String(profileDir), 'node_modules', ...String(packageName).split('/'), 'package.json')
    let rel = null
    try {
      rel = JSON.parse(readFileSync(pkgPath, 'utf8'))?.dsh?.bundle?.patch ?? null
    } catch {
      rel = null
    }
    if (typeof rel !== 'string' || rel === '') {
      out.code = 'mount-bundle-no-patch'
      out.reason = `已在 dsh.profile.bundles 里，但该包没有声明 dsh.bundle.patch —— bundle 层不会装入任何行，需要一条 insert 行`
      return out
    }
    const file = join(String(profileDir), 'node_modules', ...String(packageName).split('/'), rel)
    if (!existsSync(file)) {
      out.bundlePatch = file
      out.code = 'mount-bundle-patch-missing'
      out.reason = `dsh.profile.bundles 里有它，但它声明的 bundle 补丁文件不存在（${file}）`
      return out
    }
    let rows = new Map()
    try {
      rows = parseInsertNames(readFileSync(file, 'utf8'))
    } catch {
      rows = new Map()
    }
    if (rows.size === 0) {
      out.bundlePatch = file
      out.code = 'mount-bundle-patch-empty'
      out.reason = `bundle 补丁里读不到任何 insert 行（${rel}）—— 没有任何东西会被挂载`
      return out
    }
    return { ...out, ok: true, via: 'bundle', rowId: [...rows.keys()][0], bundlePatch: file }
  }
  out.code = 'mount-no-row'
  out.reason = '用户补丁里没有它的 insert 行，dsh.profile.bundles 里也没有它 —— 重启后不会被挂载'
  return out
}

/**
 * 0.5.84 判据降噪的**唯一判据**：这次不一致会不会让插件在重启后消失？
 * 输入可以是一份 `persistReport()` 的结果（只看 `parts` / `missing`），也可以是裸的 `parts`。
 * 返回 `{ level, losesAfterRestart, critical, downgraded, codes, note }`：
 *   · `level: 'ok'`        三处齐备（不会多报红）
 *   · `level: 'critical'`  至少一处会丢插件（清单里没有 / 挂不上）→ 面板必须报红
 *   · `level: 'warn'`      只有口径不一致（lock 形态/目标、清单形态与磁盘不同）→ 降级成提示
 * `note` 是**降级后**那句人话（critical 时与旧 persistNote 同一句，warn 时换软一点的措辞）；
 * 旧的 `report.note` / `persisted` / `suggestedPersistAction` **一个字都没动**（安装闸门语义不变）。
 */
function persistSeverity(input) {
  const parts = input !== null && typeof input === 'object' && input.parts !== undefined && input.parts !== null
    ? input.parts
    : (input !== null && typeof input === 'object' ? input : {})
  const partsOf = {}
  for (const key of PERSIST_PARTS) {
    const part = parts[key]
    partsOf[key] = part === undefined || part === null ? null : part
  }
  const openParts = PERSIST_PARTS.filter((key) => partsOf[key] !== null && partsOf[key].ok !== true)
  const codes = {}
  const critical = []
  const downgraded = []
  for (const key of openParts) {
    const code = typeof partsOf[key].code === 'string' && partsOf[key].code !== '' ? partsOf[key].code : `${key}-unknown`
    codes[key] = code
    // 表里没有的码一律按 warn（保守方向：宁可少报红，也不拿红字打扰人）
    if (isPersistCriticalCode(code)) critical.push(key)
    else downgraded.push(key)
  }
  const losesAfterRestart = critical.length > 0
  const level = openParts.length === 0 ? 'ok' : (losesAfterRestart ? 'critical' : 'warn')
  const labels = { dependency: '① 清单 dependencies', lock: '② pnpm-lock.yaml', mount: '③ 挂载行（cordis.patch.yml / bundles）' }
  let note = null
  if (level === 'critical') {
    const rows = critical.map((key) => `${labels[key]}：${(partsOf[key] && partsOf[key].reason) ?? PERSIST_CODE_TEXT[codes[key]] ?? '未就位'}`)
    note = `未持久化（重启或任何一次 pnpm 操作后可能消失）—— ${rows.join('；')}`
    if (downgraded.length > 0) {
      note += `。另有 ${downgraded.length} 处口径不一致（不影响重启后加载）：${downgraded.map((key) => labels[key] + '：' + ((partsOf[key] && partsOf[key].reason) ?? '不一致')).join('；')}`
    }
  } else if (level === 'warn') {
    const rows = downgraded.map((key) => `${labels[key]}：${(partsOf[key] && partsOf[key].reason) ?? '不一致'}`)
    note = `口径不一致（**不影响重启后加载**，只是清单 / lock 没对齐，下次 pnpm 操作会自行收敛）—— ${rows.join('；')}`
  }
  return { level, losesAfterRestart, critical, downgraded, codes, note }
}

/**
 * 持久化判据（**只读**，永不抛）：返回
 * `{ persisted, packageName, missing, parts:{dependency,lock,mount}, note }`。
 * 三个阶段各自读盘（不信任调用方传进来的 job 字段），missing 的顺序恒为 PERSIST_PARTS 的顺序。
 */
function persistReport({ profileDir, patchPath, packageName, entries = null, patchText = null, bundles = null }) {
  const dep = dependencyPart({ profileDir, packageName })
  const lock = lockPart({ profileDir, packageName, spec: dep.spec })
  const mount = mountPart({ profileDir, patchPath, packageName, patchText, bundles, entries })
  const parts = { dependency: dep, lock, mount }
  const missing = PERSIST_PARTS.filter((key) => parts[key].ok !== true)
  const report = {
    persisted: missing.length === 0,
    packageName,
    missing,
    parts,
    actual: {
      spec: dep.spec,
      lockEntry: lock.entry,
      mountVia: mount.via,
      version: dep.disk.version,
      inBundles: (Array.isArray(bundles) ? bundles : readBundlesSync(profileDir)).includes(packageName),
    },
  }
  report.note = report.persisted ? null : persistNote(report)
  // 0.5.84 加法：同一份事实多一档"要不要报红"的结论（判据见 persistSeverity 顶部）。
  // 旧的 persisted / note 保持原样 —— 这里只多一个字段，老调用点（与安装闸门）一个字都不用改。
  report.severity = persistSeverity(report)
  return report
}

/** 缺口 → 人话（**如实**：说清实际是什么、缺的是哪一处、后果是什么）。 */
function persistNote(report) {
  const labels = { dependency: '① 清单 dependencies', lock: '② pnpm-lock.yaml', mount: '③ 挂载行（cordis.patch.yml / bundles）' }
  const rows = report.missing.map((key) => `${labels[key]}：${report.parts[key].reason ?? '未就位'}`)
  return `未持久化（重启或任何一次 pnpm 操作后可能消失）—— ${rows.join('；')}`
}

/** 结构化「一键钉住」动作（面板据此渲染执行框；命令只供展示/复制，执行侧只认 payload.action）。 */
function suggestedPersistAction({ packageName, profile = null, profileDir = null, missing = [], reason = null } = {}) {
  const name = profile ?? profileNameOf(profileDir)
  const list = Array.isArray(missing) ? missing.filter((m) => typeof m === 'string' && m !== '') : []
  return {
    kind: 'persist-plugin',
    label: '一键钉住（清单 + lock + 挂载行）',
    command: `dsh-plugin-console: persist-plugin ${packageName}`,
    payload: { action: 'persist-plugin', packageName, profile: name },
    missing: list,
    reason,
  }
}

/**
 * 收口动作（**唯一的写入入口**）：把 ①②③ 里缺的部分补齐，然后**读回磁盘**再判一次。
 *   · ① 缺/形态不一致 → 按磁盘真实形态写：链接 → `pinProfileDependency`（link: 并物化到 plugin-src）；
 *     真实目录 → `declareProfileDependency`（自带 registry 可解析性判定：非 registry 来源写 link:）；
 *   · ② 缺/形态不一致 → `reconcileLockfile`（既有对账通道，argv/写回形态同安装路径）；
 *   · ③ 缺 → `mode==='bundle'` 时补 `dsh.profile.bundles`；否则追加一条 insert 行（entry id 由
 *     `deriveEntryId` 按既有规则产出）。`mode==='served'` 时**绝不写行**（已有行提供它，再写就是重复装配）。
 *
 * 2026-10-06 接线（0.5.41）：`sourceSpec` / `sourceOrigin` 由**安装通道**一路传进来 ——
 * 取样通道（curl / GitHub release 资产 / 源码装配）装的包，真实来源规格在这里被交给
 * `declareProfileDependency({sourceSpec, sourceOrigin:'sampled'})` ⇒ `pnpm add <spec>` 真装，
 * 依赖与 peer 由包管理器保证；真装失败则回落既有 `link:` 路径并**如实**报
 * 「已装上（link 方式）· 真装失败：… · 可一键真装」（回落只对"物已在盘上"成立）。
 * 返回 `{ persisted, before, after, missing, declared, lock, notes, suggested, note, rowId }`；
 * 任何一步失败都**如实**留在 notes 里，绝不影响收口的返回值语义（persisted 只认最终读回结果）。
 */
async function ensurePersisted({ profileDir, patchPath, packageName, mode = 'insert', taken = null, entries = null, registries = [], deps = {}, sourceSpec = null, sourceOrigin = null, sourceKind = null } = {}) {
  const pin = typeof deps.pin === 'function' ? deps.pin : pinProfileDependency
  const declare = typeof deps.declare === 'function' ? deps.declare : declareProfileDependency
  const setSpec = typeof deps.setSpec === 'function' ? deps.setSpec : setProfileDependency
  const reconcile = typeof deps.reconcile === 'function' ? deps.reconcile : reconcileLockfile
  const insert = typeof deps.insert === 'function' ? deps.insert : appendInsert
  const addBundle = typeof deps.addBundle === 'function' ? deps.addBundle : addBundleToManifest
  const notes = []
  const before = persistReport({ profileDir, patchPath, packageName, entries })
  let declared = null
  let lock = null
  let rowId = before.parts.mount.rowId
  // ① 依赖声明（按磁盘真实形态写，绝不猜）
  if (before.parts.dependency.ok !== true) {
    const disk = diskFormOf(profileDir, packageName)
    try {
      if (disk.form === 'link' && isUnder(disk.target, join(dshHome(), PLUGIN_SRC_DIR))) {
        // 目标已经在 plugin-src 里 → 走既有「钉住」（幂等：realpath 相同则不会重复物化）
        const pinned = await pin(profileDir, packageName, {})
        declared = { changed: pinned.changed === true, spec: pinned.after ?? null, form: 'link', lockSynced: null, lockNote: null, depNote: null, suggested: null }
        notes.push(pinned.changed === true
          ? `清单已按磁盘真实形态钉成 ${pinned.after}（node_modules 里就是指到这个目录的链接）`
          : `清单里已是 ${pinned.after ?? '（无条目）'}（无需改动）`)
      } else if (disk.form === 'link') {
        // 目标是用户自己的位置（开发目录 / 别的盘）→ **原样写这条链接**，绝不复制成 plugin-src 的新拷贝
        const wrote = await setSpec(profileDir, packageName, disk.spec)
        declared = { changed: wrote.changed === true, spec: wrote.after ?? disk.spec, form: 'link', lockSynced: null, lockNote: null, depNote: null, suggested: null }
        notes.push(`清单已按磁盘真实值写成 ${wrote.after ?? disk.spec}（该链接指向用户自己的位置，未做物化复制）`)
      } else if (disk.form === 'version') {
        // 来源型（安装通道知道真实来源规格）：把规格一并交给写入层 —— 由它决定"真装 / link:"
        // （0.5.41 接线；没传规格时形状与默认值一个字都不变）。
        // `deps.installSource` / `deps.syncLock` 是**离线测试缝**（与 deps.pin / deps.declare 同一风格）：
        // 正控/负控要能确定性地让"包管理器那一步"成功或失败、并让 lock 那一步不跑真 pnpm，
        // 生产调用方不传时用的就是真实 `pnpm add` 与真实 lock 对账。
        declared = await declare(profileDir, packageName, disk.version, {
          registries,
          ...(typeof sourceSpec === 'string' && sourceSpec !== '' ? { sourceSpec, sourceOrigin, sourceKind } : {}),
          ...(typeof deps.installSource === 'function' ? { installSource: deps.installSource } : {}),
          ...(deps.syncLock === false ? { syncLock: false } : {}),
          // ★ 0.5.87 加法（用户红线：正常下载安装/更新绝不能产出 link:/file:）：`registry-tarball` 是
          // curl 通道从 registry 元数据里拿到 dist.tarball 并**校验摘要后**铺进去的 —— 这份物**证明**
          // 该版本在 registry 上存在。于是探测说"查无此包/此版本"只能算探测失败，不能据此物化成 link:
          // （详见 manifest.js#planDependencySpec 的 registryProven 分支）。其它来源一律不置位。
          ...(sourceKind === 'registry-tarball' ? { registryProven: true } : {}),
        })
        if (declared.changed !== true) notes.push(`清单里已有这个包（实际是 ${declared.spec ?? disk.version}）`)
        if (declared.depNote !== null && declared.depNote !== undefined) notes.push(declared.depNote)
      } else {
        notes.push(`node_modules 里读不到 ${packageName} —— 无法判断该写成什么形态，已跳过清单写回（绝不凭空猜一个 spec）`)
      }
    } catch (error) {
      notes.push(`清单写回失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // ② lock 对账
  const mid = persistReport({ profileDir, patchPath, packageName, entries })
  if (mid.parts.lock.ok !== true) {
    try {
      // 0.5.41：本次带来的是 **tarball URL** 来源规格（刚真装过）⇒ 不许对账把它规整回 link:
      // （判据与 manifest.js#declareProfileDependency 的同一套：只有这一段来源型接线会点名 keepUrlSpecs）。
      const keepUrlSpecs = (typeof sourceSpec === 'string' && /^https?:/u.test(sourceSpec.trim()))
        || (declared !== null && declared !== undefined && declared.form === 'source' && /^https?:/u.test(String(declared.spec ?? '')))
        ? [packageName] : []
      lock = await reconcile({
        profileDir, packages: [{ name: packageName }], registries,
        ...(keepUrlSpecs.length > 0 ? { keepUrlSpecs } : {}),
      })
      if (lock.lockNote !== null && lock.lockNote !== undefined) notes.push(lock.lockNote)
      else if (lock.depNote !== null && lock.depNote !== undefined) notes.push(lock.depNote)
    } catch (error) {
      notes.push(`lock 对账失败：${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (declared !== null && declared.lockSynced === false && declared.lockNote !== null) {
    notes.push(declared.lockNote)
  }
  // ③ 挂载行
  const pre = persistReport({ profileDir, patchPath, packageName, entries })
  let bundled = null
  if (pre.parts.mount.ok !== true && mode !== 'served') {
    try {
      if (mode === 'bundle') {
        bundled = await addBundle(profileDir, packageName)
      } else {
        const id = deriveEntryId(packageName, taken instanceof Set ? taken : new Set())
        const row = await insert(patchPath, id, packageName)
        rowId = id
        if (row && row.changed === false && row.reason !== undefined) {
          notes.push(`未新写补丁行（原因：${row.reason}）—— 由既有声明承担挂载`)
        }
      }
    } catch (error) {
      notes.push(`挂载行写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const after = persistReport({ profileDir, patchPath, packageName, entries })
  // 0.5.39 加法（修 1 的收尾）：reconcile 写出 lock importer 条目后会用 pnpm 的**只读**用法确认 lock
  // 仍可解析；「没通过 / 无法确认」时**不能**因为磁盘上有那两行就报成功 —— 按未持久化处理。
  // 判据与文案都来自同一条通路（reconcile 的 lockVerified/lockNote），本模块只把结论并进来，不新判一套。
  let lockVerdict = null
  if (lock !== null && typeof lock === 'object' && (lock.lockVerified === false || lock.lockVerified === null) && lock.lockUpdated !== true) {
    const reason = lock.lockNote ?? 'lock 已写入，但 pnpm 的只读校验未能确认它可解析'
    after.parts.lock = { ...after.parts.lock, ok: false, reason }
    after.missing = PERSIST_PARTS.filter((key) => after.parts[key].ok !== true)
    after.persisted = after.missing.length === 0
    after.note = after.persisted ? null : persistNote(after)
    // 0.5.84：这一档判据也改了 parts（lock → ok:false），降噪结论必须跟着重算，否则会拿旧的
    after.severity = persistSeverity(after)
    lockVerdict = { verified: lock.lockVerified, reason }
  }
  // 0.5.41 接线：真装失败时写入层会下发「一键真装」动作 —— 它优先于"钉住"（此时用户要的是真装那一步）；
  // 只有三处都没就位时仍按老规矩给「一键钉住」（收口更根本）。老客户端忽略该字段，向后兼容。
  const declaredAction = declared !== null && declared !== undefined && declared.suggested !== null && declared.suggested !== undefined
    ? declared.suggested
    : null
  const suggested = after.persisted
    ? declaredAction
    : suggestedPersistAction({ packageName, profileDir, missing: after.missing, reason: after.note })
  const sourceInstall = declared !== null && declared !== undefined && declared.sourceInstall !== undefined ? declared.sourceInstall : null
  return {
    persisted: after.persisted,
    before,
    after,
    missing: after.missing,
    parts: after.parts,
    declared,
    lock,
    lockVerdict,
    bundled,
    rowId: after.parts.mount.rowId ?? rowId ?? null,
    notes,
    suggested,
    note: after.note,
    sourceInstall,
  }
}

export {
  PERSIST_PARTS, EXACT_VERSION_RE, SOURCE_SPEC_RE, readManifestSync, readBundlesSync, diskFormOf,
  dependencyPart, lockPart, mountPart, persistReport, persistNote, suggestedPersistAction, ensurePersisted,
  // 0.5.84 判据降噪：原因码表 + 唯一判据 + 判定函数（面板与测试都只认这一份）
  PERSIST_CRITICAL_CODES, PERSIST_CRITICAL_MOUNT, PERSIST_CODE_TEXT, isPersistCriticalCode, persistSeverity,
}
