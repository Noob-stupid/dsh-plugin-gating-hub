// L1 · domain —— bundle-refs.js（读**已装聚合包**的 bundle patch 引用清单）
//
// 为什么单开一个模块（0.5.26）：install.js 贴着 600 行架构硬顶（test-architecture-guard.mjs），
// 而"从 node_modules/<pkg>/cordis.patch.yml 里读出 insert 行引用了哪些包名"是一块自洽的只读逻辑，
// 装前校验（install-job 的注册前防线）与装后完整性保障都要用。抽出**只搬移未改逻辑**。
//
// 背景事故（2026-09-06）：装 dsh-desktop 类插件时其 bundle patch 引用了 `@deepseek-ai/dsh-root`
// 等框架级行，那些包不在 profile node_modules → 注册后整服务启动崩溃。
// 注册前先按本模块读出的引用逐个 `resolvePackageJson` 核实，缺失即拒绝注册。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 读取聚合包 `cordis.patch.yml` 的 insert 行 name 列表（注册前校验用）。
 *  解析形状与 install.js#ensureBundlePatchIntegrity 同构：`- insert:` 块下的
 *  `- id: xxx` + 下一行 `      name: '包名'`。读不到（没装 / 没声明 dsh.bundle.patch / 文件缺失）
 *  一律返回 `[]` —— 调用方据此判定"没有可核实的引用"，而不是把它当成错误。 */
function readBundlePatchRefNames(profileDir, pkgName) {
  try {
    const pkgJsonPath = join(profileDir, 'node_modules', pkgName, 'package.json')
    if (!existsSync(pkgJsonPath)) return []
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel !== 'string') return []
    const text = readFileSync(join(profileDir, 'node_modules', pkgName, patchRel), 'utf8')
    const names = []
    const lines = text.split(/\r?\n/u)
    let inInsert = false
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
      if (/^- /u.test(line) && !/^ {4}- /u.test(line)) inInsert = false
      if (!inInsert) continue
      // ★ 2026-10-04 改错（0.5.38）：`name:` 的值**加不加引号都是合法 YAML** —— 真机 dsh-whale-widget
      // 写的是不带引号的 `name: dsh-whale-widget`，旧判据只认带引号 ⇒ 引用清单为空 ⇒ 注册前的
      // "引用包是否都可解析"这道防崩闸门对这类包**形同不存在**。现在两种形态都认。
      const nameM = (lines[i + 1] ?? '').match(/^ {6}name:\s*(.+?)\s*$/u)
      if (nameM) {
        const raw = nameM[1].replace(/\s+#.*$/u, '').trim()
        const value = /^(['"]).*\1$/u.test(raw) ? raw.slice(1, -1) : raw
        if (value !== '') names.push(value)
      }
    }
    return names
  } catch { return [] }
}

export { readBundlePatchRefNames }
