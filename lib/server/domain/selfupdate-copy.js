// L1 · domain —— selfupdate-copy.js（自更新的**本体**：下载 tarball → 只覆盖文件、不清空目录 → 补 lock）
//
// ── 现场（真机 2026-11-04 实测采样，用户提供的原始时间线）─────────────────────────────────
//   0.5.103 的自更新是「包管理器优先」：`pnpm update` → `pnpm add` → 才轮到本模块的手铺（见 selfupdate.js 顶部）。
//   pnpm 一启动就**先清空目标目录**再重算整棵依赖树；这一步在 profile 里要跑 3~9 分钟
//   （`18:32:31 pkg=False files=1 bak=1 pnpm=1` → `18:43:48` 仍是空壳），于是：
//     · 撞 90s/300s 超时被杀 → 目录停在"空了"的状态，跑了一整夜都没轮到第三步；
//     · 就算第三步轮到了，既有 curl 通道也是"先 rmSync 整目录再 copyTree"（见 install.js#curlManualInstall），
//       宿主正读着这些文件时更容易被 Windows 拒绝。
//   ⇒ 用户拍板「自更新彻底不走 pnpm，改回下载 tarball + 覆盖解包」：本模块的三个函数从此是**主路径**，
//     不再有任何包管理器排在它们前面（补 lock 也一样，见 ③）。
//
// ── 本模块只做三件事 ─────────────────────────────────────────────────────────
//   ① prepareSelfUpdateTarball：registry 元数据 → `dist.tarball` → curl 下载到临时目录（**唯一的取包动作**）；
//   ② overlaySelfUpdateTarball：用下载的 tarball **只覆盖文件、绝不清空目录**（copyTree 的语义，
//      见 infra/fsx.js —— 它只 copyFileSync，不删任何东西），随后**读回** package.json 的版本与期望值比对；
//   ③ patchSelfUpdateLock：把 `pnpm-lock.yaml` 里该包的版本/完整性更新到目标版本（**唯一**写入口仍是
//      domain/lock-importer.js#writeLockRegistryVersion，本模块不另写一套 lock 解析；它自带"写后读回逐字核对"），
//      之后**默认不跑 pnpm**（见 patchSelfUpdateLock 里 verify 那一段）；只读校验只在调用方显式注入时执行。
//
// ── 与既有实现的关系（复用，不另造一套）──────────────────────────────────────────
//   · 盒子校验 `verifyPackageBox`（install-box.js）、覆盖复制 `copyTree`（fsx.js）、临时目录删除核实
//     `removeDirVerified`（fsx.js）、lock 写入（lock-importer.js）、失败兜底与自愈（self-update-guard.js）都是既有件；
//   · 本模块**不判断"更新成功与否"**：那由 selfupdate.js 的回读核实 + 自更新守卫说了算。
//
// ── 边界（别越线）──────────────────────────────────────────────────────────────
//   ① 只对**自更新**生效：由 selfupdate.js 在 `/self-update` 那条路里调用；装别的插件的通道一个字节都不经过这里。
//   ② 拿不到 tarball / 没有该版本的完整性摘要 ⇒ 什么都不做（返回 reason），调用方回落到既有 curl 通道。
//   ③ 覆盖失败（EPERM/EBUSY 等）⇒ 如实返回 reason，**不重试、不删目录、不谎报**。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeLockRegistryVersion } from './lock-importer.js'
import { verifyPackageBox } from './install-box.js'
import { execFileAsync } from '../infra/exec.js'
import { copyTree, removeDirVerified } from '../infra/fsx.js'
import { fetchJsonUrl } from '../infra/http.js'

/** registry 元数据的超时（与既有 curl 通道同量级；拿不到就是拿不到，不许拖住自更新）。 */
const META_TIMEOUT_MS = 15000
/** tarball 下载超时（既有 curl 通道是 70s；这里 60s 封顶）。 */
const DOWNLOAD_TIMEOUT_MS = 60000
/** 解包超时（既有 curl 通道 30s）。 */
const EXTRACT_TIMEOUT_MS = 30000
/** 补完 lock 之后那次 pnpm **只读**校验的超时。刻意比 lock-importer 的 60s 短：
 *  自更新这条路上 pnpm 本来就是"可能很慢"的那一环，不能为了复核再让用户多等一分钟；
 *  超时按"**无法确认**"处理（verified=null），**不**回滚 —— 只有 pnpm 真的报错才回滚。 */
