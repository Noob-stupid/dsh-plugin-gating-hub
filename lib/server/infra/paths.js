// L0 · infra（paths.js）—— 分层 Step 从 lib/index.js 搬出，只搬移未改逻辑
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/** DSH 数据根目录（与 dsh-github-login 工具共享令牌文件位置）。 */
function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** 默认 profile 用户补丁层路径（无 include 条目可推导时的兜底）。 */
function defaultPatchPath() {
  const home = dshHome()
  return join(home, 'profiles', 'web', 'cordis.patch.yml')
}

/** 从 loader 树推导 profile 的 cordis.patch.yml 绝对路径。 */
function findPatchPath(ctx) {
  for (const entry of ctx.loader.entries()) {
    const cfg = entry.options?.config
    if (entry.options?.name !== 'cordis:include' || cfg == null || typeof cfg.path !== 'string') continue
    if (!cfg.path.includes('cordis.yml')) continue
    const configPath = fileURLToPath(new URL(cfg.path))
    return configPath.replace(/cordis\.yml$/u, 'cordis.patch.yml')
  }
  return defaultPatchPath()
}

/** profile 根目录（resolvePackageJson 的 fallbackBase 用；失败返回 null）。 */
function profileDirOf(ctx) {
  try {
    return dirname(findPatchPath(ctx))
  } catch {
    return null
  }
}

/** 把 file:// URL（如 ctx.baseUrl）转成目录路径（resolve 用）。 */
function baseDirOf(baseUrl) {
  try {
    if (typeof baseUrl === 'string' && baseUrl.startsWith('file:')) return dirname(fileURLToPath(baseUrl))
  } catch {}
  return typeof baseUrl === 'string' && baseUrl !== '' ? baseUrl : '.'
}

/**
 * 解析包 package.json 的绝对路径（exports 限制包 fallback）：
 * require.resolve('pkg/package.json') 对声明了 exports 且不含 './package.json' 的包会抛错
 * （2026-09-04 教训：@openviking/dsh-memory-plugin 因此被 heal 误判模块缺失并自动禁用）——
 * fallback 直接查 node_modules 物理路径。
 */
function resolvePackageJson(pkgName, baseDir, fallbackBase) {
  const name = packageNameOf(pkgName)
  try {
    return createRequire(join(baseDir, 'package.json')).resolve(`${name}/package.json`)
  } catch {}
  const parts = String(name).split('/')
  const candidate = join(baseDir, 'node_modules', ...parts, 'package.json')
  if (existsSync(candidate)) return candidate
  // issue #15：npm 全局安装 dsh 时 ctx.baseUrl 落在框架安装树（而非 profile node_modules），
  // 官方 @deepseek-ai/* 恰好可见、第三方插件全部解析失败 → 详情/版本/仓库全空。
  // 回退到 profile 目录（fallbackBase）再试一次。
  if (typeof fallbackBase === 'string' && fallbackBase !== '' && fallbackBase !== baseDir) {
    try {
      return createRequire(join(fallbackBase, 'package.json')).resolve(`${name}/package.json`)
    } catch {}
    const candidate2 = join(fallbackBase, 'node_modules', ...parts, 'package.json')
    if (existsSync(candidate2)) return candidate2
  }
  return null
}

