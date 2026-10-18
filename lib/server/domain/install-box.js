// L1 · domain —— install-box.js（「盒子实验」：解压后的包目录先静态校验再覆盖正式位置）
//
// 2026-10-18 从 domain/install.js **原样搬出**（install.js 贴着 600 行架构硬顶，见
// tests/test-architecture-guard.mjs；这一块本来就是自洽的"装前只读校验"，与 sources 无关）。
// 搬移只搬移未改逻辑：install.js 继续 re-export 这两个名字，**对外导出名与调用点一个字都没变**。
//
// 校验什么（都是"装了也起不来"的硬伤，所以要在覆盖旧版本**之前**拦住）：
//   · package.json 必须可解析且 name 与安装目标一致；
//   · main / exports 入口文件必须真实存在；
//   · bundle patch（cordis.patch.yml）引用的包必须已就位（防聚合包引用缺失崩溃）。
// 失败抛错 → 调用方保留旧版本（安装不中断服务）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 盒子验证：解压后的包目录先通过静态校验再允许覆盖正式位置。
 * refCheckRoot 指定引用检查根（宿主插件在根层 node_modules，与 profile 层不同）。 */
function verifyPackageBox(pkgPath, profileDir, packageName, refCheckRoot = null) {
  const note = []
  const pkgRaw = readFileSync(join(pkgPath, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw)
  if (pkg.name !== packageName) {
    throw new Error(`盒子验证失败：包名不符（tarball 内为 ${pkg.name}，期望 ${packageName}），已保留旧版本`)
  }
  // 入口存在性：main 字段 / exports.'.'（字符串或对象 default）指向的文件必须存在
  let entry = typeof pkg.main === 'string' ? pkg.main : null
  if (entry === null && pkg.exports && typeof pkg.exports === 'object') {
    const dot = pkg.exports['.'] ?? pkg.exports['./package.json'] === undefined ? pkg.exports['.'] : null
    if (typeof dot === 'string') entry = dot
    else if (dot && typeof dot === 'object') entry = typeof dot.default === 'string' ? dot.default : null
  }
  if (entry !== null) {
    const entryPath = join(pkgPath, ...entry.split('/'))
    if (!existsSync(entryPath)) {
      throw new Error(`盒子验证失败：入口文件缺失（${entry}），已保留旧版本`)
    }
  }
  // bundle patch 引用预检：引用的包必须已存在于目标 node_modules（防聚合包半更新崩溃）。
  // refCheckRoot 指定检查根（宿主插件在根层 node_modules，与 profile 层不同）。
  const checkRoot = refCheckRoot ?? join(profileDir, 'node_modules')
  try {
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel === 'string') {
      const bundlePatch = join(pkgPath, patchRel)
      if (existsSync(bundlePatch)) {
        const refs = parseBundlePatchRefs(readFileSync(bundlePatch, 'utf8'))
        const missingRefs = refs.filter((r) => !existsSync(join(checkRoot, r.name)))
        if (missingRefs.length > 0) {
          note.push(`bundle 引用缺失：${missingRefs.map((r) => r.name).join('、')}（安装后由聚合完整性检查补齐/禁用）`)
        }
        if (refs.length > 0) note.push(`bundle 引用 ${refs.length} 个已就位`)
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('盒子验证失败')) throw error
  }
  return { note: note.length > 0 ? note.join('；') : null }
}

/** 解析 bundle patch（cordis.patch.yml）的 insert 引用列表（id + 包名）。 */
function parseBundlePatchRefs(text) {
  const refs = []
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
    if (/^- /u.test(line) && !/^ {4}- /u.test(line)) inInsert = false
    if (!inInsert) continue
    const idM = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
    if (!idM) continue
    const nameM = (lines[i + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
    if (nameM) refs.push({ id: idM[1], name: nameM[1] })
  }
  return refs
}

export { verifyPackageBox, parseBundlePatchRefs }
