// L1 · domain —— profile 清单（<profile>/package.json）的写入层：bundles 层 + dependencies 声明
//
// 为什么单独成模块（2026-09-24）：安装落点原本散在 install.js 里，而 install.js 已经贴着
// 架构守卫的 600 行上限；更重要的是，「装了但没声明」这一类问题反复出现（官方面板看不见 /
// pnpm 按清单还原 / 我们的清理判据误当孤儿），把「怎么写清单」收口到一处才好统一保证。
//
// 规矩：
//   · 所有写操作走 fsx 的写队列（queuedWrite），避免并发读改写互相覆盖；
//   · **安装即声明**：装到哪版就把 dependencies 写成哪版（读磁盘真实版本，不猜）；
//   · **卸载即撤销**：否则清单留幽灵依赖，下次 pnpm 操作把它装回来；
//   · 来源型 spec（link:/file:/git:/URL）绝不改写成版本号 —— 改写等于丢来源。

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { linkSpecFor, materializePackageForLink, probeFailureKind, probeRegistryPackage, sameSourceSpec, suggestedPinAction } from './dep-source.js'
import { queuedWrite } from '../infra/fsx.js'
import { resolvePackageJson } from '../infra/paths.js'
import { reconcileLockfile } from './selfupdate.js'

/** 官方 profile 模板自带的 bundle（其余 bundle 视为用户额外添加）。 */
const DEFAULT_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 读磁盘上真实安装的版本（读不到返回 null，绝不猜）。 */
async function installedVersionOf(profileDir, packageName) {
  try {
    const pkgPath = resolvePackageJson(packageName, profileDir)
    if (pkgPath === null) return null
    const version = JSON.parse(await readFile(pkgPath, 'utf8')).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

async function readManifest(profileDir) {
  return JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
}

async function writeManifest(profileDir, manifest) {
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * 把包追加进 profile 的 `dsh.profile.bundles` 层（与官方 `dsh plugin add` 的 reconcile 一致），
 * 同一把写锁内**顺手声明 dependencies**（安装即声明）。
 * @returns {{ version: string|null }}
 */
async function addBundleToManifest(profileDir, packageName) {
  return queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    let touched = false
    if (!bundles.includes(packageName)) {
      bundles.push(packageName)
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
      touched = true
    }
    const version = await installedVersionOf(profileDir, packageName)
    if (version !== null) {
      const deps = { ...(manifest.dependencies ?? {}) }
      if (deps[packageName] !== version) { deps[packageName] = version; manifest.dependencies = deps; touched = true }
    }
    if (touched) await writeManifest(profileDir, manifest)
    return { version }
  })
}

/** 从 profile manifest 移除一个 bundle（同时撤销 dependencies 声明，避免留下幽灵依赖）。 */
async function removeBundleFromManifest(profileDir, bundlePkg) {
  return queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const next = bundles.filter((name) => name !== bundlePkg)
    let touched = false
    if (next.length !== bundles.length) {
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: next } }
      touched = true
    }
    const deps = { ...(manifest.dependencies ?? {}) }
    if (bundlePkg in deps) { delete deps[bundlePkg]; manifest.dependencies = deps; touched = true }
    if (touched) await writeManifest(profileDir, manifest)
    return { changed: touched }
  })
}

/** 读 profile 清单里某包的 spec（读不到返回 null）。 */
async function specOf(profileDir, packageName) {
  try {
    const manifest = await readManifest(profileDir)
    const spec = manifest?.dependencies?.[packageName]
    return typeof spec === 'string' && spec !== '' ? spec : null
  } catch {
    return null
  }
}

/**
 * **写回形态判定**（2026-09-27 改错，这是"清单里留下裸版本号 → 下次 pnpm 操作 404"的根修）。
 *
 * 修的是什么：`declareProfileDependency` 过去无条件把**磁盘上的版本号**写进 `dependencies`
 * （注释写着"装到哪版就写哪版"）——对 release 通道 / curl 手铺 / git 装配来的包，npm registry 上
 * **根本没有这个包**。面板当时显示安装成功，直到任何一次 pnpm 操作按清单解析才炸 `ERR_PNPM_FETCH_404`；
 * 真机证据：desktop profile 里 `@dsh-external/dsh-graded-mode: 0.0.1-rc1`（npmmirror 与 npmjs 双双 404）。
 *
 * 判据（与 lockfile 对账的 planWriteback 同一套语义，绝不两处各判一套）：
 *   · registry 上**查得到这个包的这个版本** → 写版本号（原行为，回归不变）；
 *   · 查无此包 / 查无此版本（404）      → 物化到 `<DSH_HOME>/plugin-src/<包名>` 并写 `link:<绝对路径>`；
 *   · 本次没探到（网络/镜像不可达）      → 不敢替用户猜：仍按旧行为写版本号，但**如实记 note**
 *     并给出结构化「钉住」建议动作（面板可一键执行），绝不写成"已钉住"。
 * 返回 { form, spec, note, suggestion }；`spec` 为 null 表示"不要改清单"。
 */
