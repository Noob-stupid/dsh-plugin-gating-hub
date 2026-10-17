// bundle 级否决的**离线**判据测试（0.5.53 加法）。
//
// 真机背景（2026-10-15，用户原话「为啥有的插件我本身是有的，但是没显示呢，比如 opviking 的 memory 插件」）：
//   `dsh-app-boot#loadProfileDirectory` 在装载 bundle 时检查**该 bundle 自身**的 dsh peers，
//   不满足就 throw ⇒ 整个 bundle 层进 skippedBundles ⇒ 它要插的行根本不存在 ⇒ 面板无从显示。
//   本模块复算同一判据，把它变成"可见"。
//
// 本套钉死的判据（每条都要能失败）：
//   ① 内置 bundle（从**安装锚点**解析到、peers 满足）⇒ 不报（正控：别把在跑的东西报成被跳过）
//   ② 第三方旧 bundle（peers 只允许 0.1.x，框架 0.2.1-rc.2）⇒ 报，kind='peers'，原因写清"需要什么/当前什么"
//   ③ 没有 dsh.bundle 声明 ⇒ 报，但 kind='no-bundle'（**与 peers 分开**：两种原因出路完全不同）
//   ④ 解析不到包体 ⇒ 报，kind='missing'
//   ⑤ **豁免优先**：compatibility.json 里授了当前框架版本 ⇒ 不报（负控：豁免必须真的生效）
//   ⑥ **解析顺序**必须是"安装锚点优先、profile 兜底"（框架注释：内置 bundle 永远来自运行中的安装）
//      —— 用"同一个包名在两处都有、版本不同"的夹具把顺序钉出来
//   ⑦ **可靠性闸**：拿不到安装锚点（普通 Node 读不进 asar 的真实场景）⇒ reliable=false 且 items 为空，
//      绝不制造假警报（真机试算过一次：普通 Node 下会把 dsh-web-app 误报成被跳过）
//
// 全离线：私有夹具目录（tests/.testdir/，已 gitignore），不联网、不动真实 profile。
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '.testdir', 'bundle-veto')
rmSync(ROOT, { recursive: true, force: true })

