// L0 · infra —— fw-closure.js（框架**依赖闭包**探测：判据是"能不能解析出来"；0.5.50 加法）
//
// 为什么需要它（**真机停机事故 2026-10-14**）：
//   npx 缓存里的四个框架包被掏空 —— `cordis` 顶层 junction 还在、它指向的 `.pnpm` 实体目录
//   被清空；`dsh-llm` / `dsh-tools` / `dsh-web` 直接成了**空的真实目录**。后果是 dsh 启动即
//   `startup failed: 54 个插件 failed to import`，web 服务 exit code=1，**插件自己没机会运行**。
//
//   而既有指纹判据 `compat-state.js#pnpmEntities` 是**数 `.pnpm` 里 `@deepseek-ai*` 的目录个数**：
//   本事故形态恰好是"目录壳还在、里面被掏空" ⇒ 19 → 19，计数**一个都不变** ⇒ 指纹判定环境未变
//   ⇒ 不触发任何动作。次生的：`dsh-llm` / `dsh-tools` / `dsh-web` **根本不在 `.pnpm` 里**
//   （它们住在顶层 `node_modules/@deepseek-ai/`），那个计数从来就不覆盖它们。
//
//   本模块给出**面向解析**的判据：从 dsh 的 `lib/bin.js` 出发，把 `@deepseek-ai/*` 的依赖闭包
//   整条走一遍，谁 `resolve(name + '/package.json')` 失败谁就是坏的 —— 与目录长什么样无关，
//   不存在"数个数"那种对"掏空"免疫的盲区，也不会把 `@scope` 目录、`.pnpm` 历史残留误判成损坏
//   （2026-10-14 实测：按"目录空不空"粗扫本机会误报 237 个；换成闭包判据后 287 个包精准通过）。
//
// 两条纪律：
//   ① 判据只认"能解析"这一件事（与版本号无关）—— 与 domain/framework-residuals.js 的
//      `FRAMEWORK_BOOT_PACKAGES` 同源取舍：版本号对 ≠ 装完整。
//   ② IO 全部可注入（`deps`）—— 单测用内存实现即可驱动，不必真造一棵坏框架树、不联网、不起进程。
//
// 分层：L0 · infra（不得 import domain/routes/index —— tests/test-architecture-guard.mjs 断言②）。
// 行数预算：独立小模块，留在 600 行架构硬顶内。

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

/** 框架命名空间：`@deepseek-ai/*` 随框架版本走，承载者永远是框架安装树。 */
const FRAMEWORK_SCOPE = '@deepseek-ai/'

/**
 * 包名归一：`@scope/name/sub/deep` → `@scope/name`；裸名 `name/sub` → `name`。
 * 与 domain/framework-root.js#basePackageName 同判据（这里独立实现：那边服务"基准枚举"，
 * 这边服务"闭包遍历"，两者失败模式不同，不互相牵制）。
 */
function baseNameOf(spec) {
  const text = String(spec ?? '')
  if (text.startsWith('@')) {
    const parts = text.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : text
  }
  return text.split('/')[0]
}

/** 该引用名是否属于要遍历的命名空间（默认 `@deepseek-ai/`）。 */
function isInScope(spec, scopePrefix = FRAMEWORK_SCOPE) {
  const name = baseNameOf(spec)
  return name === scopePrefix.slice(0, -1) || name.startsWith(scopePrefix)
}

/**
 * 走一遍依赖闭包，返回**解析不了**的包（= 真正的损坏面）。
 *
 * @param {object} p
 * @param {string} p.entry            入口文件绝对路径（如 `<fwRoot>/@deepseek-ai/dsh/lib/bin.js`）；
 *                                    解析基准由它决定 —— 与 Node 真实解析语义完全一致，不另造基准。
 * @param {string} [p.rootName]       入口包名（默认 `@deepseek-ai/dsh`）。
 * @param {string} [p.scopePrefix]    只遍历这个前缀（默认 `@deepseek-ai/`）。
 * @param {number} [p.maxPackages]    遍历上限（防御病态闭包；默认 2000）。
 * @param {object} [p.deps]           IO 注入（单测用）。
 * @returns {{ ok: boolean, walked: string[], broken: Array<{name:string, from:string, reason:string}>,
 *             total: number, truncated: boolean }}
 *          `broken[].reason` 取值：`unresolvable`（解析失败）/`unreadable`（清单读不出）/`malformed`（JSON 坏）。
 */
