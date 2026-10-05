// L1 · domain —— selfupdate.js（控制台自更新：**包管理器优先**，保证升级真的写进 pnpm-lock.yaml）
//
// 缺陷背景（2026-09-20 用户实测报告，附完整时间线）：
//   旧的 `/self-update` 直接把 npm tarball 的文件铺进 profile 的 node_modules，**不碰 pnpm-lock.yaml**；
//   而 profile 的依赖是 pnpm 按 lock 管理的（`dsh plugin` 本身就是 pnpm 的薄转发器）。于是只要发生
//   **任何一次 pnpm 操作**——开关任意插件（会改 `dsh.profile.bundles`）、`dsh plugin add/remove/install`——
//   pnpm 就按 lock 重装，把刚"升级"上去的版本**还原**回 lock 里钉住的旧版本。
//   用户侧现象：UI 一直提示有新版（package.json 写 `^0.3.47` 允许 0.3.54），点更新显示成功、重启后还是旧版。
//
// 现在的顺序：① spec 是版本范围 → `pnpm update <pkg>`（spec 不变、lock 提到范围内最新）
//            ② 仍不是 latest（超出范围 / spec 是 git·file 来源）→ `pnpm add <pkg>@<latest>`（spec 与 lock 同步改写）
//            ③ 回读核实 readInstalledVersion / lockVersion；都不匹配才回落手铺文件，且**必须**带 lockNote 警告。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { linkSpecFor, linkSpecIsIntact, materializePackageForLink, probeRegistryPackage, sameSourceSpec, suggestedPinAction } from './dep-source.js'
import { canWriteImporterEntry, lockEntryKeyMatches, verifyLockReadOnly, writeLockImporterEntry } from './lock-importer.js'
import { readManifestDeps } from './lockfile-health.js'
import { pnpmInstall } from './install.js'
import { fetchJsonUrl } from '../infra/http.js'
import { runPnpmWithFallback } from '../infra/exec.js'

const CONSOLE_PACKAGE = '@noob-stupid/dsh-plugin-console'

/** spec 是否是 registry 版本范围（`^1.2.3` / `~1.2.3` / `1.2.3` / `>=1` / `=1`）。
 * 只有这种才能用 `pnpm update` 在**不改写 spec**的前提下把 lock 提到范围内最新；
 * git / file / link / workspace 来源没有"范围"可言，只能走 `pnpm add <pkg>@<版本>`。 */
function isRegistryRange(spec) {
  if (typeof spec !== 'string') return false
  const s = spec.trim()
  if (/^[\^~]?\d/u.test(s)) return true
  return /^(>=|>|=)\s*\d/u.test(s)
}

/** profile 里该包的依赖声明（spec）。读不到返回 null。 */
function profileSpec(profileDir, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const spec = pkg?.dependencies?.[name]
    return typeof spec === 'string' ? spec : null
  } catch {
    return null
  }
}

/** 已安装版本（直接读 node_modules 里那份 package.json）。 */
function readInstalledVersion(profileDir, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 从 pnpm-lock.yaml 读出该包被**钉住**的版本。解析策略（lock 格式五花八门，只认两种确定性位置，避免子串误命中）：
 *   ① importers 段：行内容恰为 `'<name>':`（可带缩进），随后几行内的 `version: X`；
 *   ② packages 段：行首（可带缩进/引号）`<name>@<版本或 git+...>:` 的键名。
 * 读不到返回 null（调用方据此判定"没能核实"，不谎报成功）。
 *
 * ★ 2026-09-22 修复（缺陷②连带）：旧版 ① 在遇到 `specifier: …` 行时**直接 break**，而 importers 段
 *   恒为 `specifier:` 在前、`version:` 在后 → ① 从来没生效过，全靠 ② 兜底；而 ② 的正则用 `[^':\s]+`
 *   取值，遇到 `name@https://…tgz` / `link:…` 会在第一个冒号处截断（读出 `http`）或读不到（link 依赖
 *   在 lock 里没有 packages 条目 → 返回 null）。后果：来源钉住的包永远被判为「漂移」→ 每次安装都白跑
 *   一次 pnpm add，并给用户一条假的「没写进 lock」警告。现在 ① 跳过 specifier 行、② 取到行尾。
 */
function lockVersion(profileDir, name) {
  const file = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(file)) return null
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/u)
  } catch {
    return null
  }
  for (let i = 0; i < lines.length; i += 1) {
    // 键形态三种都认（0.5.38 改错）：`name`、`'name':`（pnpm 对**含 `/`/`@`** 的包名加引号）、
    // `name:`（pnpm 对**未加 scope** 的包名不加引号）。旧判据漏了第三种 ⇒ 未加 scope 的 `link:`
    // 依赖在 importers 里明明有条目却读不出来（真机 desktop profile 的 `dshmarket` 就是：
    // lock 的 35-37 行写着 `dshmarket: / specifier: link:… / version: link:../../plugin-src/dshmarket`，
    // 而 `lockVersion()` 返回 null）——后果是面板永远报"没写进 pnpm-lock.yaml"、pin 永远 partial、
    // 每次对账都白跑一次 `pnpm add`。真值一律从下面这一处读，别在调用方再补一套。
    // 0.5.39：键判据搬进 lock-importer.js#lockEntryKeyMatches —— 定点**写**入也要认同一批键形态，
    // 两处各写一份必然再次分叉（写进去的键、读的时候认不出，就是 0.5.38 那个现场）。
    if (lockEntryKeyMatches(lines[i], name)) {
      for (let k = i + 1; k < Math.min(i + 8, lines.length); k += 1) {
        const m = /^\s*version:\s*(\S+)\s*$/u.exec(lines[k])
        if (m) return m[1]
        // 只在新包的键行（`'<name>':` 形态）处停止；`specifier: X` 有值，不是键行，必须继续往下看
        if (/^\s*'?[^\s:]+'?:\s*$/u.test(lines[k])) break
      }
    }
  }
  const escaped = name.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&')
  // 取到行尾再剥尾部的引号/冒号：`'name@https://…tgz':` / `name@git+https://…#sha:` / `name@1.2.3:`
  const keyRe = new RegExp(`^\\s*'?${escaped}@(.+?)'?:\\s*$`, 'u')
  for (const line of lines) {
    const m = keyRe.exec(line)
    if (m) return m[1]
  }
  return null
}

