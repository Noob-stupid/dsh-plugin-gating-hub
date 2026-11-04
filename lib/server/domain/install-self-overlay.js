// L1 · domain —— install-self-overlay.js（`POST /install` 上「目标就是本插件自己」的覆盖式安装；2026-11-04 加法）
//
// ── 现场（真机 2026-11-04 20:21，8 秒粒度采样；用户提供的原始时间线）──────────────────────────
//   用户点的是「**详情页的更新按钮**」—— 那颗按钮走 `POST /install`（lib/client.js#startJob），
//   **不是** `POST /self-update`。所以 0.5.105「自更新彻底不走 pnpm」那套改动**一次都没被触发**：
//     20:21:14  目录 = 空壳（1 文件）   pnpm = 有 1 个在跑   备份 = 0
//     20:22:14  目录 = 空壳（1 文件）   pnpm = 仍在跑         备份 = 0
//   即：`/install` 这条路上通道序列照旧先启动 pnpm，而 pnpm 一启动就**先把目标目录清空**，
//   本机它要 3~9 分钟且必被超时杀 ⇒ 目录一直空着；排在它后面的 curl 兜底永远轮不到。
//
// ── 本模块做什么（判据只有一个：目标包名 === 本插件包名）──────────────────────────────────
//   命中 ⇒ **整条通道序列（竞速 / pnpm / curl / release / preset / git / 定向重试）一个都不跑**，
//   改走与 `/self-update` 同一条"下载 tarball → **只覆盖、不清空** → 读回核对版本"的路：
//     ① 目标版本：作业点名的版本（`job.version`）优先；没点名就按 registry 的 `dist-tags.latest` 探一次；
//     ② 预下载 tarball + 覆盖解包 —— **复用** domain/selfupdate-copy.js（唯一实现，含 breakHardLinksUnder）；
//     ③ 备份 / 自愈 / 绝对路径 manualCommand —— **复用** domain/self-update-guard.js（唯一实现）；
//     ④ **pnpm-lock.yaml 一个字节都不动**（用户 2026-11-04 拍板：「不按 lock 不就行了，我们不是取消 lock 了吗」）。
//        理由：改 lock 是**风险来源**（写坏会波及整个 profile），而"被还原"的代价很低 —— 再点一次更新即可
//        （覆盖式只要几秒钟）。所以本次**不写 lock、不做 lock 外科手术**，只在结果里如实记一条 `lockNote`
//        （「本次没有改 lock，下次包管理器操作可能把版本还原」），绝不谎报"已同步"。
//
// ── 边界（别越线）────────────────────────────────────────────────────────────────────
//   ① 只对**本插件自己**生效：`isSelfUpdate()` 不成立时 `runSelfOverlayInstall()` 直接返回 null，
//      调用方走原路径 —— 装别的包的通道序列、超时、版本闸、AI 兜底、清单与 lock 写入**一个字节都不变**
//      （负控见 tests/test-install-self-overlay.mjs ④）；
//   ② 覆盖**没成**（离线 / 拿不到 tarball / 解包失败）⇒ 返回 `ok:false` 并**交还控制权**：调用方落回
//      **既有**通道序列（语义与改动前逐字相同）。本模块绝不半路改判既有通道的行为。
//   ③ 本模块**不判断"更新成功与否"**：落地与否由「读回的版本 === 目标版本」（覆盖那一步自己核对）
//      + 守卫的同一判据说了算；任何一项不成立都如实报，绝不报成功。
//   ④ 清单一族（`<profile>/package.json` 的 dependencies）本次也不改：清单与 lock 保持**互相一致**的旧状态，
//      比"清单写新版、lock 还写旧版"这种两处对不上的状态干净（后者正是 reconcileLockfile 报的 `misrecorded`）。
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { probeRegistryPackage } from './dep-source.js'
import { targetVersionOf } from './install-version.js'
import { isSelfUpdate } from './self-update-guard.js'
import { disposeSelfUpdateTarball, overlaySelfUpdateTarball, prepareSelfUpdateTarball } from './selfupdate-copy.js'

