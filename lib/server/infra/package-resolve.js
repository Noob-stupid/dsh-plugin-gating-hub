// L0 · infra —— package-resolve.js（Node 解析器封装：包名可解析性 + 可用包名枚举；0.5.30 加法）
//
// 为什么不用「store 目录名」判断包在不在（真机教训 2026-09-28）：
//   pnpm 会**截断超长目录名**（`@deepseek-ai+dsh-workflow-ptc` → `@deepseek-ai+dsh-workflow-p_<hash>`），
//   按目录名前缀匹配会把**存在的包**误判成不存在 —— 本机实测：`dsh-workflow-ptc`、`dsh-agent-preset`
//   两个真存在的包都被目录名法误报。所以体检一律走 **Node 自己的解析器**（与框架加载补丁行同一套解析），
//   并在多个基准上取并集：① profile 目录（第三方插件在这里）② 框架运行时根（`@deepseek-ai/*` 在这里）。

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 基准目录 → `createRequire` 的探针位置。
 * base 有两种合法写法，本函数把两者都收下（判据：base 自己是不是就叫 node_modules）：
 *   · base 是**含 node_modules 的目录**（如 profile 目录 `<…>/profiles/web`）→ 探针 `<base>/__patch_audit_probe__.js`
 *   · base 本身就是 **node_modules 目录**（如 `…/.pnpm/@deepseek-ai+dsh@…/node_modules`）→ 探针放它内部
 * 为什么必须兼容第二种：框架内置包的实体只存在于 `.pnpm/<pkg>/node_modules/` 这一层，
 * 说"框架基准"时最自然的写法就是那层本身；若一律拼 `<base>/node_modules/…`，
 * 就会去找 `<…>/node_modules/node_modules` —— **真存在的包被判成不存在**（本套 ① 段即是回归）。
 */
function probePathOf(base) {
  return base.replace(/[\\/]+$/u, '').toLowerCase().endsWith('node_modules')
    ? join(base, '__patch_audit_probe__.js')
    : join(base, 'node_modules', '__patch_audit_probe__.js')
}

/** 造多基准解析器：任一基准能解析即算命中（`from` 如实回带，便于报告里说明"从哪解析到的"）。 */
function makePackageResolver(bases) {
  const reqs = []
  for (const base of (Array.isArray(bases) ? bases : [])) {
    if (typeof base !== 'string' || base === '') continue
    try { reqs.push(createRequire(probePathOf(base))) } catch {}
  }
  return (name) => {
    for (const req of reqs) {
      try { return { ok: true, from: req.resolve(name) } } catch {}
    }
    return { ok: false, reason: '所有基准都解析不到（包可能已被移除/改名，或该子路径不存在）' }
  }
}

/** 枚举一个 node_modules 目录下可见的包名（含 scope 内一层）。 */
function listPackageNames(nodeModulesDir, limit = 4000) {
  const out = []
  try {
    for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
      if (out.length >= limit) break
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        for (const sub of readdirSync(join(nodeModulesDir, entry.name), { withFileTypes: true })) {
          if (out.length >= limit) break
          if (sub.isDirectory() && !sub.name.startsWith('.')) out.push(`${entry.name}/${sub.name}`)
        }
        continue
      }
      out.push(entry.name)
    }
  } catch {}
  return out
}

/** 合并多个 node_modules 目录下的包名（去重）—— 供「疑似改名」当候选集。 */
function listAvailablePackages(dirs) {
  const set = new Set()
  for (const dir of (Array.isArray(dirs) ? dirs : [])) {
    if (typeof dir !== 'string' || dir === '' || !existsSync(dir)) continue
    for (const name of listPackageNames(dir)) set.add(name)
  }
  return [...set]
}

export { listAvailablePackages, listPackageNames, makePackageResolver }