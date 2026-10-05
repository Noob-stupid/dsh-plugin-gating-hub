// L1 · domain —— source-spec.js（**来源型安装的"真实来源规格"记录** + 一键真装动作；2026-10-06 接线）
//
// 为什么需要它（本轮的接线缺口）：0.5.40 已经把能力做进了写入层 —— `declareProfileDependency({sourceSpec})`
// 会把**真实来源规格**写回清单，并由 `installSourceDependency` 走 `pnpm add <spec>` 真装（依赖与 peer
// 交给包管理器，与官方 `dsh plugin add` 同一条通道）。但**生产路径上没有一个调用方传过 sourceSpec**：
// curl / GitHub release 这些"取样通道"把包铺进 `node_modules` 之后，收口那一步只知道"磁盘上有个真实目录"，
// 于是按老的 registry 404 判据写成 `link:`（复制到 plugin-src + 链接）——依赖还是没人管。
// 本轮把"这个包是从哪个来源装来的"从通道一路传到收口，并在两处留下可核对的东西：
//   ① **记录**（本模块）：`<DSH_HOME>/plugin-console/source-specs/<包名>.json` —— 记下真实来源规格与
//      最近一次真装结果。用途是让「一键真装」动作能**服务端自己**取到规格：动作接口只接受
//      `{ action, packageName, profile }`，客户端**没有位置**传 spec 字符串（否则等于开了任意命令的口子）。
//   ② **文案与动作**（本模块是唯一承担者）：真装成功 / 真装失败的两种如实说法 + 结构化「一键真装」动作。
//
// 失败路径的语义（写死在这里，别处不许再解释一遍 —— 用户点名要求）：
//   A) 取样/下载**成功**、包管理器安装**失败** ⇒ 磁盘上确实有那份物化副本 ⇒ 允许回落既有 `link:`
//      路径（插件至少能加载）⇒ 文案必须含「已装上（link 方式）」+「真装失败：<原因>」+「可一键真装」。
//   B) 取样/下载**本身失败** ⇒ 磁盘上什么都没有 ⇒ **没有任何东西可挂** ⇒ 只能如实失败
//      （原因 + 重试）；**严禁**出现"回落成功 / 已安装 / 已启用"之类说法。
//   C) 本地目录：不涉及下载 ⇒ `link:` 是它的正常路径（+ 既有自足补齐）。
//   判据一句话：**回落只对"物已在盘上"成立；物不在盘上就只有如实失败**。
//
// 分层：L1 domain —— 不认识 cordis ctx；home 可注入（隔离测试用私有 DSH_HOME），一切失败都不抛。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'
import { canonicalSourceSpec, profileNameOf } from './dep-source.js'

/** 记录目录（与 link-self-sufficiency 记录同族，都在 `<DSH_HOME>/plugin-console/` 下）。 */
const SOURCE_SPEC_DIR = 'source-specs'

/** `link:` = 显式开发式安装（本地目录的正常路径），**不**交给 pnpm 真装（见 C）。 */
const LINK_SPEC_RE = /^link:/u

/** 可以交给 `pnpm add <spec>` 的**来源型**规格（tarball URL / git 族 / file: / 别名协议）。
 *  刻意**不含**版本号、版本范围、dist-tag：那些是 registry 路径，写回形态由既有判据决定（不倒退）。 */
const REAL_INSTALLABLE_RE = /^(?:https?:|git\+|git:|github:|gitlab:|bitbucket:|file:|workspace:|portal:|npm:|jsr:)/u

/** 记录目录 / 记录文件（一个包一份，便于一键真装与卸载清理精确定位）。 */
function sourceSpecRecordDir(home = null) {
  return join(typeof home === 'string' && home !== '' ? home : dshHome(), 'plugin-console', SOURCE_SPEC_DIR)
}
function recordFileNameOf(packageName) {
  return `${String(packageName).replace(/[^A-Za-z0-9._-]+/gu, '_')}.json`
}
function sourceSpecRecordPath(home, packageName) {
  return join(sourceSpecRecordDir(home), recordFileNameOf(packageName))
}

