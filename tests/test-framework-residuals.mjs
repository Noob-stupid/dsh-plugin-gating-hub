// 0.5.30 加法：框架树残留判据 + 备份保留策略（真机背景见 domain/framework-residuals.js 头注释）。
//
// 本套钉死（全离线，纯函数）：
//   ① 顶层分类：junction 不动 / 同版本不动 / 缺版本只单列 / 旧版本进 stale
//   ② 保留策略：**回滚点引用的那条永远保留**；最近 N 条（默认 1）保留；其余才进删除清单
//   ③ 可释放字节按"实际要删的那些"累加（少报比多报安全）
//   ④ keep 非法值 → 回落 1（最小保留，绝不因为参数脏就把备份全删）
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const { classifyTopLevel, planBackupRetention } = await import('../lib/server/domain/framework-residuals.js')

let passed = 0
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

const ENTRIES = [
  { name: 'dsh', version: '0.2.0-rc.1', isLink: true, sizeBytes: 0 },
  { name: 'dsh-base', version: '0.1.5-rc.2', isLink: false, sizeBytes: 10 },
  { name: 'dsh-web-app', version: '0.2.0-rc.1', isLink: false, sizeBytes: 20 },
  { name: 'dsh-unknown', version: null, isLink: false, sizeBytes: 30 },
  { name: 'dsh-tool-web', version: '0.1.5-rc.2', isLink: false, sizeBytes: 40 },
  { name: '.DS_Store', version: 'x', isLink: false },
]

check('① 分类：junction / 同版本 / 缺版本 / 旧版本 各归各位', () => {
  const r = classifyTopLevel(ENTRIES, { runningVersion: '0.2.0-rc.1' })
  assert.deepEqual(r.stale.map((x) => x.name).sort(), ['dsh-base', 'dsh-tool-web'])
  assert.deepEqual(r.sameVersion.map((x) => x.name), ['dsh-web-app'])
  assert.deepEqual(r.missingVersion.map((x) => x.name), ['dsh-unknown'])
  assert.ok(!r.stale.some((x) => x.name === 'dsh'), 'junction 不能被当成残留')
})

check('② 保留策略：回滚点那条 + 最近 1 条必留，其余才删', () => {
  const snaps = [
    { path: '/b/0.1.7-rc.2/fw-tree/300', mtimeMs: 300, sizeBytes: 2154 },
    { path: '/b/0.1.7-rc.1/fw-tree/200', mtimeMs: 200, sizeBytes: 1344 },
    { path: '/b/0.1.5-rc.1/fw-tree/100', mtimeMs: 100, sizeBytes: 80 },
  ]
  const r = planBackupRetention(snaps, { referenced: ['/b/0.1.5-rc.1/fw-tree/100'], keep: 1 })
  assert.deepEqual(r.kept.map((x) => [x.path, x.reason]), [
    ['/b/0.1.7-rc.2/fw-tree/300', 'recent'],
    ['/b/0.1.5-rc.1/fw-tree/100', 'rollback-point'],
  ])
  assert.deepEqual(r.remove.map((x) => x.path), ['/b/0.1.7-rc.1/fw-tree/200'])
  assert.equal(r.freedBytes, 1344)
})

check('③ 回滚点 === 最新那条时，实际只留 1 条（真机当前形态）', () => {
  const snaps = [
    { path: '/b/new/fw-tree/9', mtimeMs: 9, sizeBytes: 2154 },
    { path: '/b/old/fw-tree/1', mtimeMs: 1, sizeBytes: 5000 },
  ]
  const r = planBackupRetention(snaps, { referenced: ['/b/new/fw-tree/9'], keep: 1 })
  assert.deepEqual(r.kept.map((x) => x.reason), ['rollback-point'])
  assert.deepEqual(r.remove.map((x) => x.path), ['/b/old/fw-tree/1'])
  assert.equal(r.freedBytes, 5000)
})

