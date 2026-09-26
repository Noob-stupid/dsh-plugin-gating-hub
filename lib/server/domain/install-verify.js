// L1 · domain —— install-verify.js（装后校验 + 下载物摘要校验；2026-09-26 新增，**纯加法**）
//
// 解决什么：装完就报成功，用户要到重启后才发现"入口文件不在 / 补丁行指向别的包 / bundle 引用缺失"，
// 而失败原因常常只是**镜像没同步完整**（本控制台主源是 registry.npmmirror.com）——这类问题重装/换源即可，
// 但面板在此之前完全不告诉用户。
//
// 两条硬规矩（写在最前面，改代码时别越线）：
//   ① verifyInstalledEntry 只**读**、只产出结构化诊断：**绝不影响既有成功判定** —— 校验失败也只是提示，
//      不把已经装成功的作业改判失败（安装是否成功由 install-job.js 的既有逻辑决定）。
//   ② verifyTarballDigest 拿不到摘要时如实记「来源无摘要，未校验」，**绝不因此拒装**（离线/内网源常见）；
//      摘要不匹配也只记录 + 强烈提示，不拒装（部分镜像会重打包 tarball，拒装会直接破坏这些源的可用性）。
//
// 报告里的 mirrorHint 是刻意固化的：主源是镜像站，"文件/引用缺失"最常见的解释就是镜像未同步完整。
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseInsertNames } from './patch.js'
import { deriveEntryId } from './runtime.js'

/** 固定的镜像提示（面板会原样显示给用户）。 */
const MIRROR_HINT = '镜像可能未同步完整（本控制台主源是 registry.npmmirror.com）：可稍后重试，'
  + '或在「源管理」里换用 registry.npmjs.org / 其它镜像后重装'

/** 入口字段归一：main（字符串）优先，其次 exports['.']（字符串或 {default}）。
 * 返回 { field, value } 或 null（包没声明入口 —— 不算问题，很多 bundle/皮肤包没有入口）。 */
function entryFieldOf(pkg) {
  if (typeof pkg?.main === 'string' && pkg.main !== '') return { field: 'main', value: pkg.main }
  const dot = pkg?.exports?.['.']
  if (typeof dot === 'string' && dot !== '') return { field: 'exports["."]', value: dot }
  if (dot !== null && typeof dot === 'object' && typeof dot.default === 'string' && dot.default !== '') {
    return { field: 'exports["."].default', value: dot.default }
  }
  if (typeof pkg?.exports === 'string' && pkg.exports !== '') return { field: 'exports', value: pkg.exports }
  return null
}

/** 读 profile 的补丁行（id → 包名）；读不到就当没有，不抛。 */
function readPatchRows(profileDir) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  try {
    if (!existsSync(patchPath)) return { patchPath, rows: new Map() }
    return { patchPath, rows: parseInsertNames(readFileSync(patchPath, 'utf8')) }
  } catch {
    return { patchPath, rows: new Map() }
  }
}

/** profile 清单里声明的 bundle 层（读不到就空数组）。 */
function readBundles(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles : []
  } catch {
    return []
  }
}

/**
 * 装后校验（只读、永不抛）：读回刚装的 package.json，检查
 *   ① 入口（main / exports）指向的文件确实存在；
 *   ② profile 补丁里与这个包相关的行**指向的就是这个包名**（id 派生一致但 name 不同 → 明确报错）；
 *   ③ 若该包声明了 dsh.bundle.patch（或已被写进 profile bundles）：补丁文件存在、且其中引用的包都能解析。
 * 返回结构化诊断（ok / problems / mirrorHint / suggestions / entry / patch / bundle / version …）。
 */
