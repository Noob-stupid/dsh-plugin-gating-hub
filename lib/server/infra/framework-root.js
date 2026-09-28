// L0 · infra —— framework-root.js（框架运行时解析基准；0.5.30 加法）
//
// 为什么必须有它（**真机事故 2026-09-28 / 2026-09-29**）：
//   框架 0.2.0-rc.1 把 `@deepseek-ai/*` 的实体全部搬进 `.pnpm` **内部**那层，profile 顶层
//   projection 还停在旧版（本机实测：顶层 239 个 `@deepseek-ai` 目录仍是 0.1.5-rc.2 的残影）。
//   任何"只拿 profileDir 当解析基准"的判断都会把**真存在的框架内置包**（`dsh-agent-preset`、
//   `dsh-workflow-ptc`）判成"缺失" —— 实测后果：`healPatchSafety()` 给它们自动写了 4 个
//   `disabled: true` 块（2026-09-29 01:05:44），把用户的 preset-router-* 三条全停掉。
//
// 所以「框架内置包在不在」必须走**多基准并集**：任一基准能解析即算命中。
// 本模块把该判据集中一处，供只读体检（routes/patch-audit.js）与补丁自愈（domain/patch.js）共用 ——
// 两处若各写一份，下次框架再挪目录就会只有一处被修好。
//
// 行数预算：独立小模块，留在 600 行架构硬顶内。

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolvePackageJson } from './paths.js'

/** 框架命名空间：`@deepseek-ai/*` 随框架版本走，承载者永远是框架安装树。 */
const FRAMEWORK_SCOPE = '@deepseek-ai/'

/** 包名归一：`@scope/name/sub` → `@scope/name`；裸名原样。 */
function basePackageName(moduleName) {
  const text = String(moduleName ?? '')
  if (text.startsWith('@')) {
    const parts = text.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : text
  }
  return text.split('/')[0]
}

/** 归一后的包名是否属于框架命名空间（`@deepseek-ai/dsh-*`）。 */
function isFrameworkModuleName(moduleName) {
  const name = basePackageName(moduleName)
  return name === FRAMEWORK_SCOPE.slice(0, -1) || name.startsWith(FRAMEWORK_SCOPE)
}

/** 路径是否落在给定根目录内（大小写不敏感，Windows 与 POSIX 都成立）。 */
function isUnder(childPath, rootDir) {
  if (typeof childPath !== 'string' || childPath === '' || typeof rootDir !== 'string' || rootDir === '') return false
  let child = resolve(childPath).toLowerCase()
  let root = resolve(rootDir).toLowerCase()
  if (!root.endsWith(sep)) root += sep
  if (!child.endsWith(sep)) child += sep
  return child.startsWith(root)
}

/**
 * 框架运行时解析基准（**有序**，先准后宽）：
 *   ① `@deepseek-ai/dsh` 所在的那层 `node_modules`（= `.pnpm` 实体内部，框架内置包的真正家）
 *   ② 从 ① 向上逐级找到的第一个含 `.pnpm` 的目录（与 ① 同层时去重）
 *   ③ `@deepseek-ai/dsh` 解析不出来时的兜底：`baseDir` / `profileDir` 自身（供离线测试桩使用）
 * 返回去重后的绝对路径数组；一个都拿不到时返回 `[]`（调用方必须把空数组当"无法判定"而非"缺失"）。
 */
function frameworkBases(baseDir, profileDir) {
  const out = []
  const push = (dir) => {
    if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return
    const norm = resolve(dir)
    if (!out.includes(norm)) out.push(norm)
  }
  let found = null
  // base 有两种合法写法（`…/profiles/web` 这种**含 node_modules 的目录**，或 `…/.pnpm/<pkg>/node_modules`
  // 这种 **node_modules 本身**）；resolvePackageJson 只认前者，所以后者要退一级再试 ——
  // 否则框架基准这一路永远解析不到 `@deepseek-ai/dsh`，整个框架基准列表会退化成兜底值。
  for (const base of [baseDir, profileDir]) {
    if (typeof base !== 'string' || base === '') continue
    for (const cand of [base, dirname(base)]) {
      if (typeof cand !== 'string' || cand === '') continue
      try {
        found = resolvePackageJson('@deepseek-ai/dsh', cand, profileDir)
      } catch { found = null }
      if (found !== null) break
    }
    if (found !== null) break
  }
  if (found !== null) {
    // ★ 2026-09-30 改错（本批修 A 事故时抓到）：这里过去是 `dirname(dirname(pkgPath))` ——
    //   pkgPath 形如 `<…>/node_modules/@deepseek-ai/dsh/package.json`，两层 dirname 只退到
    //   **scope 目录** `<…>/node_modules/@deepseek-ai`（实测 `existsSync(inner@deepseek-ai)` = false），
    //   拿它当解析基准必然解析不到任何包。正确是**三层**：package.json → dsh → @deepseek-ai → node_modules。
    const inner = dirname(dirname(dirname(found)))
    push(inner)
    let dir = inner
    for (let i = 0; i < 6; i += 1) {
      if (existsSync(join(dir, '.pnpm'))) { push(dir); break }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // 兜底：框架树找不到时，至少把 profile 目录本身当基准 —— 否则 `bases` 为空会让
  // 自愈把所有 insert 行都判成"无法确认"（宁缺勿滥，但那会让真缺失的行不再被停用）。
  if (out.length === 0) { push(profileDir); push(baseDir) }
  return out
}

export { FRAMEWORK_SCOPE, basePackageName, frameworkBases, isFrameworkModuleName, isUnder }
