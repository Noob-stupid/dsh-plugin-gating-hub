// 0.5.48 · exports 子路径引用（`包/子路径`）必须按**真实解析语义**核实，不得假阳性。
//
// 缺陷④现场（装 ds-bot 时撞出来）：`verifyInstalledEntry` 拿 `ds-bot/web-search` 去核实，
// 旧 `resolvePackageJson` 把引用名拼成 `ds-bot/web-search/package.json` ⇒ ds-bot 的 exports
// 里没有这个子路径 ⇒ `ERR_PACKAGE_PATH_NOT_EXPORTED` ⇒ 退物理路径
// `node_modules/ds-bot/web-search/package.json` ⇒ **也不存在**（包的清单在
// `node_modules/ds-bot/package.json`，不在子目录里）⇒ 返回 null ⇒ 误报"缺模块会崩/会被自动禁用"。
// 而按真实解析语义这个引用是好的：`require.resolve('ds-bot/web-search')` 成功
// （`包/子路径` 是生态既有约定，官方 patch 里也有这种 entry），模块也能真 `import()`。
//
// 本套钉死的语义（**全离线**：零网络、零 spawn；夹具是临时目录里的真文件，
// 因为这一条修的就是"真实解析语义"，必须让 node 的解析器真的参与）：
//   ① 子路径引用 ⇒ 解析到**该包的清单**（不再是 null / 不再假阳性）
//   ② 裸包名、无 exports 的包、老式 main 包 ⇒ 行为不变
//   ③ 负控：真不存在的子路径 / 真不存在的包 ⇒ **仍然返回 null**（绝不放松成"一律放行"）
//   ④ 真机形态复刻：exports 里**不含** './package.json' 时，`pkg/package.json` 解析必失败
//      —— 这条正是旧实现踩的坑，留着当"旧行为确实坏"的证据
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePackageJson } from '../lib/server/infra/paths.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const ROOT = join(tmpdir(), `dsh-subpath-resolve-${process.pid}`)
rmSync(ROOT, { recursive: true, force: true })
const put = (rel, content) => {
  const p = join(ROOT, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content, 'utf8')
  return p
}
const pkgJson = (o) => `${JSON.stringify(o, null, 2)}\n`

// ── 夹具：三种真实包形 ────────────────────────────────────────────────────────
// ① ds-bot 形态：声明 exports 子路径（生态既有约定），**不含** './package.json'
const botPkg = put('node_modules/ds-bot/package.json', pkgJson({
  name: 'ds-bot', version: '1.2.3',
  exports: { '.': './index.js', './web-search': './web-search/index.js' },
}))
put('node_modules/ds-bot/index.js', 'export default 1\n')
put('node_modules/ds-bot/web-search/index.js', 'export default 2\n')
// ② 无 exports 的老式包（既有 fallback 必须继续管用）
const plainPkg = put('node_modules/plain-pkg/package.json', pkgJson({ name: 'plain-pkg', version: '0.0.1', main: 'index.js' }))
put('node_modules/plain-pkg/index.js', 'module.exports = 1\n')
// ③ 作用域包 + 子路径
const scopePkg = put('node_modules/@scope/tool/package.json', pkgJson({
  name: '@scope/tool', version: '2.0.0', exports: { '.': './main.js', './settings': './settings.js' },
}))
put('node_modules/@scope/tool/main.js', 'export default 1\n')
put('node_modules/@scope/tool/settings.js', 'export default 2\n')

// ── ① 子路径：不再假阳性 ─────────────────────────────────────────────────────
{
  const hit = resolvePackageJson('ds-bot/web-search', ROOT)
  check('★ 缺陷④核心：exports 子路径 `ds-bot/web-search` 能解析出**该包的清单**（旧实现返回 null ⇒ 假阳性）',
    hit === botPkg, String(hit))
  check('★ 解析到的是**包根**的清单（不是子目录下不存在的 package.json）',
    hit !== null && hit.endsWith(join('ds-bot', 'package.json')), String(hit))
  const scopeHit = resolvePackageJson('@scope/tool/settings', ROOT)
  check('作用域包的子路径同样命中', scopeHit === scopePkg, String(scopeHit))
  check('裸包名行为不变', resolvePackageJson('ds-bot', ROOT) === botPkg)
}

// ── ② 既有行为不倒退 ────────────────────────────────────────────────────────
{
  check('无 exports 的老式包仍能解析（既有 fallback 未丢）',
    resolvePackageJson('plain-pkg', ROOT) === plainPkg)
  check('作用域裸包名仍能解析', resolvePackageJson('@scope/tool', ROOT) === scopePkg)
  check('issue #15 的 fallbackBase 通道仍在：baseDir 解析不到时从 fallback 目录解析',
    resolvePackageJson('ds-bot', join(ROOT, 'empty-base'), ROOT) === botPkg)
}

// ── ③ 负控：真不存在 ⇒ 仍必须报"解析不到" ────────────────────────────────────
{
  check('★ 负控：真不存在的子路径 ⇒ 仍然 null（校验没被放松成"一律放行"）',
    resolvePackageJson('ds-bot/does-not-exist', ROOT) === null)
  check('★ 负控：真不存在的包 ⇒ 仍然 null',
    resolvePackageJson('no-such-package-xyz', ROOT) === null)
  check('★ 负控：作用域包的不存在子路径 ⇒ 仍然 null',
    resolvePackageJson('@scope/tool/nope', ROOT) === null)
  check('★ 负控：fallbackBase 通道也不许把不存在的子路径放行',
    resolvePackageJson('ds-bot/does-not-exist', join(ROOT, 'empty-base'), ROOT) === null)
  check('脏输入安全（空串 / undefined 不抛）',
    resolvePackageJson('', ROOT) === null && resolvePackageJson(undefined, ROOT) === null)
}

// ── ④ 复刻旧实现的坏：`pkg/package.json` 对这类包**本来就解析不到** ─────────────
{
  const { createRequire } = await import('node:module')
  const req = createRequire(join(ROOT, 'package.json'))
  let code = null
  try { req.resolve('ds-bot/web-search/package.json') } catch (e) { code = e.code }
  check('★ 证据：`ds-bot/web-search/package.json` 解析必失败（ERR_PACKAGE_PATH_NOT_EXPORTED）'
    + ' —— 旧实现正是拿它当判据，所以对 exports 子路径必然假阳性',
    code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', String(code))
  let ok = null
  try { ok = req.resolve('ds-bot/web-search') } catch {}
  check('★ 证据：而按真实解析语义 `ds-bot/web-search` **是成功的**（所以引用本身没问题）',
    typeof ok === 'string' && ok.includes('web-search'), String(ok))
}

// ── ⑤ 端到端：装后校验不再对子路径引用误报缺失 ────────────────────────────────
{
  const { verifyInstalledEntry } = await import('../lib/server/domain/install-verify.js')
  const report = verifyInstalledEntry(ROOT, 'ds-bot')
  check('★ 端到端：verifyInstalledEntry 对 exports 子路径包不再报"读不到 package.json"',
    report.problems.every((p) => !/读不到|可能被 pnpm 还原/u.test(p)), JSON.stringify(report.problems))
  check('端到端：识别出版本（说明清单真的读到了）', report.version === '1.2.3', String(report.version))
  check('端到端：入口存在性判定为存在（exports "." 指向 index.js）',
    report.entry?.exists === true, JSON.stringify(report.entry))
}

rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(`${fail} FAILED`); process.exit(1) }