async function planDependencySpec({ profileDir, packageName, version, registries = [], probe = null, home = undefined, profile = null }) {
  const doProbe = typeof probe === 'function' ? probe : probeRegistryPackage
  const linkable = () => materializePackageForLink(profileDir, packageName, home === undefined ? {} : { home })
  const asLink = (why) => {
    const dir = linkable()
    if (dir === null) {
      return {
        form: 'unknown',
        spec: null,
        note: `${packageName}：${why}，但 node_modules 里找不到可物化的已装副本 —— 已跳过写回（未改动清单，避免留下指向不存在 npm 版本的裸版本号）`,
        suggestion: null,
      }
    }
    const link = linkSpecFor(dir)
    return {
      form: 'link',
      spec: link,
      note: `${packageName}：${why}，清单已按 link: 形式记录（${link}）—— 不经 npm registry 解析、不经 tarball 完整性校验，pnpm 重建 lock 也能装上`,
      suggestion: null,
    }
  }
  let result = null
  try {
    result = await doProbe(packageName, registries, { version })
  } catch (error) {
    result = { resolvable: false, hasVersion: false, tried: [error instanceof Error ? error.message : String(error)] }
  }
  if (result?.resolvable === true && result.hasVersion !== false) return { form: 'version', spec: version, note: null, suggestion: null }
  if (probeFailureKind(result) === 'fetch-404') {
    return asLink(result?.resolvable === true
      ? `registry 上没有 ${version} 这个版本（该包只在 GitHub release / 本地有）`
      : 'npm registry 查无此包（该包只存在于 GitHub release 或本地）')
  }
  return {
    form: 'unknown',
    spec: version,
    note: `${packageName}：本次没能确认 registry 可解析性（网络/镜像不可达），先按版本号 ${version} 写入；若该包确实不在 npm 上，请执行下面的「钉住」动作改成 link:（否则下次 pnpm 操作会 404）`,
    suggestion: suggestedPinAction({ packageName, version, profileDir, profile }),
  }
}

/**
 * 安装即声明：把包写进 profile 清单的 `dependencies`。
 *
 * 三个现象同一个根因（2026-09-24 复盘）：
 *   · 官方「设置 → 插件」的**已安装**分区只显示清单里声明过的包 —— 我们手铺的包在那里看不见；
 *   · 任何一次 pnpm 操作都会按清单 + lock 重装，未声明的包会被**还原/清掉**；
 *   · 连我们自己的「清理残余」也按「有没有被声明」判孤儿 —— 判据病根也在这里。
 *
 * 2026-09-27 改错（见 planDependencySpec 注释）：写进去的形态**按 registry 可解析性决定**，
 * 并且写完**总是**做一次 lock 对账（对齐时零成本：reconcileLockfile 只在漂移时才跑 pnpm）。
 * @returns {{ changed: boolean, version: string|null, spec: string|null, form: string|null, reason: string|null,
 *             lockSynced: boolean, lockNote: string|null, depNote: string|null, suggested: object|null }}
 */
