// L1 · domain —— link 开发式安装的**清单与体检**（0.5.54 加法）
//
// 为什么需要（用户 2026-10-15 明确诉求 + 审计结论）：
//   控制台**算得出**这些信息，却**从不展示**：
//     · `planLinkSelfSufficiency` 会给出 target / ready / 缺哪些 dep 与 peer / 哪些 peer
//       解析到了**别的副本**（模块身份不共享）—— 但过去只用来判断"要不要修"，结果一算就丢；
//     · `listSelfSufficiencyRecords` 记着"我们造过哪些垫片"，也没有任何生产调用方；
//     · `persistReport` 能判"清单 + lock + 挂载行"三处是否齐备，只在安装作业里用一次。
//   于是开发者的真实处境是：**插件钉到本地目录了，但面板上它和普通插件长得一模一样** ——
//   看不出指向哪、目标还在不在、依赖齐不齐、改完代码到底加载的是哪一份。
//
// 本模块把这些**只读地聚合成一份清单**（纯读盘、零写盘、不联网、不 spawn）：
//   每项 = 包名 + spec + 目标目录 + 目标版本 + 自足性明细 + 垫片账 → 供面板直接渲染。
//
// 边界（与既有模块同一套纪律）：
//   · 判据**全部复用**既有唯一真源（`planLinkSelfSufficiency` / `persistReport` /
//     `listSelfSufficiencyRecords`），本模块**不新写**任何 lock / 清单 / 解析器；
//   · 只处理**路径型来源**（`link:` / `file:`）—— 那是"开发式安装"的定义（见 source-spec 判据 C）；
//   · 任何单个包出问题都**不抛**，如实降级成该行的一个字段（一份清单不能因为一行坏掉就整体消失）。
//
// 分层：L1 domain —— 不认识 cordis ctx；home / profileDir / patchPath 全部由调用方解开后传入。
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSourceSpec, sourceSpecTarget } from './dep-source.js'
import { planLinkSelfSufficiency, listSelfSufficiencyRecords } from './link-self-sufficiency.js'
import { persistReport } from './persist.js'

const readJsonSafe = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 路径型来源（`link:` / `file:`）—— 只有这一族是"开发式安装"，才有目标目录可体检。 */
const PATH_SPEC_RE = /^(?:link:|file:)/u

/** profile 清单里的依赖（只取路径型来源，保持清单原顺序）。 */
function pathDepsOf(profileDir) {
  const manifest = readJsonSafe(join(profileDir, 'package.json'))
  const deps = manifest?.dependencies
  if (deps === null || typeof deps !== 'object') return []
  const out = []
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || spec === '') continue
    const canonical = canonicalSourceSpec(spec)
    if (canonical === null || !PATH_SPEC_RE.test(canonical)) continue
    out.push({ packageName: name, spec: canonical })
  }
  return out
}

/** 该包的垫片记录（按包名匹配；找不到返回 null）。 */
function shimRecordOf(records, packageName) {
  for (const item of records) {
    const rec = item?.record
    if (rec && rec.packageName === packageName) return { file: item.file, shims: Array.isArray(rec.shims) ? rec.shims : [], updatedAt: rec.updatedAt ?? null, note: rec.note ?? null }
  }
  return null
}

/**
 * 聚合一份 link 清单。
 *
 * @param {object} p
 * @param {string} p.profileDir profile 根目录
 * @param {string} [p.patchPath] 用户补丁路径（persistReport 判"挂载行"用；缺省则该项 skipped）
 * @param {Array} [p.entries] loader 行（判"运行时已有行"用；缺省则由 persistReport 自行读盘）
 * @param {string} [p.home] DSH 家目录（读垫片账用；缺省走 dshHome）
 * @returns {{ items: Array<object>, count: number, readyCount: number }}
 */
function buildLinkInventory({ profileDir, patchPath = null, entries = null, home = null } = {}) {
  const deps = pathDepsOf(profileDir)
  if (deps.length === 0) return { items: [], count: 0, readyCount: 0 }
  const records = listSelfSufficiencyRecords({ home })
  const items = []
  for (const { packageName, spec } of deps) {
    // 每一项都独立 try：一行坏掉不能让整份清单消失（体检报告的价值在于"看得到"）
    const item = {
      packageName,
      spec,
      target: null,
      targetExists: false,
      // ★ 0.5.87 加法：目标目录的最后修改时间（ISO 字符串；拿不到就是 null，由面板渲染成「—」）。
      //   为什么需要：开发者常常同时有 plugin-src 下的好几个副本，「这是不是我正在改的那个」
      //   只能靠时间判断。**绝不编造**：stat 失败一律 null，不写 0、不写当前时间。
      targetMtime: null,
      version: null,
      ready: null,
      missingDeps: [],
      missingPeers: [],
      shimmablePeers: [],
      unavailablePeers: [],
      foreignPeers: [],
      shims: null,
      persisted: null,
      note: null,
      error: null,
    }
    try {
      const plan = planLinkSelfSufficiency({ profileDir, packageName, spec, home })
      item.target = plan.target ?? sourceSpecTarget(profileDir, spec)
      item.targetExists = plan.targetExists === true
      item.ready = plan.ready === true
      item.missingDeps = plan.missingDeps ?? []
      item.missingPeers = plan.missingPeers ?? []
      item.shimmablePeers = plan.shimmablePeers ?? []
      item.unavailablePeers = plan.unavailablePeers ?? []
      // 「能解析」不等于「解析到宿主那一份」：声明过框架 peer 却解析到别处 ⇒ 模块身份不共享。
      // 这条最隐蔽，必须让开发者看见（只报告、不动手）。
      item.foreignPeers = plan.foreignPeers ?? []
      item.note = plan.note ?? plan.reason ?? null
      if (item.target !== null && item.targetExists) {
        // 版本与修改时间各自独立 try：读 package.json 坏掉不该连"文件是什么时候动的"也一并丢掉，
        // 反之 stat 失败也不该吞掉版本号。
        try {
          const pkg = readJsonSafe(join(item.target, 'package.json'))
          item.version = typeof pkg?.version === 'string' ? pkg.version : null
        } catch {}
        try { item.targetMtime = statSync(item.target).mtime.toISOString() } catch { item.targetMtime = null }
      }
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error)
    }
    try {
      const rec = shimRecordOf(records, packageName)
      item.shims = rec === null ? null : { count: rec.shims.length, items: rec.shims, updatedAt: rec.updatedAt, note: rec.note }
    } catch {}
    try {
      if (typeof patchPath === 'string' && patchPath !== '') {
        const report = persistReport({ profileDir, patchPath, packageName, entries })
        item.persisted = { ok: report.persisted === true, missing: report.missing ?? [] }
      }
    } catch {}
    items.push(item)
  }
  const readyCount = items.filter((x) => x.ready === true).length
  return { items, count: items.length, readyCount }
}

/** 该路径是不是本 profile 里某个 `link:`/`file:` 依赖的**实际目标**（`repo-open` 的白名单判据）。
 *  只认"清单里写着的那条"，浏览器无法通过请求体扩大它 —— 因此不构成任意路径打开的越权。 */
function isLinkTargetOfProfile(profileDir, candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false
  const norm = (s) => String(s).replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
  const want = norm(candidate)
  for (const { spec } of pathDepsOf(profileDir)) {
    const target = sourceSpecTarget(profileDir, spec)
    if (target !== null && norm(target) === want) return true
  }
  return false
}

export { PATH_SPEC_RE, pathDepsOf, buildLinkInventory, isLinkTargetOfProfile }