const LOCK_VERIFY_TIMEOUT_MS = 20000
/** 工作目录前缀（临时目录，跑完即删；名字里带随机段避免并发互撞）。 */
const WORK_PREFIX = 'dsh-selfupdate-'

/** registry 包名 → URL 段（与 install.js#curlManualInstall **同一口径**：scope 的 `/` 编成 `%2f`）。 */
function encodePackageName(packageName) {
  const name = String(packageName ?? '')
  if (!name.startsWith('@')) return encodeURIComponent(name)
  return `@${encodeURIComponent(name.slice(1).split('/')[0])}%2f${encodeURIComponent(name.split('/').slice(1).join('/'))}`
}

/** curl 可执行名（与既有通道一致：Windows 上是 curl.exe —— 有些环境里 PATH 上只有它）。 */
function curlBin() {
  return process.platform === 'win32' ? 'curl.exe' : 'curl'
}

/** 离线/测试模式：CI 里 `DSH_TEST_SKIP_NETWORK=1`（见 .github/workflows/test.yml），照着跳过网络。 */
function networkBlocked(deps = {}) {
  const env = typeof deps.env === 'object' && deps.env !== null ? deps.env : process.env
  return String(env?.DSH_TEST_SKIP_NETWORK ?? '') === '1'
}

/** 建一个本次自更新专用的临时工作目录。 */
function makeWorkDir(deps = {}) {
  const base = typeof deps.tmpDir === 'function' ? deps.tmpDir() : tmpdir()
  const dir = join(base, `${WORK_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 删掉一个工作目录并**核实**（infra/fsx.js#removeDirVerified：本机实测 `%TEMP%` 下 rmSync 会
 *  **静默落空** —— 不抛错、目录仍在；临时目录里装着下载下来的 tarball，不能"以为删了"就算了）。
 *  返回 `{ removed, note }`；没删掉时 note 里带绝对路径（用户可自己清）。 */
function cleanWorkDir(dir) {
  const target = typeof dir === 'string' ? dir : ''
  if (target === '') return { removed: false, note: null }
  const verdict = removeDirVerified(target)
  if (verdict.ok === true) return { removed: true, note: null }
  return { removed: false, note: `临时目录没删掉（${target}）：${verdict.error ?? '原因未知'}（可自行删除）` }
}

/** `curl -sL -m <秒> -o <tgz> <url>`（与 install.js#curlManualInstall 同一形态）。 */
async function downloadToFile(url, tgz, { timeout = DOWNLOAD_TIMEOUT_MS, deps = {} } = {}) {
  const run = typeof deps.exec === 'function' ? deps.exec : execFileAsync
  await run(curlBin(), ['-s', '-L', '-m', String(Math.max(5, Math.ceil(timeout / 1000))), '-o', tgz, url], { timeout: timeout + 10000, windowsHide: true })
}

/** `tar -xzf <tgz> -C <dir>`（与既有通道同一形态）。 */
async function extractTarball(tgz, dir, { deps = {} } = {}) {
  const run = typeof deps.exec === 'function' ? deps.exec : execFileAsync
  await run('tar', ['-xzf', tgz, '-C', dir], { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true })
}

/** 解压目录里含 package.json 的那一层（npm tarball 恒为 `package/`，但别假设）。 */
function findPackageDir(dir) {
  const direct = join(dir, 'package')
  if (existsSync(join(direct, 'package.json'))) return direct
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(dir, entry.name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

/** 目录里的文件相对路径集合（用于如实报"铺了几个文件、原地保留了几个"）。只读、失败返回空集。 */
function filesUnder(dir) {
  const out = new Set()
  const walk = (current, prefix) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(current, entry.name), rel)
      else if (entry.isFile()) out.add(rel)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

/**
 * ① 预先备好目标版本的 tarball（**pnpm 之前**跑；失败只记原因，不阻断后续）。
 * 走的是既有链路：registry 元数据（`fetchJsonUrl`，可注入）→ `meta.versions[版本].dist.tarball` → curl 下载。
 * 返回 `{ ok, version, tgzPath, workDir, integrity, tarball, registry, reason, ms }`。
 * `integrity` 来自元数据 `dist.integrity`（pnpm 自己写进 lock 的就是这个值）——
 * 拿不到就为 null，调用方据此**不**改 lock 的 packages 段（绝不用旧版本的摘要顶替）。
 */
async function prepareSelfUpdateTarball({ packageName, version, registries = [], deps = {} } = {}) {
  const startedAt = Date.now()
  const out = { ok: false, version: typeof version === 'string' ? version : null, tgzPath: null, workDir: null, integrity: null, tarball: null, registry: null, reason: null, ms: 0 }
  const label = (error) => (error instanceof Error ? error.message : String(error))
  const fetchJson = typeof deps.fetchJson === 'function' ? deps.fetchJson : fetchJsonUrl
  if (typeof version !== 'string' || version.trim() === '') {
    out.reason = '没有目标版本，未预先下载 tarball'
    return out
  }
  if (networkBlocked(deps)) {
    out.reason = '已跳过网络（DSH_TEST_SKIP_NETWORK=1）—— 未预先下载 tarball'
    return out
  }
  const regs = Array.isArray(registries) ? registries.filter((r) => typeof r === 'string' && r !== '') : []
  if (regs.length === 0) {
    out.reason = '没有可用的软件源，未预先下载 tarball'
    return out
  }
  let dist = null
  const metaErrors = []
  for (const registry of regs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const meta = await fetchJson(`${registry}/${encodePackageName(packageName)}`, META_TIMEOUT_MS)
      const record = meta?.versions?.[version]
      if (record === undefined || record === null) {
        metaErrors.push(`${registry}：元数据里没有 ${version} 这个版本`)
        continue
      }
      const tarball = typeof record.dist?.tarball === 'string' ? record.dist.tarball : null
      if (tarball === null) {
        metaErrors.push(`${registry}：${version} 没有 dist.tarball`)
        continue
      }
      dist = { registry, tarball, integrity: typeof record.dist?.integrity === 'string' && record.dist.integrity !== '' ? record.dist.integrity : null }
      break
    } catch (error) {
      metaErrors.push(`${registry}：${label(error)}`)
    }
  }
  if (dist === null) {
    out.reason = `拿不到 ${version} 的 registry 元数据（${metaErrors.join('；') || '原因未知'}）`
    out.ms = Date.now() - startedAt
    return out
  }
  let workDir = null
  try {
    workDir = makeWorkDir(deps)
    const tgzPath = join(workDir, 'pkg.tgz')
    const download = typeof deps.download === 'function' ? deps.download : downloadToFile
    await download(dist.tarball, tgzPath, { timeout: deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS, deps })
    const size = existsSync(tgzPath) ? statSync(tgzPath).size : 0
    if (size <= 0) throw new Error(`下载下来的 tarball 是空文件（${tgzPath}）`)
    out.ok = true
    out.version = version
    out.tgzPath = tgzPath
    out.workDir = workDir
    out.integrity = dist.integrity
    out.tarball = dist.tarball
    out.registry = dist.registry
    return out
  } catch (error) {
    out.reason = `下载 ${version} 的 tarball 失败：${label(error)}`
    if (workDir !== null) {
      cleanWorkDir(workDir)
    }
    return out
  } finally {
    out.ms = Date.now() - startedAt
  }
}

/**
 * ② 用备好的 tarball **只覆盖文件、不清空目录**地铺进 `node_modules/<包名>`，随后**读回**版本核实。
 * 与既有 curl 通道的区别只有一条、但正是这条要命：**不先 rmSync 整目录**
 * （宿主正读着这些文件时，删目录比覆盖文件更容易被 Windows 拒绝；而且删完再失败就只剩空目录）。
 * 返回 `{ ok, version, files, preserved, boxNote, reason }`：`preserved` = 目录里原有的、**不在 tarball 里**的文件数
 * （copyTree 一个都不删，这个数是给"没清空目录"作证的）。
 */
async function overlaySelfUpdateTarball({ prepared = null, profileDir, packageName, expectedVersion = null, deps = {} } = {}) {
  const out = { ok: false, version: null, files: 0, preserved: 0, boxNote: null, links: null, reason: null }
  const label = (error) => (error instanceof Error ? error.message : String(error))
  if (prepared === null || prepared === undefined || prepared.ok !== true || typeof prepared.tgzPath !== 'string') {
    out.reason = `没有可用的预下载 tarball${prepared?.reason ? `（${prepared.reason}）` : ''}`
    return out
  }
  const target = join(String(profileDir), 'node_modules', ...String(packageName).split('/'))
  let extractDir = null
  try {
    extractDir = makeWorkDir(deps)
    const extract = typeof deps.extract === 'function' ? deps.extract : extractTarball
    await extract(prepared.tgzPath, extractDir, { deps })
    const pkgDir = findPackageDir(extractDir)
    if (pkgDir === null) throw new Error('解包后未找到含 package.json 的目录')
    // 盒子校验（既有件）：包名不符 / 入口文件缺失 / bundle 引用缺失 —— 覆盖旧版本**之前**拦住
    const box = verifyPackageBox(pkgDir, profileDir, packageName)
    out.boxNote = box?.note ?? null
    const tarballFiles = filesUnder(pkgDir)
    const existing = filesUnder(target)
    let preserved = 0
    for (const rel of existing) if (!tarballFiles.has(rel)) preserved += 1
    // ★ 覆盖之前先**断开硬链接**（2026-11-04 加法，见 breakHardLinksUnder：pnpm 的 node_modules 文件是指向
    //   store 的硬链接，copyFileSync 会顺着链接把 store 里那一版的内容改掉 —— 波及别的 profile）
    out.links = breakHardLinksUnder(target, tarballFiles)
    // ★ 只覆盖：copyTree 只 copyFileSync（不删任何东西），目录缺就建目录 —— 见 infra/fsx.js
    copyTree(pkgDir, target)
    try {
      writeFileSync(join(target, '.dsh-installed-at'), String(Date.now()), 'utf8')
    } catch {}
    const installed = readVersionOf(target)
    out.version = installed
    out.files = tarballFiles.size
    out.preserved = preserved
    const want = typeof expectedVersion === 'string' && expectedVersion !== '' ? expectedVersion : null
    if (want !== null && installed !== want) {
      out.reason = `铺完之后读回的版本是 ${installed ?? '（读不出来）'}，不是目标版本 ${want}`
      return out
    }
    out.ok = true
    return out
  } catch (error) {
    out.reason = `覆盖文件失败：${label(error)}`
    return out
  } finally {
    if (extractDir !== null) {
      cleanWorkDir(extractDir)
    }
  }
}

/**
 * 覆盖之前**断开硬链接**（2026-11-04 加法，用户红线「不能影响别的功能」）。
 * 现场事实：pnpm 把 store 里的文件**硬链接**进 `node_modules`，而 `copyFileSync` 是"打开目标文件、截断、写入"
 * —— 它顺着硬链接**写回 store**：把 store 里 0.5.103 那份的内容换成 0.5.101 的（本机实测确认：nlink=2 时
 * copyFileSync 会让另一份的内容一起变）。store 被改脏会波及**别的 profile**（同一 store 里那一版从此是坏的）。
 * 所以只对"本来就在、且 nlink > 1"的目标文件做 **delete-then-copy**（删一个文件 ≠ 清空目录：
 * 它本来就要被覆盖；tarball 里没有的文件一个都不动）。
 * 删不掉（宿主正锁着该文件）⇒ 退回原地覆盖 = 与上一版行为逐字一致，**不新增失败模式**。
 * 返回 `{ broken, failed }`：断了几个硬链接、几个没断开（如实上报，供调用方展示）。
 */
function breakHardLinksUnder(root, rels) {
  const out = { broken: 0, failed: 0 }
  for (const rel of rels) {
    const full = join(String(root), ...String(rel).split('/'))
    // 目标里还没有这个文件（首次铺入 / 新版新增）⇒ 不需要断链，更不是失败
    if (existsSync(full) !== true) continue
    try {
      const info = statSync(full)
      if (info.isFile() !== true || info.nlink <= 1) continue
      rmSync(full, { force: true })
      out.broken += 1
    } catch {
      out.failed += 1
    }
  }
  return out
}

/** 读一份包目录里清单的版本（读不到返回 null）。 */
function readVersionOf(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(String(dir), 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 该包在清单里属于哪个依赖分区 —— **不在这里再写一份**：由调用方（selfupdate.js#manifestSectionOf，
 *  复用 lockfile-health.js 的既有解析器）传进来，两处各写一份必然分叉。 */

/**
 * ③ 落地成功之后**必须**把 lock 补到目标版本（不补就重演"下次 pnpm 操作把版本还原"的老毛病）。
 * 写入走 domain/lock-importer.js#writeLockRegistryVersion（唯一写入口，内部再复用 importer 规划器，
 * 并且**写后读回逐字核对**）。
 * ★ 2026-11-04 改动：pnpm 的只读解析校验（`pnpm install --lockfile-only --dry-run --frozen-lockfile`）
 * 改成**显式注入才跑**（`deps.verifyLock`）—— 自更新这条路从此不启动任何 pnpm。不注入时 verified=null
 * 并如实写明"未做解析层校验"（**绝不**把它当作通过）。注入时逐字沿用既有逻辑：复核**明确不通过**
 * （verified === false）⇒ 把 lock 还原成改动前的字节，并按未补上如实上报：宁可回到"会被还原"的老状态
 * + 一条可复制的命令，也绝不留下 pnpm 会拒绝的 lock。
 * 返回 `{ attempted, changed, unchanged, version, integrityWritten, renamed, verified, verifyNote, rolledBack, reason, note }`。
 */
async function patchSelfUpdateLock({ profileDir, packageName, targetVersion, spec = null, integrity = null, section = 'dependencies', deps = {} } = {}) {
  const out = { attempted: false, changed: false, unchanged: false, version: null, integrityWritten: false, renamed: { packages: false, snapshots: false }, verified: null, verifyNote: null, rolledBack: false, reason: null, note: null }
  const label = (error) => (error instanceof Error ? error.message : String(error))
  const specText = typeof spec === 'string' ? spec.trim() : ''
  const rangeLike = specText === '' || /^[\^~]?\d/u.test(specText) || /^(>=|>|=)\s*\d/u.test(specText)
  if (rangeLike !== true) {
    // 来源型 spec（git/file/link/URL）：既有约定是**原样保留**清单声明，lock 的 importer 条目也因此不改
    // （改成版本号就会与清单对不上，pnpm 下一次操作会把链接/来源丢掉）。
    out.reason = `清单 spec 是来源型（${specText}）—— 按既有约定保留来源，importer 条目不改写，lock 未补`
    return out
  }
  const lockFile = join(String(profileDir), 'pnpm-lock.yaml')
  let before = null
  try {
    before = readFileSync(lockFile, 'utf8')
  } catch (error) {
    out.reason = `读不到 pnpm-lock.yaml（${label(error)}）—— lock 未补`
    return out
  }
  out.attempted = true
  const write = typeof deps.writeLock === 'function' ? deps.writeLock : writeLockRegistryVersion
  let written = null
  try {
    written = await write(String(profileDir), {
      name: packageName,
      // 清单会被收尾段同步成裸版本号（见 self-update-guard.js#finishSelfUpdate），lock 的 specifier 跟它一致
      spec: targetVersion,
      version: targetVersion,
      integrity,
      section,
      deps: deps.writeDeps ?? {},
    })
  } catch (error) {
    out.reason = `写 lock 失败：${label(error)}`
    return out
  }
  out.changed = written?.changed === true
  out.unchanged = written?.unchanged === true
  out.version = written?.version ?? null
  out.integrityWritten = written?.integrityWritten === true
  out.renamed = written?.renamed ?? out.renamed
  // 写入器"改成了、但有话要说"（例如没有该版本的完整性摘要 ⇒ packages/snapshots 段按规则不动）：
  // 这句是**说明**不是失败，放 note 里如实下发（reason 只留给真正的失败）。
  out.note = typeof written?.reason === 'string' && written.reason !== '' ? written.reason : null
  if (out.changed !== true && out.unchanged !== true) {
    out.reason = written?.reason ?? 'lock 未写入（原因未给出）'
    return out
  }
  // ★ 2026-11-04 改动（用户拍板「自更新彻底不走 pnpm」）：pnpm 的**只读解析校验**也改成"显式注入才跑"。
  //   理由与自更新同一条：`pnpm install --lockfile-only --dry-run` 在这台机器上同样要几分钟（必被超时杀），
  //   而自更新不能为了复核再启动一次包管理器。不注入 ⇒ `verified=null`（**无法确认**，不是"通过"），
  //   并如实说明"未做解析层校验"；写入器（writeLockRegistryVersion）本身已经做了**写后读回逐字核对**。
  //   注入（既有测试 / 未来调用方）⇒ 逐字沿用原逻辑，含"明确不通过就把 lock 还原成改动前的字节"。
  const verify = typeof deps.verifyLock === 'function' ? deps.verifyLock : null
  if (verify === null) {
    out.verified = null
    out.verifyNote = '本轮不启动 pnpm（自更新不再走包管理器）：lock 已定点写入并读回核对，但未做 pnpm 的解析层只读校验'
    return out
  }
  try {
    const verdict = await verify({ profileDir, registry: deps.registry ?? null, execOpts: { timeout: LOCK_VERIFY_TIMEOUT_MS }, ...(deps.verifyArgs ?? {}) })
    out.verified = verdict?.verified ?? null
    out.verifyNote = verdict?.reason ?? null
  } catch (error) {
    out.verified = null
    out.verifyNote = `只读校验执行失败：${label(error)}`
  }
  // 只读校验**没跑完**（超时/被杀/执行方式不可用）不算"明确不通过" ⇒ 按无法确认处理，不回滚：
  // 这类失败说明的是"这台机器上 pnpm 跑不动"，而不是"写进去的 lock 有问题"。
  if (out.verified === false && /超时|timed out|timeout|已终止整棵进程树|killed|ENOENT|Cannot find module|不可用/iu.test(String(out.verifyNote ?? ''))) {
    out.verified = null
    out.verifyNote = `pnpm 只读校验没跑完（按无法确认处理，未回滚）：${out.verifyNote ?? '原因未知'}`
  }
  if (out.verified === false) {
    // 明确不通过：还原成改动前的字节（宁可报没补上，也绝不留下 pnpm 会拒绝的 lock）
    try {
      writeFileSync(lockFile, before, 'utf8')
      out.rolledBack = true
      out.changed = false
      out.reason = `pnpm 的只读校验未通过（${out.verifyNote ?? '原因未知'}）—— 已把 pnpm-lock.yaml 还原成改动前的内容，按未补上处理`
    } catch (error) {
      out.reason = `pnpm 的只读校验未通过（${out.verifyNote ?? '原因未知'}），且还原 pnpm-lock.yaml 失败：${label(error)}`
    }
  }
  return out
}

/** 收尾：删掉本次临时工作目录（不抛、不阻塞、绝不影响返回结构）。 */
function disposeSelfUpdateTarball(prepared) {
  return cleanWorkDir(typeof prepared?.workDir === 'string' ? prepared.workDir : '')
}

export {
  DOWNLOAD_TIMEOUT_MS,
  EXTRACT_TIMEOUT_MS,
  LOCK_VERIFY_TIMEOUT_MS,
  META_TIMEOUT_MS,
  WORK_PREFIX,
  breakHardLinksUnder,
  disposeSelfUpdateTarball,
  downloadToFile,
  encodePackageName,
  extractTarball,
  filesUnder,
  findPackageDir,
  overlaySelfUpdateTarball,
  patchSelfUpdateLock,
  prepareSelfUpdateTarball,
  readVersionOf,
}
