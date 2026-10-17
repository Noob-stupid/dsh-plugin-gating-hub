// 兼容豁免写入的**离线**判据测试（0.5.56 加法）。
//
// 为什么需要：0.5.53 让"被框架跳过的 bundle"可见，提示里写了三条出路（更新 / 授精确版本豁免 / 删掉），
//   但控制台只会**读** compatibility.json、从不写 —— 那句提示等于把活推回用户。
//   本模块补上写入；写错格式框架会**静默忽略**，所以必须把"写了要真的生效"钉死。
//
// 本套钉死的判据（每条都要能失败）：
//   ① 授权后**框架读得出来**（用 bundle-veto 的 readCompatExemptions 回读，而不是只看自己写的字节）
//   ② 幂等：已授权再授不重复写、changed=false
//   ③ 撤销：只去掉当前框架版本；同一包对别的框架版本的授权**必须保留**
//   ④ 精确版本校验：范围/前缀/空 ⇒ 拒绝（框架只认精确版本，写范围等于写了一条会被忽略的记录）
//   ⑤ 坏文件 ⇒ **停止**不覆盖（那是用户的文件），并给出 409
//   ⑥ 其它记录原样保留（含用户手写的），键序不变
//   ⑦ 拿不到框架版本 ⇒ 拒绝（不许写"授权了但不知道授权给谁"的记录）
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '.testdir', 'compat-exempt')
rmSync(ROOT, { recursive: true, force: true })

const { planExemption, applyExemption, isExactPackageVersionKey } = await import(`file://${join(HERE, '..', 'lib', 'server', 'domain', 'compat-exempt.js').replace(/\\/gu, '/')}`)
const { readCompatExemptions } = await import(`file://${join(HERE, '..', 'lib', 'server', 'domain', 'bundle-veto.js').replace(/\\/gu, '/')}`)

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const fresh = (name) => { const d = join(ROOT, name); mkdirSync(d, { recursive: true }); return d }
const FW = '0.2.1-rc.2'

// ── ④ 精确版本校验 ─────────────────────────────────────────────────────────
check('④ 非精确版本/畸形键一律拒绝（框架只认精确版本，写范围等于写了条会被忽略的记录）', () => {
  const d = fresh('reject')
  for (const bad of ['^0.5.11', '0.5.x', '', '0.5', null, undefined]) {
    const r = planExemption({ profileDir: d, packageName: '@third/old', version: bad, frameworkVersion: FW })
    assert.equal(r.ok, false, `应拒绝 version=${JSON.stringify(bad)}`)
  }
  assert.equal(isExactPackageVersionKey('@third/old@0.5.11'), true)
  assert.equal(isExactPackageVersionKey('@third/old@^0.5.11'), false)
  assert.equal(isExactPackageVersionKey('nonsense'), false)
})

// ── ⑦ 拿不到框架版本就拒绝 ────────────────────────────────────────────────
check('⑦ 拿不到精确框架版本 ⇒ 拒绝写入', () => {
  const d = fresh('no-fw')
  const r = planExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: null })
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('框架版本'), r.error)
})

// ── ① 授权后框架读得出来 ──────────────────────────────────────────────────
check('① ★ 授权后能**被框架读到**（用 readCompatExemptions 回读，不只看自己写的字节）', () => {
  const d = fresh('grant')
  const r = applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW })
  assert.equal(r.ok, true, r.error ?? '')
  assert.equal(r.changed, true)
  const back = readCompatExemptions(d)
  assert.deepEqual(back['@third/old@0.5.11'], [FW], JSON.stringify(back))
  assert.ok(r.backup === null || typeof r.backup === 'string')
})

// ── ② 幂等 ────────────────────────────────────────────────────────────────
check('② 已授权再授 ⇒ changed=false（不重复写、不制造假变更）', () => {
  const d = fresh('idem')
  applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW })
  const again = applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW })
  assert.equal(again.ok, true)
  assert.equal(again.changed, false)
  assert.deepEqual(readCompatExemptions(d)['@third/old@0.5.11'], [FW])
})

// ── ③ 撤销只去掉当前版本 ──────────────────────────────────────────────────
check('③ ★ 撤销只去掉**当前框架版本**，同一包对别的版本的授权必须保留', () => {
  const d = fresh('revoke')
  applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW })
  applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: '0.2.0-rc.2' })
  assert.deepEqual(readCompatExemptions(d)['@third/old@0.5.11'], [FW, '0.2.0-rc.2'])
  const rev = applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW, mode: 'revoke' })
  assert.equal(rev.ok, true, rev.error ?? '')
  assert.deepEqual(readCompatExemptions(d)['@third/old@0.5.11'], ['0.2.0-rc.2'], '别的版本授权应保留')
})
check('③ 撤到空 ⇒ 键被删除（不留空数组这类脏数据）', () => {
  const d = fresh('revoke-empty')
  applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW })
  applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW, mode: 'revoke' })
  assert.equal('@third/old@0.5.11' in readCompatExemptions(d), false)
})

// ── ⑤ 坏文件不覆盖 ────────────────────────────────────────────────────────
check('⑤ ★ 已有文件不是合法对象 ⇒ 409 停止，**不覆盖**用户的文件', () => {
  const d = fresh('bad-file')
  writeFileSync(join(d, 'compatibility.json'), '[1,2,3]', 'utf8')
  const r = applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW })
  assert.equal(r.ok, false)
  assert.equal(r.status, 409)
  assert.equal(readFileSync(join(d, 'compatibility.json'), 'utf8'), '[1,2,3]', '文件必须原封不动')
})

// ── ⑥ 其它记录保留 ────────────────────────────────────────────────────────
check('⑥ 用户手写的其它记录原样保留（键序也不动）', () => {
  const d = fresh('preserve')
  const original = { '@user/hand@1.0.0': ['0.1.0'], '@other/pkg@2.0.0': ['0.2.1-rc.2', '0.2.0-rc.2'] }
  writeFileSync(join(d, 'compatibility.json'), JSON.stringify(original, null, 2), 'utf8')
  applyExemption({ profileDir: d, packageName: '@third/old', version: '0.5.11', frameworkVersion: FW })
  const back = readCompatExemptions(d)
  assert.deepEqual(back['@user/hand@1.0.0'], ['0.1.0'])
  assert.deepEqual(back['@other/pkg@2.0.0'], ['0.2.1-rc.2', '0.2.0-rc.2'])
  assert.deepEqual(back['@third/old@0.5.11'], [FW])
  assert.deepEqual(Object.keys(back), Object.keys(original).concat(['@third/old@0.5.11']), '新键应追加在最后')
})

rmSync(ROOT, { recursive: true, force: true })
console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