function probeClosure({ entry, rootName = '@deepseek-ai/dsh', scopePrefix = FRAMEWORK_SCOPE, maxPackages = 2000, deps = {} } = {}) {
  const createReq = deps.createRequire ?? createRequire
  const readJson = deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')))
  const exists = deps.exists ?? existsSync
  const resolveSpec = deps.resolveSpec ?? null

  const walked = []
  const broken = []
  const brokenSeen = new Set()
  const seen = new Set()
  if (typeof entry !== 'string' || entry === '') {
    return { ok: false, walked, broken: [{ name: rootName, from: '(入口)', reason: 'entry-missing' }], total: 0, truncated: false }
  }

  /**
   * 记录一个坏包。**同一个包只记一次**（保留第一个发现它的引用方）。
   * 为什么去重：一个"枢纽包"（如 `dsh-tools`）坏了会波及整条下游 —— 真机实测清空 `dsh-tools`
   * 会产出 46 条记录，而它们**全是同一个包**。逐条打印会把"到底哪个包坏了"淹没在噪声里；
   * 修复计划也会对同一个目标重复下单。去重后：一个坏包 = 一条记录 = 一次修复。
   */
  const markBroken = (name, from, reason) => {
    if (brokenSeen.has(name)) return
    brokenSeen.add(name)
    broken.push({ name, from, reason })
  }

  const entryReq = createReq(entry)
  /** 解析一个引用名 → 它的包目录；失败返回 null。注入 `resolveSpec` 时完全走替身（单测）。 */
  const resolveDir = (name, fromDir, fromReq) => {
    if (typeof resolveSpec === 'function') return resolveSpec(name, fromDir)
    try { return dirname(fromReq.resolve(name + '/package.json')) } catch { return null }
  }

  const walk = (name, from, fromReq, fromDir) => {
    if (walked.length >= maxPackages) return
    if (seen.has(name)) return
    seen.add(name)
    walked.push(name)

    const dir = resolveDir(name, fromDir, fromReq)
    if (dir === null) { markBroken(name, from, 'unresolvable'); return }
    let pkg = null
    try { pkg = readJson(join(dir, 'package.json')) } catch (error) { markBroken(name, from, 'unreadable'); return }
    if (pkg === null || typeof pkg !== 'object') { markBroken(name, from, 'malformed'); return }

    const depsOf = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
    const optionalPeers = pkg.peerDependenciesMeta ?? {}
    let subReq = null
    try { subReq = typeof resolveSpec === 'function' ? fromReq : createReq(join(dir, 'noop.js')) } catch { subReq = fromReq }
    for (const spec of Object.keys(depsOf)) {
      if (!isInScope(spec, scopePrefix)) continue
      const child = baseNameOf(spec)
      const optional = optionalPeers[spec]?.optional === true
      const childDir = resolveDir(child, dir, subReq)
      if (childDir === null) {
        // 可选 peer 缺失不算坏（与既有判据一致：不放松成"一律放行"，也不冤枉合法的可选依赖）
        if (!optional) markBroken(child, name, 'unresolvable')
        continue
      }
      // `exists` 仅用于让注入替身也能表达"目录在、内容空"这一形态
      if (typeof deps.exists === 'function' && exists(childDir) === false) continue
      walk(child, name, subReq, dir)
    }
  }

  // 入口包本身也要认：它解析不出来时，后面所有包都会连带失败 —— 先把根报出来，才有可读的原因链
  const rootDir = resolveDir(rootName, dirname(entry), entryReq)
  if (rootDir === null) {
    return { ok: false, walked, broken: [{ name: rootName, from: '(入口)', reason: 'unresolvable' }], total: 0, truncated: false }
  }
  walk(rootName, '(入口)', entryReq, dirname(entry))

  return { ok: broken.length === 0, walked, broken, total: walked.length, truncated: walked.length >= maxPackages }
}

export { FRAMEWORK_SCOPE, baseNameOf, isInScope, probeClosure }