/** 读 JSON（读不到/坏文件都返回 null，绝不抛）。 */
function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 这个规格该不该交给包管理器**真装**（`link:` 不算：那是显式开发式安装）。 */
function isRealInstallSpec(spec) {
  const canonical = canonicalSourceSpec(spec)
  if (canonical === null || canonical === '') return false
  if (LINK_SPEC_RE.test(canonical)) return false
  return REAL_INSTALLABLE_RE.test(canonical)
}

/** 这个规格是不是 `link:`（显式开发式安装 / 本地目录的正常路径）。 */
function isLinkSourceSpec(spec) {
  const canonical = canonicalSourceSpec(spec)
  return canonical !== null && LINK_SPEC_RE.test(canonical)
}

/**
 * 安装通道带回的「来源」（`{ spec, origin, kind }`）→ `ensurePersisted` 的入参。
 * 空/没有规格 ⇒ **空对象**（调用方的形状与默认值与接线前逐字一致）；有规格 ⇒ 三个字段一次给全，
 * 收口才好判"这份物是取样通道铺的（sampled）还是包管理器装的（pnpm）"。
 */
function sourcePersistOptions(source) {
  if (source === null || source === undefined || typeof source !== 'object') return {}
  const spec = typeof source.spec === 'string' && source.spec !== '' ? source.spec : null
  if (spec === null) return {}
  return { sourceSpec: spec, sourceOrigin: source.origin ?? null, sourceKind: source.kind ?? null }
}

/** 读某包的来源规格记录（没有/坏文件返回 null）。 */
function readSourceSpec({ packageName, home = null } = {}) {
  if (typeof packageName !== 'string' || packageName === '') return null
  const record = readJsonSafe(sourceSpecRecordPath(home, packageName))
  if (record === null || typeof record !== 'object') return null
  if (typeof record.spec !== 'string' || record.spec === '') return null
  return record
}

/** 列出全部记录（体检/报告用）。 */
function listSourceSpecs({ home = null } = {}) {
  const dir = sourceSpecRecordDir(home)
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: join(dir, f), record: readJsonSafe(join(dir, f)) }))
  } catch {
    return []
  }
}

/**
 * 记下某包的真实来源规格（安装时写；**幂等**：规格与最近一次真装结论都没变 ⇒ 一个字节都不写）。
 * `install` 传 `installSourceDependency` 的返回值（`{ ok, spec, error }`）时，最近一次结论一并记下。
 * 返回 `{ ok, changed, file, record }`；任何失败都只如实返回，**绝不抛**（安装主路径不许被它带崩）。
 */