check('④ keep 非法/负数 → 回落 1（绝不因参数脏而全删）', () => {
  const snaps = [
    { path: '/b/a/fw-tree/2', mtimeMs: 2, sizeBytes: 1 },
    { path: '/b/b/fw-tree/1', mtimeMs: 1, sizeBytes: 1 },
  ]
  for (const keep of [undefined, null, -5, 'x', NaN]) {
    const r = planBackupRetention(snaps, { referenced: [], keep })
    assert.equal(r.kept.length, 1, `keep=${String(keep)} 时应只留 1 条`)
    assert.equal(r.remove.length, 1)
  }
  const all = planBackupRetention(snaps, { referenced: [], keep: 2 })
  assert.equal(all.remove.length, 0, 'keep=2 时两条都留')
})

check('⑤ 脏数据不炸：非对象/空 path/无 mtime 都能安全处理', () => {
  const r = planBackupRetention([null, 42, { path: '' }, { path: '/ok', sizeBytes: 7 }, { path: '/ok2' }], { referenced: [], keep: 1 })
  assert.equal(r.kept.length, 1)
  assert.equal(r.remove.length, 1)
  assert.equal(r.kept[0].path, '/ok', '无 mtime 时保持原序 → 第一条（有体积的那条）被保留')
  assert.equal(r.remove[0].path, '/ok2')
  assert.equal(r.freedBytes, 0, '被删的那条没有 sizeBytes → 可释放字节按 0 计（少报比多报安全）')
  assert.deepEqual(classifyTopLevel(null, {}), { stale: [], sameVersion: [], missingVersion: [] })
})

// ── 动作层（真机同款形态：真 junction + 假删除器；全离线） ─────────────────────────
const FIX = join(ROOT, '.testdir', 'fw-cleanup-fixture')
rmSync(FIX, { recursive: true, force: true })
const { cleanFrameworkBackups, cleanFrameworkTopLevel } = await import('../lib/server/domain/framework-cleanup.js')

await check('⑥ 动作层：顶层旧目录 → 改名备份；目标存在的重建 junction；目标缺失的**连名字都不动**', async () => {
  const top = join(FIX, 'node_modules', '@deepseek-ai')
  const running = join(FIX, 'running-scope')
  mkdirSync(top, { recursive: true })
  mkdirSync(running, { recursive: true })
  const mk = (dir, version) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify({ version, main: 'index.js' }), 'utf8'); writeFileSync(join(dir, 'index.js'), 'export const x = 1\n', 'utf8') }
  mk(join(top, 'dsh-current'), '0.2.0-rc.1')        // 同版本 → 不动
  mk(join(top, 'dsh-base'), '0.1.5-rc.2')           // 旧 → 改名 + 目标存在 → junction
  mk(join(top, 'dsh-old-only'), '0.1.5-rc.2')       // 旧 → **无目标 → 完全不动**（0.5.34：名字绝不允许空缺）
  mk(join(running, 'dsh-base'), '0.2.0-rc.1')       // 运行树里的目标
  mk(join(running, 'dsh'), '0.2.0-rc.1')            // 运行树入口本体
  // 0.5.34 硬闸要用的两个启动关键包（同版本 → 判据不动它们；默认解析器据此验证可解析性）
  mk(join(top, 'cordis'), '0.2.0-rc.1')
  mk(join(top, 'dsh-app-boot'), '0.2.0-rc.1')
  symlinkSync(join(running, 'dsh'), join(top, 'dsh'), 'junction') // 真 junction 指向 <运行树>/dsh（dirname 后就是运行 scope 目录）
  const rel = await cleanFrameworkTopLevel({ topScopeDir: top, dshLinkPath: join(top, 'dsh'), runningVersion: '0.2.0-rc.1', relink: true, stamp: 12345 })
  assert.equal(rel.renamed.length, 1, JSON.stringify(rel))
  assert.deepEqual(rel.renamed.map((x) => x.name), ['dsh-base'])
  assert.ok(rel.renamed.every((x) => x.backup.includes('.stale-0.1.5-rc.2-12345')), '备份名要带版本与时间戳')
  assert.deepEqual(rel.relinked.map((x) => x.name), ['dsh-base'])
  assert.deepEqual(rel.relinkSkipped.map((x) => [x.name, x.reason]), [['dsh-old-only', 'no-target']])
  assert.deepEqual(rel.failed, [])
  assert.deepEqual(rel.rolledBack, [])
  assert.ok(existsSync(join(top, 'dsh-base')), '目标存在的那条要重建回原位（junction）')
  assert.ok(existsSync(join(top, 'dsh-old-only')), '目标缺失的那条**连名字都不动** —— 0.5.34：只改名不重建正是停机事故本体')
  assert.ok(!readdirSync(top).some((n) => n.startsWith('dsh-old-only.stale-')), '没目标 → 不留备份')
  assert.ok(readdirSync(top).some((n) => n.startsWith('dsh-base.stale-')), '旧目录要留备份')
  assert.equal(rel.sameVersionCount, 3)
  assert.equal(rel.verify.ok, true, '多基准可解析性验证必须过：' + JSON.stringify(rel.verify.error))
})

