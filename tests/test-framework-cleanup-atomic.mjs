// 0.5.34 改错 A：框架残留清理必须「改名 + 重建 junction」原子化（**2026-10-01 真机停机事故的根因**）。
//
// 事故现场（证据链完整）：
//   · `D:\node_cache\_npx\<hash>\node_modules\@deepseek-ai\cordis` 被改名成 `cordis.stale-4.0.4-<ts>`，
//     **但没重建 junction** ⇒ 启动包 `dsh-app-boot` 的 `import '@deepseek-ai/cordis'` 解析失败
//     ⇒ web 服务进程退出 code=1，起不来（用户手工补回 10 条 junction 才恢复）。
//   · 改名者是 domain/framework-cleanup.js 的 `name + '.stale-' + version + '-' + ts`；
//     紧接着本应 `link(target, …, 'junction')` —— 但重建链接只在「`dsh` junction 推得出运行树
//     **且** 目标存在」时才做，其余分支"只改名不重建"，且回报里只有一行 JSON（面板不留痕）。
//   · 真机实证：顶层 `@deepseek-ai/dsh` 是**真实目录**而不是 junction ⇒ `runningScopeDir = null`
//     ⇒ 10 条包全部落进"只改名"那一支；用户手工补回的 10 条 junction Target 全部指向
//     `<fwRoot>\.pnpm\node_modules\@deepseek-ai\<name>`（多基准候选的来源）。
//
// 本套把新语义钉死（**全离线**：夹具树 + 注入 IO；**绝不碰真实框架树**）：
//   ① 改名 + 重建成功 → 原位置是 junction、指向候选目标、无回滚、verify.ok
//   ② 重建失败 → **改名被回滚**（原名回来、备份不残留）、报告点名原因、进 failed
//   ③ 整批解析验证失败 → **本轮全部改名回滚**、报告点明（verify.error + rolledBackAll）
//   ④ **绝不删除**任何 `.stale-*` 备份（旧备份逐字节不变；新备份留着）
//   ⑤ **幂等**：同一 stamp 再跑一次 → 零改名、零新建链接、零新备份
//   ⑥ 不改非目标文件：整棵夹具树逐字节比对，只有"改名 + 建链接"这一处差异
//   ⑦ 反向：`relink:false`（旧代码会"只改名"）现在**完全不改**；找不到目标时**连名字都不动**
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const FIX = join(ROOT, '.testdir', 'fw-cleanup-atomic')
const { cleanFrameworkTopLevel, verifyFrameworkTreeResolvable } = await import('../lib/server/domain/framework-cleanup.js')
const { FRAMEWORK_BOOT_PACKAGES, isStaleBackupName, relinkTargetCandidates } = await import('../lib/server/domain/framework-residuals.js')

let passed = 0
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

