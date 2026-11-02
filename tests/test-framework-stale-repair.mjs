// 升级失败后的「改名残留」修复（2026-10-28 真机事故的回归钉子）
//
// 现场：升级在「拉起」阶段失败，清扫步把 10 个框架包改名成 `<name>.stale-<ver>-<ts>`，
// 真名处什么都没有 ⇒ 框架起不来 `Cannot find package '@deepseek-ai/cordis'`，只能手改目录名。
//
// ★ 0.5.99 改错（真机 2026-11-02）：现场又出现另一种形态 —— **真名目录存在但是空壳**
//   （没有 package.json），内容被改名成 `.stale-*`。旧判据「真名存在就跳过」把它当成已恢复，
//   于是框架一直解析不到包（ERR_MODULE_NOT_FOUND）。现在：
//     可用 = 目录里有 package.json；空壳 ≡ 缺失；候选包名必须与真名一致；
//     空壳挪成 `<real>.empty-<ts>`（挪开不删）；恢复后读回核实；三类结果分开报告。
//
// 这里钉的是六条纪律：改回真名（含空壳）/ 真名可用就不动 / 包名不符不动 / 读回核实 /
// 不删任何东西 / 幂等；外加判据函数的单测。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreStaleBackups } from '../lib/server/domain/framework-cleanup.js'
import { repairStaleRenameResidue } from '../lib/server/domain/framework-stale-repair.js'
import { expectedPackageName, isUsablePackageDir, pickRestoreCandidate, staleRealNameOf } from '../lib/server/domain/framework-stale-restore.js'

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
/** 目录名 → 真名（`cordis.stale-4.0.4-123` → `cordis`）。 */
const realOf = (dirName) => String(dirName).replace(/\.(stale|empty)-.*$/u, '')
/** 造一个**真实形态**的包目录：package.json 里的 name 是 `@deepseek-ai/<真名>`（真机被改名后内容不变）。 */
const pkg = (scope, dirName, over = {}) => {
  const dir = join(scope, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${realOf(dirName)}`, version: '1.0.0', ...over }), 'utf8')
  return dir
}
/** 造一个**空壳**：目录在、里面有别的东西，但**没有 package.json**（真机 2026-11-02 的形态）。 */
const emptyShell = (scope, real) => {
  const dir = join(scope, real)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'note.txt'), 'shell without package.json', 'utf8')
  return dir
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

// ② 真名已存在（且可用）⇒ 一个都不动（宁可不动，也不覆盖可能更新的目录）
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
  assert.deepEqual(none.steps, [], '目录不存在时不应返回步骤')
  rmSync(root, { recursive: true, force: true })
})

// ═══ 0.5.99 新增：空壳（真名在、package.json 没了）这一整类 ═══════════════════════════════

check('⑥ 空壳 + 有可用候选 ⇒ 恢复成功，空壳挪成 <real>.empty-*（不删、可回溯）', () => {
  const { root, scope } = makeScope()
  emptyShell(scope, 'cordis')
  pkg(scope, 'cordis.stale-4.0.4-1793185607671')
  const r = restoreStaleBackups({ scopeDir: scope, stamp: 1793185608000 })
  assert.equal(r.ok, true, `应当成功：${JSON.stringify(r.failed)}`)
  assert.equal(r.restored.length, 1, `应恢复 1 个，实际 ${r.restored.length}`)
  assert.equal(r.restored[0].to, 'cordis')
  assert.equal(existsSync(join(scope, 'cordis', 'package.json')), true, '★ 真名里必须真的有 package.json')
  const names = readdirSync(scope).sort()
  assert.ok(names.includes('cordis.empty-1793185608000'), `★ 空壳应被挪成 cordis.empty-<ts>（挪开不删）：${names.join(',')}`)
  assert.equal(existsSync(join(scope, 'cordis.empty-1793185608000', 'note.txt')), true, '空壳里的东西不许丢')
  assert.equal(names.includes('cordis.stale-4.0.4-1793185607671'), false, '候选应已改名（旧名不该还在）')
  assert.equal(r.emptied.length, 1, 'emptied 要如实报出来')
  rmSync(root, { recursive: true, force: true })
})

check('⑦ 空壳 + 没有候选 ⇒ noCandidate，目录一个字都不动', () => {
  const { root, scope } = makeScope()
  emptyShell(scope, 'cordis')
  const before = readdirSync(scope).sort()
  const r = restoreStaleBackups({ scopeDir: scope })
  assert.equal(r.restored.length, 0)
  assert.equal(r.failed.length, 0, `不该有失败：${JSON.stringify(r.failed)}`)
  assert.equal(r.noCandidate.length, 1, `应报 1 条 noCandidate，实际 ${JSON.stringify(r.noCandidate)}`)
  assert.equal(r.noCandidate[0].real, 'cordis')
  assert.equal(r.noCandidate[0].reason, 'no-usable-stale')
  assert.deepEqual(readdirSync(scope).sort(), before, '★ 目录一字不动')
  // 候选存在但**没有 package.json** ⇒ 同样算 noCandidate（不可作为候选），不动
  const { root: root2, scope: scope2 } = makeScope()
  emptyShell(scope2, 'schemastery')
  mkdirSync(join(scope2, 'schemastery.stale-3.18.4-1'), { recursive: true })
  const r2 = restoreStaleBackups({ scopeDir: scope2 })
  assert.equal(r2.noCandidate.length, 1, `候选不可用也应报 noCandidate：${JSON.stringify(r2)}`)
  assert.equal(r2.restored.length, 0)
  assert.equal(existsSync(join(scope2, 'schemastery.stale-3.18.4-1')), true, '不可用的候选不许被挪动')
  rmSync(root, { recursive: true, force: true })
  rmSync(root2, { recursive: true, force: true })
})

check('⑧ 候选的 package.json.name 与真名不符 ⇒ failed（name-mismatch），一个都不动', () => {
  const { root, scope } = makeScope()
  emptyShell(scope, 'cordis')
  pkg(scope, 'cordis.stale-4.0.4-1', { name: '@deepseek-ai/schemastery' }) // 张冠李戴
  const before = readdirSync(scope).sort()
  const r = restoreStaleBackups({ scopeDir: scope })
  assert.equal(r.restored.length, 0, '★ 名字不符绝不许恢复')
  assert.equal(r.failed.length, 1, `应记 1 条失败：${JSON.stringify(r.failed)}`)
  assert.equal(r.failed[0].reason, 'name-mismatch')
  assert.deepEqual(readdirSync(scope).sort(), before, '★ 目录一字不动')
  assert.equal(existsSync(join(scope, 'cordis', 'package.json')), false, '不该凭空造出 package.json')
  rmSync(root, { recursive: true, force: true })
})

check('⑨ 恢复后读回仍没有 package.json（注入 rename 空转）⇒ failed 且如实报，不谎报成功', () => {
  const { root, scope } = makeScope()
  emptyShell(scope, 'cordis')
  pkg(scope, 'cordis.stale-4.0.4-1')
  const before = readdirSync(scope).sort()
  // 第一次 rename（挪空壳）生效，之后全部空转 —— 模拟"改名调用成功但其实没落盘"
  let calls = 0
  const r = restoreStaleBackups({
    scopeDir: scope,
    stamp: 55,
    deps: {
      rename: (a, b) => {
        calls += 1
        if (calls === 1) renameSync(a, b)
      },
    },
  })
  assert.equal(r.restored.length, 0, '★ 读回没有 package.json 就绝不能算恢复成功')
  assert.equal(r.failed.length, 1, `应记 1 条失败：${JSON.stringify(r.failed)}`)
  assert.equal(r.failed[0].reason, 'verify-failed')
  assert.ok(String(r.failed[0].error).includes('读回核实不通过'), `失败原因要说清是读回核实不过：${r.failed[0].error}`)
  assert.ok(String(r.failed[0].error).includes('回滚'), `失败原因要说清回滚情况：${r.failed[0].error}`)
  assert.equal(existsSync(join(scope, 'cordis.stale-4.0.4-1')), true, '候选必须还在（不许丢）')
  assert.ok(readdirSync(scope).length >= before.length, `目录数不该变少：before=${before.join(',')} after=${readdirSync(scope).join(',')}`)
  rmSync(root, { recursive: true, force: true })
})

check('⑩ 真名完好（有 package.json）⇒ 跳过，零动作（旁边有 .stale-* 也不动）', () => {
  const { root, scope } = makeScope()
  pkg(scope, 'cordis')
  pkg(scope, 'cordis.stale-4.0.4-1')
  pkg(scope, 'cordis.stale-4.0.3-2')
  const before = readdirSync(scope).sort()
  const r = restoreStaleBackups({ scopeDir: scope })
  assert.equal(r.restored.length, 0)
  assert.equal(r.failed.length, 0)
  assert.equal(r.noCandidate.length, 0, '健康行不该被报成 noCandidate')
  assert.equal(r.skipped.length, 1, '应记 1 条 skip')
  assert.deepEqual(readdirSync(scope).sort(), before, '★ 目录一字不动')
  assert.equal(JSON.parse(readFileSync(join(scope, 'cordis', 'package.json'), 'utf8')).name, '@deepseek-ai/cordis')
  rmSync(root, { recursive: true, force: true })
})

check('⑪ 幂等（空壳场景）：跑两次，第二次零动作、零失败', () => {
  const { root, scope } = makeScope()
  emptyShell(scope, 'cordis')
  pkg(scope, 'cordis.stale-4.0.4-1')
  const first = restoreStaleBackups({ scopeDir: scope, stamp: 7 })
  const second = restoreStaleBackups({ scopeDir: scope })
  assert.equal(first.restored.length, 1)
  assert.equal(second.restored.length, 0, '★ 第二次不该再改')
  assert.equal(second.failed.length, 0)
  assert.equal(second.noCandidate.length, 0, '恢复后的真名可用，不该报 noCandidate')
  assert.equal(existsSync(join(scope, 'cordis', 'package.json')), true)
  rmSync(root, { recursive: true, force: true })
})

check('⑫ 助手层把三类结果都带出来（升级日志里能看见 noCandidate）', () => {
  const { root, scope } = makeScope()
  emptyShell(scope, 'cordis')
  pkg(scope, 'cordis.stale-4.0.4-1')
  emptyShell(scope, 'schemastery') // 真缺内容，无候选
  pkg(scope, 'cosmokit.stale-1.8.5-1', { name: '@deepseek-ai/other' }) // 名字不符
  const r = repairStaleRenameResidue({ fwRoot: join(root, 'node_modules') })
  assert.equal(r.restored.length, 1, `restored=${JSON.stringify(r.restored)}`)
  assert.equal(r.noCandidate.length, 1, `noCandidate=${JSON.stringify(r.noCandidate)}`)
  assert.equal(r.failed.length, 1, `failed=${JSON.stringify(r.failed)}`)
  assert.equal(r.emptied.length, 1, 'emptied 要带出来')
  const text = r.steps.join(' | ')
  assert.ok(text.includes('已改回真名'), `步骤里要说恢复：${text}`)
  assert.ok(text.includes('空壳'), `步骤里要提空壳被挪开：${text}`)
  assert.ok(text.includes('schemastery'), `步骤里要点名真缺内容的包：${text}`)
  assert.ok(text.includes('未全部成功'), `步骤里要说失败：${text}`)
  rmSync(root, { recursive: true, force: true })
})

check('⑬ 判据单测：可用=有 package.json / 真名解析 / 包名期望值 / 多候选取最新', () => {
  const { root, scope } = makeScope()
  pkg(scope, 'cordis')
  emptyShell(scope, 'schemastery')
  assert.equal(isUsablePackageDir(join(scope, 'cordis')), true)
  assert.equal(isUsablePackageDir(join(scope, 'schemastery')), false, '空壳必须判成不可用')
  assert.equal(isUsablePackageDir(join(scope, 'not-there')), false)
  assert.equal(staleRealNameOf('cordis.stale-4.0.4-1'), 'cordis')
  assert.equal(staleRealNameOf('dsh-experimental-inspector.stale-0.2.1-rc.2-1793185607671'), 'dsh-experimental-inspector')
  assert.equal(staleRealNameOf('cordis'), null)
  assert.equal(expectedPackageName(scope, 'cordis'), '@deepseek-ai/cordis')
  pkg(scope, 'zlib.stale-1.0.0-100')
  pkg(scope, 'zlib.stale-2.0.0-200')
  const pick = pickRestoreCandidate({ scopeDir: scope, real: 'zlib', candidates: ['zlib.stale-1.0.0-100', 'zlib.stale-2.0.0-200'] })
  assert.equal(pick.picked.name, 'zlib.stale-2.0.0-200', '多份候选应取时间戳最新的那份')
  rmSync(root, { recursive: true, force: true })
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