/** 通道名（与 `/self-update` 那条路同一个说法：覆盖式 = manual-overlay）。 */
const OVERLAY_CHANNEL = 'manual-overlay'

/** 「lock 一个字节都没动」的如实说明（结果里/面板上都用这一句；**不许**改写成"已同步"）。 */
const SELF_OVERLAY_LOCK_NOTE = '本次没有改 pnpm-lock.yaml（覆盖式安装只动 node_modules/<本插件>，清单与 lock 都保持原样）：'
  + '之后任何一次包管理器操作（开关插件、dsh plugin add/remove）都可能把版本还原成 lock 里那一版 —— 届时在面板上再点一次更新即可（覆盖式只要几秒钟）'

/** 目录是不是链接（junction 在 lstat 上也表现为符号链接）—— 只看形状；读不到按"不是链接"处理。 */
function isLinkedDir(dir) {
  try { return lstatSync(dir).isSymbolicLink() === true } catch { return false }
}

const labelOf = (error) => (error instanceof Error ? error.message : String(error))


/**
 * 目标版本：点名的优先，其次 registry 的 `dist-tags.latest`（**只读探测**，不装任何东西）。
 * 返回 `{ version, source, reason }`：`version:null` 时 `reason` 里有如实原因（调用方据此落回既有通道。
 */
async function resolveSelfOverlayVersion({ job = null, packageName = '', registries = [], deps = {} } = {}) {
  const named = targetVersionOf(job, packageName)
  if (named !== null) return { version: named, source: 'job', reason: null }
  const list = (Array.isArray(registries) ? registries : []).filter((r) => typeof r === 'string' && r.trim() !== '')
  if (list.length === 0) return { version: null, source: null, reason: '没有可用的软件源，无法确定目标版本' }
  const probe = typeof deps.probeRegistry === 'function' ? deps.probeRegistry : probeRegistryPackage
  try {
    const found = await probe(packageName, list, { fetchJson: deps.fetchJson, timeoutMs: deps.metaTimeoutMs })
    const latest = typeof found?.latest === 'string' && found.latest !== '' ? found.latest : null
    if (found?.resolvable !== true || latest === null) {
      const tried = Array.isArray(found?.tried) && found.tried.length > 0 ? `（${found.tried.join('；')}）` : ''
      return { version: null, source: null, reason: `探测不到 ${packageName} 的最新版本${tried}` }
    }
    return { version: latest, source: 'registry', reason: null }
  } catch (error) {
    return { version: null, source: null, reason: `探测最新版本失败：${labelOf(error)}` }
  }
}

/**
 * 覆盖式安装的**唯一入口**。
 * 不是本插件自己 ⇒ 返回 null（调用方走原路径，一个字节都不多走）；是本插件自己 ⇒ 一定返回一个报告对象：
 *   `ok:true`  已经铺上并且**读回的版本 === 目标版本**（可以就此收口，不用再碰任何通道）；
 *   `ok:false` 没铺成（`reason` 里是如实原因）—— 调用方落回**既有**通道序列，语义不变。
 * 返回结构（也直接进 `job.selfOverlay`，面板/接口都看得到；只增字段）：
 * `{ ok, channel, packageName, targetVersion, versionSource, version, files, preserved, links, boxNote,
 *    tarballNote, cleanupNote, lockTouched, lockNote, reason, ms }`。
 */
