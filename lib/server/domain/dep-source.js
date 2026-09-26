// L1 · domain —— dep-source.js（依赖**来源**判定与写回：registry 探测 / plugin-src 物化 / link: 规格）
//
// 为什么单开一个模块：install.js 有 600 行棘轮（test-architecture-guard.mjs），而这块逻辑既被
// install.js 家族用，也被 selfupdate.js 的 lock 对账用——放在自己这里两边都能引，且互不牵连。
//
// 缺陷②修复（0.3.63 / 0.4.0-beta.16）背景（用户 issue 草案「缺陷②」，2026-09-22 实测）：
//   release 通道装的包只存在于 GitHub release，npm registry 里查无此包；而 0.3.57 起的 lock 对账
//   一律 `pnpm add <name>@<installed>` —— pnpm 看到「已装版本满足新 spec」就**静默**把 profile
//   package.json 的 dependencies 改写为裸版本号（输出 `Already up to date`、EXIT=0，面板显示成功），
//   同时把 lock 的 specifier 也改成版本号、却保留旧的 tarball 解析。装完一切正常，直到有人重建
//   lock（删 lock / 清 node_modules / 换机 / CI）→ `ERR_PNPM_FETCH_404`，而报错指向 npm registry，
//   用户根本联想不到是几周前面板安装改写造成的。
//
// 两条硬约束（本机真 pnpm 10.34.5 实测矩阵见 D:\dsh\dsh-plugin-hub-plan\refactor-bugs.zh.md 第 23 节）：
//   ① 写回前必须确认「这个包的**这个版本**」在 registry 可解析，否则**绝不**写裸版本号；
//   ② 不可解析时**也不能**写 tarball URL：pnpm 10 对 direct-URL 依赖只在冷缓存真下载时记 integrity，
//      命中缓存重写 lock 时 resolution 里没有 integrity → `ERR_PNPM_MISSING_TARBALL_INTEGRITY`，
//      而且 pnpm 会把 lock 文件直接删掉，形成「删 lock 修不好、不删 lock 装不动」的死循环。
//      改用 `link:<DSH_HOME>/plugin-src/<包名>`：pnpm 的 link 协议只建符号链接，不经 registry 解析、
//      不经 tarball 完整性校验，lock 删掉重建、node_modules 清空重装都稳定通过。

import { existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { copyTree } from '../infra/fsx.js'
import { fetchJsonUrl } from '../infra/http.js'
import { dshHome } from '../infra/paths.js'

/** 物化目录的根（与用户 issue 里手工规避用的 `/root/.dsh/plugin-src/...` 同一位置）。 */
const PLUGIN_SRC_DIR = 'plugin-src'

/**
 * registry 能否解析该包的指定版本（按顺序多源尝试，任一源可解析即通过）。
 * 404 / 网络失败都归为「不可解析」——调用方据此决定**绝不写裸版本号**。
 * `version` 为 null 时只判包是否存在；`hasVersion` 表示指定版本是否在 versions 里
 * （release 通道装的版本可能比 registry 上的 latest 还新，只判包名存在是不够的）。
 * 2026-09-27 加法：`includeMeta: true` 时把 registry 原始元数据一起返回（`meta`），
 * 供「依赖锁体检」读发布时间（供应链间隔判定）用；默认不返回，既有调用方形状不变。
 */
async function probeRegistryPackage(packageName, registries = [], options = {}) {
  const fetchJson = typeof options.fetchJson === 'function' ? options.fetchJson : fetchJsonUrl
  const version = typeof options.version === 'string' && options.version !== '' ? options.version : null
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000
  const withMeta = options.includeMeta === true
  const list = (Array.isArray(registries) ? registries : []).filter((r) => typeof r === 'string' && r.trim() !== '')
  const tries = list.length > 0 ? list : ['https://registry.npmmirror.com']
  const encoded = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1).split('/')[0])}%2f${encodeURIComponent(packageName.split('/').slice(1).join('/'))}`
    : encodeURIComponent(packageName)
  const tried = []
  for (const reg of tries) {
    const base = String(reg).replace(/\/+$/u, '')
    try {
      const meta = await fetchJson(`${base}/${encoded}`, timeoutMs)
      const versions = meta && typeof meta === 'object' && meta.versions && typeof meta.versions === 'object' ? meta.versions : null
      if (versions === null) {
        tried.push(`${base}：返回体没有 versions 字段`)
        continue
      }
      const latest = typeof meta['dist-tags']?.latest === 'string' ? meta['dist-tags'].latest : null
      return {
        resolvable: true,
        hasVersion: version === null || Object.prototype.hasOwnProperty.call(versions, version),
        latest,
        registry: base,
        tried,
        ...(withMeta ? { meta } : {}),
      }
    } catch (error) {
      tried.push(`${base}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { resolvable: false, hasVersion: false, latest: null, registry: null, tried }
}

