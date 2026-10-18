// link 面板的**定点补齐**（repairLinkTarget）离线判据（0.5.87 加法）
//
// 用户 2026-10-18 要求：行内动作「缺依赖 → [补齐依赖]」「缺 peer/垫片 → [造垫片]」——
//   两个按钮必须**各做各的事**：点 [造垫片] 不许顺手跑一次 pnpm install（那是用户没要求的写盘），
//   点 [补齐依赖] 也不许顺手建垫片。本套就是钉这条分工，外加：
//   ① 幂等：没缺的就零写盘，并如实说"没有缺的"（不谎报做过）
//   ② 目标目录不在 / 不是插件 ⇒ 如实报，一个字节都不写
//   ③ 装依赖失败**不抛**、也绝不因此报"已就绪"（ok 与 ready 是两件事）
//   ④ 造过的垫片要有记录（卸载据此只清我们造的）
//
// 全离线：私有夹具（tests/.testdir，已 gitignore）+ 注入的假 pnpm。**一次真实 pnpm 都不跑**。
// 垫片用**真的** symlinkSync（与 test-link-self-sufficiency.mjs 同口径：Windows junction / Linux symlink 都不需要提权）。
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '.testdir', 'link-repair')
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, 'home')
const PROFILE = join(ROOT, 'profile')
const FW_ROOT = join(HOME, 'profiles', 'node_modules', '@deepseek-ai')
// 名字故意选"保证不存在"的：tests/.testdir/node_modules 里留着历史夹具残留，
// 用真实包名会意外解析成功 ⇒ 假绿（test-link-inventory.mjs 顶部记过这个坑）。
const PEER_SHIM = '@deepseek-ai/dsh-repair-probe-peer-xyz'
const PEER_NO_SHIM = '@deepseek-ai/dsh-repair-probe-nowhere-abc'
const DEP = 'left-pad-repair-probe'

