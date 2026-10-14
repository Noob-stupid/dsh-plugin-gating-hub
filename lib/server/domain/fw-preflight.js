// L1 · domain —— fw-preflight.js（框架闭包**预检与治包**：服务起不来时的自救；0.5.50 加法）
//
// ── 为什么必须有它（**真机停机事故 2026-10-14**）────────────────────────────────
//   四个框架包被掏空（`cordis` 的 junction 还在但 `.pnpm` 实体被清空；`dsh-llm` / `dsh-tools` /
//   `dsh-web` 成了空的真实目录）⇒ dsh 启动即 `54 个插件 failed to import` ⇒ web 服务 exit code=1。
//
//   **这次事故的所有既有防线都失效**，原因是结构性的：
//     · safe-boot 快照存的是 `cordis.patch.yml` 的**文本**（63KB 全是配置）—— 坏的却是包实体，
//       而补丁当时好端端的 ⇒ 恢复动作等于"把一份没坏的配置换成另一份没坏的配置"；
//     · 指纹 `pnpmEntities` 数的是 `.pnpm` 里的**目录个数** —— "目录壳还在、里面被掏空"⇒ 计数不变
//       ⇒ 判定环境未变 ⇒ 不触发任何动作；
//     · 自动禁用针对"插件不适配" —— 这次是框架包没了，不是插件问题。
//   而最根本的一条：**它是跑在 dsh 里的**。dsh 起不来 ⇒ 插件从未加载（事故日志里出现 0 次）
//   ⇒ 一切"面板里有按钮"的方案在这类事故面前等于没有。
//
//   所以本模块的定位是**进程外的预检与治包**，可由 `scripts/fw-preflight.mjs` 在服务之外调用：
//     探测（infra/fw-closure.js）→ 定计划 → 从本地 npm 缓存装回（infra/npm-cache.js）→ 复验。
//   路由侧（若日后接线）同用本模块，两处不会分叉。
//
// ── 四条硬规矩（对齐仓库既有纪律）──────────────────────────────────────────────
//   ① **只补缺的**：能解析的包一个字节都不写（幂等；健康的框架树是 no-op）。
//   ② **绝不 kill / spawn / 抢端口 / 建计划任务** —— 这正是 2026-10-10 `restart.js` 下线的
//      那套动作（会与宿主争端口 ⇒ `listen EADDRINUSE`；kill 宿主 ⇒ 外壳弹「应用无法启动或已意外停止」）。
//      本模块只做**文件级**修复，跑完由调用方决定要不要重启。
//   ③ **修复源必须可解释**：只从 `package-lock.json` 的 `integrity` + 本地 npm 缓存取，
//      **不联网、不猜版本**；取不到就如实报"缺什么"，绝不假装成功。
//   ④ **改前留痕**：有内容的目标目录先改名成 `<name>.preflight-bak-<ts>`（绝不直接删）。
//
// 分层：L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。
// 行数预算：独立模块，留在 600 行架构硬顶内。

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { probeClosure } from '../infra/fw-closure.js'
import { candidateCacheRoots, extractTgz, readTarballFromAny } from '../infra/npm-cache.js'

/** 备份名后缀（与 `.stale-*` 同族但可区分：预检造的备份不该被"框架残留"判据当成残留改名）。 */
const PREFLIGHT_BAK = '.preflight-bak-'

/** 该目录名是不是预检留下的备份。 */
function isPreflightBak(name) {
  return typeof name === 'string' && name.includes(PREFLIGHT_BAK)
}

/** 文件名里安全的时间戳（冒号/点在 Windows 上是非法字符）。 */
function stampOf(ms) {
  return new Date(ms).toISOString().replace(/[:.]/gu, '-')
}

/**
 * 定位 lock 文件：`fwRoot` 是**那层 `node_modules` 本身**，而 lock 住在它的**父目录**
 * （真机实测：`D:\node_cache\_npx\<hash>\node_modules` 是框架树，而
 *   `D:\node_cache\_npx\<hash>\package-lock.json` 才是清单）。
 *
 * 候选顺序（先近后远，两种生态都认）：
 *   ① `<fwRoot>/package-lock.json`（少数形态：树根就带清单）
 *   ② `<dirname(fwRoot)>/package-lock.json` ← **真机主力**
 *   ③ `<dirname(fwRoot)>/pnpm-lock.yaml`（pnpm 形态；本模块目前只解析 npm 的 JSON 清单，
 *      命中 yaml 时返回它并由调用方如实记"该清单格式不支持"，**不静默当成没有**）
 *
 * @returns {{ path: string|null, kind: 'npm'|'pnpm'|null, tried: string[] }}
 */