const RUNNING = '0.2.0-rc.2'
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 造一棵「真机同款」夹具树：treeRoot/node_modules = fwRoot（含 .pnpm），scope 目录在 fwRoot/@deepseek-ai。 */
function makeTree(tag, { storeCordis = true } = {}) {
  const treeRoot = join(FIX, tag)
  rmSync(treeRoot, { recursive: true, force: true })
  const fwRoot = join(treeRoot, 'node_modules')
  const scope = join(fwRoot, '@deepseek-ai')
  const mk = (dir, version) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: dir.split(/[\\/]/u).pop(), version, main: 'index.js' }, null, 2) + '\n', 'utf8')
    writeFileSync(join(dir, 'index.js'), `export const v = '${version}'\n`, 'utf8')
  }
  mkdirSync(scope, { recursive: true })
  // 运行版本包（与 runningVersion 相同 → 判据不动它）：dsh 是**真实目录**（真机形态 ⇒ 推不出运行树）
  mk(join(scope, 'dsh'), RUNNING)
  mk(join(scope, 'dsh-app-boot'), RUNNING) // 启动关键包之一，必须活到最后
  // 待处理残留：cordis（有 store 投影）/ cosmokit（**没有任何可指回的目标**）
  mk(join(scope, 'cordis'), '4.0.4')
  mk(join(scope, 'cosmokit'), '1.8.5')
  // 上一轮留下的备份（幂等：绝不能再被当成残留改名，也绝不能被删）
  mk(join(scope, 'cordis-plugin-loader.stale-1.0.5-1790836784030'), '1.0.5')
  // pnpm store：hoisted 投影 + 实体本体
  mk(join(fwRoot, '.pnpm', '@deepseek-ai+cordis@4.0.4', 'node_modules', '@deepseek-ai', 'cordis'), '4.0.4')
  mkdirSync(join(fwRoot, '.pnpm', 'node_modules', '@deepseek-ai'), { recursive: true })
  if (storeCordis) {
    symlinkSync(join(fwRoot, '.pnpm', '@deepseek-ai+cordis@4.0.4', 'node_modules', '@deepseek-ai', 'cordis'),
      join(fwRoot, '.pnpm', 'node_modules', '@deepseek-ai', 'cordis'), 'junction')
  }
  // 非目标文件（必须逐字节不变）
  writeFileSync(join(treeRoot, 'package.json'), JSON.stringify({ name: 'fw-tree-fixture', private: true }, null, 2) + '\n', 'utf8')
  writeFileSync(join(scope, 'dsh-app-boot', 'index.js'), "export const boot = true\n", 'utf8')
  return { treeRoot, fwRoot, scope, dshLinkPath: join(scope, 'dsh') }
}

/** 整棵树的快照（文件 → sha256；目录 → 'dir'；链接 → 目标字符串），用于逐字节比对。 */
function snapshot(root) {
  const out = new Map()
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      const rel = relative(root, full).split(sep).join('/')
      let st = null
      try { st = lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) { out.set(rel, 'link:' + readlinkSync(full)); continue }
      if (st.isDirectory()) { out.set(rel, 'dir'); walk(full); continue }
      try { out.set(rel, 'sha:' + sha(full)) } catch { out.set(rel, 'unreadable') }
    }
  }
  walk(root)
  return out
}

const listing = (dir) => readdirSync(dir).sort()

console.log('=== 判据自检（纯函数，离线）===')
await check('⓪ 备份名判据 + 多基准候选顺序（真机 10 条手工 junction 的来源）', () => {
  assert.equal(isStaleBackupName('cordis.stale-4.0.4-1790836784030'), true)
  assert.equal(isStaleBackupName('cordis'), false)
  const cands = relinkTargetCandidates({
    runningScopeDir: join('X', 'running', '@deepseek-ai'),
    storeHoistDir: join('X', 'node_modules', '.pnpm', 'node_modules'),
    scopeName: '@deepseek-ai',
    name: 'cordis',
  })
  assert.deepEqual(cands.map((c) => c.via), ['running-scope', 'pnpm-hoist', 'pnpm-hoist-flat'])
  assert.equal(cands[1].path, join('X', 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'cordis'))
  assert.deepEqual(FRAMEWORK_BOOT_PACKAGES, ['cordis', 'dsh-app-boot'])
  assert.deepEqual(relinkTargetCandidates({ name: '' }), [])
})

