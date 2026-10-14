// L0 · infra —— fw-root-detect.js（框架树根的**多基准探测**；0.5.50 加法）
//
// 为什么要多基准（真机实证，2026-10-14）：
//   这套代码会在**两种完全不同的位置**被运行，解析语义天然不同：
//     ① 插件装在 profile 里（正常形态）—— 从插件自己的 `lib/index.js` 能解析到
//        `@deepseek-ai/dsh`（本机实测：profile 的 node_modules 把它指向 npx 缓存的
//        `D:\node_cache\_npx\<hash>\node_modules\@deepseek-ai\dsh`）；
//     ② 在**开发仓库**里直接跑（`node scripts/fw-preflight.mjs`）—— 仓库根没有 node_modules，
//        `require.resolve('@deepseek-ai/dsh/package.json')` 直接 `MODULE_NOT_FOUND`。
//        **而"服务起不来"时最可能的调用方式恰恰是这一种**（用户手里只有一条命令）。
//   ⇒ 只写一种基准等于在最需要它的场景里失效。本模块把候选收在一处，按"最准 → 最宽"排序。
//
// 与 domain/framework-root.js 的分工（**不是同一件事，别合并**）：
//   · 那边：给**补丁自愈/只读体检**判断"某个 `@deepseek-ai/*` 包在不在"，产出**多个**解析基准；
//   · 这边：给**预检治包**判断"框架树根本身在哪"，产出**一个**根目录（供走闭包与定 .pnpm 位置）。
//
// 分层：L0 · infra（不得 import domain/routes/index —— tests/test-architecture-guard.mjs 断言②）。

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { candidateCacheRoots } from './npm-cache.js'