function locateLockfile(fwRoot, { deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const parent = dirname(fwRoot)
  const tried = []
  const cands = [
    { p: join(fwRoot, 'package-lock.json'), kind: 'npm' },
    { p: join(parent, 'package-lock.json'), kind: 'npm' },
    { p: join(parent, 'pnpm-lock.yaml'), kind: 'pnpm' },
  ]
  for (const c of cands) {
    tried.push(c.p)
    if (exists(c.p)) return { path: c.p, kind: c.kind, tried }
  }
  return { path: null, kind: null, tried }
}

/**
 * 从 `package-lock.json` 建索引：`名@版本` → `{ name, version, integrity }`。
 * 兼容 lockfileVersion 3（`packages` 键形如 `node_modules/@scope/name`）与更老的 `dependencies` 树。
 * 读不出/解析失败一律返回空 Map（调用方据此如实报"没有可用恢复源"）。
 */
function buildLockIndex(lockPath, { deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const read = deps.read ?? ((p) => readFileSync(p, 'utf8'))
  const idx = new Map()
  if (typeof lockPath !== 'string' || !exists(lockPath)) return idx
  let lock = null
  try { lock = JSON.parse(read(lockPath)) } catch { return idx }
  if (lock === null || typeof lock !== 'object') return idx

  const add = (name, entry) => {
    if (typeof name !== 'string' || name === '') return
    if (entry === null || typeof entry !== 'object' || typeof entry.version !== 'string') return
    const key = `${name}@${entry.version}`
    if (!idx.has(key)) idx.set(key, { name, version: entry.version, integrity: entry.integrity ?? null, resolved: entry.resolved ?? null })
  }

  if (lock.packages !== null && typeof lock.packages === 'object') {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/')) continue
      // `node_modules/@scope/name` 与 `node_modules/a/node_modules/b` 都取**最后一段包名**
      const m = /node_modules\/(@[^/]+\/[^/]+|[^/]+)$/u.exec(key)
      if (m !== null) add(m[1], entry)
    }
  }
  if (idx.size === 0 && lock.dependencies !== null && typeof lock.dependencies === 'object') {
    const walkDeps = (tree) => {
      for (const [name, entry] of Object.entries(tree ?? {})) {
        add(name, entry)
        if (entry?.dependencies) walkDeps(entry.dependencies)
      }
    }
    walkDeps(lock.dependencies)
  }
  return idx
}

/** 宽松版本比较（够用于"多版本里挑一个"，不追求完整 semver）。 */
function compareLoose(a, b) {
  const pa = String(a ?? '').split(/[.\-+]/u)
  const pb = String(b ?? '').split(/[.\-+]/u)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb
    } else {
      const sa = String(pa[i] ?? '')
      const sb = String(pb[i] ?? '')
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  return 0
}

/**
 * **纯函数**：给定闭包探测结果与 lock 索引，产出修复计划（不碰 IO，可离线单测）。
 *
 * 目标目录判定（先问"它本该在哪"，再退顶层投影 —— 真机 `dsh-llm` / `dsh-tools` / `dsh-web`
 * 就住在顶层 `node_modules/@deepseek-ai/` 下，而 `cordis` 是顶层 junction 指向 `.pnpm` 实体）：
 *   ① `resolveDir(name)` 给出的位置  ② `nodeModulesDir/<scope>/<name>`  ③ `storeDir/<name>`
 *
 * 同包多版本时取**版本最高**那条（把包装回来时，新版更可能是对的那份）。
 *
 * @returns {{ items: Array, skippable: Array }}
 *          `skippable[].reason`：`no-lock-entry`（lock 里没有 ⇒ **不猜版本**）/`no-integrity`/`no-target`。
 */
function planClosureRepair({ broken = [], lockIndex = new Map(), resolveDir = () => null, nodeModulesDir = null, storeDir = null } = {}) {
  const items = []
  const skippable = []
  for (const bad of Array.isArray(broken) ? broken : []) {
    const name = bad?.name
    if (typeof name !== 'string' || name === '') continue

    const hits = []
    for (const [key, entry] of lockIndex) if (key.startsWith(name + '@')) hits.push(entry)
    if (hits.length === 0) { skippable.push({ name, reason: 'no-lock-entry' }); continue }
    hits.sort((a, b) => compareLoose(a.version, b.version))
    const chosen = hits[hits.length - 1]
    if (chosen.integrity === null || chosen.integrity === undefined) { skippable.push({ name, reason: 'no-integrity' }); continue }

    const segments = name.startsWith('@') ? name.split('/') : [name]
    const resolved = typeof resolveDir === 'function' ? resolveDir(name) : null
    const topLevel = nodeModulesDir === null ? null : join(nodeModulesDir, ...segments)
    const store = storeDir === null ? null : join(storeDir, ...segments)
    let target = null
    let via = null
    for (const [cand, how] of [[resolved, 'resolve'], [topLevel, 'top-level'], [store, 'pnpm-store']]) {
      if (typeof cand === 'string' && cand !== '') { target = cand; via = how; break }
    }
    if (target === null) { skippable.push({ name, reason: 'no-target' }); continue }
    items.push({ name, version: chosen.version, integrity: chosen.integrity, target, via, reason: bad.reason ?? 'unresolvable' })
  }
  return { items, skippable }
}

/**
 * 执行计划里的**一条**恢复：缓存命中 → 解包到目标。
 *
 * ★ **junction 关键判据**（真机 2026-10-14 演练抓到的设计错误）：
 *   `cordis` 的坏法是"顶层 junction 还在、它指向的 `.pnpm` **实体**被掏空"。若把内容写进
 *   **顶层那个 junction 名字**，pnpm 的链接结构就被破坏了 —— 顶层从"链接"退化成"真实目录"，
 *   同一份包在树里于是有了**第二个实体**：
 *     · 模块身份不再共享（Cordis service 类 / LLM error 类靠 `instanceof` 与单例注册表相认 ——
 *       这正是 domain/link-self-sufficiency.js 头注释里"必须链接而不是复制"的那条教训）；
 *     · pnpm 后续重装会认为顶层"不是自己管的"，产生版本漂移与二次损坏。
 *   ⇒ 目标是链接时，**只把内容写进它指向的真实目录**（`realpathSync`），链接原样保留。
 *
 * 其余三种形态照旧：空壳真实目录直接替换；有内容的真实目录先改名成 `.preflight-bak-<ts>`
 * 再装（**绝不直接删**）；目标不存在则新建后装。
 *
 * 返回 `{ ok, action, note }`，失败必须带可读原因（绝不静默吞）。
 */
function applyRepairItem(item, { cacheRoots = [], deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const rename = deps.rename ?? renameSync
  const rm = deps.rm ?? ((p) => rmSync(p, { recursive: true, force: true }))
  const mkdir = deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true }))
  const now = deps.now ?? (() => Date.now())
  const realpath = deps.realpath ?? ((p) => realpathSync(p))
  const lstat = deps.lstat ?? ((p) => lstatSync(p))
  try {
    const hit = readTarballFromAny(cacheRoots, item.integrity, { deps })
    if (hit === null) return { ok: false, action: 'skipped', note: '本地 npm 缓存中找不到该 integrity（未联网，不猜版本）' }

    // 目标是链接 ⇒ 写进它指向的实体，链接本身一个字节都不动
    let target = item.target
    let viaLink = false
    let isLink = false
    try { isLink = lstat(target).isSymbolicLink() } catch { isLink = false }
    if (isLink) {
      viaLink = true
      try { target = realpath(target) } catch {
        return { ok: false, action: 'failed', note: '目标是指向不存在实体的悬空链接，且无法解析真身 —— 不猜目标' }
      }
    }

    let backupPath = null
    if (exists(target)) {
      let empty = false
      try { empty = readdirSync(target).length === 0 } catch { empty = false }
      if (empty) rm(target)
      else {
        backupPath = `${target}${PREFLIGHT_BAK}${stampOf(now())}`
        rename(target, backupPath)
      }
    }
    mkdir(target)
    const stat = extractTgz(hit.buf, target, { deps })
    if (!exists(join(target, 'package.json'))) {
      return { ok: false, action: 'extracted-but-no-manifest', note: `解包完成但无 package.json（${stat.files} 个文件）`, backupPath }
    }
    return {
      ok: true,
      action: 'restored',
      note: `${item.version}（${stat.files} 个文件）${viaLink ? ' → 经链接写入实体，链接保留' : ''}`,
      backupPath,
      cacheRoot: hit.cacheRoot,
      viaLink,
    }
  } catch (error) {
    return { ok: false, action: 'failed', note: String(error?.message ?? error) }
  }
}

