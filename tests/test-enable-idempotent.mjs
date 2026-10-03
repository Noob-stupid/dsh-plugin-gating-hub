// 启用幂等护栏（复现 2026-10-03 用户实测事故）
//   ① 先用【官方插件管理】启用插件 → 包被写进 profile 的 dsh.profile.bundles，
//      bundle 自带的 cordis.patch.yml 会在启动时自动装配它自己的行；
//   ② 再在我们的面板点「启用」→ 旧代码**又追加一条 insert 行** → 同一插件被装配两次
//      → 第二行重复注册抛错 → 面板显示「已启用 + 挂载失败」。
// 断言 appendInsert 在三种情况下**不写盘**并回报原因，且正常情况仍照常写入（不许为了幂等阉掉功能）：
//   bundle        同包名已在 dsh.profile.bundles 里（bundle 会自动装配）
//   same-package  同包名已由**别的** insert 行声明（重复装配）
//   same-id       同 id 已在 insert 里
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendInsert } from '../lib/server/domain/patch.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const BASE = join(ROOT, '.testdir', 'enable-idempotent')
await rm(BASE, { recursive: true, force: true })

let passed = 0
const ok = (cond, label) => { assert.ok(cond, label); passed += 1; console.log(`PASS ${label}`) }

const PKG = '@openviking/dsh-memory-plugin'
const ROW = 'openviking-dsh-memory-plugin'

/** 建临时 profile：package.json（可带 bundles）+ cordis.patch.yml（给定内容） */
async function makeProfile(name, { bundles = [], patch = '' } = {}) {
  const dir = join(BASE, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test-profile', version: '1.0.0', dsh: { profile: { bundles } } }, null, 2),
    'utf8',
  )
  await writeFile(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  return { patchPath: join(dir, 'cordis.patch.yml') }
}

// ── ① bundle 已声明（用户先用官方启用那条路）→ 不写、注明原因 ────────────────────
{
  const { patchPath } = await makeProfile('bundle-declared', { bundles: [PKG], patch: '# 空补丁\n' })
  const before = await readFile(patchPath, 'utf8')
  const r = await appendInsert(patchPath, ROW, PKG)
  const after = await readFile(patchPath, 'utf8')
  ok(r.changed === false, '① bundle 已声明 → changed=false（不再重复声明）')
  ok(r.reason === 'bundle', '① 原因标记 bundle（面板可如实说明来源）')
  ok(after === before, '① 补丁文件逐字节未变')
}

// ── ② 同包名已由别的 insert 行声明（重复装配）→ 不写 ─────────────────────────────
{
  const patch = `- insert:\n    - id: other-row-id\n      name: '${PKG}'\n`
  const { patchPath } = await makeProfile('same-package', { patch })
  const before = await readFile(patchPath, 'utf8')
  const r = await appendInsert(patchPath, ROW, PKG)
  ok(r.changed === false, '② 同包名已由别行声明 → changed=false（避免同一插件装配两次）')
  ok(r.reason === 'same-package', '② 原因标记 same-package')
  ok((await readFile(patchPath, 'utf8')) === before, '② 补丁文件逐字节未变')
}

// ── ③ 同 id 已插入 → 不写（原有行为，保持不回归）────────────────────────────────
{
  const patch = `- insert:\n    - id: ${ROW}\n      name: '${PKG}'\n`
  const { patchPath } = await makeProfile('same-id', { patch })
  const before = await readFile(patchPath, 'utf8')
  const r = await appendInsert(patchPath, ROW, PKG)
  ok(r.changed === false, '③ 同 id 已在 insert 里 → changed=false')
  ok(r.reason === 'same-id', '③ 原因标记 same-id')
  ok((await readFile(patchPath, 'utf8')) === before, '③ 补丁文件逐字节未变')
}

// ── ④ 正常情况（既无 bundle 声明、也无同包行）→ 照常写入；再调一次 → 幂等 ────────
{
  const { patchPath } = await makeProfile('normal', { patch: '# 空补丁\n' })
  const r1 = await appendInsert(patchPath, ROW, PKG)
  ok(r1.changed === true, '④ 无任何既有声明 → changed=true（功能没被阉掉）')
  const text = await readFile(patchPath, 'utf8')
  ok(text.includes(`- id: ${ROW}`) && text.includes(`name: '${PKG}'`), '④ 行已写入且 id/name 正确')
  const r2 = await appendInsert(patchPath, ROW, PKG)
  ok(r2.changed === false && r2.reason === 'same-id', '④ 再调一次 → 幂等不再写')
}

// ── ⑤ 读不到 package.json（清单缺失）不许阻断既有行为 ───────────────────────────
{
  const dir = join(BASE, 'no-manifest')
  await mkdir(dir, { recursive: true })
  const patchPath = join(dir, 'cordis.patch.yml')
  await writeFile(patchPath, '# 空补丁\n', 'utf8')
  const r = await appendInsert(patchPath, ROW, PKG)
  ok(r.changed === true, '⑤ 清单缺失 → 仍按既有行为写入（不因读清单失败而阻断）')
}

await rm(BASE, { recursive: true, force: true })
console.log(`\n═══ 启用幂等护栏：${passed} 通过 / 0 失败 ═══`)