function entryPkgMeta(moduleName, baseUrl, profileDir) {
  if (typeof moduleName !== 'string' || moduleName.startsWith('cordis:')) return null
  const hit = pkgMetaCache.get(moduleName)
  if (hit !== undefined && Date.now() - hit.at < PKG_META_TTL) return hit
  const meta = { at: Date.now(), installDate: null, version: null, repository: null }
  try {
    const pkgPath = resolvePackageJson(moduleName, baseDirOf(baseUrl), profileDir ?? null)
    if (pkgPath === null) throw new Error('not found')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    // 安装日期：优先 curl 通道写入的 .dsh-installed-at 标记（真实安装时刻）；
    // 否则用 package.json 的 mtime，但 npm tarball 会把文件时间固定为 1985-10-26
    // （可复现构建），此时回退到目录创建时间（birthtime，解压时刻，Windows 上可靠）。
    try {
      const marker = join(dirname(pkgPath), '.dsh-installed-at')
      if (existsSync(marker)) {
        const ts = Number(readFileSync(marker, 'utf8').trim())
        if (Number.isFinite(ts) && ts > 0) {
          const d = new Date(ts)
          meta.installDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
      }
      if (meta.installDate === null) {
        const st = statSync(pkgPath)
        const yearOk = (t) => t >= 946684800000 // 2000-01-01：早于它都是打包器固定时间戳等伪日期
        const candidates = [st.mtimeMs, st.birthtimeMs ?? NaN].filter((t) => Number.isFinite(t) && yearOk(t))
        if (candidates.length > 0) {
          const d = new Date(Math.min(...candidates))
          meta.installDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
      }
    } catch {}
    meta.version = typeof pkg.version === 'string' ? pkg.version : null
    const rawRepo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? null)
    if (typeof rawRepo === 'string') meta.repository = rawRepo.replace(/^git\+/u, '').replace(/\.git$/u, '').toLowerCase()
  } catch {}
  pkgMetaCache.set(moduleName, meta)
  return meta
}

/** 包名归一：支持子路径导出形式（@linxin666/dsh-web-all/settings → @linxin666/dsh-web-all）。 */
function packageNameOf(moduleName) {
  if (typeof moduleName !== 'string') return moduleName
  const m = moduleName.match(/^(@[^/]+\/[^/]+)(?:\/.*)?$/u)
  return m ? m[1] : moduleName
}

/** include 前缀（加载器条目 id 形如 include:schedule，补丁行 id 为 schedule）。 */
function includePrefix(ctx) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.name === 'cordis:include') return `${entry.id}:`
  }
  return ''
}

/** 接受加载器条目 id 或行 id，返回补丁行 id。 */
function rowIdOf(ctx, entryId) {
  const prefix = includePrefix(ctx)
  if (prefix.length > 0 && entryId.startsWith(prefix)) return entryId.slice(prefix.length)
  return entryId
}

/** 已加载插件的包元信息缓存（安装日期/版本/仓库），60 秒 TTL。 */
const pkgMetaCache = new Map()

const PKG_META_TTL = 60000

/**
 * 本插件包根目录（含 package.json 与 lib/）。
 * ★ 为什么必须有它：函数搬进 lib/server/** 之后，`dirname(import.meta.url)` 指的是
 * `lib/server/infra` 而不是包根 —— 直接拿它拼 '..' 会得到错误路径。
 * 升级/回滚/重启脚本生成器里的 pluginDir 也走这里，错了会让生成的脚本找不到插件目录。
 * **全仓库只有这一处允许用 import.meta.url 计算包根。**
 */
export function pluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/** 软件源配置文件（registry 列表，安装链按主→备依次尝试）。 */
const sourcesFile = () => join(dshHome(), 'plugin-console-sources.json')

/** 敏感凭据单独落盘（避免与可分享配置混存）：自定义搜索源 headers + Gitee secret/token。 */
const sourcesSecretsFile = () => join(dshHome(), 'plugin-console-sources.secrets.json')

/** 市场索引落盘缓存（网络不可达时降级展示上次成功结果，避免内网/断网下市场空白）。 */
const marketIndexCacheFile = () => join(dshHome(), 'plugin-console-market-index-cache.json')

/** 组件注册表（服务型组件：启动/停止/状态控制按钮的数据源）。 */
const componentsFile = () => join(dshHome(), 'plugin-console', 'components.json')

/** AI 赋能任务持久化文件（DSH 重启不丢计划/结果；running 任务重启后标记中断）。 */
const aiJobsFile = () => join(dshHome(), 'plugin-console', 'ai-jobs.json')

const repoLandConfFile = () => join(dshHome(), 'plugin-console', 'repo-land.json')

/** 批量识别搜索结果类型（官方 bundle / 聚合仓库 / 普通项目 / 技能仓库）。
 * 全部条目并发 + raw 主站与镜像双通道竞速，单条 4 秒封顶。
 * 聚合仓库（根包 private+workspaces）额外检查子包是否有 dsh.bundle 清单：
 * 任一子包可 `dsh plugin add` 直装 → aggregateInstallable = true（★ 筛选会包含它）。 */
const ENRICH_CACHE_FILE = () => join(dshHome(), 'plugin-console', 'enrich-cache.json')

export { dshHome, defaultPatchPath, findPatchPath, profileDirOf, baseDirOf, resolvePackageJson, entryPkgMeta, packageNameOf, includePrefix, rowIdOf, pkgMetaCache, PKG_META_TTL, sourcesFile, sourcesSecretsFile, marketIndexCacheFile, componentsFile, aiJobsFile, repoLandConfFile, ENRICH_CACHE_FILE }