/** 给用户的兜底建议命令（照用户报告里那条：让 lock 也变成新版本，而不是只改文件）。 */
function selfUpdateCommand(latest, profileName = '<你的profile>') {
  return `dsh plugin --profile ${profileName} add ${CONSOLE_PACKAGE}@${latest}`
}

/**
 * 把控制台升到 `latest` 并**确保写进 lock**。
 * 依赖以参数注入（便于单测替换）：`runPnpm`（默认 runPnpmWithFallback）、`pnpmAdd`（默认 pnpmInstall）、
 * `curlManualInstall`（手铺文件兜底，由路由传入）。
 */
async function selfUpdateToLatest({ profileDir, latest, registries, curlManualInstall, runPnpm = runPnpmWithFallback, pnpmAdd = pnpmInstall, profileName = null, execOpts = {} }) {
  const command = selfUpdateCommand(latest, profileName ?? '<你的profile>')
  const spec = profileSpec(profileDir, CONSOLE_PACKAGE)
  const errors = []
  let method = null
  const label = (e) => (e instanceof Error ? e.message : String(e))

  // ① spec 是版本范围 → pnpm update（spec 不变，lock 提到范围内最新）
  if (isRegistryRange(spec)) {
    try {
      await runPnpm(['update', CONSOLE_PACKAGE], { execOpts: { cwd: profileDir, timeout: 300000, ...execOpts } })
      method = 'pnpm-update'
    } catch (error) {
      errors.push(`pnpm update 失败：${label(error)}`)
    }
  }
  // ② 还没到 latest（超出 range / git·file 来源）→ pnpm add <pkg>@<latest>（spec 与 lock 一起改写）
  if (readInstalledVersion(profileDir, CONSOLE_PACKAGE) !== latest) {
    try {
      await pnpmAdd(profileDir, `${CONSOLE_PACKAGE}@${latest}`, registries?.[0])
      method = method === null ? 'pnpm-add' : `${method}+pnpm-add`
    } catch (error) {
      errors.push(`pnpm add 失败：${label(error)}`)
    }
  }

  let installed = readInstalledVersion(profileDir, CONSOLE_PACKAGE)
  let lock = lockVersion(profileDir, CONSOLE_PACKAGE)
  let lockUpdated = installed === latest && lock === latest
  let lockNote = null

  // ③ 包管理器都没成 → 手铺文件兜底（**不写 lock**），并且必须明确警告，不能让人以为升级成功
  if (!lockUpdated) {
    try {
      const info = await curlManualInstall(profileDir, CONSOLE_PACKAGE, registries, null, latest)
      method = method === null ? 'manual-copy' : `${method}+manual-copy`
      installed = info?.version ?? readInstalledVersion(profileDir, CONSOLE_PACKAGE)
      lock = lockVersion(profileDir, CONSOLE_PACKAGE)
      lockUpdated = installed === latest && lock === latest
    } catch (error) {
      errors.push(`手动铺文件失败：${label(error)}`)
    }
    if (!lockUpdated) {
      lockNote = `此更新未写入 pnpm-lock.yaml（lock 里仍是 ${lock ?? '未知'}）：之后任何 pnpm 操作（开关插件、dsh plugin add/remove）都会把它还原成 lock 里的版本。要真正落地请执行：${command}`
    }
  }

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

  return { method, spec: specUpdated ?? spec, installedVersion: installed, lockVersion: lock, lockUpdated, lockNote, command, note: noteParts.join('；'), errors }
}

/**
 * 依赖**来源规格**的协议前缀：manifest 里出现这些，说明来源不是 npm registry（link:/file:/URL/git/别名）。
 * 这类 spec 必须原样保留，**绝不能**换成版本号（换成 `<name>@<版本>` 就等于把来源丢掉 —— 缺陷②）。
 */