/**
 * 把 profile 里**已装好的**包物化一份到 `<DSH_HOME>/plugin-src/<包名>`，返回该绝对路径。
 * 为什么必须另存一份而不是直接 link node_modules 里的目录：pnpm 重建 node_modules 时会先删掉
 * 整个目录，link 目标随即消失；plugin-src 是 pnpm 不管理的独立目录，跨 lock 重建、
 * 跨 node_modules 清空都稳定存在（这也是用户手工规避时选的位置）。
 * 返回 null 表示源目录不存在或复制失败 —— 调用方必须**跳过对齐**并如实记 note，绝不改 package.json。
 */
function materializePackageForLink(profileDir, packageName, options = {}) {
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : dshHome()
  const src = join(profileDir, 'node_modules', ...packageName.split('/'))
  if (!existsSync(join(src, 'package.json'))) return null
  const dest = join(home, PLUGIN_SRC_DIR, ...packageName.split('/'))
  // 已经是指向 plugin-src 的链接（重复对账）→ 不能先删再复制：那样源就成了悬空链接
  try {
    if (existsSync(dest) && realpathSync(src) === realpathSync(dest)) return dest
  } catch {}
  try {
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    copyTree(src, dest)
  } catch {
    return null
  }
  return existsSync(join(dest, 'package.json')) ? dest : null
}

/** pnpm 的 `link:` 规格：写绝对路径（反斜杠转正斜杠，跨平台且 lock 可读）。 */
function linkSpecFor(dir) {
  return `link:${String(dir).replace(/\\/gu, '/')}`
}

/**
 * manifest 里的 `link:` 规格当前是否**真的**还生效（`node_modules/<包名>` 就是指向它的那个链接）。
 * 为什么必须查：release / curl 通道更新包时是「先 rmSync 再 copyTree」，会把 `node_modules/<包名>`
 * 从"链接"换成"真实目录"，而 manifest 与 lock 里仍写着 `link:<plugin-src/…>` —— 光看版本号看不出来
 * （lock 里本来就是 `link:`），但**之后任何一次 pnpm 操作都会按 lock 重建链接**，把刚更新上去的版本
 * 还原成 `plugin-src` 里的旧副本（与 0.3.56 修过的「自更新被 lock 还原」同族）。
 * 返回 false 时调用方会重新物化（把新副本刷进 plugin-src）并重放 `link:`，实测能把链接与版本一起恢复。
 */
function linkSpecIsIntact(profileDir, packageName, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('link:')) return false
  const target = spec.slice('link:'.length)
  const src = join(profileDir, 'node_modules', ...packageName.split('/'))
  try {
    if (!existsSync(src) || !existsSync(target)) return false
    return realpathSync(src) === realpathSync(target)
  } catch {
    return false
  }
}

export { PLUGIN_SRC_DIR, probeRegistryPackage, materializePackageForLink, linkSpecFor, linkSpecIsIntact }