function recordSourceSpec({ packageName, spec, kind = null, install = null, home = null } = {}) {
  const empty = { ok: false, changed: false, file: null, record: null }
  if (typeof packageName !== 'string' || packageName === '') return empty
  const canonical = canonicalSourceSpec(spec)
  if (canonical === null || canonical === '') return empty
  const file = sourceSpecRecordPath(home, packageName)
  const installSummary = install === null || install === undefined
    ? null
    : { ok: install.ok === true, error: typeof install.error === 'string' && install.error !== '' ? install.error.slice(0, 600) : null }
  try {
    const previous = readJsonSafe(file)
    const sameSpec = typeof previous?.spec === 'string' && canonicalSourceSpec(previous.spec) === canonical
    const sameInstall = installSummary === null
      ? true
      : previous?.lastInstall?.ok === installSummary.ok && (previous?.lastInstall?.error ?? null) === installSummary.error
    if (sameSpec && sameInstall) return { ok: true, changed: false, file, record: previous }
    const record = {
      packageName,
      spec: canonical,
      kind: typeof kind === 'string' && kind !== '' ? kind : (previous?.kind ?? null),
      recordedAt: new Date().toISOString(),
      ...(installSummary === null ? {} : { lastInstall: { ...installSummary, at: new Date().toISOString() } }),
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return { ok: true, changed: true, file, record }
  } catch (error) {
    return { ...empty, file, reason: String(error?.message ?? error).slice(0, 300) }
  }
}

/**
 * 忘掉某包的来源规格记录（**卸载即撤销**，与 `undeclareProfileDependency` 同一时机调用）。
 * 删不掉时**退而求其次清空内容**（Windows 上 `<DSH_HOME>/plugin-console/` 下删除会静默落空，
 * 与 junction / `*_tmp_*` 同族）—— 绝不留下指向已卸载包的陈旧规格。
 */
function forgetSourceSpec({ packageName, home = null } = {}) {
  if (typeof packageName !== 'string' || packageName === '') return { removed: false, emptied: false, file: null }
  const file = sourceSpecRecordPath(home, packageName)
  if (!existsSync(file)) return { removed: false, emptied: false, file }
  try { rmSync(file, { force: true }) } catch {}
  if (!existsSync(file)) return { removed: true, emptied: false, file }
  let emptied = false
  try {
    writeFileSync(file, `${JSON.stringify({ packageName, forgotten: true, spec: null, note: '记录已作废；文件本身删除未生效，已清空以免留下陈旧规格' }, null, 2)}\n`, 'utf8')
    emptied = readJsonSafe(file)?.spec === null
  } catch { emptied = false }
  return { removed: false, emptied, file }
}

/**
 * 结构化「一键真装」动作（与 `suggestedPinAction` 同一套安全语义）：
 * `command` 只供展示/复制；执行侧只认 `payload.action`，**规格由服务端从记录里读**，
 * payload 里没有 spec / 命令字符串的位置。
 */
function suggestedRealInstallAction({ packageName, spec = null, profile = null, profileDir = null, reason = null } = {}) {
  const name = profile ?? profileNameOf(profileDir)
  const shown = canonicalSourceSpec(spec) ?? '<来源规格>'
  return {
    kind: 'real-install',
    label: '一键真装（交给包管理器装依赖）',
    command: `pnpm add ${shown} --registry https://registry.npmmirror.com`,
    payload: { action: 'real-install', packageName, profile: name },
    reason,
  }
}

/**
 * 真装结果 → 如实说法（**唯一承担者**）。三种形态各自把该说的话说完，绝不覆盖、绝不美化：
 *   · 成功：说清"按真实来源规格真装、依赖与 peer 由包管理器保证"；
 *   · 失败 + 已回落 `link:`：说清「已装上（link 方式）· 真装失败：<原因> · 可一键真装」；
 *   · 失败 + 盘上什么都没有：说清"无可挂载（未改动清单）"——**不出现**任何"已装上"字样。
 */
function composeSourceInstallNote({ packageName, install, plan = null } = {}) {
  if (install === null || install === undefined || typeof install.ok !== 'boolean') return null
  const spec = typeof install.spec === 'string' && install.spec !== '' ? install.spec : null
  if (install.ok === true) {
    return `${packageName}：已按真实来源规格真装（pnpm add ${spec ?? '（规格缺失）'}）—— 依赖与 peer 由包管理器保证（与官方 dsh plugin add 同一条通道）`
  }
  const error = typeof install.error === 'string' && install.error !== '' ? install.error : '（原因未记录）'
  if (plan?.form === 'link' && typeof plan.spec === 'string' && plan.spec !== '') {
    return `${packageName}：已装上（link 方式）· 真装失败：${error} · 已按 link: 记录（${plan.spec}），缺失依赖由 link 自足性尽力补齐 · 可一键真装`
  }
  if (plan !== null && typeof plan?.spec === 'string' && plan.spec !== '') {
    return `${packageName}：真装失败：${error}；已按现有形态记录（${plan.spec}）· 可一键真装`
  }
  return `${packageName}：真装失败：${error}；磁盘上没有任何副本 —— 无可挂载（未改动清单）`
}

export {
  SOURCE_SPEC_DIR,
  REAL_INSTALLABLE_RE,
  sourceSpecRecordDir,
  sourceSpecRecordPath,
  isRealInstallSpec,
  isLinkSourceSpec,
  sourcePersistOptions,
  readSourceSpec,
  listSourceSpecs,
  recordSourceSpec,
  forgetSourceSpec,
  suggestedRealInstallAction,
  composeSourceInstallNote,
}