const SOURCE_SPEC_RE = /^(link:|file:|https?:|git\+|git:|github:|gitlab:|bitbucket:|workspace:|portal:|npm:|jsr:)/u

/**
 * lock 里被**来源**（而不是版本号）钉住的解析：`link:../x`、`https://…tgz`、`git+https://…#sha`。
 * 这类解析的 `version` 字段不是语义化版本，不能拿它跟已装版本做相等比较（见下面 aligned）。
 */
const SOURCE_PINNED_RE = SOURCE_SPEC_RE

/** 裸精确版本号（面板写回留下的形态）：`0.3.3`。`^0.3.3` / `~0.3.3` / `>=1` 是用户手写的范围。 */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

/**
 * dist-tag 形式的 spec（`latest` / `next` / `beta`）：也是 registry 来源，但要**保留标签**而不是钉成版本号。
 * 判据：不含版本号或协议前缀的裸标识符。注意不能把它当成"非 registry 来源"原样丢给 pnpm ——
 * `pnpm add latest` 会去装一个**名叫 latest 的包**，那是灾难性的误装。
 */
const DIST_TAG_RE = /^[A-Za-z][A-Za-z0-9._-]*$/u

/**
 * manifest spec 的写入器（0.5.39 加法）：**复用 manifest.js 那一个既有写入器**
 * `setProfileDependency`（只改 `dependencies[包名]` 一个键、走同一把写队列），本模块**不新造第二套**。
 * 为什么用动态 import：manifest.js 顶部 import 了本模块的 `reconcileLockfile`（syncLockFor 用），
 * 静态互相 import 会成环；这里只在**真的需要改清单**时才按需取一次（同进程内 import 有缓存，零成本）。
 * 单测可用 `deps.setSpec` 直接替换（离线夹具不需要真写清单时）。
 */
async function defaultSetSpec(profileDir, packageName, spec) {
  // 注意：这里**不能**用解构（`const { setProfileDependency } = await import(…)`）—— 架构守卫的自由变量
  // 扫描认不出解构声明（`const {` 形态），会把导入名误判成"没声明/没 import"的自由变量。
  const manifestModule = await import('./manifest.js')
  return manifestModule.setProfileDependency(profileDir, packageName, spec)
}

/** 该包在清单里属于哪个依赖分区（复用 lockfile-health.js 的既有解析器，不新写一份）。 */
function manifestSectionOf(profileDir, name) {
  try {
    const { deps } = readManifestDeps(readFileSync(join(String(profileDir), 'package.json'), 'utf8'))
    return deps.find((d) => d.name === name)?.section ?? 'dependencies'
  } catch {
    return 'dependencies'
  }
}

/**
 * 非 registry 来源的 lock 持久化收口（0.5.39 加法，用户点名的修 1）：
 *   · `items`（**能由 importer 条目完整表达**的来源，目前只有 `link:`）→ **只写 lock importer 条目**
 *     （lock-importer.js 是唯一实现；persist.js 走的 reconcile 通路就是这一条），清单形态与目标不等价时
 *     先用既有 `setProfileDependency` 写规范形；写完跑**一次** pnpm **只读**校验确认 lock 仍可解析；
 *   · `skipped`（file:/workspace:/portal:/git+/URL…）→ lock 记录不止 importer 一行（pnpm 还要写
 *     packages/snapshots 的解析记录），本地无法确定 ⇒ **既不伪造条目、也不用 `pnpm add` 当持久化手段**，
 *     由调用方如实报「未持久化」+ 一键钉住。
 * 返回 `{ writes, verified, verifyNote, errors, manifestWrites, changed }`；`verified` 为 `true|false|null`
 * （null = pnpm 执行方式不可用 ⇒ 无法确认）。
 */