console.log('\n=== ① 改名 + 重建成功（无回滚；verify 多基准通过）===')
const T1 = makeTree('ok')
const before1 = snapshot(T1.treeRoot)
let rel1 = null
await check('① 真机形态：dsh 是真实目录（推不出运行树）→ 仍用 .pnpm 多基准重建成功', async () => {
  rel1 = await cleanFrameworkTopLevel({ topScopeDir: T1.scope, dshLinkPath: T1.dshLinkPath, runningVersion: RUNNING, relink: true, stamp: 20261001 })
  assert.deepEqual(rel1.renamed.map((x) => x.name), ['cordis'], JSON.stringify(rel1.renamed))
  assert.deepEqual(rel1.relinked.map((x) => [x.name, x.via]), [['cordis', 'pnpm-hoist']])
  assert.equal(rel1.rolledBack.length, 0, '成功路径不该有回滚：' + JSON.stringify(rel1.rolledBack))
  assert.equal(rel1.failed.length, 0, JSON.stringify(rel1.failed))
  assert.equal(rel1.ok, true)
  assert.equal(rel1.verify.ok, true, JSON.stringify(rel1.verify.error))
  assert.deepEqual(rel1.verify.bases.map((b) => b.id), ['framework-top', 'pnpm-store'])
  assert.equal(rel1.verify.checks.length, 4, '两个基准 × 两个关键包')
  assert.ok(rel1.verify.checks.every((c) => c.ok === true), JSON.stringify(rel1.verify.checks))
  // 找不到目标的那条（cosmokit）**连名字都没动**
  assert.deepEqual(rel1.relinkSkipped.map((x) => [x.name, x.reason]), [['cosmokit', 'no-target']])
  assert.ok(rel1.relinkSkipped[0].tried.length >= 2, '要如实列出试过哪些基准：' + JSON.stringify(rel1.relinkSkipped[0].tried))
})
await check('① 落盘：原位置是 junction（指向候选目标）、备份留着、cosmokit 原样', () => {
  const at = join(T1.scope, 'cordis')
  assert.ok(lstatSync(at).isSymbolicLink(), 'cordis 必须是新链接')
  assert.equal(readlinkSync(at), join(T1.fwRoot, '.pnpm', 'node_modules', '@deepseek-ai', 'cordis'))
  assert.equal(JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')).version, '4.0.4', '链接要指向 4.0.4 真身')
  assert.ok(existsSync(join(T1.scope, 'cordis.stale-4.0.4-20261001', 'package.json')), '备份必须留着')
  assert.ok(lstatSync(join(T1.scope, 'cosmokit')).isDirectory() && !lstatSync(join(T1.scope, 'cosmokit')).isSymbolicLink(), 'cosmokit 必须还是原来的真实目录')
  assert.ok(!existsSync(join(T1.scope, 'cosmokit.stale-1.8.5-20261001')), 'cosmokit 连名字都不该动（不留备份）')
})

console.log('\n=== ② 重建失败 → 立刻回滚改名（反向断言）===')
const T2 = makeTree('relink-fail')
await check('② 注入 link 抛错：改名被回滚、报告点名原因、备份不残留', async () => {
  const link = () => { throw new Error('EPERM: operation not permitted, symlink (junction)') }
  const rel = await cleanFrameworkTopLevel({ topScopeDir: T2.scope, dshLinkPath: T2.dshLinkPath, runningVersion: RUNNING, stamp: 20261002, deps: { link } })
  assert.deepEqual(rel.renamed, [], '失败条目不该留在 renamed 里')
  assert.deepEqual(rel.relinked, [])
  assert.deepEqual(rel.rolledBack.map((x) => [x.name, x.reason]), [['cordis', 'relink-failed']])
  assert.equal(rel.failed.length, 1, JSON.stringify(rel.failed))
  assert.equal(rel.failed[0].name, 'cordis')
  assert.match(rel.failed[0].error, /重建链接失败/u)
  assert.match(rel.failed[0].error, /EPERM/u, '必须带可读的底层原因：' + rel.failed[0].error)
  assert.match(rel.failed[0].error, /已把改名回滚/u)
  assert.equal(rel.ok, false)
  assert.match(String(rel.error), /cordis/u)
  // 现场 = 操作前：原名还在（真实目录、4.0.4），备份名不存在
  const at = join(T2.scope, 'cordis')
  assert.ok(existsSync(at) && lstatSync(at).isDirectory() && !lstatSync(at).isSymbolicLink(), 'cordis 必须还是原来的真实目录')
  assert.equal(JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')).version, '4.0.4')
  assert.ok(!existsSync(join(T2.scope, 'cordis.stale-4.0.4-20261002')), '回滚后不该留下备份目录（否则下次会被当成残留）')
  assert.equal(rel.verify.ok, true, '回滚后框架仍可解析：' + JSON.stringify(rel.verify.error))
})

console.log('\n=== ③ 整批解析验证失败 → 全部回滚（反向断言，硬闸本体）===')
const T3 = makeTree('verify-fail')
const before3 = snapshot(T3.treeRoot)
await check('③ 注入解析器报告 cordis 解析不到 → 本轮全部改名回滚、报告点明', async () => {
  const resolveFrom = (baseFile, name) => {
    if (name === '@deepseek-ai/cordis') throw new Error("Cannot find module '@deepseek-ai/cordis'")
    return join(T3.fwRoot, '..', 'node_modules', ...name.split('/'), 'index.js')
  }
  const rel = await cleanFrameworkTopLevel({ topScopeDir: T3.scope, dshLinkPath: T3.dshLinkPath, runningVersion: RUNNING, stamp: 20261003, deps: { resolveFrom } })
  assert.equal(rel.verify.ok, false)
  assert.equal(rel.verify.rolledBackAll, true)
  assert.match(String(rel.verify.error), /框架可解析性验证失败/u)
  assert.match(String(rel.verify.error), /cordis/u)
  assert.match(String(rel.verify.error), /已把本轮全部 1 条改名回滚/u, String(rel.verify.error))
  assert.deepEqual(rel.rolledBack.map((x) => [x.name, x.reason]), [['cordis', 'verify-failed']])
  assert.deepEqual(rel.renamed, [], '回滚后不得再声称改名成功')
  assert.deepEqual(rel.relinked, [])
  assert.equal(rel.ok, false, '验证失败必须 ok:false')
  assert.match(String(rel.error), /框架可解析性验证失败/u)
})
await check('③ 现场恢复到操作前（整棵树逐字节一致，含链接目标）', () => {
  const after = snapshot(T3.treeRoot)
  assert.deepEqual([...after.entries()].sort(), [...before3.entries()].sort(), '验证失败回滚后必须与操作前逐字节一致')
  assert.ok(!existsSync(join(T3.scope, 'cordis.stale-4.0.4-20261003')), '回滚要连备份目录一起撤回')
})

console.log('\n=== ④ 绝不删除 .stale-* 备份 ===')
await check('④ 旧备份逐字节不变（且没被再改名成 .stale-….stale-…）', () => {
  const oldBak = join(T1.scope, 'cordis-plugin-loader.stale-1.0.5-1790836784030')
  assert.ok(existsSync(join(oldBak, 'package.json')), '上一轮的 .stale-* 备份必须还在')
  assert.equal(JSON.parse(readFileSync(join(oldBak, 'package.json'), 'utf8')).version, '1.0.5')
  const names = listing(T1.scope).filter((n) => n.includes('.stale-'))
  assert.deepEqual(names.filter((n) => /\.stale-.*\.stale-/u.test(n)), [], '备份绝不能被二次改名（真机 `cordis.stale-4.0.4-<ts>` 同族缺陷）')
  assert.deepEqual(names.sort(), ['cordis-plugin-loader.stale-1.0.5-1790836784030', 'cordis.stale-4.0.4-20261001'])
})

console.log('\n=== ⑤ 幂等：同一 stamp 再跑一次 → 零改名 / 零新建链接 / 零新备份 ===')
await check('⑤ 第二次运行 = 完全无副作用（真机可反复点）', async () => {
  const before = snapshot(T1.treeRoot)
  const rel = await cleanFrameworkTopLevel({ topScopeDir: T1.scope, dshLinkPath: T1.dshLinkPath, runningVersion: RUNNING, stamp: 20261001 })
  assert.deepEqual(rel.renamed, [], '不允许新改名：' + JSON.stringify(rel.renamed))
  assert.deepEqual(rel.relinked, [], '不允许重复建链接：' + JSON.stringify(rel.relinked))
  assert.deepEqual(rel.rolledBack, [])
  assert.deepEqual(rel.failed, [])
  assert.equal(rel.verify.ok, true)
  assert.deepEqual(rel.relinkSkipped.map((x) => [x.name, x.reason]), [['cosmokit', 'no-target']], 'cordis 已是 junction（判据跳过）、cosmokit 无目标（跳过）')
  const after = snapshot(T1.treeRoot)
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), '幂等：一个字节都不许变')
})

