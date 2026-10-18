// 开发区根 + 钉住动作的**离线**判据测试（0.5.57 加法）。
//
// 用户 2026-10-15 的三个决定，逐条钉死：
//   ① 「允许」注册自己的开发区根  → 登记表可增删；默认根必须在
//   ② 「不允许」任意目录          → 包含性判定：根内允许；根外 / 父目录 / 兄弟前缀 / 系统目录全拒
//   ③ 「要，默认关闭」            → agent 发起的钉住必须 allowAgent===true，否则 403
//
// 另外钉住：非插件目录（无 dsh 标记）拒；缺 package.json 拒；**写失败必须回滚清单**（绝不半截状态）；
// 写成功必须"读回是 link: 形式"才算数。
//
// 全离线：私有夹具 + 注入的假 pnpm/自足性执行器（一次真实 pnpm 都不跑）。
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '.testdir', 'pin-dev-dir')
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, 'home')
const PROFILE = join(ROOT, 'profile')
const SRC = join(HOME, 'plugin-src')
const OTHER = join(ROOT, 'other-root')
const OUTSIDE = join(ROOT, 'outside')

const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, 'utf8') }
const plugin = (dir, name, version = '0.1.0') => writeJson(join(dir, 'package.json'), { name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } })
const nonPlugin = (dir, name) => writeJson(join(dir, 'package.json'), { name, version: '1.0.0' })