async function settleImporterEntries({ profileDir, items = [], deps = {}, registries = [] } = {}) {
  const setSpec = typeof deps.setSpec === 'function' ? deps.setSpec : defaultSetSpec
  const writeImporter = typeof deps.writeImporter === 'function' ? deps.writeImporter : writeLockImporterEntry
  const verify = typeof deps.verifyLock === 'function' ? deps.verifyLock : verifyLockReadOnly
  const writes = []
  const errors = []
  const manifestWrites = []
  for (const item of items) {
    // ① 清单里必须有这个来源的声明：lock 条目不能单独存在（清单没有 = pnpm 会把它当多余条目清掉）
    const before = profileSpec(profileDir, item.name)
    if (typeof before !== 'string' || before.trim() === '') {
      writes.push({ name: item.name, changed: false, skipped: true, reason: '清单 dependencies 里没有这个依赖的声明（lock 条目不能单独存在）—— 未写 lock，请先走「声明」通路' })
      continue
    }
    // ② 形态与目标**不等价**才算真漂移 → 写**规范形**；等价（正/反斜杠、相对↔绝对同一目标）⇒ 零写盘
    if (!sameSourceSpec(profileDir, before, item.spec)) {
      try {
        const wrote = await setSpec(profileDir, item.name, item.spec)
        manifestWrites.push({ name: item.name, changed: wrote?.changed === true, before, after: wrote?.after ?? null })
      } catch (error) {
        const reason = `清单写回失败：${error instanceof Error ? error.message : String(error)}`
        errors.push(reason)
        writes.push({ name: item.name, changed: false, skipped: true, reason })
        continue
      }
      const actual = profileSpec(profileDir, item.name)
      if (!sameSourceSpec(profileDir, actual, item.spec)) {
        const reason = `清单写回未生效（现在仍是 ${actual ?? '（没有这个条目）'}）—— 未写 lock`
        errors.push(`${item.name}：${reason}`)
        writes.push({ name: item.name, changed: false, skipped: true, reason })
        continue
      }
    }
    // ③ 定点写 lock importer 条目（读改写 + 读回核实都在 lock-importer.js 里）
    let written = null
    try {
      written = await writeImporter(profileDir, { name: item.name, spec: item.spec, section: manifestSectionOf(profileDir, item.name), deps })
    } catch (error) {
      written = { changed: false, reason: `lock 写入失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (written?.changed !== true && written?.unchanged !== true) errors.push(`${item.name}：${written?.reason ?? 'lock 写入未成功'}`)
    writes.push({ name: item.name, ...written, reason: written?.reason ?? null })
  }
  let verified
  let verifyNote = null
  if (writes.some((w) => w.changed === true)) {
    // 写出后**必须**用 pnpm 的只读用法确认 lock 仍可解析；失败或无法确认 ⇒ 调用方报「未持久化」
    let verdict = null
    try {
      verdict = await verify({ profileDir, registry: registries?.[0] ?? null })
    } catch (error) {
      verdict = { verified: null, reason: `只读校验执行失败：${error instanceof Error ? error.message : String(error)}` }
    }
    verified = verdict?.verified ?? null
    verifyNote = verdict?.reason ?? null
    if (verified !== true) errors.push(`pnpm 只读校验${verified === null ? '无法确认' : '未通过'}：${verifyNote ?? '原因未知'}`)
  }
  return { writes, manifestWrites, verified, verifyNote, errors, changed: writes.some((w) => w.changed === true) }
}

/**
 * 通用 lock 对账（**任何**安装通道装完都该调用，支持一次对账多个包）：
 * 走非 pnpm 通道（并行 curl / curl tarball / GitHub Release / git clone 装配 / 套装装配）装的包，
 * node_modules 里的版本与 `pnpm-lock.yaml` 记的版本可能不一致——之后任何 pnpm 操作（开关插件改
 * `dsh.profile.bundles`、`dsh plugin add/remove`）都可能按 lock 把它**还原**甚至当外来物处理。这里：
 *   ① 全部一致 → 直接返回（不跑 pnpm，零成本）；
 *   ② 有漂移 → registry 形态（版本号/dist-tag）：**一次** `pnpm add <spec1> <spec2> …` 把它们精确写进
 *      lock（**行为一个字未改**）；非 registry 来源里的 `link:`：**只写 lock importer 条目**
 *      （domain/lock-importer.js，唯一实现），再用 pnpm 的**只读**用法确认 lock 可解析 ——
 *      `pnpm add` **不再**充当非 registry 来源的持久化手段；
 *   ③ 仍对不上（含只读校验没通过/无法确认）→ 返回 lockNote（逐包列出）与可复制命令，由调用方如实展示，
 *      绝不假装成功。
 * `packages` 形如 [{ name, version }]；只给 `packageName` 时等价于单包对账（向后兼容）。
 *
 * ★ 缺陷②修复（0.4.0-beta.16 / 0.3.63）：写回 spec 前必须确认来源，**绝不能把 release 来源的包
 *   写成裸版本号**——0.3.57 起的旧实现一律 `pnpm add <name>@<installed>`，对 npm 上不存在的包会被
 *   pnpm 静默改写成 `<name>: "<版本>"`（EXIT=0，装完看不出问题），lock 一重建就 ERR_PNPM_FETCH_404。
 *   现在的规则（详见 domain/install.js 顶部「依赖来源写回」注释与 issue 草案「缺陷②」）：
 *     · manifest 已是真实来源（link: / git+ / file:）→ 原样重放，不降级成版本号；
 *     · 已是 tarball URL（或在 lock 里被 URL 钉住）→ 转成 link: 形式
 *       （pnpm 10 对 direct-URL 依赖重写 lock 会丢 integrity，实测 ERR_PNPM_MISSING_TARBALL_INTEGRITY）；
 *     · 版本号 / 没有条目 → **先探 registry**：这个包的**这个版本**可解析才写 `<name>@<版本>`；
 *       查无此包（404）→ 物化到 `<DSH_HOME>/plugin-src/<包名>` 并写 `link:<绝对路径>`，同时回 depNote；
 *       连物化都做不到 → **跳过对齐且不碰 package.json**，只记 note。
 */
async function reconcileLockfile({ profileDir, packageName = null, packages = null, registries = [], pnpmAdd = pnpmInstall, execOpts = {}, fetchJson = fetchJsonUrl, home = null, deps = {}, keepUrlSpecs = [] } = {}) {
  const targets = Array.isArray(packages)
    ? packages.filter((p) => p && typeof p.name === 'string' && p.name !== '')
    : (packageName === null ? [] : [{ name: packageName, version: null }])
  const unique = []
  for (const t of targets) if (!unique.some((u) => u.name === t.name)) unique.push(t)
  const command = (name, version) => `dsh plugin --profile <你的profile> add ${name}@${version ?? '<版本>'}`

  const snap = () => unique.map((t) => ({
    name: t.name,
    spec: profileSpec(profileDir, t.name),
    installed: readInstalledVersion(profileDir, t.name),
    lock: lockVersion(profileDir, t.name),
  }))
  const sourcePinned = (v) => typeof v === 'string' && SOURCE_PINNED_RE.test(v.trim())
  const urlPinned = (v) => typeof v === 'string' && /^https?:/u.test(v.trim())
  /** 缺陷②指纹：manifest 声明裸版本号、lock 却把该包解析到一个 URL —— pnpm 静默改写留下的状态。
   *  2026-09-27 扩展（真机证据，desktop profile）：**不止 URL** —— `dependencies` 写 `0.0.1-rc1`
   *  而 lock 的 importer 把同一个包钉在 `link:…`，同样是"两处对不上"的静默遗留态（清单里那个
   *  裸版本号在 registry 上根本不存在，lock 一重建就 ERR_PNPM_FETCH_404）。来源一律算指纹。 */
  const misrecorded = (r) => typeof r.spec === 'string' && EXACT_VERSION_RE.test(r.spec.trim()) && sourcePinned(r.lock)
  /** manifest 里仍是 tarball URL：虽然 lock 能解析，但 pnpm 10 重写 lock 会丢 integrity（实测），
   *  必须**主动**规整成 link: 形式 —— 否则「删 lock / 清 node_modules / 换机」就装不回来。 */
  const urlSpec = (r) => typeof r.spec === 'string' && /^https?:/u.test(r.spec.trim())
  /** 来源钉住的包没有「版本号相等」可比：link 依赖要看链接是否**真的**还在（release 通道更新会把
   *  node_modules/<包名> 换成真实目录，此时必须重新物化 + 重放 link:，否则下次 pnpm 操作会还原版本）；
   *  其余来源（git+/file:/URL）只要有解析且包装着即视为对齐。
   *  ★ 2026-09-27 改错：link: 依赖还必须**在 lock 里有那条 link 条目**才算对齐。旧判据只看"链接还在"，
   *  于是「清单是 link:、node_modules 是链接、但 lock 里根本没有这个依赖」也被判成对齐 → `lockUpdated`
   *  报 true（谎报"已写进 lock"），而 lock 一重建就丢依赖。真机复现路径：先手动把 node_modules 换成指向
   *  plugin-src 的链接（或上一次对账刚建好链接），再走一次声明 —— pnpm add 根本不会被调用。 */
  const aligned = (r) => {
    if (r.installed === null) return false
    if (typeof r.spec === 'string' && r.spec.startsWith('link:')) {
      // 0.5.39 改错（Fix 2）：lock 里那条 link 条目还必须**指向同一个目标**才算对齐。
      // 旧判据只要求它以 `link:` 开头 ⇒ 「清单指 A、lock 指 B」被当成对齐（真实漂移：两处目标不同），
      // 而 pnpm 下一次操作会按 lock 把链接还原到 B。等价判据与清单写入共用同一把尺子
      // （dep-source.js#sameSourceSpec：正/反斜杠、相对↔绝对都算同一目标）。
      return linkSpecIsIntact(profileDir, r.name, r.spec)
        && typeof r.lock === 'string' && r.lock.trim().startsWith('link:')
        && sameSourceSpec(profileDir, r.lock, r.spec)
    }
    return r.installed === r.lock || sourcePinned(r.lock)
  }
  // 0.5.41 加法：**刚按真实来源规格真装过**的包（tarball URL）**不算漂移** —— 那个 URL 是用户可见的
  // 来源事实，lock 里的解析记录也正是 pnpm 自己在那次 `pnpm add <url>` 里写下的（带 integrity）。
  // 这条口子只对调用方**点名**的包生效（调用方 = 刚刚真装它的那条路，见 manifest.js / persist.js），
  // 其余任何 URL 形态照旧走下面的"URL → link:"规整（那条保护是给"pnpm 静默改写/来源不确定"的历史状态）。
  const keepUrls = new Set((Array.isArray(keepUrlSpecs) ? keepUrlSpecs : []).filter((n) => typeof n === 'string' && n !== ''))
  const driftedOf = (rows) => rows
    .filter((r) => !(keepUrls.has(r.name) && typeof r.spec === 'string' && /^https?:/u.test(r.spec.trim())))
    .filter((r) => r.installed === null || !aligned(r) || misrecorded(r) || urlSpec(r))

  const depNotes = []
  // 物化 + link: 计划（registry 查无此包时唯一安全的写回形式）。
  // ★ 2026-09-27 改错：这里**只产出"打算写什么"和"为什么"**，不再抢先断言"已按 link: 形式记录依赖"——
  //   旧版在 pnpm add 之前就把这句写进 depNote，于是"写回失败/被后一步覆盖"时面板仍然报"已钉住"，
  //   而磁盘上留着的是裸版本号（真机 desktop profile 的实际状态）。最终文案一律在写回之后**读回真实值**再生成。
  const linkPlan = (row, why) => {
    const dir = materializePackageForLink(profileDir, row.name, home === null ? {} : { home })
    if (dir === null) {
      return {
        spec: null,
        reason: why,
        note: `${row.name}：${why}，但 node_modules 里找不到可物化的已装副本 —— 已跳过 lock 对齐（**未改动 package.json**，避免留下指向不存在 npm 版本的裸版本号）`,
      }
    }
    return { spec: linkSpecFor(dir), reason: why, note: null }
  }
  /** 决定单个漂移包该以什么 spec 写回。spec=null 表示跳过（不碰 manifest）。 */
  const planWriteback = async (row) => {
    const { name, spec, installed } = row
    // ① manifest 里已是真实来源（协议前缀）→ 保持来源，绝不降级成裸版本号
    if (typeof spec === 'string' && SOURCE_SPEC_RE.test(spec.trim())) {
      if (/^https?:/u.test(spec.trim()) || misrecorded(row)) {
        return linkPlan(row, '该包原先以 tarball URL 记录（pnpm 10 重写 lock 会丢 integrity，实测 ERR_PNPM_MISSING_TARBALL_INTEGRITY）')
      }
      // link: 规格：链接**还在**（node_modules 里就是指向清单那个目标的链接）→ 一个字节都不用物化，
      // 按清单形态重放即可（0.5.39：等价即零漂移，别为了写一条 lock 去复制整棵包）；
      // 链接已被 release/curl 通道的"先删再铺"打断 → 先把新副本刷进 plugin-src 再重放（既有能力，不变）
      if (spec.trim().startsWith('link:')) {
        if (linkSpecIsIntact(profileDir, name, spec)) return { spec: spec.trim(), reason: null, note: null }
        const dir = materializePackageForLink(profileDir, name, home === null ? {} : { home })
        return { spec: dir === null ? spec.trim() : linkSpecFor(dir), reason: null, note: null }
      }
      return { spec: spec.trim(), reason: null, note: null } // git+ / file: / 别名 原样重放（幂等，来源不变）
    }
    // ①′ 清单写裸版本号、lock 却把该包钉在**来源**上（URL/link/git）：pnpm 静默改写的遗留态。
    //     按 lock 的来源重放（来源绝不降级成版本号），而不是"registry 能解析就换回版本号"——
    //     后者等于把用户/前一步刻意钉住的来源丢掉，且 lock 重建时会指向 registry 上并不存在的版本。
    if (misrecorded(row) && typeof row.lock === 'string' && row.lock.trim().startsWith('link:')) {
      return linkPlan(row, `pnpm-lock.yaml 里把该包钉在 link:（${row.lock.trim()}）而清单里是版本号 ${spec.trim()} —— 两处对不上，按来源重放`)
    }
    // ② dist-tag（latest/next…）：registry 来源，但**保留标签**（钉成版本号会悄悄失去升级语义）
    if (typeof spec === 'string' && DIST_TAG_RE.test(spec.trim())) {
      const probeTag = await probeRegistryPackage(name, registries, { fetchJson })
      if (probeTag.resolvable) return { spec: `${name}@${spec.trim()}`, reason: null, note: null }
      return linkPlan(row, 'npm registry 查无此包（该包只存在于 GitHub release）')
    }
    // ③ 版本号或没有条目 → 先探 registry：**这个版本**可解析才允许写版本号
    const probe = await probeRegistryPackage(name, registries, { version: installed, fetchJson })
    if (probe.resolvable && probe.hasVersion) return { spec: `${name}@${installed}`, reason: null, note: null }
    // ④ registry 查无此包（或查无此版本）→ 只存在于 GitHub release → 物化 + link:
    return linkPlan(row, probe.resolvable ? `registry 上没有 ${installed} 这个版本` : 'npm registry 查无此包（该包只存在于 GitHub release）')
  }

  let rows = snap()
  let drifted = driftedOf(rows)
  const errors = []
  let method = null
  const planned = []
  let importerSettled = null
  if (drifted.length > 0) {
    // 只对"能读到实际版本"的包做对齐；读不到的（目录都没有）无法对账，留给 lockNote
    const specs = []         // registry 形态（版本号 / dist-tag）→ **照旧**走既有 pnpm add 通道
    const importerItems = [] // 非 registry 来源且**能由 importer 条目完整表达**（link:）→ 定点写 lock
    const notWritable = []   // 其余非 registry 来源（file:/git+/URL/…）→ 本地不伪造、也不用 pnpm add
    for (const row of drifted) {
      if (row.installed === null) continue
      const plan = await planWriteback(row)
      const item = { name: row.name, installed: row.installed, spec: plan.spec, reason: plan.reason ?? null, note: plan.note ?? null }
      if (plan.spec !== null && canWriteImporterEntry(plan.spec)) {
        item.channel = 'importer'
        importerItems.push(item)
      } else if (plan.spec !== null && SOURCE_PINNED_RE.test(plan.spec.trim())) {
        // 修 1（0.5.39）：非 registry 来源**绝不**再用 `pnpm add` 当持久化手段；本地又无法确定它的
        // lock 记录（上面 IMPORTER_ONLY_RE 的注释说了为什么）⇒ 一个字节都不写，交给下面的文案如实报。
        item.channel = 'importer-skipped'
        notWritable.push(item)
      } else {
        item.channel = 'pnpm'
        if (plan.spec !== null) specs.push(plan.spec)
      }
      planned.push(item)
    }
    if (specs.length > 0) {
      try {
        await pnpmAdd(profileDir, specs.length === 1 ? specs[0] : specs, registries?.[0])
        method = 'pnpm-add'
      } catch (error) {
        errors.push(`pnpm add 对齐失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (importerItems.length > 0) {
      importerSettled = await settleImporterEntries({ profileDir, items: importerItems, deps, registries })
      errors.push(...importerSettled.errors)
      if (importerSettled.changed === true) method = method === null ? 'lock-importer' : `${method}+lock-importer`
    }
    rows = snap()
    drifted = driftedOf(rows)
  }
  // ★ 文案一律按**实际写入形态**生成（读回清单再描述）——"计划写 link:"与"清单里真是 link:"
  //   是两件事：pnpm add 失败、或后续某一步又把 spec 覆盖成版本号时，绝不能报"已钉住"。
  const suggestedActions = []
  const writeOf = new Map((importerSettled?.writes ?? []).map((w) => [w.name, w]))
  for (const item of planned) {
    const actual = profileSpec(profileDir, item.name)
    if (item.spec === null) {
      if (item.note !== null) depNotes.push(item.note)
      continue
    }
    if (item.channel === 'importer') {
      const wrote = writeOf.get(item.name) ?? null
      if (wrote !== null && (wrote.changed === true || wrote.unchanged === true)) {
        if (item.reason !== null) {
          depNotes.push(`${item.name}：${item.reason}，已按 link: 形式记录依赖（${actual}）—— lock 的 importer 条目已**定点写入**（${wrote.version ?? ''}），不经 npm registry 解析、不经 tarball 完整性校验`)
        }
        continue
      }
      const why = `${item.name}：${item.reason !== null ? `${item.reason}；` : ''}${wrote?.reason ?? 'lock importer 条目未能写入'}（清单现在是 ${actual ?? '（没有这个条目）'}）—— lock 条目**未写入**`
      depNotes.push(`${why}。请执行「钉住」动作或手动执行：${command(item.name, item.installed)}`)
      suggestedActions.push(suggestedPinAction({ packageName: item.name, version: item.installed, profileDir, reason: why }))
      continue
    }
    if (item.channel === 'importer-skipped') {
      const why = `${item.name}：来源是 ${item.spec}（非 registry）—— lock 里的记录不止 importer 一行（pnpm 还要写 packages/snapshots 的解析记录），本地无法确定 ⇒ **未写入 lock**，也没用 pnpm add 顶替`
      depNotes.push(`${why}。要钉住请执行「钉住」动作或手动执行：${command(item.name, item.installed)}`)
      suggestedActions.push(suggestedPinAction({ packageName: item.name, version: item.installed, profileDir, reason: why }))
      continue
    }
    if (actual === item.spec) {
      if (item.spec.startsWith('link:') && item.reason !== null) {
        depNotes.push(`${item.name}：${item.reason}，已按 link: 形式记录依赖（${actual}）—— 不经 npm registry 解析、不经 tarball 完整性校验，pnpm 重建 lock 也能装上`)
      }
      continue
    }
    const why = `${item.name}：${item.reason ?? '该包在 npm registry 上解析不到'}；计划写入 ${item.spec}，但清单里实际是 ${actual ?? '（没有这个条目）'} —— 写回**未生效**${errors.length > 0 ? `（${errors.join('；')}）` : ''}`
    depNotes.push(`${why}。请执行「钉住」动作或手动执行：${command(item.name, item.installed)}`)
    suggestedActions.push(suggestedPinAction({ packageName: item.name, version: item.installed, profileDir, reason: why }))
  }
  // 只读校验没通过/无法确认 ⇒ **不算已持久化**（修 1 的硬要求：不许报成功），把缺口与出路如实写进 lockNote
  const lockVerified = importerSettled === null ? undefined : importerSettled.verified
  const verifyBlocked = lockVerified === false || lockVerified === null
  const verifyNames = (importerSettled?.writes ?? []).filter((w) => w.changed === true).map((w) => w.name)
  const verifyNote = verifyBlocked
    ? `${verifyNames.join('、')} 的 lock importer 条目已按来源写入，但 pnpm 的**只读**校验${lockVerified === null ? '无法确认' : '未通过'}（${importerSettled?.verifyNote ?? '原因未知'}）—— 按**未持久化**处理，绝不报成功`
    : null
  if (verifyBlocked && verifyNames.length > 0 && !suggestedActions.some((a) => a?.payload?.packageName === verifyNames[0])) {
    const target = planned.find((p) => p.name === verifyNames[0]) ?? { name: verifyNames[0], installed: readInstalledVersion(profileDir, verifyNames[0]) }
    suggestedActions.push(suggestedPinAction({ packageName: target.name, version: target.installed ?? null, profileDir, reason: verifyNote }))
  }
  // 只写 lock 成功、但 node_modules 里的链接还没就位（release/curl/URL 通道「先删再铺」把链接换成了真实目录）：
  // 这条**不是**"没写进 lock"，文案必须分开说；同时要给「缺口明细 + 一键钉住」。
  const writtenNames = new Set((importerSettled?.writes ?? []).filter((w) => w.changed === true || w.unchanged === true).map((w) => w.name))
  const linkPending = drifted.filter((r) => writtenNames.has(r.name) && typeof r.lock === 'string' && r.lock.trim().startsWith('link:'))
  for (const row of linkPending) {
    if (suggestedActions.some((a) => a?.payload?.packageName === row.name)) continue
    const reason = `${row.name}：lock 条目已按来源写入（${row.lock}），但 node_modules 里的链接尚未就位 —— 点「钉住」可立即用 pnpm 把链接建起来（否则要等下一次 pnpm 操作）`
    depNotes.push(reason)
    suggestedActions.push(suggestedPinAction({ packageName: row.name, version: row.installed, profileDir, reason }))
  }
  const lockUpdated = drifted.length === 0 && !verifyBlocked
  const notWritten = drifted.filter((r) => !linkPending.includes(r))
  const driftedText = drifted.length === 0
    ? null
    : [
      linkPending.length > 0
        ? `${linkPending.map((r) => `${r.name}：lock 条目已按来源写入（${r.lock}），但 node_modules 里的链接尚未就位 —— 下一次 pnpm 操作会按这条 lock 重建链接`).join('；')}`
        : null,
      notWritten.length > 0
        ? `${notWritten.length} 个包没写进 pnpm-lock.yaml（${notWritten.map((r) => `${r.name}：装了 ${r.installed ?? '未知'}／lock 里是 ${r.lock ?? '未记录'}`).join('；')}）：之后任何 pnpm 操作（开关插件、dsh plugin add/remove）都可能把它们还原。要钉住请执行：${command(notWritten[0].name, notWritten[0].installed)}`
        : null,
    ].filter((x) => x !== null).join('；')
  return {
    method,
    packages: rows.map((r) => ({ name: r.name, installedVersion: r.installed, lockVersion: r.lock, spec: r.spec, aligned: r.installed !== null && (r.installed === r.lock || sourcePinned(r.lock)) })),
    spec: rows.length === 1 ? rows[0].spec : null,
    installedVersion: rows.length === 1 ? rows[0].installed : null,
    lockVersion: rows.length === 1 ? rows[0].lock : null,
    lockUpdated,
    // 只读校验的结论如实下发（true=确认可解析 / false=未通过 / null=无法确认；没写过条目时是 undefined）
    lockVerified,
    lockVerifyNote: importerSettled?.verifyNote ?? null,
    lockImporterWrites: (importerSettled?.writes ?? []).map((w) => ({ name: w.name, changed: w.changed === true, version: w.version ?? null, reason: w.reason ?? null })),
    lockNote: lockUpdated
      ? null
      : [
        verifyNote,
        // 定点写入失败的逐条原因也要进 lockNote（缺口明细：面板只看 lockNote 时也说得清）
        (importerSettled?.writes ?? []).filter((w) => w.changed !== true && w.unchanged !== true && typeof w.reason === 'string' && w.reason !== '')
          .map((w) => `${w.name}：${w.reason}`).join('；') || null,
        drifted.length === 0 ? null : `${driftedText}`,
      ].filter((x) => x !== null).join('；'),
    // 非常规来源（link:）写回时的**用户可见**说明：绝不静默（缺陷②的隐蔽性正是"装完看不出问题"）。
    // 文案由上面的"读回真实值"步骤产出，因此永远不会出现"面板说已钉住、磁盘上仍是版本号"。
    depNote: depNotes.length > 0 ? depNotes.join('；') : null,
    // 结构化建议动作（2026-09-27 加法）：面板可一键「执行」（服务端只认白名单动作，argv 自己拼）
    suggestedActions,
    command: drifted.length > 0 ? command(drifted[0].name, drifted[0].installed) : command(rows[0]?.name ?? '', rows[0]?.installed ?? null),
    errors,
  }
}

export { CONSOLE_PACKAGE, isRegistryRange, readInstalledVersion, lockVersion, profileSpec, reconcileLockfile, selfUpdateCommand, selfUpdateToLatest }
