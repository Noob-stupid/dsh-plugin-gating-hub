// ④ 装后校验 + 下载物摘要校验（2026-09-26）
//
// 覆盖三件事（全部**只读/只提示**，绝不改既有成功判定）：
//   ① verifyInstalledEntry：读回刚装的 package.json → 入口（main/exports）文件存在性、
//      补丁行与包名一致性、bundle 引用可解析性；失败给结构化诊断（含"镜像可能未同步完整"）
//   ② verifyTarballDigest：sha256 记录 + 按 registry 元数据 dist.integrity/shasum 校验；
//      **拿不到摘要只如实记录、不拒装**；摘要不匹配也只记录（部分镜像会重打包 tarball）
//   ③ 真链路：起一个本地假 registry + 真 curl 下载真 tarball → curlManualInstall 落盘，
//      断言摘要结果与"坏摘要仍然装成功"（用本地 tar 打包，全离线）
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeDirVerifiedAsync } from '../lib/server/infra/fsx.js'
import { entryFieldOf, verifyInstalledEntry, verifyTarballDigest, MIRROR_HINT } from '../lib/server/domain/install-verify.js'
import { curlManualInstall } from '../lib/server/domain/install.js'

const execFileAsync = promisify(execFile)
let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-verify-'))

/** 造一个假 profile（package.json + cordis.patch.yml）。 */
function makeProfile(name, { patch = '# empty\n', bundles = null, pkgFiles = {}, patchFile = null } = {}) {
  const dir = join(ROOT, name, 'profiles', 'web')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const manifest = { name: 'dsh-profile-web', private: true }
  if (bundles !== null) manifest.dsh = { profile: { bundles } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  return dir
}
/** 往 profile 里放一个"装好的包"。 */
function placePackage(profileDir, pkg, files = {}) {
  const dir = join(profileDir, 'node_modules', ...pkg.name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}
const row = (id, name) => `- insert:\n    - id: ${id}\n      name: '${name}'\n`

// ── ① 入口字段归一（纯函数）────────────────────────────────────────────────
{
  check('entryFieldOf：main 优先', JSON.stringify(entryFieldOf({ main: './lib/index.js', exports: { '.': './x.js' } })) === JSON.stringify({ field: 'main', value: './lib/index.js' }))
  check('entryFieldOf：exports["."] 字符串', entryFieldOf({ exports: { '.': './lib/index.js' } }).value === './lib/index.js')
  check('entryFieldOf：exports["."].default', entryFieldOf({ exports: { '.': { default: './e.js' } } }).field === 'exports["."].default')
  check('entryFieldOf：没有入口 → null（bundle/皮肤包不算问题）', entryFieldOf({}) === null && entryFieldOf({ main: 42 }) === null)
}

// ── ② verifyInstalledEntry：健康包 / 四类缺陷 ───────────────────────────────
{
  // 健康：入口在、补丁行名字一致、bundle 引用可解析
  const dir = makeProfile('healthy', {
    patch: row('demo-plugin', '@demo/plugin'),
    bundles: ['@deepseek-ai/dsh-base', '@demo/plugin'],
  })
  placePackage(dir, { name: '@demo/plugin', version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, {
    'index.js': 'export {}\n',
    'cordis.patch.yml': row('dep-a', 'dep-a'),
  })
  placePackage(dir, { name: 'dep-a', version: '0.1.0', main: 'index.js' }, { 'index.js': 'export {}\n' })
  const okReport = verifyInstalledEntry(dir, '@demo/plugin')
  check('健康包：ok=true 且无 problems', okReport.ok === true && okReport.problems.length === 0, JSON.stringify({ p: okReport.problems, e: okReport.entry }))
  check('健康包：记录版本、入口、补丁行、bundle 引用数',
    okReport.version === '1.0.0' && okReport.entry.exists === true && okReport.patch.matched.length === 1 && okReport.bundle.refs === 1,
    JSON.stringify({ v: okReport.version, matched: okReport.patch.matched, refs: okReport.bundle.refs }))
  check('健康包：给不出镜像提示（没问题就不吓人）', okReport.mirrorHint === null)

  // 入口文件缺失（镜像同步不全 / 打包漏文件）
  const missingEntry = makeProfile('entry-missing')
  placePackage(missingEntry, { name: 'broken-entry', version: '2.0.0', main: './lib/index.js' })
  const r1 = verifyInstalledEntry(missingEntry, 'broken-entry')
  check('入口缺失：ok=false、problems 说清缺哪个文件、带上"镜像可能未同步完整"',
    r1.ok === false && r1.problems.some((p) => /入口文件缺失/u.test(p)) && r1.mirrorHint === MIRROR_HINT,
    JSON.stringify(r1.problems))
  check('入口缺失：给出可执行建议（重装 / 换源）',
    r1.suggestions.some((s) => /重装/u.test(s)) && r1.suggestions.some((s) => /换源|registry\.npmjs\.org/u.test(s)), JSON.stringify(r1.suggestions))

  // package.json 读不到（被 pnpm 还原/删除）
  const noPkg = makeProfile('no-pkg')
  mkdirSync(join(noPkg, 'node_modules', 'ghost-pkg'), { recursive: true })
  const r2 = verifyInstalledEntry(noPkg, 'ghost-pkg')
  check('读不到 package.json：ok=false + 明确说明 + 镜像提示', r2.ok === false && /读不到/u.test(r2.problems.join('')) && r2.mirrorHint === MIRROR_HINT)

  // 包名不一致（镜像发了别的产物）：目录在，但 package.json 里的 name 不是要装的那个
  const wrongName = makeProfile('wrong-name')
  mkdirSync(join(wrongName, 'node_modules', 'wanted-pkg'), { recursive: true })
  writeFileSync(join(wrongName, 'node_modules', 'wanted-pkg', 'package.json'), JSON.stringify({ name: 'someone-else', version: '1.0.0', main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(join(wrongName, 'node_modules', 'wanted-pkg', 'index.js'), '', 'utf8')
  const r3 = verifyInstalledEntry(wrongName, 'wanted-pkg')
  check('包名不一致：ok=false 且说清"镜像把同名/错误产物发了下来"',
    r3.ok === false && r3.problems.some((p) => /与安装目标（wanted-pkg）不一致/u.test(p)), JSON.stringify(r3.problems))

  // 补丁行指向别的包（id 派生一致但 name 不同）
  const badRow = makeProfile('bad-row', { patch: row('demo-plugin', 'other-plugin') })
  placePackage(badRow, { name: '@demo/plugin', version: '1.0.0', main: 'index.js' }, { 'index.js': '' })
  const r4 = verifyInstalledEntry(badRow, '@demo/plugin')
  check('补丁行与包名不一致：ok=false + 指出 id→name + 给出修正建议',
    r4.ok === false && r4.patch.mismatched.length === 1 && /补丁行与包名不一致/u.test(r4.problems.join('')) && r4.suggestions.some((s) => /cordis\.patch\.yml/u.test(s)),
    JSON.stringify(r4.problems))

  // bundle 引用缺失
  const badRefs = makeProfile('bad-refs', { bundles: ['@demo/agg'] })
  placePackage(badRefs, { name: '@demo/agg', version: '3.0.0', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, {
    'index.js': '',
    'cordis.patch.yml': `${row('dep-a', 'dep-a')}${row('dep-b', 'dep-b')}`,
  })
  placePackage(badRefs, { name: 'dep-a', version: '1.0.0', main: 'index.js' }, { 'index.js': '' })
  const r5 = verifyInstalledEntry(badRefs, '@demo/agg')
  check('bundle 引用缺失：ok=false 且列出缺失包名 + 镜像提示',
    r5.ok === false && r5.bundle.missingRefs.includes('dep-b') && /bundle 引用的包缺失/u.test(r5.problems.join('')) && r5.mirrorHint === MIRROR_HINT,
    JSON.stringify(r5.bundle.missingRefs))

  // 永不抛：非法输入也必须是结构化结果
  const r6 = verifyInstalledEntry(null, undefined)
  check('非法输入不抛异常，返回结构化诊断', typeof r6 === 'object' && r6.ok === false && Array.isArray(r6.problems) && r6.problems.length > 0, JSON.stringify(r6.problems).slice(0, 120))
}

// ── ③ verifyTarballDigest：三种摘要来源 + 缺失 + 不匹配 ─────────────────────
{
  const file = join(ROOT, 'sample.tgz')
  const buf = Buffer.from('假装这是 tarball 内容\x00\x01\x02', 'utf8')
  writeFileSync(file, buf)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const sha512b64 = createHash('sha512').update(buf).digest('base64')
  const sha1 = createHash('sha1').update(buf).digest('hex')

  const good = verifyTarballDigest(file, { integrity: `sha512-${sha512b64}`, shasum: sha1 })
  check('integrity 命中：ok=true、记录 sha256、说明用哪种算法校验通过',
    good.ok === true && good.algorithm === 'sha512' && good.sha256 === sha256 && /校验通过/u.test(good.note), good.note)
  const bad = verifyTarballDigest(file, { integrity: `sha512-${Buffer.from('nope').toString('base64')}` })
  check('integrity 不匹配：ok=false、note 明说"不拒装、只记录"',
    bad.ok === false && /不匹配/u.test(bad.note) && /不拒装/u.test(bad.note), bad.note)
  const sha1Only = verifyTarballDigest(file, { shasum: sha1 })
  check('只有 shasum：按 sha1 校验并记录', sha1Only.ok === true && sha1Only.algorithm === 'sha1', sha1Only.note)
  const none = verifyTarballDigest(file, null)
  check('来源无摘要：ok=null 且如实记「来源无摘要，未校验」（不拒装）',
    none.ok === null && /来源无摘要，未校验/u.test(none.note) && none.sha256 === sha256, none.note)
  const missing = verifyTarballDigest(join(ROOT, 'not-there.tgz'), null)
  check('文件不存在：不抛，记"无法完成"', missing.checked === false && /无法完成/u.test(missing.note), missing.note)
}

// ── ④ 真链路：本地假 registry + 真 curl 下载 + 真 tar 解压落盘 ──────────────
{
  const PKG = 'dsh-verify-probe'
  const build = join(ROOT, 'build')
  mkdirSync(join(build, 'package'), { recursive: true })
  writeFileSync(join(build, 'package', 'package.json'), JSON.stringify({ name: PKG, version: '1.2.3', main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(join(build, 'package', 'index.js'), 'export const ok = true\n', 'utf8')
  const tgz = join(ROOT, 'pkg.tgz')
  await execFileAsync('tar', ['-czf', tgz, '-C', build, 'package'], { windowsHide: true })
  const tgzBuf = readFileSync(tgz)
  const sha256 = createHash('sha256').update(tgzBuf).digest('hex')
  const sha512b64 = createHash('sha512').update(tgzBuf).digest('base64')

  let mode = 'good'
  const server = createServer((req, res) => {
    if (req.url === `/${PKG}`) {
      const dist = { tarball: `http://127.0.0.1:${server.address().port}/pkg.tgz` }
      if (mode === 'good') { dist.integrity = `sha512-${sha512b64}`; dist.shasum = createHash('sha1').update(tgzBuf).digest('hex') }
      if (mode === 'bad') dist.integrity = `sha512-${Buffer.from('bogus').toString('base64')}`
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': { dist } } }))
      return
    }
    if (req.url === '/pkg.tgz') {
      res.setHeader('content-type', 'application/octet-stream')
      res.end(tgzBuf)
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const registry = `http://127.0.0.1:${server.address().port}`
  const profileDir = makeProfile('curl-e2e', { patch: row(PKG, PKG) })
  try {
    const info = await curlManualInstall(profileDir, PKG, [registry])
    check('真链路：curl 通道装成功且返回值新增 integrity 字段（旧字段 version/missingDeps 仍在）',
      info.version === '1.2.3' && Array.isArray(info.missingDeps) && info.integrity?.checked === true, JSON.stringify(info.integrity))
    check('真链路：摘要按 registry 元数据校验通过，并记录 sha256',
      info.integrity.ok === true && info.integrity.algorithm === 'sha512' && info.integrity.sha256 === sha256, JSON.stringify(info.integrity))
    check('真链路：包真的落盘（入口文件在）', existsSync(join(profileDir, 'node_modules', PKG, 'index.js')))
    const real = verifyInstalledEntry(profileDir, PKG)
    check('真链路：对刚装好的包做装后校验 → ok=true（补丁行名字一致）', real.ok === true && real.patch.matched.length === 1, JSON.stringify(real.problems))

    mode = 'bad'
    const badInfo = await curlManualInstall(profileDir, PKG, [registry])
    check('坏摘要**不拒装**（部分镜像会重打包 tarball）：仍然装成功，只如实记录 ok=false',
      badInfo.version === '1.2.3' && badInfo.integrity.ok === false && /不匹配/u.test(badInfo.integrity.note),
      badInfo.integrity.note)

    mode = 'none'
    const noneInfo = await curlManualInstall(profileDir, PKG, [registry])
    check('元数据无摘要**不拒装**：装成功 + 记「来源无摘要，未校验」',
      noneInfo.version === '1.2.3' && noneInfo.integrity.ok === null && /来源无摘要，未校验/u.test(noneInfo.integrity.note),
      noneInfo.integrity.note)
  } finally {
    server.close()
  }
}

// 清理临时目录：本机实测 `rmSync` 会**静默落空**（目录仍在、不抛错，与 fsx.js 注释里那台机器的表现一致），
// 所以走仓库自己的"删除 + 核实 + 外部兜底"助手 removeDirVerifiedAsync，删不掉就如实打印。
const cleaned = await removeDirVerifiedAsync(ROOT, { attempts: 2, pollMs: 600 })
if (cleaned.ok !== true) console.log(`（提示：临时目录未能删除：${ROOT} — ${cleaned.error ?? '未知'}）`)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
