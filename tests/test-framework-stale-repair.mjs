// 升级失败后的「改名残留」修复（2026-10-28 真机事故的回归钉子）
//
// 现场：升级在「拉起」阶段失败，清扫步把 10 个框架包改名成 `<name>.stale-<ver>-<ts>`，
// 真名处什么都没有 ⇒ 框架起不来 `Cannot find package '@deepseek-ai/cordis'`，只能手改目录名。
//
// 这里钉的是补偿函数的四条纪律：改回真名、真名已存在就不动、不删任何东西、幂等。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreStaleBackups } from '../lib/server/domain/framework-cleanup.js'
import { repairStaleRenameResidue } from '../lib/server/domain/framework-stale-repair.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) {
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

const makeScope = () => {
  const root = mkdtempSync(join(tmpdir(), 'fw-stale-'))
  const scope = join(root, 'node_modules', '@deepseek-ai')
  mkdirSync(scope, { recursive: true })
  return { root, scope }
}
const pkg = (scope, name) => {
  const dir = join(scope, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
}

// ① 只有 .stale-* 没有真名 ⇒ 改回真名
check('① 只有 .stale-* 时改回真名（真机 10 个包的情形）', () => {
  const { root, scope } = makeScope()
  pkg(scope, 'cordis.stale-4.0.4-1790836784030')
  pkg(scope, 'schemastery.stale-3.18.4-1790836784030')
  const r = restoreStaleBackups({ scopeDir: scope })
  assert.equal(r.ok, true)
  assert.equal(r.restored.length, 2, `应修复 2 个，实际 ${r.restored.length}`)
  assert.equal(existsSync(join(scope, 'cordis', 'package.json')), true, 'cordis 真名没恢复')
  assert.equal(existsSync(join(scope, 'cordis.stale-4.0.4-1790836784030')), false, '旧名还在（应已改名）')
  rmSync(root, { recursive: true, force: true })
})

// ② 真名已存在 ⇒ 一个都不动（宁可不动，也不覆盖可能更新的目录）
check('② 真名已存在时跳过，不覆盖', () => {
  const { root, scope } = makeScope()
  pkg(scope, 'cordis')
  pkg(scope, 'cordis.stale-4.0.4-123')
  const r = restoreStaleBackups({ scopeDir: scope })
  assert.equal(r.restored.length, 0, '不该动任何东西')
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].reason, 'real-name-exists')
  assert.equal(JSON.parse(readFileSync(join(scope, 'cordis', 'package.json'), 'utf8')).version, '1.0.0')
  rmSync(root, { recursive: true, force: true })
})

// ③ 绝不删除：非 .stale-* 的目录原样保留
check('③ 只碰 .stale-*，别的目录一个不动', () => {
  const { root, scope } = makeScope()
  pkg(scope, 'cordis')
  pkg(scope, 'dsh')
  pkg(scope, 'cordis-plugin-loader.stale-1.0.5-1')
  restoreStaleBackups({ scopeDir: scope })
  const names = readdirSync(scope).sort()
  assert.deepEqual(names, ['cordis', 'cordis-plugin-loader', 'dsh'], `目录变了：${names.join(',')}`)
  rmSync(root, { recursive: true, force: true })
})

// ④ 幂等：跑两次，第二次什么都不做
check('④ 幂等：第二次调用零动作', () => {
  const { root, scope } = makeScope()
  pkg(scope, 'cordis.stale-4.0.4-1')
  const first = restoreStaleBackups({ scopeDir: scope })
  const second = restoreStaleBackups({ scopeDir: scope })
  assert.equal(first.restored.length, 1)
  assert.equal(second.restored.length, 0, '第二次不该再改')
  assert.equal(second.failed.length, 0)
  rmSync(root, { recursive: true, force: true })
})

// ⑤ 助手层：给出人类可读步骤；目录不存在也不炸
check('⑤ repairStaleRenameResidue 返回可读步骤；scope 不存在也不抛', () => {
  const { root, scope } = makeScope()
  pkg(scope, 'cosmokit.stale-1.8.5-1')
  const r = repairStaleRenameResidue({ fwRoot: join(root, 'node_modules') })
  assert.equal(r.restored.length, 1)
  assert.equal(r.steps.length, 1, `应有一条步骤，实际 ${JSON.stringify(r.steps)}`)
  assert.ok(r.steps[0].includes('cosmokit'), `步骤里没提到包名：${r.steps[0]}`)
  const none = repairStaleRenameResidue({ fwRoot: join(root, '不存在') })
  assert.deepEqual(none.steps, [], '目录不存在时不应产生步骤')
  rmSync(root, { recursive: true, force: true })
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