console.log('\n=== ⑥ 不改非目标文件（整棵树逐字节比对）===')
await check('⑥ 与操作前相比只有「cordis 改名 + 建链接」这一处差异', () => {
  const after = snapshot(T1.treeRoot)
  const S = (p) => `node_modules/@deepseek-ai/${p}`
  const added = []
  const removed = []
  const changed = []
  for (const [k, v] of after) {
    if (!before1.has(k)) added.push(k)
    else if (before1.get(k) !== v) changed.push(k)
  }
  for (const [k] of before1) if (!after.has(k)) removed.push(k)
  assert.deepEqual(removed.sort(), [S('cordis/index.js'), S('cordis/package.json')].sort(), '除了被改名的那一份，什么都不该消失')
  const expectedAdded = [
    S('cordis.stale-4.0.4-20261001'),
    S('cordis.stale-4.0.4-20261001/index.js'),
    S('cordis.stale-4.0.4-20261001/package.json'),
  ]
  assert.deepEqual(added.sort(), expectedAdded.sort(), '除了改名产生的备份，什么都不该新增：' + JSON.stringify(added))
  assert.deepEqual(changed.sort(), [S('cordis')], '唯一变化 = 原位置变成 junction（其余文件逐字节不变）')
  assert.equal(after.get(S('cordis')), 'link:' + join(T1.fwRoot, '.pnpm', 'node_modules', '@deepseek-ai', 'cordis'))
})