mkdirSync(SRC, { recursive: true })
mkdirSync(OTHER, { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
writeJson(join(PROFILE, 'package.json'), { name: 'p', private: true, dependencies: {} })
plugin(join(SRC, 'in-root'), '@dev/in-root')
plugin(join(OTHER, 'in-other'), '@dev/in-other')
plugin(join(OUTSIDE, 'not-registered'), '@dev/outside')
nonPlugin(join(SRC, 'plain-lib'), '@dev/plain')

const DR = await import(pathToFileURL(join(HERE, '..', 'lib', 'server', 'domain', 'dev-roots.js')).href)
const PIN = await import(pathToFileURL(join(HERE, '..', 'lib', 'server', 'domain', 'pin-dev-dir.js')).href)

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
// ★ 异步断言必须单独一个：同步 check 拿到 Promise 会**立刻 PASS**（断言失败变成未处理拒绝，
//   就是最坏的那种假绿）。真机写盘那两条必须走这里，并且要 await。
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

// ── ① 登记表 ───────────────────────────────────────────────────────────────
check('① 缺省登记表 = 只有默认根（plugin-src）', () => {
  const r = DR.readDevRoots(HOME)
  assert.equal(r.roots.length, 1)
  assert.equal(DR.normalizePath(r.roots[0]), DR.normalizePath(join(HOME, 'plugin-src')))
})
check('① 可以注册自己的根，并能读回来', () => {
  const a = DR.addDevRoot(HOME, OTHER)
  assert.equal(a.ok, true, a.error ?? '')
  assert.equal(DR.readDevRoots(HOME).roots.length, 2)
})
check('① 重复注册幂等（不产生第二条）', () => {
  const a = DR.addDevRoot(HOME, OTHER)
  assert.equal(a.ok, true)
  assert.equal(DR.readDevRoots(HOME).roots.length, 2)
})
check('① 默认根不能取消注册（它是兜底）', () => {
  const r = DR.removeDevRoot(HOME, DR.defaultDevRoot(HOME))
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('默认根'), r.error)
})

// ── ② 包含性判定（"不允许任意目录"的唯一执行点）────────────────────────────
check('② ★ 根内目录允许', () => {
  assert.equal(DR.checkInsideDevRoots(HOME, join(SRC, 'in-root')).ok, true)
  assert.equal(DR.checkInsideDevRoots(HOME, join(OTHER, 'in-other')).ok, true, '注册过的新根也要允许')
})
check('② ★ 根外允许？不行 —— 未注册的目录一律拒', () => {
  const r = DR.checkInsideDevRoots(HOME, join(OUTSIDE, 'not-registered'))
  assert.equal(r.ok, false)
  assert.ok(String(r.reason).includes('不在任何已注册'), r.reason)
})
check('② ★ 根本身不算"之内"（父目录也必须拒，否则等于放行整个 .dsh）', () => {
  assert.equal(DR.checkInsideDevRoots(HOME, SRC).ok, false, '根本身应拒绝')
  assert.equal(DR.checkInsideDevRoots(HOME, HOME).ok, false)
})
// 0.5.87 改错：判据不变（根本身照旧拒绝），但**话要说准** —— 旧文案说"不在任何已注册的开发区根里"，
// 而它恰恰就是那个根，会把人引去"再注册一个根"这条错路。面板把这句话原样显示给用户，所以文案也是行为。
check('② ★ 根被拒时的原因必须是"这就是根本身"，不能再说"不在任何已注册的开发区根里"', () => {
  const reason = String(DR.checkInsideDevRoots(HOME, SRC).reason)
  assert.ok(reason.includes('开发区根本身'), reason)
  assert.ok(reason.includes('<插件目录名>'), `应给出下一步（指向根里的插件目录）：${reason}`)
  assert.ok(!reason.includes('不在任何已注册'), `旧文案未修正：${reason}`)
  // 反向：真正在根外的目录仍用原来那句话（不许把两种情形混成一句）
  const outside = String(DR.checkInsideDevRoots(HOME, OUTSIDE).reason)
  assert.ok(outside.includes('不在任何已注册'), outside)
})
check('② ★ 兄弟前缀不算之内（`C:\\dev` 不能命中 `C:\\devil` 这类）', () => {
  const norm = DR.normalizePath(join(SRC, 'in-root'))
  assert.equal(DR.isInside(norm, DR.normalizePath(SRC)), true)
  assert.equal(DR.isInside(DR.normalizePath(join(SRC + 'x', 'a')), DR.normalizePath(SRC)), false)
})
check('② 不存在的路径 / 空值一律拒（不猜）', () => {
  assert.equal(DR.checkInsideDevRoots(HOME, join(SRC, 'nope')).ok, false)
  assert.equal(DR.checkInsideDevRoots(HOME, '').ok, false)
  assert.equal(DR.checkInsideDevRoots(HOME, null).ok, false)
})

// ── ③ agent 默认关闭 ──────────────────────────────────────────────────────
check('③ ★ agent 发起 + 未放行 ⇒ 403（默认关闭）', () => {
  const p = PIN.planPinDevDir({ home: HOME, profileDir: PROFILE, dir: join(SRC, 'in-root'), byAgent: true })
  assert.equal(p.ok, false)
  assert.equal(p.status, 403)
  assert.ok(String(p.error).includes('默认关闭'), p.error)
})
check('③ agent 发起 + 已放行 ⇒ 允许（用户勾选后才 true）', () => {
  const p = PIN.planPinDevDir({ home: HOME, profileDir: PROFILE, dir: join(SRC, 'in-root'), byAgent: true, allowAgent: true })
  assert.equal(p.ok, true, p.error ?? '')
})
check('③ 用户自己点（byAgent=false）⇒ 不需要 allowAgent', () => {
  assert.equal(PIN.planPinDevDir({ home: HOME, profileDir: PROFILE, dir: join(SRC, 'in-root') }).ok, true)
})

// ── 规划内容（人性化：先告诉人会发生什么）────────────────────────────────
check('规划返回可读的步骤清单与现值（面板直接展示，不用人猜）', () => {
  const p = PIN.planPinDevDir({ home: HOME, profileDir: PROFILE, dir: join(SRC, 'in-root') })
  assert.equal(p.ok, true)
  assert.equal(p.packageName, '@dev/in-root')
  assert.ok(p.spec.startsWith('link:'))
  assert.equal(p.current, null, '还没钉过 ⇒ 现值为 null')
  assert.ok(Array.isArray(p.steps) && p.steps.length >= 3, JSON.stringify(p.steps))
})

// ── 拒绝非法目标 ──────────────────────────────────────────────────────────
check('非插件目录（没有 dsh 标记）⇒ 拒，且说清原因', () => {
  const p = PIN.planPinDevDir({ home: HOME, profileDir: PROFILE, dir: join(SRC, 'plain-lib') })
  assert.equal(p.ok, false)
  assert.ok(String(p.error).includes('dsh.bundle'), p.error)
})
check('根外目录 ⇒ 拒（先注册根才行）', () => {
  const p = PIN.planPinDevDir({ home: HOME, profileDir: PROFILE, dir: join(OUTSIDE, 'not-registered') })
  assert.equal(p.ok, false)
  assert.equal(p.status, 403)
})

// ── 真写（注入假执行器，零真实 pnpm）──────────────────────────────────────
const readManifest = () => JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))

await checkAsync('★ 写入成功：清单变成 link: 形式，并记录 backup', async () => {
  const r = await PIN.applyPinDevDir({
    home: HOME, profileDir: PROFILE, dir: join(SRC, 'in-root'),
    runInstall: async () => ({ ok: true, note: 'stub: lock 已对齐' }),
    ensureSufficiency: async () => ({ ok: true, ready: true, created: [] }),
  })
  assert.equal(r.ok, true, r.error ?? '')
  assert.equal(r.changed, true)
  assert.ok(String(readManifest().dependencies['@dev/in-root']).startsWith('link:'))
  assert.ok(typeof r.backup === 'string')
})

await checkAsync('★ pnpm 失败 ⇒ **清单必须回滚**，且如实报错（绝不留半截、绝不谎报钉住了）', async () => {
  const before = JSON.stringify(readManifest())
  const r = await PIN.applyPinDevDir({
    home: HOME, profileDir: PROFILE, dir: join(SRC, 'in-root'),
    runInstall: async () => ({ ok: false, stderr: 'ERR_PNPM_FAKE 模拟失败' }),
  })
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('模拟失败'), r.error)
  assert.equal(JSON.stringify(readManifest()), before, '清单必须回到改动前')
})

rmSync(ROOT, { recursive: true, force: true })
console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
