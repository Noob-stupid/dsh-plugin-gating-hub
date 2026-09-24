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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { linkSpecFor, linkSpecIsIntact, materializePackageForLink, probeRegistryPackage } from './dep-source.js'
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
    const bare = lines[i].trim().replace(/^'|':?$/gu, '').replace(/'$/u, '')
    if (bare === name || lines[i].trim() === `'${name}':`) {
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
  const noteParts = [lockUpdated ? '已写入 pnpm-lock.yaml，重启服务后生效' : '已铺入文件但未写入 pnpm-lock.yaml：重启后可用，但会被 pnpm 还原']
  if (sourceSwitch !== null) noteParts.push(sourceSwitch)

  return { method, spec, installedVersion: installed, lockVersion: lock, lockUpdated, lockNote, command, note: noteParts.join('；'), errors }
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
 * 通用 lock 对账（**任何**安装通道装完都该调用，支持一次对账多个包）：
 * 走非 pnpm 通道（并行 curl / curl tarball / GitHub Release / git clone 装配 / 套装装配）装的包，
 * node_modules 里的版本与 `pnpm-lock.yaml` 记的版本可能不一致——之后任何 pnpm 操作（开关插件改
 * `dsh.profile.bundles`、`dsh plugin add/remove`）都可能按 lock 把它**还原**甚至当外来物处理。这里：
 *   ① 全部一致 → 直接返回（不跑 pnpm，零成本）；
 *   ② 有漂移 → **一次** `pnpm add <spec1> <spec2> …` 把所有漂移包精确写进 lock；
 *   ③ 仍对不上 → 返回 lockNote（逐包列出）与可复制命令，由调用方如实展示，绝不假装成功。
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
async function reconcileLockfile({ profileDir, packageName = null, packages = null, registries = [], pnpmAdd = pnpmInstall, execOpts = {}, fetchJson = fetchJsonUrl, home = null } = {}) {
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
  /** 缺陷②指纹：manifest 声明裸版本号、lock 却把该包解析到一个 URL —— pnpm 静默改写留下的状态。 */
  const misrecorded = (r) => typeof r.spec === 'string' && EXACT_VERSION_RE.test(r.spec.trim()) && urlPinned(r.lock)
  /** manifest 里仍是 tarball URL：虽然 lock 能解析，但 pnpm 10 重写 lock 会丢 integrity（实测），
   *  必须**主动**规整成 link: 形式 —— 否则「删 lock / 清 node_modules / 换机」就装不回来。 */
  const urlSpec = (r) => typeof r.spec === 'string' && /^https?:/u.test(r.spec.trim())
  /** 来源钉住的包没有「版本号相等」可比：link 依赖要看链接是否**真的**还在（release 通道更新会把
   *  node_modules/<包名> 换成真实目录，此时必须重新物化 + 重放 link:，否则下次 pnpm 操作会还原版本）；
   *  其余来源（git+/file:/URL）只要有解析且包装着即视为对齐。 */
  const aligned = (r) => {
    if (r.installed === null) return false
    if (typeof r.spec === 'string' && r.spec.startsWith('link:')) return linkSpecIsIntact(profileDir, r.name, r.spec)
    return r.installed === r.lock || sourcePinned(r.lock)
  }
  const driftedOf = (rows) => rows.filter((r) => r.installed === null || !aligned(r) || misrecorded(r) || urlSpec(r))

  const depNotes = []
  // 物化 + link: 计划（registry 查无此包时唯一安全的写回形式）
  const linkPlan = (row, why) => {
    const dir = materializePackageForLink(profileDir, row.name, home === null ? {} : { home })
    if (dir === null) {
      return {
        spec: null,
        note: `${row.name}：${why}，但 node_modules 里找不到可物化的已装副本 —— 已跳过 lock 对齐（**未改动 package.json**，避免留下指向不存在 npm 版本的裸版本号）`,
      }
    }
    const link = linkSpecFor(dir)
    return {
      spec: link,
      note: `${row.name}：${why}，已按 link: 形式记录依赖（${link}）—— 不经 npm registry 解析、不经 tarball 完整性校验，pnpm 重建 lock 也能装上`,
    }
  }
  /** 决定单个漂移包该以什么 spec 写回。spec=null 表示跳过（不碰 manifest）。 */
  const planWriteback = async (row) => {
    const { name, spec, installed } = row
    // ① manifest 里已是真实来源（协议前缀）→ 保持来源，绝不降级成裸版本号
    if (typeof spec === 'string' && SOURCE_SPEC_RE.test(spec.trim())) {
      if (/^https?:/u.test(spec.trim()) || misrecorded(row)) {
        return linkPlan(row, '该包原先以 tarball URL 记录（pnpm 10 重写 lock 会丢 integrity，实测 ERR_PNPM_MISSING_TARBALL_INTEGRITY）')
      }
      // link: 规格：链接可能已被 release/curl 通道的"先删再铺"打断 → 先把新副本刷进 plugin-src 再重放
      if (spec.trim().startsWith('link:')) {
        const dir = materializePackageForLink(profileDir, name, home === null ? {} : { home })
        return { spec: dir === null ? spec.trim() : linkSpecFor(dir), note: null }
      }
      return { spec: spec.trim(), note: null } // git+ / file: / 别名 原样重放（幂等，来源不变）
    }
    // ② dist-tag（latest/next…）：registry 来源，但**保留标签**（钉成版本号会悄悄失去升级语义）
    if (typeof spec === 'string' && DIST_TAG_RE.test(spec.trim())) {
      const probeTag = await probeRegistryPackage(name, registries, { fetchJson })
      if (probeTag.resolvable) return { spec: `${name}@${spec.trim()}`, note: null }
      return linkPlan(row, 'npm registry 查无此包（该包只存在于 GitHub release）')
    }
    // ③ 版本号或没有条目 → 先探 registry：**这个版本**可解析才允许写版本号
    const probe = await probeRegistryPackage(name, registries, { version: installed, fetchJson })
    if (probe.resolvable && probe.hasVersion) return { spec: `${name}@${installed}`, note: null }
    // ④ registry 查无此包（或查无此版本）→ 只存在于 GitHub release → 物化 + link:
    return linkPlan(row, probe.resolvable ? `registry 上没有 ${installed} 这个版本` : 'npm registry 查无此包（该包只存在于 GitHub release）')
  }

  let rows = snap()
  let drifted = driftedOf(rows)
  const errors = []
  let method = null
  if (drifted.length > 0) {
    // 只对"能读到实际版本"的包做对齐；读不到的（目录都没有）无法对账，留给 lockNote
    const specs = []
    for (const row of drifted) {
      if (row.installed === null) continue
      const plan = await planWriteback(row)
      if (plan.note !== null) depNotes.push(plan.note)
      if (plan.spec !== null) specs.push(plan.spec)
    }
    if (specs.length > 0) {
      try {
        await pnpmAdd(profileDir, specs.length === 1 ? specs[0] : specs, registries?.[0])
        method = 'pnpm-add'
      } catch (error) {
        errors.push(`pnpm add 对齐失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    rows = snap()
    drifted = driftedOf(rows)
  }
  const lockUpdated = drifted.length === 0
  return {
    method,
    packages: rows.map((r) => ({ name: r.name, installedVersion: r.installed, lockVersion: r.lock, spec: r.spec, aligned: r.installed !== null && (r.installed === r.lock || sourcePinned(r.lock)) })),
    spec: rows.length === 1 ? rows[0].spec : null,
    installedVersion: rows.length === 1 ? rows[0].installed : null,
    lockVersion: rows.length === 1 ? rows[0].lock : null,
    lockUpdated,
    lockNote: lockUpdated
      ? null
      : `${drifted.length} 个包没写进 pnpm-lock.yaml（${drifted.map((r) => `${r.name}：装了 ${r.installed ?? '未知'}／lock 里是 ${r.lock ?? '未记录'}`).join('；')}）：之后任何 pnpm 操作（开关插件、dsh plugin add/remove）都可能把它们还原。要钉住请执行：${command(drifted[0].name, drifted[0].installed)}`,
    // 非常规来源（link:）写回时的**用户可见**说明：绝不静默（缺陷②的隐蔽性正是"装完看不出问题"）
    depNote: depNotes.length > 0 ? depNotes.join('；') : null,
    command: drifted.length > 0 ? command(drifted[0].name, drifted[0].installed) : command(rows[0]?.name ?? '', rows[0]?.installed ?? null),
    errors,
  }
}

export { CONSOLE_PACKAGE, isRegistryRange, readInstalledVersion, lockVersion, profileSpec, reconcileLockfile, selfUpdateCommand, selfUpdateToLatest }