async function declareProfileDependency(profileDir, packageName, version = null, options = {}) {
  const { syncLock = true, registries = [], probe = null, home = undefined, profile = null } = options
  const empty = { changed: false, version: null, spec: null, form: null, reason: null, lockSynced: false, lockNote: null, depNote: null, suggested: null }
  const resolved = typeof version === 'string' && version !== '' ? version : await installedVersionOf(profileDir, packageName)
  if (resolved === null) return { ...empty, reason: '读不到已安装版本' }
  // 探测/物化放在写锁**之外**（网络探测最长 8 秒，占着清单写锁会堵住其它写）
  const plan = await planDependencySpec({ profileDir, packageName, version: resolved, registries, probe, home, profile })
  if (plan.spec === null) return { ...empty, version: resolved, form: plan.form, reason: plan.note, depNote: plan.note, suggested: plan.suggestion }
  const result = await queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const deps = { ...(manifest.dependencies ?? {}) }
    // 0.5.39 改错（Fix 2）：逐字比较会把「同一目标的另一种写法」当成漂移 —— 真机 desktop profile 的
    // `link:D:\dsh-link\…`（反斜杠）会被这条路径无谓改写成正斜杠（用户没要求的漂移）。等价 ⇒ 零写盘。
    if (sameSourceSpec(profileDir, deps[packageName], plan.spec)) return { changed: false }
    deps[packageName] = plan.spec
    manifest.dependencies = deps
    await writeManifest(profileDir, manifest)
    return { changed: true }
  })
  const out = { ...empty, changed: result.changed, version: resolved, spec: plan.spec, form: plan.form, depNote: plan.note, suggested: plan.suggestion }
  if (syncLock !== true) return out
  // **写完清单必须把 lock 拉齐**（2026-09-24 CI 实测）：只写清单不写 lock → 清单/lock 不一致 →
  // 之后任何 pnpm 操作都会硬失败（ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS）。
  // 放在写队列**之外**执行（对账本身会跑 pnpm，不该占着清单写锁）；失败只记 note，不让安装失败。
  const synced = await syncLockFor(profileDir, [packageName], { registries, home, profile })
  return { ...out, ...synced, depNote: joinNotes(plan.note, synced.depNote), suggested: synced.suggested ?? plan.suggestion }
}

/** 多段说明拼接（空段自动跳过）：文案只做拼接，不覆盖 —— 覆盖就是"谎报"的来源。 */
function joinNotes(...notes) {
  const list = notes.filter((note) => typeof note === 'string' && note.trim() !== '')
  return list.length === 0 ? null : list.join('；')
}

/** 声明之后同步 lock：用仓库既有的对账通道；失败如实回报，不假装成功。 */
async function syncLockFor(profileDir, names, options = {}) {
  try {
    const lock = await reconcileLockfile({
      profileDir,
      packages: names.map((name) => ({ name })),
      registries: Array.isArray(options.registries) ? options.registries : [],
      ...(options.home === undefined ? {} : { home: options.home }),
    })
    return {
      lockSynced: lock.lockUpdated === true,
      lockNote: lock.lockNote,
      depNote: lock.depNote,
      suggested: Array.isArray(lock.suggestedActions) && lock.suggestedActions.length > 0 ? lock.suggestedActions[0] : null,
    }
  } catch (error) {
    return { lockSynced: false, lockNote: `lock 对账失败：${error instanceof Error ? error.message : String(error)}`, depNote: null, suggested: null }
  }
}

/**
 * 「钉住」动作的核心（POST /plugin-console/run-suggested 的 pin-dependency 分支）：
 * 把这个包在清单里钉成 `link:<DSH_HOME>/plugin-src/<包名>`（需要时先把已装副本物化过去）。
 * 只碰清单，不跑 pnpm（lock/node_modules 的对齐由动作执行器随后显式跑一次 pnpm add 完成）。
 * 返回 { ok, spec, before, after, changed, dir }；物化不出来时**抛错**（绝不写指向不存在目录的 link:）。
 */
async function pinProfileDependency(profileDir, packageName, options = {}) {
  const { home = undefined } = options
  const dir = materializePackageForLink(profileDir, packageName, home === undefined ? {} : { home })
  if (dir === null) throw new Error(`${packageName}：node_modules 里没有可物化的已装副本，无法钉住（已中止，未改动清单）`)
  const spec = linkSpecFor(dir)
  const before = await specOf(profileDir, packageName)
  const changed = await queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const deps = { ...(manifest.dependencies ?? {}) }
    // 0.5.39 改错（Fix 2）：等价写法（正/反斜杠、相对↔绝对指向同一目录）**不再改写清单** ——
    // 幂等零写盘；只有真漂移（目标不同/确实缺失）才写，且写的是 linkSpecFor 的**规范形**。
    if (sameSourceSpec(profileDir, deps[packageName], spec)) return false
    deps[packageName] = spec
    manifest.dependencies = deps
    await writeManifest(profileDir, manifest)
    return true
  })
  const after = await specOf(profileDir, packageName)
  return { ok: sameSourceSpec(profileDir, after, spec), spec, before, after, changed, dir }
}