/** 定框架树的解析入口：优先顶层 `@deepseek-ai/dsh/lib/bin.js`，退 `.pnpm` 内层实体。 */
function locateFrameworkEntry(fwRoot, { deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const topBin = join(fwRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (exists(topBin)) return { entry: topBin, via: 'top-level' }
  try {
    for (const name of readdirSync(join(fwRoot, '.pnpm'))) {
      if (!name.startsWith('@deepseek-ai+dsh@')) continue
      const cand = join(fwRoot, '.pnpm', name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (exists(cand)) return { entry: cand, via: 'pnpm-store' }
    }
  } catch {}
  return { entry: null, via: null }
}

/**
 * 预检 + 治包的**唯一入口**（探测 → 计划 → 执行 → 复验）。
 *
 * @param {object} p
 * @param {string} p.fwRoot       框架树根（含 `@deepseek-ai/` 与 `.pnpm/`）。
 * @param {boolean} [p.repair]    true = 真装回；false（默认）= **只诊断，一个字节都不写**。
 * @param {string} [p.lockPath]   默认 `<fwRoot>/package-lock.json`。
 * @param {number} [p.maxRepair]  单次最多修几个（防御上限；默认 200）。
 * @param {object} [p.deps]       IO 注入（单测用）。
 * @returns 结构化报告；`ok` = **修复前**闭包是否完整，`okAfter` = 修复后复验结果。
 */
function runFwPreflight({ fwRoot, repair = false, lockPath = null, maxRepair = 200, deps = {}, cacheRoots = null } = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, 'utf8'))
  const makeReq = deps.createRequire ?? createRequire
  const probe = deps.probeClosure ?? probeClosure
  const roots = Array.isArray(cacheRoots) && cacheRoots.length > 0
    ? cacheRoots
    : (typeof deps.cacheRoots === 'function' ? deps.cacheRoots() : candidateCacheRoots({ env: deps.env ?? process.env }))

  const report = { fwRoot: fwRoot ?? null, entry: null, entryVia: null, before: null, after: null, plan: [], repaired: [], failed: [], skipped: [], cacheRoots: roots, repair, lockPath: null, lockKind: null }

  if (typeof fwRoot !== 'string' || fwRoot === '') { report.error = 'fwRoot 未提供'; return report }

  const located = locateFrameworkEntry(fwRoot, { deps })
  report.entry = located.entry
  report.entryVia = located.via
  if (located.entry === null) { report.error = '找不到 dsh 的 lib/bin.js（顶层与 .pnpm 都没有）——框架树本身不完整'; report.ok = false; return report }

  const before = probe({ entry: located.entry, deps })
  report.before = before
  report.ok = before.ok

  let req = null
  try { req = makeReq(located.entry) } catch { req = null }
  const resolveDir = (name) => {
    if (req === null) return null
    try { return dirname(req.resolve(name + '/package.json')) } catch { return null }
  }

  const lockLocated = typeof lockPath === 'string' && lockPath !== ''
    ? { path: lockPath, kind: 'npm', tried: [lockPath] }
    : locateLockfile(fwRoot, { deps })
  report.lockPath = lockLocated.path
  report.lockKind = lockLocated.kind
  const lock = lockLocated.kind === 'npm' ? buildLockIndex(lockLocated.path, { deps }) : new Map()
  // ★ 基准收口：`fwRoot` 就是**那层 node_modules 本身**（真机实测：`…\_npx\<hash>\node_modules`、
  //   `…\profiles\node_modules`、桌面端 `…\dsh\node_modules` 都是这个形态）。
  //   于是顶层投影就是 `fwRoot/@deepseek-ai/<name>` —— **不再拼一层 `node_modules`**。
  //   （2026-10-14 踩到：拼成 `fwRoot/node_modules/@deepseek-ai/…` ⇒ 目标路径不存在 ⇒
  //    修复计划指向错误的树，真正坏掉的那棵树纹丝不动。）
  const plan = planClosureRepair({
    broken: before.broken,
    lockIndex: lock,
    resolveDir,
    nodeModulesDir: fwRoot,
    storeDir: join(fwRoot, '.pnpm', 'node_modules'),
  })
  report.plan = plan.items.map((i) => ({ name: i.name, version: i.version, target: i.target, via: i.via, reason: i.reason }))
  report.skipped = plan.skippable

  if (repair !== true) return report

  for (const item of plan.items.slice(0, maxRepair)) {
    const r = applyRepairItem(item, { cacheRoots: roots, deps })
    if (r.ok) report.repaired.push({ name: item.name, version: item.version, target: item.target, via: item.via, note: r.note })
    else report.failed.push({ name: item.name, target: item.target, action: r.action, note: r.note })
  }

  // 复验：修完必须**重新走一遍闭包** —— 不靠"我装完了"自证
  const after = probe({ entry: located.entry, deps })
  report.after = after
  report.okAfter = after.ok
  report.changed = report.repaired.length > 0
  return report
}

export {
  PREFLIGHT_BAK,
  applyRepairItem,
  buildLockIndex,
  compareLoose,
  isPreflightBak,
  locateFrameworkEntry,
  locateLockfile,
  planClosureRepair,
  runFwPreflight,
  stampOf,
}