console.log('\n=== ⑦ 反向：relink:false 与「目标缺失」都不许让名字空缺 ===')
await check('⑦ relink:false（旧代码会只改名）→ 现在完全不改，名字一个不少', async () => {
  const T = makeTree('relink-off')
  const before = snapshot(T.treeRoot)
  const rel = await cleanFrameworkTopLevel({ topScopeDir: T.scope, dshLinkPath: T.dshLinkPath, runningVersion: RUNNING, relink: false, stamp: 20261004 })
  assert.deepEqual(rel.renamed, [])
  assert.deepEqual(rel.rolledBack, [])
  assert.deepEqual(rel.relinkSkipped.map((x) => [x.name, x.reason]), [['cordis', 'relink-off'], ['cosmokit', 'relink-off']])
  assert.match(String(rel.relinkSkipped[0].detail), /改名后无法指回真实包体/u)
  assert.ok(existsSync(join(T.scope, 'cordis', 'package.json')), '名字必须还在（旧行为会只剩 .stale-* 备份）')
  const after = snapshot(T.treeRoot)
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), 'relink:false 一个字节都不许动')
})
await check('⑦ 无 store 投影时：走 pnpm 实体兜底或如实报 no-target —— 名字一个不少、零意外改动', async () => {
  const T = makeTree('no-store', { storeCordis: false })
  const before = snapshot(T.treeRoot)
  const S = (p) => `node_modules/@deepseek-ai/${p}`
  const rel = await cleanFrameworkTopLevel({ topScopeDir: T.scope, dshLinkPath: T.dshLinkPath, runningVersion: RUNNING, stamp: 20261005 })
  assert.deepEqual(rel.failed, [])
  const after = snapshot(T.treeRoot)
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  if (rel.relinked.length > 0) {
    // 实体本体还在 ⇒ 走"pnpm 虚拟 store 实体"兜底也能建（这正是 pnpm 自己的指法）
    assert.equal(rel.relinked[0].via, 'pnpm-store-entity')
    assert.equal(after.get(S('cordis')), 'link:' + join(T.fwRoot, '.pnpm', '@deepseek-ai+cordis@4.0.4', 'node_modules', '@deepseek-ai', 'cordis'))
    assert.deepEqual(added.sort(), [S('cordis.stale-4.0.4-20261005'), S('cordis.stale-4.0.4-20261005/index.js'), S('cordis.stale-4.0.4-20261005/package.json')].sort())
    assert.deepEqual(removed.sort(), [S('cordis/index.js'), S('cordis/package.json')].sort(), '原名一刻都没缺过（只是由目录换成链接）')
  } else {
    assert.equal(rel.relinkSkipped.find((x) => x.name === 'cordis')?.reason, 'no-target')
    assert.ok(existsSync(join(T.scope, 'cordis', 'package.json')), '没目标时必须原样留下')
    assert.deepEqual(added, [], '没目标时一个新文件都不该有')
    assert.deepEqual(removed, [])
  }
  // 无论哪条路：**顶层 `@deepseek-ai/cordis` 这个名字自始至终存在**（事故反例：只剩 .stale-*）
  assert.ok(existsSync(join(T.scope, 'cordis')), 'cordis 这个名字绝不能缺')
  assert.ok(existsSync(join(T.scope, 'cordis', 'package.json')) || lstatSync(join(T.scope, 'cordis')).isSymbolicLink())
})
await check('⑦ 目录整个不存在 → 如实报错（不抛异常、不静默）', async () => {
  const rel = await cleanFrameworkTopLevel({ topScopeDir: join(FIX, '不存在', '@deepseek-ai'), runningVersion: RUNNING })
  assert.equal(rel.ok, false)
  assert.match(String(rel.error), /框架顶层目录不存在/u)
  assert.deepEqual(rel.renamed, [])
  assert.deepEqual(rel.rolledBack, [])
  assert.deepEqual(rel.failed, [])
})