await check('⑦ 动作层 dryRun：只出 planned，一个字节都不动', async () => {
  const top = join(FIX, 'dryrun', '@deepseek-ai')
  mkdirSync(top, { recursive: true })
  mkdirSync(join(top, 'dsh-base'), { recursive: true })
  writeFileSync(join(top, 'dsh-base', 'package.json'), JSON.stringify({ version: '0.1.5-rc.2' }), 'utf8')
  const r = await cleanFrameworkTopLevel({ topScopeDir: top, dshLinkPath: null, runningVersion: '0.2.0-rc.1', dryRun: true, stamp: 1 })
  assert.equal(r.dryRun, true)
  assert.deepEqual(r.planned.map((x) => x.name), ['dsh-base'])
  assert.equal(r.renamed.length, 0)
  assert.ok(existsSync(join(top, 'dsh-base')), 'dryRun 不许动现场')
  assert.ok(!readdirSync(top).some((n) => n.includes('.stale-')), 'dryRun 不许留备份目录')
})

await check('⑧ 动作层：框架备份只删"计划要删的"，且 dryRun 时删除器一次都不调', async () => {
  const root = join(FIX, 'framework-backups')
  const mkSnap = (ver, id, size) => { const d = join(root, ver, 'fw-tree', id); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'x.bin'), Buffer.alloc(size), 'utf8'); return d }
  const newest = mkSnap('0.2.0-rc.1', '300', 10)
  const mid = mkSnap('0.1.7-rc.1', '200', 20)
  const oldest = mkSnap('0.1.5-rc.1', '100', 30)
  mkdirSync(join(root, '0.1.5-rc.1', 'dsh-package-backup'), { recursive: true })
  const calls = []
  const remove = async (p) => { calls.push(p); rmSync(p, { recursive: true, force: true }); return { ok: true } }
  // 三条快照几乎是同一秒建的 → 注入确定性 mtime（目录名就是序号），否则"最近 1 条"不确定
  const stat = (p) => ({ mtimeMs: Number(String(p).split(/[\\/]/u).pop()) })
  const dry = await cleanFrameworkBackups({ backupsRoot: root, referenced: [oldest], keep: 1, dryRun: true, deps: { remove, stat } })
  assert.equal(calls.length, 0, 'dryRun 不许调删除器')
  assert.equal(dry.plannedRemove.length, 1)
  assert.equal(dry.plannedRemove[0].path, mid)
  const real = await cleanFrameworkBackups({ backupsRoot: root, referenced: [oldest], keep: 1, deps: { remove, stat } })
  assert.deepEqual(calls, [mid], '只删中间那条（最新那条按 keep=1 留、最旧那条是回滚点）')
  assert.ok(existsSync(newest) && existsSync(oldest), '保留项必须还在')
  assert.ok(!existsSync(mid), '被删项应消失')
  assert.equal(real.freedBytes, 20)
  assert.ok(existsSync(join(root, '0.1.5-rc.1', 'dsh-package-backup')), 'dsh-package-backup 绝不能被碰')
})

console.log(passed === 8 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)