const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// ── 夹具：安装锚点（模拟运行中的 dsh 安装）与 profile ────────────────────────────
const INSTALL = join(ROOT, 'install')
const PROFILE = join(ROOT, 'profile')
// 安装锚点：@deepseek-ai/dsh 的 package.json（resolveBundleDir 的第一个锚点）
const INSTALL_DSH = join(INSTALL, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
writeJson(INSTALL_DSH, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' })
const BASE_URL = pathToFileURL(join(INSTALL, 'node_modules', '@deepseek-ai', 'dsh', 'index.js')).href

// ① 内置 bundle：装在**安装**里、peers 满足 0.2.1-rc.2
writeJson(join(INSTALL, 'node_modules', '@deepseek-ai', 'inbox-bundle', 'package.json'), {
  name: '@deepseek-ai/inbox-bundle', version: '0.2.1-rc.2',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.1-rc.2' },
})
// ② 第三方旧 bundle：装在 profile 里、peers 只允许 0.1.x
writeJson(join(PROFILE, 'node_modules', '@third', 'old-bundle', 'package.json'), {
  name: '@third/old-bundle', version: '0.5.11',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1' },
})
// ③ 没有 dsh.bundle 声明
writeJson(join(PROFILE, 'node_modules', '@third', 'not-a-bundle', 'package.json'), {
  name: '@third/not-a-bundle', version: '1.0.0',
})
// ⑤ 可被豁免的旧 bundle
writeJson(join(PROFILE, 'node_modules', '@third', 'exemptable', 'package.json'), {
  name: '@third/exemptable', version: '0.5.11',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.7-rc.2' },
})
// ⑥ 同名两处：安装里是新的（满足），profile 里是旧的（不满足）——用来钉"安装锚点优先"
writeJson(join(INSTALL, 'node_modules', '@deepseek-ai', 'both-bundle', 'package.json'), {
  name: '@deepseek-ai/both-bundle', version: '0.2.1-rc.2',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.1-rc.2' },
})
writeJson(join(PROFILE, 'node_modules', '@deepseek-ai', 'both-bundle', 'package.json'), {
  name: '@deepseek-ai/both-bundle', version: '0.1.9',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.9' },
})
// profile 清单
writeJson(join(PROFILE, 'package.json'), {
  name: 'profile-fixture', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/inbox-bundle', '@third/old-bundle', '@third/not-a-bundle', '@third/exemptable', '@deepseek-ai/both-bundle', '@third/absent-bundle'] } },
})

const FRAMEWORK = '0.2.1-rc.2'
const { bundleVetoList, readCompatExemptions, resolveBundlePackageJson } = await import('../lib/server/domain/bundle-veto.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const listOf = (over = {}) => bundleVetoList({
  bundleNames: ['@deepseek-ai/inbox-bundle', '@third/old-bundle', '@third/not-a-bundle', '@third/exemptable', '@deepseek-ai/both-bundle', '@third/absent-bundle'],
  profileDir: PROFILE,
  baseUrl: BASE_URL,
  frameworkVersion: FRAMEWORK,
  ...over,
})
const byName = (items) => Object.fromEntries(items.map((x) => [x.packageName, x]))

// ── ⑥ 解析顺序（先钉顺序，后面的断言都依赖它）────────────────────────────────
check('⑥ 解析顺序：同名包在安装与 profile 各有一份时，取**安装**那份（框架 resolveBundleDir 同序）', () => {
  const hit = resolveBundlePackageJson('@deepseek-ai/both-bundle', PROFILE, BASE_URL)
  assert.ok(hit !== null, '应解析到一份')
  assert.ok(hit.replace(/\\/gu, '/').includes('/install/'), `应来自安装锚点，实际 ${hit}`)
})

// ── ① 正控：内置且满足 ⇒ 不报 ───────────────────────────────────────────────
check('① 内置 bundle（peers 满足）⇒ 不出现在被跳过清单里（别把在跑的报成被跳过）', () => {
  const r = listOf()
  assert.equal(r.reliable, true)
  assert.equal(byName(r.items)['@deepseek-ai/inbox-bundle'], undefined)
  assert.equal(byName(r.items)['@deepseek-ai/both-bundle'], undefined, 'both-bundle 取安装那份（满足）⇒ 不该报')
})

// ── ② peers 不满足 ⇒ 报，且原因可读 ─────────────────────────────────────────
check('② 第三方旧 bundle（peers 只允许 0.1.x）⇒ 报 kind=peers，原因写明"需要什么 / 当前什么"', () => {
  const hit = byName(listOf().items)['@third/old-bundle']
  assert.ok(hit, '应被报出')
  assert.equal(hit.kind, 'peers')
  assert.ok(hit.reason.includes('<0.2.0') || hit.reason.includes('0.1'), hit.reason)
  assert.ok(hit.reason.includes(FRAMEWORK), `原因里应带当前框架版本：${hit.reason}`)
  assert.ok(typeof hit.hint === 'string' && hit.hint.includes('compatibility.json'), `出处应指向豁免文件：${hit.hint}`)
})

// ── ③ 没有 dsh.bundle ⇒ 报，但**原因不同** ───────────────────────────────────
check('③ 没有 dsh.bundle 声明 ⇒ 报 kind=no-bundle（与 peers 分开，出路也不同）', () => {
  const hit = byName(listOf().items)['@third/not-a-bundle']
  assert.ok(hit, '应被报出')
  assert.equal(hit.kind, 'no-bundle')
  assert.ok(hit.reason.includes('dsh.bundle'), hit.reason)
  assert.ok(!hit.hint.includes('compatibility.json'), '它不是版本问题，不该指向豁免')
})

// ── ④ 解析不到 ⇒ 报 missing ─────────────────────────────────────────────────
check('④ 解析不到的 bundle ⇒ 报 kind=missing', () => {
  const hit = byName(listOf().items)['@third/absent-bundle']
  assert.ok(hit, '应被报出')
  assert.equal(hit.kind, 'missing')
  assert.equal(hit.path, null)
})

// ── ⑤ 豁免优先（负控：豁免必须真的生效）────────────────────────────────────
check('⑤ 未豁免时：可豁免的旧 bundle 会被报出', () => {
  assert.ok(byName(listOf().items)['@third/exemptable'], '未授豁免前应被报出')
})
check('⑤ 授了当前框架版本的豁免 ⇒ **不再**报（豁免优先，与框架一致）', () => {
  writeJson(join(PROFILE, 'compatibility.json'), { '@third/exemptable@0.5.11': [FRAMEWORK] })
  try {
    const ex = readCompatExemptions(PROFILE)
    assert.deepEqual(ex, { '@third/exemptable@0.5.11': [FRAMEWORK] }, '豁免应能读出来')
    assert.equal(byName(listOf().items)['@third/exemptable'], undefined, '授权后不该再报')
  } finally {
    rmSync(join(PROFILE, 'compatibility.json'), { force: true })
  }
})
check('⑤ 豁免版本对不上（授的是别的框架版本）⇒ 仍然报（负控）', () => {
  writeJson(join(PROFILE, 'compatibility.json'), { '@third/exemptable@0.5.11': ['0.0.0-other'] })
  try {
    assert.ok(byName(listOf().items)['@third/exemptable'], '版本不匹配的豁免不算数')
  } finally {
    rmSync(join(PROFILE, 'compatibility.json'), { force: true })
  }
})
check('⑤ 坏 compatibility.json ⇒ 视为无豁免（与框架同款降级，不抛错）', () => {
  writeFileSync(join(PROFILE, 'compatibility.json'), '{ 坏 JSON', 'utf8')
  try {
    assert.deepEqual(readCompatExemptions(PROFILE), {})
    assert.ok(byName(listOf().items)['@third/exemptable'], '坏文件 ⇒ 无豁免 ⇒ 仍然报出')
  } finally {
    rmSync(join(PROFILE, 'compatibility.json'), { force: true })
  }
})

// ── ⑦ 可靠性闸（真机试算教训）──────────────────────────────────────────────
check('⑦ ★ 拿不到安装锚点（普通 Node 读不进 asar 的真实场景）⇒ reliable=false 且 items 为空，绝不假警报', () => {
  const r = listOf({ baseUrl: pathToFileURL(join(ROOT, 'nowhere', 'index.js')).href })
  assert.equal(r.reliable, false)
  assert.deepEqual(r.items, [])
  assert.ok(typeof r.note === 'string' && r.note.includes('锚点'), r.note)
})
check('⑦ 拿不到框架版本 ⇒ 同样不报（不知道就不说）', () => {
  const r = listOf({ frameworkVersion: '' })
  assert.equal(r.reliable, false)
  assert.deepEqual(r.items, [])
})
check('⑦ 空 bundle 清单 ⇒ reliable=true 且 items 为空（正常空态，不是不可靠）', () => {
  assert.deepEqual(listOf({ bundleNames: [] }), { items: [], reliable: true, note: null })
})

rmSync(ROOT, { recursive: true, force: true })
console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