/**
 * 把清单里的该包 spec **原样写成给定值**（0.5.38 加法，供 domain/persist.js 的持久化收口用）。
 * 场景：`node_modules/<包名>` 是指向**用户自己位置**的链接（开发目录 / 别的盘），而清单里没有条目。
 * 此时"按磁盘真实值写 spec"就是写这条链接本身 —— 走 `pinProfileDependency` 会把它**物化复制**到
 * plugin-src 并把 spec 换成一个新拷贝，等于悄悄改掉用户的来源（那是另一件事，不该由收口代做）。
 * 只碰 `dependencies[packageName]` 这一个键，走同一把写队列；返回 `{ before, after, changed }`。
 */
async function setProfileDependency(profileDir, packageName, spec) {
  const before = await specOf(profileDir, packageName)
  const changed = await queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const deps = { ...(manifest.dependencies ?? {}) }
    // 0.5.39 改错（Fix 2）：判等用同一把尺子（canonicalSourceSpec + realpath）—— 等价即零写盘
    if (sameSourceSpec(profileDir, deps[packageName], spec)) return false
    deps[packageName] = spec
    manifest.dependencies = deps
    await writeManifest(profileDir, manifest)
    return true
  })
  return { before, after: await specOf(profileDir, packageName), changed }
}

/** 卸载即撤销声明。 */
async function undeclareProfileDependency(profileDir, packageName) {
  return queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const deps = { ...(manifest.dependencies ?? {}) }
    if (!(packageName in deps)) return { changed: false }
    delete deps[packageName]
    manifest.dependencies = deps
    await writeManifest(profileDir, manifest)
    return { changed: true }
  })
}

/**
 * 扫描「已装但未声明」的插件（补声明用）。
 *
 * 判据刻意保守：只看 profile 的 `dsh.profile.bundles` 里**非默认**且**真装在磁盘上**的包。
 * 为什么不扫整个 node_modules：那会把框架自带包、传递依赖一并卷进来（它们本来就不该出现在
 * 用户清单里）。bundles 是「用户显式加进组合树的东西」—— 正是该被声明的那一批。
 *
 * 为什么值得做（2026-09-24 用户实测）：第三方插件管理器（如 @linxin666 的插件页）与 pnpm
 * 都只认清单里的依赖 —— 手铺安装的包在它们眼里不存在：看不见，还会被 pnpm 还原。
 * @returns {{ candidates: {name: string, version: string}[], skipped: {name: string, reason: string}[] }}
 */
async function planDependencyBackfill(profileDir) {
  const manifest = await readManifest(profileDir)
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const deps = manifest.dependencies ?? {}
  const candidates = []
  const skipped = []
  for (const name of bundles) {
    if (typeof name !== 'string' || name === '') continue
    if (DEFAULT_BUNDLES.includes(name)) continue
    if (typeof deps[name] === 'string' && deps[name] !== '') continue
    const version = await installedVersionOf(profileDir, name)
    if (version === null) {
      skipped.push({ name, reason: '磁盘上读不到已安装版本（可能已卸载）' })
      continue
    }
    candidates.push({ name, version })
  }
  return { candidates, skipped }
}

/** 执行补声明：逐条写入清单（每条独立走写队列，一条失败不影响其它）。
 * 2026-09-27：补声明同样按 registry 可解析性决定形态（补声明也曾把 release 专属包写成裸版本号 →
 * 下次 pnpm 操作 404）。`options` 直接透传给 declareProfileDependency（registries/probe 注入）。 */
async function applyDependencyBackfill(profileDir, options = {}) {
  const { candidates, skipped } = await planDependencyBackfill(profileDir)
  const declared = []
  const notes = []
  const suggested = []
  for (const item of candidates) {
    const result = await declareProfileDependency(profileDir, item.name, item.version, options)
    if (result.changed) declared.push({ name: item.name, version: result.version, spec: result.spec, form: result.form })
    else skipped.push({ name: item.name, reason: result.reason ?? '无需改动' })
    if (result.depNote !== null) notes.push(result.depNote)
    if (result.suggested !== null) suggested.push(result.suggested)
  }
  return { declared, skipped, depNote: notes.length === 0 ? null : notes.join('；'), suggestedActions: suggested }
}

export {
  DEFAULT_BUNDLES, addBundleToManifest, applyDependencyBackfill, declareProfileDependency,
  installedVersionOf, planDependencyBackfill, planDependencySpec, pinProfileDependency, removeBundleFromManifest,
  setProfileDependency, specOf, syncLockFor, undeclareProfileDependency,
}