console.log('\n=== ⑧ dryRun：只出 planned，一个字节都不动 ===')
await check('⑧ dryRun 计划 + verify(phase=pre) + 零落盘', async () => {
  const T = makeTree('dryrun')
  const before = snapshot(T.treeRoot)
  const rel = await cleanFrameworkTopLevel({ topScopeDir: T.scope, dshLinkPath: T.dshLinkPath, runningVersion: RUNNING, dryRun: true, stamp: 20261006 })
  assert.deepEqual(rel.planned.map((x) => x.name), ['cordis', 'cosmokit'])
  assert.deepEqual(rel.renamed, [])
  assert.equal(rel.verify.phase, 'pre')
  const after = snapshot(T.treeRoot)
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort())
})

console.log('\n=== ⑨ verify 工具本身（可独立调用；不含本机路径）===')
await check('⑨ 多基准 × 关键包；解析到框架树之外判失败', () => {
  const T = makeTree('verify-tool')
  const v = verifyFrameworkTreeResolvable({ fwRoot: T.fwRoot })
  assert.equal(v.ok, true, JSON.stringify(v.error))
  assert.deepEqual(v.packages, ['@deepseek-ai/cordis', '@deepseek-ai/dsh-app-boot'])
  assert.ok(v.bases.every((b) => b.dir.startsWith(FIX)), '两个基准必须由 fwRoot 推导出来（不得出现硬编码本机路径/用户名）')
  const outside = verifyFrameworkTreeResolvable({ fwRoot: T.fwRoot, deps: { resolveFrom: () => join(FIX, '别处', 'index.js') } })
  assert.equal(outside.ok, false)
  assert.match(String(outside.error), /解析到框架树之外/u)
  const noResolve = verifyFrameworkTreeResolvable({ fwRoot: T.fwRoot, deps: { resolveFrom: () => { throw new Error('MODULE_NOT_FOUND') } } })
  assert.equal(noResolve.ok, false)
  assert.match(String(noResolve.error), /框架可解析性验证失败/u)
})

console.log(`\n${passed} PASS / ${process.exitCode === 1 ? '有失败' : '全绿'}`)
