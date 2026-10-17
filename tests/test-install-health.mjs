// 安装健康摘要的**离线**判据测试（0.5.55 加法）。
//
// 为什么需要（审计 + 用户 2026-10-15「优化到你能做到的最好」）：
//   面板 176 个按钮、信息散在六处，没有任何地方回答"整体健康吗、我该先处理哪件"。
//   本模块只做**折叠**：把 /state 里已经算好的块折成一行摘要 —— 不读盘、不联网、不新增判据。
//
// 本套钉死的判据（每条都要能失败）：
//   ① 全健康 ⇒ issues=0、items 为空（正控：别把正常说成有问题）
//   ② 被整层跳过的 bundle ⇒ 计为 **blocker**（最严重：它在列表里连位置都没有）
//   ③ reliable=false 的 skippedBundles ⇒ **不计入**（判据不可靠时宁可不报，与 bundle-veto 同一纪律）
//   ④ 被否决的行 / 待适配 / 补丁不确定 ⇒ 各自计数，严重度分 blocker 与 warn
//   ⑤ 混合场景 ⇒ issues = **类数**（不是条目总数），且每项的 count 是该项条目数
//   ⑥ 输入缺失/畸形 ⇒ 不抛、不虚报（空态）
import { strict as assert } from 'node:assert'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { buildInstallHealth, SEVERITY } = await import(`file://${join(HERE, '..', 'lib', 'server', 'domain', 'install-health.js').replace(/\\/gu, '/')}`)

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const kinds = (r) => r.items.map((x) => x.kind)
const itemOf = (r, kind) => r.items.find((x) => x.kind === kind)

// ── ① 全健康 ───────────────────────────────────────────────────────────────
check('① 什么都没问题 ⇒ issues=0、items 为空（正控）', () => {
  const r = buildInstallHealth({ entries: [{ veto: null }, { veto: null }], skippedBundles: { items: [], reliable: true }, pendingCompat: [] })
  assert.equal(r.issues, 0)
  assert.deepEqual(r.items, [])
})

// ── ② 被跳过的 bundle 是 blocker ──────────────────────────────────────────
check('② 被框架整层跳过的 bundle ⇒ blocker（列表里连位置都没有，最严重）', () => {
  const r = buildInstallHealth({ entries: [], skippedBundles: { reliable: true, items: [{ packageName: 'a' }, { packageName: 'b' }] } })
  const it = itemOf(r, 'skipped-bundle')
  assert.ok(it, JSON.stringify(r.items))
  assert.equal(it.severity, SEVERITY.blocker)
  assert.equal(it.count, 2)
})

// ── ③ 不可靠的判据不计入 ──────────────────────────────────────────────────
check('③ ★ skippedBundles.reliable=false ⇒ 不计入（不可靠宁可不报，与 bundle-veto 同纪律）', () => {
  const r = buildInstallHealth({ entries: [], skippedBundles: { reliable: false, items: [{ packageName: 'x' }] } })
  assert.equal(itemOf(r, 'skipped-bundle'), undefined)
  assert.equal(r.issues, 0)
})

// ── ④ 各来源分别计数 + 严重度 ─────────────────────────────────────────────
check('④ 被否决行 / 待适配 / 补丁不确定 各自成项，严重度分 blocker 与 warn', () => {
  const r = buildInstallHealth({
    entries: [{ veto: { kind: 'peers' } }, { veto: null }, { veto: { kind: 'missing' } }],
    skippedBundles: { reliable: true, items: [] },
    pendingCompat: [{ rowId: 'x' }],
    patchUncertain: ['a', 'b', 'c'],
  })
  assert.equal(itemOf(r, 'vetoed').count, 2)
  assert.equal(itemOf(r, 'vetoed').severity, SEVERITY.blocker)
  assert.equal(itemOf(r, 'pending-compat').count, 1)
  assert.equal(itemOf(r, 'pending-compat').severity, SEVERITY.warn)
  assert.equal(itemOf(r, 'patch-uncertain').count, 3)
})

// ── ⑤ issues 是"类数"不是"条目总数" ─────────────────────────────────────
check('⑤ ★ issues = 类数（不是条目总数），每项 count 才是条目数', () => {
  const r = buildInstallHealth({
    entries: [{ veto: {} }, { veto: {} }],
    skippedBundles: { reliable: true, items: [{ packageName: 'a' }] },
    pendingCompat: [{}, {}, {}],
  })
  assert.equal(r.issues, 3, `期望 3 类，实际 ${r.issues}（${kinds(r).join(',')}）`)
  assert.equal(r.items.reduce((n, x) => n + x.count, 0), 6, '条目总数应是 6')
})

// ── ⑥ 畸形输入 ───────────────────────────────────────────────────────────
check('⑥ 输入缺失/畸形 ⇒ 不抛、空态（体检不能自己崩）', () => {
  for (const input of [undefined, null, {}, { entries: null, skippedBundles: null, pendingCompat: null }, { entries: 'nope', skippedBundles: 42 }]) {
    const r = buildInstallHealth(input)
    assert.equal(r.issues, 0, JSON.stringify(input))
    assert.deepEqual(r.items, [])
  }
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