function verifyInstalledEntry(profileDir, packageName) {
  const safeName = typeof packageName === 'string' ? packageName : String(packageName ?? '')
  const report = {
    ok: false,
    checked: false,
    packageName,
    // 用 String() 兜住非法输入：本函数的契约是"永不抛"，连 path.join 的参数类型错误都不许漏出去
    packageDir: join(String(profileDir ?? ''), 'node_modules', ...safeName.split('/')),
    version: null,
    entry: null,
    patch: { patchPath: null, rows: [], matched: [], mismatched: [] },
    bundle: { declared: false, inBundles: false, patchFile: null, refs: 0, missingRefs: [] },
    problems: [],
    mirrorHint: null,
    suggestions: [],
    error: null,
  }
  try {
    const pkgPath = join(report.packageDir, 'package.json')
    if (!existsSync(pkgPath)) {
      report.problems.push(`读不到 ${packageName} 的 package.json（${pkgPath}）：可能被 pnpm 还原/删除，或安装目录被占用`)
      report.mirrorHint = MIRROR_HINT
      report.suggestions.push('重装一次；若仍失败请确认该包在 registry 上确实存在该版本')
      report.checked = true
      report.ok = false
      return report
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    report.checked = true
    report.version = typeof pkg.version === 'string' ? pkg.version : null
    if (pkg.name !== packageName) {
      report.problems.push(`package.json 里的包名（${pkg.name}）与安装目标（${packageName}）不一致：`
        + '多半是镜像把同名/错误产物发了下来')
      report.mirrorHint = MIRROR_HINT
    }

    // ① 入口文件存在性
    const entry = entryFieldOf(pkg)
    if (entry === null) {
      report.entry = { field: null, value: null, exists: null, note: '该包未声明 main/exports（bundle/皮肤类包常见），跳过入口检查' }
    } else {
      const target = join(report.packageDir, ...entry.value.split('/'))
      const exists = existsSync(target)
      report.entry = { field: entry.field, value: entry.value, exists, note: exists ? null : `入口文件缺失：${target}` }
      if (!exists) {
        report.problems.push(`入口文件缺失：${entry.field} = ${entry.value}，但 ${target} 不存在（装了也加载不起来）`)
        report.mirrorHint = MIRROR_HINT
      }
    }

    // ② 补丁行与包名一致
    const { patchPath, rows } = readPatchRows(profileDir)
    report.patch.patchPath = patchPath
    const derivedId = deriveEntryId(packageName, new Set())
    for (const [id, name] of rows) {
      report.patch.rows.push({ id, name })
      const related = id === derivedId || id.startsWith(`${derivedId}-`) || name === packageName
      if (!related) continue
      if (name === packageName) report.patch.matched.push({ id, name })
      else report.patch.mismatched.push({ id, name })
    }
    if (report.patch.mismatched.length > 0) {
      report.problems.push(`补丁行与包名不一致：${report.patch.mismatched.map((r) => `id=${r.id} → name=${r.name}`).join('、')}`
        + `（期望 name=${packageName}）—— 会让 DSH 启动时加载到别的模块或直接缺失`)
      report.suggestions.push(`修正 profile 的 cordis.patch.yml：把 ${report.patch.mismatched.map((r) => r.id).join('、')} 行的 name 改成 ${packageName}（或重装一次让控制台重写该行）`)
    }

    // ③ bundle 引用一致性（只在"该包声明了 bundle 或已在 profile bundles 里"时检查，避免误报）
    const bundles = readBundles(profileDir)
    report.bundle.declared = typeof pkg?.dsh?.bundle?.patch === 'string'
    report.bundle.inBundles = bundles.includes(packageName)
    if (report.bundle.declared || report.bundle.inBundles) {
      const rel = typeof pkg?.dsh?.bundle?.patch === 'string' ? pkg.dsh.bundle.patch : null
      const patchFile = rel === null ? null : join(report.packageDir, rel)
      report.bundle.patchFile = patchFile
      if (rel !== null && !existsSync(patchFile)) {
        report.problems.push(`bundle 补丁文件缺失：dsh.bundle.patch = ${rel}（${patchFile} 不存在）`)
        report.mirrorHint = MIRROR_HINT
      } else if (patchFile !== null) {
        const refs = [...parseInsertNames(readFileSync(patchFile, 'utf8')).values()]
        report.bundle.refs = refs.length
        for (const name of refs) {
          if (name.startsWith('cordis:')) continue
          if (!existsSync(join(profileDir, 'node_modules', ...name.split('/')))) report.bundle.missingRefs.push(name)
        }
        if (report.bundle.missingRefs.length > 0) {
          report.problems.push(`bundle 引用的包缺失：${report.bundle.missingRefs.join('、')}（启动时会因为缺模块崩溃/自动禁用该行）`)
          report.mirrorHint = MIRROR_HINT
          report.suggestions.push('等网络恢复后在面板里重新安装该聚合包（控制台会自动补齐/禁用缺失行）')
        }
      }
    }

    if (report.problems.length > 0) {
      report.suggestions.push('重装该插件（pnpm 通道会重新下载）；若重复出现同样的缺失，优先怀疑镜像未同步，换源后再装')
      if (report.mirrorHint !== null && !report.suggestions.includes(MIRROR_HINT)) report.suggestions.unshift(MIRROR_HINT)
    }
    report.ok = report.problems.length === 0
    return report
  } catch (error) {
    report.checked = true
    report.ok = false
    report.error = error instanceof Error ? error.message : String(error)
    report.problems.push(`装后校验本身出错（不影响安装结果）：${report.error}`)
    return report
  }
}

/**
 * 下载物摘要校验（只读、永不抛）：算出 sha256 并尽量与 registry 元数据比对。
 *   · 元数据有 dist.integrity（SRI，通常 sha512）→ 按该算法校验并记录；
 *   · 只有 dist.shasum（sha1）→ 按 sha1 校验并记录；
 *   · 两者都没有 → ok=null + note「来源无摘要，未校验」，**绝不因此拒装**（离线/内网源的常态）。
 * 摘要不匹配**也不拒装**（部分镜像是重打包的 tarball），只把 ok=false 与提示记进 job 供用户判断。
 */
function verifyTarballDigest(tarballPath, dist = null) {
  const out = { checked: false, ok: null, algorithm: null, expected: null, actual: null, sha256: null, note: null }
  try {
    const buf = readFileSync(tarballPath)
    out.sha256 = createHash('sha256').update(buf).digest('hex')
    out.checked = true
    const sri = typeof dist?.integrity === 'string' ? dist.integrity.trim().split(/\s+/u)[0] : null
    const shasum = typeof dist?.shasum === 'string' ? dist.shasum.trim() : null
    if (sri !== null && /^[a-z0-9]+-[A-Za-z0-9+/=]+$/u.test(sri)) {
      const [algorithm, expected] = [sri.slice(0, sri.indexOf('-')), sri.slice(sri.indexOf('-') + 1)]
      const actual = createHash(algorithm).update(buf).digest('base64')
      out.algorithm = algorithm
      out.expected = sri
      out.actual = `${algorithm}-${actual}`
      out.ok = actual === expected
      out.note = out.ok === true
        ? `已按 registry 元数据的 ${algorithm} 摘要校验通过（sha256=${out.sha256}）`
        : `摘要不匹配：registry 元数据声明 ${algorithm} 摘要，但下载物算出来不同（疑似镜像重打包或下载损坏）——按"不拒装、只记录"处理，建议重试或换源`
      return out
    }
    if (shasum !== null) {
      const actual = createHash('sha1').update(buf).digest('hex')
      out.algorithm = 'sha1'
      out.expected = shasum
      out.actual = actual
      out.ok = actual === shasum
      out.note = out.ok === true
        ? `已按 registry 元数据的 sha1 摘要校验通过（sha256=${out.sha256}）`
        : `摘要不匹配：registry 元数据的 sha1 与下载物不同（疑似镜像重打包或下载损坏）——按"不拒装、只记录"处理`
      return out
    }
    out.ok = null
    out.note = `来源无摘要，未校验（已记录 sha256=${out.sha256}；离线/内网源常见，不影响安装）`
    return out
  } catch (error) {
    out.note = `摘要校验无法完成（不影响安装）：${error instanceof Error ? error.message : String(error)}`
    return out
  }
}

export { verifyInstalledEntry, verifyTarballDigest, entryFieldOf, MIRROR_HINT }