/** 该目录像不像一棵框架树：有 `@deepseek-ai/dsh/lib/bin.js`，或有 `.pnpm` 且其中有 dsh 实体。 */
function looksLikeFwRoot(dir, { deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  if (typeof dir !== 'string' || dir === '') return false
  if (exists(join(dir, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return true
  try {
    for (const name of readdirSync(join(dir, '.pnpm'))) {
      if (!name.startsWith('@deepseek-ai+dsh@')) continue
      if (exists(join(dir, '.pnpm', name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return true
    }
  } catch {}
  return false
}

/** 从某个基准文件/目录解析 `@deepseek-ai/dsh`，成功则反推承载它的那层 `node_modules`。 */
function fwRootFromBase(base, { deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const realpath = deps.realpath ?? ((p) => realpathSync(p))
  const makeReq = deps.createRequire ?? createRequire
  let pkgPath = null
  try { pkgPath = makeReq(base).resolve('@deepseek-ai/dsh/package.json') } catch { return null }
  if (typeof pkgPath !== 'string') return null
  // `<…>/node_modules/@deepseek-ai/dsh/package.json` → 退三层 = 那层 node_modules
  let nm = dirname(dirname(dirname(pkgPath)))
  // ★ 必须 resolve 成**真身**：profile 侧的 `node_modules/@deepseek-ai/dsh` 常是 junction 投影
  //   （真机实测：`C:\Users\<u>\.dsh\profiles\node_modules\@deepseek-ai\dsh` → `D:\node_cache\_npx\<hash>\…`）。
  //   拿投影当框架树根 ⇒ `--repair` 会按"投影的 node_modules / .pnpm"去算目标路径 ⇒ 写到不存在的
  //   结构里，或者把包装进投影层而不是真身所在的那棵树。解析到真身才能与"服务实际加载的那棵树"对齐。
  try { nm = dirname(dirname(dirname(realpath(pkgPath)))) } catch {}
  if (looksLikeFwRoot(nm, { deps })) return nm
  // rc.1 之后实体在 .pnpm 内层：再向上找最近的含 .pnpm 的 node_modules
  let dir = nm
  for (let i = 0; i < 8; i += 1) {
    if (exists(join(dir, '.pnpm'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return exists(nm) ? nm : null
}

/** 扫 npx 缓存（`<cacheBase>/_npx/<hash>/node_modules`），按 dsh 的 bin.js 修改时间取最新那个。 */
function fwRootFromNpxCache({ env = process.env, home = homedir(), deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const stat = deps.stat ?? ((p) => statSync(p))
  const readdir = deps.readdir ?? ((p) => readdirSync(p))

  const bases = []
  const pushBase = (dir) => {
    if (typeof dir !== 'string' || dir === '') return
    if (!bases.includes(dir)) bases.push(dir)
  }
  pushBase(env.npm_config_cache)
  pushBase(env.NPM_CONFIG_CACHE)
  pushBase('D:\\node_cache')
  pushBase(join(env.LOCALAPPDATA ?? '', 'npm-cache'))
  pushBase(join(home, 'AppData', 'Local', 'npm-cache'))
  // npm cacache 的根通常就是 `<cacheBase>/_cacache`，故从它的父目录取 `_npx`
  for (const cacache of candidateCacheRoots({ env, home })) pushBase(dirname(cacache))

  const hits = []
  for (const base of bases) {
    const npxRoot = join(base, '_npx')
    if (!exists(npxRoot)) continue
    let dirs = []
    try { dirs = readdir(npxRoot) } catch { continue }
    for (const d of dirs) {
      const nm = join(npxRoot, d, 'node_modules')
      const bin = join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (!exists(bin)) continue
      let mtime = 0
      try { mtime = stat(bin).mtimeMs ?? 0 } catch { mtime = 0 }
      hits.push({ fwRoot: nm, via: 'npx-cache', mtime })
    }
  }
  if (hits.length === 0) return null
  // 桌面端启动器就是按 mtime 取最新的那个 —— 这里沿用同一取舍，保证"预检的树"与"会被启动的树"一致
  hits.sort((a, b) => b.mtime - a.mtime)
  return hits[0]
}

/** 扫 `<dshHome>/profiles/**` 与各类 node_modules，找一棵像框架树的。 */
function fwRootFromDshHome({ env = process.env, home = homedir(), deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const readdir = deps.readdir ?? ((p) => readdirSync(p))
  const dshHome = (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') ? env.DSH_HOME.trim() : join(home, '.dsh')

  const cands = []
  // ① 显式 profile 目录（桌面端/CLI 都会设 DSH_PROFILE_DIR）
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.trim() !== '') cands.push(env.DSH_PROFILE_DIR.trim())
  // ② 按 profile 名
  if (typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '') cands.push(join(dshHome, 'profiles', env.DSH_PROFILE.trim()))
  // ③ 共享投影层与各 profile
  cands.push(join(dshHome, 'profiles', 'node_modules'))
  try {
    for (const d of readdir(join(dshHome, 'profiles'))) {
      if (d === 'node_modules') continue
      cands.push(join(dshHome, 'profiles', d, 'node_modules'))
    }
  } catch {}

  for (const dir of cands) {
    if (!looksLikeFwRoot(dir, { deps })) continue
    return { fwRoot: dir, via: 'dsh-home' }
  }
  return null
}

/**
 * 把"看起来像框架树根"的目录**归一到真身**。
 *
 * 为什么必须单独做这一步（真机实测 2026-10-14）：
 *   `C:\Users\<u>\.dsh\profiles\node_modules` **本身是真实目录**（不是链接），但它下面的
 *   `@deepseek-ai\dsh` 是 **junction** → `D:\node_cache\_npx\<hash>\node_modules\@deepseek-ai\dsh`。
 *   于是"这个目录像框架树"与"框架包的真身在哪"是两件事：只对根目录做 realpath 什么也变不了。
 *   ⇒ 拿投影当根，`--repair` 会按"投影的 node_modules / .pnpm"去算目标路径，写到不存在的结构里；
 *     而服务实际加载的是**真身那棵树**（启动器命令行 = `…\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js`）。
 *   ⇒ 归一到真身，预检的那棵树才与"会被启动的那棵树"一致。
 */
function realRootOf(dir, { deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const realpath = deps.realpath ?? ((p) => realpathSync(p))
  if (typeof dir !== 'string' || dir === '') return dir
  const pkg = join(dir, '@deepseek-ai', 'dsh', 'package.json')
  if (exists(pkg)) {
    try { return dirname(dirname(dirname(realpath(pkg)))) } catch { return dir }
  }
  // `.pnpm` 内层形态：解析 store 里那份 dsh 的清单，同样退三层
  try {
    for (const name of readdirSync(join(dir, '.pnpm'))) {
      if (!name.startsWith('@deepseek-ai+dsh@')) continue
      const inner = join(dir, '.pnpm', name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      if (!exists(inner)) continue
      return dirname(dirname(dirname(realpath(inner))))
    }
  } catch {}
  return dir
}

/**
 * 探测框架树根（**有序**，先准后宽）。返回 `{ fwRoot, via, tried }`；一个都拿不到时
 * `fwRoot: null` 且 `tried` 列出试过的基准 —— 调用方据此如实报"探测不到"，而不是猜一个。
 *
 * 所有分支的返回值都过一道 `realRootOf` —— 保证调用方拿到的永远是**真身所在的那棵树**。
 *
 * @param {object} p
 * @param {string} [p.pluginDir]   插件包根（调用方传 `<repo>/`，用于第 ① 基准）。
 *                                 ★ 名字不叫 `pluginRoot`：那是 infra/paths.js 的导出名，
 *                                   同名参数会被架构守卫断言⑧（导入绑定只读）判成"给导出绑定赋值"。
 * @param {string} [p.entryHint]   已知的入口文件（如 `dsh/lib/bin.js`）—— 给了就优先用它反推。
 */
function detectFrameworkRoot({ pluginDir = null, entryHint = null, env = process.env, home = homedir(), deps = {} } = {}) {
  const realpath = deps.realpath ?? ((p) => realpathSync(p))
  const tried = []
  const real = (p) => { try { return realpath(p) } catch { return p } }

  // ⓪ 调用方直接给了入口文件：它所在的那层 node_modules 最准（同样要落到真身）
  if (typeof entryHint === 'string' && entryHint !== '') {
    const nm = real(dirname(dirname(dirname(resolve(entryHint)))))
    tried.push({ via: 'entry-hint', base: nm })
    if (looksLikeFwRoot(nm, { deps })) return { fwRoot: nm, via: 'entry-hint', tried }
  }

  // ① 从插件自己解析（插件装在 profile 里时最准）
  if (typeof pluginDir === 'string' && pluginDir !== '') {
    const base = join(pluginDir, 'lib', 'index.js')
    tried.push({ via: 'plugin-root', base })
    const hit = fwRootFromBase(base, { deps })
    if (hit !== null) return { fwRoot: realRootOf(hit, { deps }), via: 'plugin-root', tried }
  }

  // ② DSH_HOME / profile 环境变量
  tried.push({ via: 'dsh-home', base: '(DSH_HOME/profiles)' })
  const fromHome = fwRootFromDshHome({ env, home, deps })
  if (fromHome !== null) return { fwRoot: realRootOf(fromHome.fwRoot, { deps }), via: fromHome.via, tried }

  // ③ npx 缓存（开发仓库里直接跑时的主要出路；与桌面端启动器同一取舍）
  tried.push({ via: 'npx-cache', base: '(cacheBase/_npx/*)' })
  const fromNpx = fwRootFromNpxCache({ env, home, deps })
  if (fromNpx !== null) return { fwRoot: realRootOf(fromNpx.fwRoot, { deps }), via: fromNpx.via, tried }

  return { fwRoot: null, via: null, tried }
}

export { detectFrameworkRoot, fwRootFromBase, fwRootFromDshHome, fwRootFromNpxCache, looksLikeFwRoot, realRootOf }