async function runSelfOverlayInstall({ job = null, packageName = '', profileDir = '', registries = [], deps = {} } = {}) {
  if (isSelfUpdate(packageName, deps) !== true) return null
  const startedAt = Date.now()
  const out = {
    ok: false, channel: OVERLAY_CHANNEL, packageName,
    targetVersion: null, versionSource: null, version: null,
    files: 0, preserved: 0, links: null, boxNote: null,
    tarballNote: null, cleanupNote: null,
    // lock 与清单**全程不动**（用户 2026-11-04 拍板）：这两个字段是给用户看的、也是自检用的
    lockTouched: false, manifestTouched: false, lockNote: SELF_OVERLAY_LOCK_NOTE,
    reason: null, ms: 0,
  }
  try {
    if (typeof profileDir !== 'string' || profileDir.trim() === '') {
      out.reason = '没有 profile 目录，无法做覆盖式安装'
      return out
    }
    // ① 目标版本（点名优先，其次 registry 的 latest —— 只读探测）
    const resolved = await resolveSelfOverlayVersion({ job, packageName, registries, deps })
    out.targetVersion = resolved.version
    out.versionSource = resolved.source
    if (resolved.version === null) {
      out.reason = resolved.reason ?? '拿不到目标版本，未做覆盖式安装'
      return out
    }
    // ①′ 目标目录是**链接**（link:/junction 安装，用户自己的源码树）⇒ 不覆盖：
    //    覆盖会顺着链接写进用户的工作区（把开发者正在改的那份源码换掉），这与 install-recovery 的
    //    边界③同一条理由（"宁可不动手，也要说清为什么不动手"）。落回既有通道，一个字节都不多走。
    if (isLinkedDir(join(String(profileDir), 'node_modules', ...String(packageName).split('/'))) === true) {
      out.reason = `node_modules/${packageName} 是链接（link:/junction 安装，指向用户自己的目录）⇒ 不做覆盖式安装，已回落既有通道`
      return out
    }
    // ② 预下载 tarball（复用的既有实现：registry 元数据 → dist.tarball → curl 下载）
    const prepared = await prepareSelfUpdateTarball({ packageName, version: resolved.version, registries, deps })
    out.tarballNote = prepared.ok === true ? null : (prepared.reason ?? null)
    // ③ **只覆盖、不清空**地铺进 node_modules/<本插件>，随后读回核对版本（同一个既有实现）
    const overlay = await overlaySelfUpdateTarball({ prepared, profileDir, packageName, expectedVersion: resolved.version, deps })
    const cleanup = disposeSelfUpdateTarball(prepared) // 下载物与解包目录收尾即删（删不掉要如实记）
    out.cleanupNote = cleanup.removed === true ? null : (cleanup.note ?? null)
    out.version = overlay.version ?? null
    out.files = overlay.files ?? 0
    out.preserved = overlay.preserved ?? 0
    out.links = overlay.links ?? null
    out.boxNote = overlay.boxNote ?? null
    out.ok = overlay.ok === true
    if (out.ok !== true) {
      out.reason = overlay.reason ?? prepared.reason ?? '覆盖式安装没有成功'
    }
    return out
  } catch (error) {
    out.reason = `覆盖式安装抛错：${labelOf(error)}`
    return out
  } finally {
    out.ms = Date.now() - startedAt
  }
}

/** 覆盖式安装成功时给用户看的那一句（**绝不静默**：铺了几个文件、原地保留几个、lock 没动）。
 *  调用方把它塞进 `job.curlNote`（面板「已安装」那一行就显示这个字段）。 */
function selfOverlayNote(overlay) {
  if (overlay === null || overlay === undefined || overlay.ok !== true) return null
  const version = overlay.version === null || overlay.version === undefined ? '?' : String(overlay.version)
  const parts = [`用覆盖式安装升到 v${version}（只覆盖了 ${overlay.files ?? 0} 个文件、**没有清空目录**，原地保留 ${overlay.preserved ?? 0} 个不在 tarball 里的文件；全程没有调用包管理器 pnpm）`]
  if (typeof overlay.boxNote === 'string' && overlay.boxNote !== '') parts.push(overlay.boxNote)
  if (overlay.links !== null && overlay.links !== undefined && (overlay.links.broken > 0 || overlay.links.failed > 0)) {
    parts.push(`断开硬链接 ${overlay.links.broken ?? 0} 个${overlay.links.failed > 0 ? `（${overlay.links.failed} 个没断开，已原地覆盖）` : ''}`)
  }
  if (typeof overlay.cleanupNote === 'string' && overlay.cleanupNote !== '') parts.push(overlay.cleanupNote)
  parts.push('重启服务后生效')
  return parts.join('；')
}

export { OVERLAY_CHANNEL, SELF_OVERLAY_LOCK_NOTE, resolveSelfOverlayVersion, runSelfOverlayInstall, selfOverlayNote }