const writeJson = (file, v) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`, 'utf8') }
const linkSpec = (dir) => `link:${dir.replace(/\\/gu, '/')}`

/** 造一个"链接目标"（插件目录）。 */
function makeTarget(name, { dependencies = {}, peerDependencies = {} } = {}) {
  const dir = join(ROOT, 'dev', name)
  writeJson(join(dir, 'package.json'), { name, version: '0.1.0', dependencies, peerDependencies })
  writeFileSync(join(dir, 'index.js'), 'export const ok = true\n', 'utf8')
  return dir
}

// 框架根里放一份"真的存在"的 peer（垫片只能指向它）；另一个名字故意不存在 ⇒ 造不出垫片
writeJson(join(FW_ROOT, 'dsh-repair-probe-peer-xyz', 'package.json'), { name: PEER_SHIM, version: '9.9.9' })

const A = makeTarget('repair-a', { dependencies: { [DEP]: '^1.0.0' }, peerDependencies: { [PEER_SHIM]: '^1.0.0' } })
const B = makeTarget('repair-b', { peerDependencies: { [PEER_NO_SHIM]: '^1.0.0' } })
const READY = makeTarget('repair-ready')
const GONE = join(ROOT, 'dev', 'repair-gone')   // 不创建：目标不存在
writeJson(join(PROFILE, 'package.json'), {
  name: 'profile-fixture', private: true,
  dependencies: { 'repair-a': linkSpec(A), 'repair-b': linkSpec(B), 'repair-ready': linkSpec(READY), 'repair-gone': linkSpec(GONE) },
})

const { repairLinkTarget } = await import('../lib/server/domain/link-self-sufficiency.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
// 异步断言必须单独一个（同步 check 拿到 Promise 会立刻 PASS = 最坏的假绿）
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

/** 目录快照（相对路径 → 内容/链接目标），用于"零写盘"的正/负控。 */
const snapshot = (dir) => {
  const out = {}
  const walk = (d, rel) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = join(d, e.name)
      const key = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isSymbolicLink()) { try { out[key] = `link:${readlinkSync(abs)}` } catch { out[key] = 'link:?' } continue }
      if (e.isDirectory()) { out[key] = 'dir'; walk(abs, key); continue }
      try { out[key] = readFileSync(abs, 'utf8') } catch { out[key] = '?' }
    }
  }
  walk(dir, '')
  return out
}
const sameSnapshot = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const shimPathOf = (dir, peer) => join(dir, 'node_modules', ...peer.split('/'))

// ── ① [补齐依赖]：只装依赖，绝不建垫片 ──────────────────────────────────────
let pnpmRuns = 0
const fakePnpm = async (args, { execOpts }) => {
  pnpmRuns += 1
  const d = join(execOpts.cwd, 'node_modules', ...DEP.split('/'))
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'package.json'), `${JSON.stringify({ name: DEP, version: '1.0.0' })}\n`, 'utf8')
  return { stdout: 'stub install ok', stderr: '' }
}

await checkAsync('① [补齐依赖] 真的跑了 pnpm（且在**目标目录内**），依赖到位', async () => {
  const r = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-a', kind: 'deps', home: HOME, deps: { runPnpm: fakePnpm } })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'deps')
  assert.equal(pnpmRuns, 1, `pnpm 应只跑 1 次，实际 ${pnpmRuns}`)
  assert.equal(r.installed?.ok, true)
  assert.ok(existsSync(join(A, 'node_modules', ...DEP.split('/'), 'package.json')))
  assert.equal(r.changed, true)
})
await checkAsync('① ★ [补齐依赖] **不**建垫片（缺 peer 是另一条出路，用户没点那件事）', async () => {
  assert.equal(existsSync(shimPathOf(A, PEER_SHIM)), false, '点了「补齐依赖」却顺手建了 peer 垫片')
  const r = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-a', kind: 'deps', home: HOME })
  assert.equal(r.plan.missingDeps.length, 0, '依赖应已补齐')
  assert.equal(r.plan.missingPeers.includes(PEER_SHIM), true, 'peer 仍缺（本步没动它）')
  assert.equal(r.ready, false, '缺 peer 时 ready 必须是 false（不许谎报就绪）')
  assert.equal(r.changed, false)
  assert.ok(String(r.note).includes('没有缺的 dependencies'), String(r.note))
})

// ── ② [造垫片]：只建垫片，绝不跑 pnpm ───────────────────────────────────────
await checkAsync('② ★ [造垫片] **一次 pnpm 都不跑**（只读地建链接）', async () => {
  const runsBefore = pnpmRuns
  const r = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-a', kind: 'shims', home: HOME })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'shims')
  assert.equal(pnpmRuns, runsBefore, '点了「造垫片」却跑了 pnpm install')
  assert.equal(r.created.length, 1)
  assert.equal(r.created[0].name, PEER_SHIM)
  assert.equal(r.ready, true, '依赖齐 + 垫片到位 ⇒ 现在应判自足')
  assert.equal(r.changed, true)
})
await check('② 垫片落在目标目录内、且指向框架根那一份（模块身份共享）', () => {
  const shim = shimPathOf(A, PEER_SHIM)
  assert.ok(existsSync(join(shim, 'package.json')), `${shim} 不可解析`)
  const target = readlinkSync(shim)
  assert.ok(target.includes(join('@deepseek-ai', 'dsh-repair-probe-peer-xyz')), target)
})
await checkAsync('② 造过的垫片有记录（卸载据此只清我们造的）', async () => {
  const file = join(HOME, 'plugin-console', 'link-self-sufficiency', 'repair-a.json')
  assert.ok(existsSync(file), file)
  const rec = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(rec.shims.length, 1)
  assert.equal(rec.shims[0].name, PEER_SHIM)
})

// ── ③ 幂等：没有对象就零写盘 + 如实说 ───────────────────────────────────────
await checkAsync('③ 自足后再点任何一键 ⇒ 零写盘，且不谎报"做过"', async () => {
  const before = snapshot(A)
  const deps = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-a', kind: 'deps', home: HOME })
  const shims = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-a', kind: 'shims', home: HOME })
  const all = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-a', kind: 'all', home: HOME })
  assert.equal(deps.changed, false)
  assert.equal(shims.changed, false)
  assert.equal(all.changed, false)
  assert.ok(String(deps.note).includes('没有缺的 dependencies'), String(deps.note))
  assert.ok(String(shims.note).includes('没有缺的框架 peer'), String(shims.note))
  assert.ok(String(all.note).includes('已自足'), String(all.note))
  assert.ok(sameSnapshot(before, snapshot(A)), '幂等路径必须零写盘')
})
await checkAsync('③ 完全自足的插件 ⇒ kind=all 直接说"已自足"', async () => {
  const r = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-ready', kind: 'all', home: HOME })
  assert.equal(r.ready, true)
  assert.equal(r.changed, false)
  assert.ok(String(r.note).includes('已自足'), String(r.note))
})

// ── ④ 负控：补不了的要如实说，不许假动作 ────────────────────────────────────
await checkAsync('④ ★ 负控：缺的 peer 不在框架根里 ⇒ 说"造不出垫片"，零写盘', async () => {
  const before = snapshot(B)
  const r = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-b', kind: 'shims', home: HOME })
  assert.equal(r.created.length, 0)
  assert.equal(r.changed, false)
  assert.equal(r.ready, false)
  assert.ok(String(r.note).includes('造不出垫片'), String(r.note))
  assert.ok(sameSnapshot(before, snapshot(B)), '不可补的路径必须零写盘')
})
await checkAsync('④ 负控：目标目录不存在 ⇒ 如实报"垫片无从补起"，零写盘', async () => {
  const r = await repairLinkTarget({ profileDir: PROFILE, packageName: 'repair-gone', kind: 'all', home: HOME })
  assert.equal(r.applies, true)
  assert.equal(r.ready, false)
  assert.equal(r.changed, false)
  assert.ok(String(r.note).includes('没有 package.json'), String(r.note))
})
await checkAsync('④ 负控：不是路径型依赖 ⇒ 无需补齐（不动手）', async () => {
  const r = await repairLinkTarget({ profileDir: PROFILE, packageName: 'not-in-manifest', kind: 'all', home: HOME })
  assert.equal(r.applies, false)
  assert.equal(r.changed, false)
  assert.ok(String(r.note).includes('清单里没有该依赖'), String(r.note))
})

// ── ⑤ 装依赖失败：ok 仍是 true（尝试本身没爆炸），但 ready 必须 false ────────
await checkAsync('⑤ ★ 装依赖失败：不抛、不谎报就绪、原因点名进 note', async () => {
  const dir = makeTarget('repair-fail', { dependencies: { [DEP]: '1.0.0' } })
  writeJson(join(ROOT, 'profile2', 'package.json'), { name: 'p2', private: true, dependencies: { 'repair-fail': linkSpec(dir) } })
  const boom = async () => { throw new Error('ERR_PNPM_FETCH_404  Not found') }
  const r = await repairLinkTarget({ profileDir: join(ROOT, 'profile2'), packageName: 'repair-fail', kind: 'deps', home: HOME, deps: { runPnpm: boom } })
  assert.equal(r.ok, true, '失败也要如实返回（不抛）')
  assert.equal(r.ready, false)
  assert.equal(r.changed, false)
  assert.equal(r.installed?.ok, false)
  assert.ok(String(r.note).includes('FETCH_404'), String(r.note).slice(0, 160))
  assert.equal(existsSync(shimPathOf(dir, PEER_SHIM)), false)
})

rmSync(ROOT, { recursive: true, force: true })
console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
