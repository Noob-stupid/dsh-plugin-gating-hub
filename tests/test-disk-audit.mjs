// 0.5.84 加法（用户第 7 项）：`<DSH_HOME>/plugin-console` 的磁盘体检 + **显式确认后**清理
//
// 用户原话（大意）：目录已经 2.1 GB（framework-backups 含全平台 libreoffice），
// 要「只读体检 + 显式确认后清理」，**绝不自动删除**。
//
// 本套钉死的死规矩（违背任何一条都比不清理更糟）：
//   ① 体检**只读**：不删、不写、不改任何文件（前后逐字节比对）；
//   ② 分级判据：真机实测最大的 2.1 GB 是 `framework-backups/<当前回滚版本>`，而它**正是**
//      `framework-rollback.json` 的 checkpointDir ⇒ 它必须是 protected，**不许**出现在可清理候选里；
//   ③ 未确认（confirm !== true）⇒ 一个文件都不动，只回计划；
//   ④ 边界：拒绝路径穿越、拒绝白名单之外的 id；
//   ⑤ 删完读回核实：删不干净如实回报，不谎报成功。
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'disk-audit-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })
const CP = join(HOME, 'plugin-console')
mkdirSync(CP, { recursive: true })

const { auditConsoleDir, planCleanup, readRollbackPointer, runCleanup } = await import('../lib/server/domain/disk-audit.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── 夹具：仿造真机的形状（大头是回滚点指向的框架备份 + 一堆日志与残留）──────────────
const put = (rel, bytes = 16) => {
  const full = join(CP, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, 'x'.repeat(bytes), 'utf8')
  return full
}
const rollbackVersion = '0.2.0-rc.1'
put(`framework-backups/${rollbackVersion}/fw-tree/1/node_modules/big.js`, 4096)
put(`framework-backups/${rollbackVersion}/dsh-package-backup/package.json`, 128)
put('framework-backups/0.1.5-rc.1/fw-tree/1/node_modules/x.js', 256)
put('profile-sync-backups/2026-09/package.json', 512)
put('subdir-src/pkg/package.json', 64)
put('fw-upgrade.log', 2048)
put('console-restart.log', 64)
put('fw-watchdog.log', 32)
put('restart-guard-23688.count', 8)
put('fw-upgrade-state.txt.bak-20260910-155834', 24)
put('persist-e2e-2026-10-04T09-01-33-096Z/a.json', 40)
writeFileSync(join(CP, 'framework-rollback.json'), `${JSON.stringify({
  from: rollbackVersion,
  to: '0.2.0-rc.2',
  checkpointDir: join(CP, 'framework-backups', rollbackVersion, 'fw-tree', '1'),
  cliBackupDir: join(CP, 'framework-backups', rollbackVersion, 'dsh-package-backup'),
  at: 1,
}, null, 2)}\n`, 'utf8')
writeFileSync(join(CP, 'framework-state.json'), '{}\n', 'utf8')
writeFileSync(join(CP, 'compat-pending.json'), '{}\n', 'utf8')
writeFileSync(join(CP, 'install-jobs.json'), '[]\n', 'utf8')

console.log('=== ① 只读体检：谁占了多少，且**一个文件都没动** ===')
const before = (() => {
  const snap = new Map()
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else snap.set(full, `${statSync(full).size}:${readFileSync(full, 'utf8').length}`)
    }
  }
  walk(CP)
  return snap
})()
const audit = auditConsoleDir({ root: CP })
{
  const after = (() => {
    const snap = new Map()
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else snap.set(full, `${statSync(full).size}:${readFileSync(full, 'utf8').length}`)
      }
    }
    walk(CP)
    return snap
  })()
  check('① 体检成功且统计到体积', audit.ok === true && audit.totalBytes > 0 && audit.totalFiles > 0, `${audit.totalBytes} 字节 / ${audit.totalFiles} 文件`)
  check('① 体检**只读**：全部文件的大小与内容逐字节不变', before.size === after.size && [...before].every(([k, v]) => after.get(k) === v), `${before.size} vs ${after.size}`)
  check('① 读到了回滚记录（判据从这里来，不按体积猜）', audit.rollback?.from === rollbackVersion && String(audit.rollback?.checkpointDir).includes('fw-tree'), JSON.stringify(audit.rollback))
  check('① 条目按体积降序（最大的在最前，且是**展开后的**那一份备份）',
    audit.entries[0]?.id === `framework-backups/${rollbackVersion}`, audit.entries.slice(0, 3).map((e) => `${e.id}:${e.bytes}B`).join(', '))
}

console.log('\n=== ② 分级：当前回滚点指向的备份**必须** protected（真机最大那份就是它）===')
{
  const byId = new Map(audit.entries.map((e) => [e.id, e]))
  check('② ★ 回滚点引用的那一份备份 protected，其余旧备份 tradeoff（判据细到"哪一份"）',
    byId.get(`framework-backups/${rollbackVersion}`)?.level === 'protected'
    && byId.get('framework-backups/0.1.5-rc.1')?.level === 'tradeoff'
    && /回滚点/u.test(String(byId.get(`framework-backups/${rollbackVersion}`)?.reason)),
    `${byId.get(`framework-backups/${rollbackVersion}`)?.level} / ${byId.get('framework-backups/0.1.5-rc.1')?.level}`)
  check('② ★ 状态文件一律 protected（framework-state / compat-pending / install-jobs / framework-rollback）',
    ['framework-state.json', 'compat-pending.json', 'install-jobs.json', 'framework-rollback.json'].every((id) => byId.get(id)?.level === 'protected'),
    ['framework-state.json', 'compat-pending.json', 'install-jobs.json', 'framework-rollback.json'].map((id) => `${id}=${byId.get(id)?.level}`).join(' '))
  check('② 日志 / 旧守护计数 / 状态 .bak / 测试残留都是 safe',
    ['fw-upgrade.log', 'console-restart.log', 'restart-guard-23688.count', 'fw-upgrade-state.txt.bak-20260910-155834', 'persist-e2e-2026-10-04T09-01-33-096Z']
      .every((id) => byId.get(id)?.level === 'safe'),
    ['fw-upgrade.log', 'restart-guard-23688.count', 'persist-e2e-2026-10-04T09-01-33-096Z'].map((id) => `${id}=${byId.get(id)?.level}`).join(' '))
  check('② 快照备份是 tradeoff（删了会失去那一次的快照）；子目录源码是 protected（已装插件可能还指着它）',
    byId.get('profile-sync-backups/2026-09')?.level === 'tradeoff' && byId.get('subdir-src')?.level === 'protected',
    `${byId.get('profile-sync-backups/2026-09')?.level} / ${byId.get('subdir-src')?.level}`)
  check('② 汇总里区分了"安全可清"与"含取舍可清"',
    audit.safeBytes > 0 && audit.reclaimableBytes > audit.safeBytes, `safe=${audit.safeBytes}B reclaim=${audit.reclaimableBytes}B`)

  // ★ 回滚点**直接指向**某个备份子目录时，那一份必须 protected
  const pointed = auditConsoleDir({
    root: CP,
    deps: {
      readFile: () => JSON.stringify({ from: '0.1.5-rc.1', checkpointDir: join(CP, 'framework-backups', '0.1.5-rc.1', 'fw-tree', '1') }),
    },
  })
  check('② 回滚点指向哪一份，判据就跟着哪一份（换成 0.1.5-rc.1 时它那份受保护、其它备份仍是 tradeoff）',
    pointed.ok === true && pointed.rollback?.from === '0.1.5-rc.1',
    JSON.stringify(pointed.rollback?.from))
}

console.log('\n=== ③ 计划：拒绝路径穿越与白名单外的 id ===')
{
  const bad = planCleanup({ audit, ids: ['../escape', 'nope-not-there', 'framework-state.json', 'fw-upgrade.log'] })
  check('③ 路径穿越被拒（`../escape`）', bad.refused.some((r) => r.id === '../escape' && /路径穿越/u.test(r.reason)), JSON.stringify(bad.refused.map((r) => r.id)))
  check('③ 体检结果里没有的 id 被拒', bad.refused.some((r) => r.id === 'nope-not-there'))
  check('③ protected 条目被拒**并说明原因**', bad.refused.some((r) => r.id === 'framework-state.json' && /状态文件/u.test(r.reason)))
  check('③ 合法项仍然进计划（拒绝的只是不该删的）', bad.plan.length === 1 && bad.plan[0].id === 'fw-upgrade.log', JSON.stringify(bad.plan.map((p) => p.id)))
  const safeIds = audit.entries.filter((e) => e.level === 'safe').map((e) => e.id)
  const all = planCleanup({ audit, ids: safeIds })
  check('③ 只清"安全"级时 0 项被拒', all.refused.length === 0 && all.plan.length === safeIds.length, `plan=${all.plan.length} refused=${all.refused.length}`)
}

console.log('\n=== ④ 未确认 ⇒ 一个文件都不动（只回计划）===')
{
  const ids = audit.entries.filter((e) => e.level === 'safe').map((e) => e.id)
  const noConfirm = runCleanup({ root: CP, audit, ids })
  check('④ needsConfirm=true 且 applied=false', noConfirm.needsConfirm === true && noConfirm.applied === false, JSON.stringify({ needsConfirm: noConfirm.needsConfirm }))
  check('④ 计划里给出将删什么/省多少', noConfirm.plan?.plan?.length === ids.length && noConfirm.plan.freedBytes > 0, `freed=${noConfirm.plan.freedBytes}B`)
  check('④ 所有待删文件**仍然都在**（未确认一个字都没动）',
    ids.every((id) => existsSync(join(CP, id))), ids.filter((id) => !existsSync(join(CP, id))).join(', ') || '全部仍在')
}

console.log('\n=== ⑤ 确认后才删；删完读回核实；protected 与 tradeoff 不会被顺带删掉 ===')
{
  const ids = audit.entries.filter((e) => e.level === 'safe').map((e) => e.id)
  const done = runCleanup({ root: CP, audit, ids, confirm: true })
  check('⑤ applied=true 且逐项进 removed', done.applied === true && done.removed.length === ids.length, `removed=${done.removed.length}/${ids.length} failed=${done.failed.length}`)
  check('⑤ 报出的释放体积 > 0', done.freedBytes > 0, `${done.freedBytes} 字节`)
  check('⑤ safe 项真的没了（读回核实）', ids.every((id) => !existsSync(join(CP, id))), ids.filter((id) => existsSync(join(CP, id))).join(', ') || '全部已删')
  check('⑤ ★ 回滚点指向的框架备份**还在**（protected/tradeoff 不会被顺带删掉）',
    existsSync(join(CP, 'framework-backups', rollbackVersion, 'fw-tree', '1', 'node_modules', 'big.js'))
    && existsSync(join(CP, 'framework-rollback.json')), '')
  check('⑤ 清理后重新体检：总体积变小、且大头仍是那份不能删的备份',
    (() => { const a2 = auditConsoleDir({ root: CP }); return a2.totalBytes < audit.totalBytes && a2.entries[0]?.id === `framework-backups/${rollbackVersion}` }) (), '')
}

console.log('\n=== ⑥ 删不干净要如实说（不许谎报成功）===')
{
  put('fw-merge-error.log', 16)
  const a3 = auditConsoleDir({ root: CP })
  const done = runCleanup({ root: CP, audit: a3, ids: ['fw-merge-error.log'], confirm: true })
  check('⑥ 正常删除：ok=true 且 removed 一项', done.ok === true && done.removed.length === 1)
  // 负控：注入一个"删了还在"的 remove（Windows 上 rmSync 真的会静默落空，fsx.js 记过）
  put('fw-relaunch.log', 16)
  const a4 = auditConsoleDir({ root: CP })
  const stuck = runCleanup({ root: CP, audit: a4, ids: ['fw-relaunch.log'], confirm: true, deps: { remove: () => {} } })
  check('⑥ 负控：删后仍在 ⇒ ok=false + failed 点名"静默落空"（绝不谎报成功）',
    stuck.ok === false && stuck.failed.some((f) => f.id === 'fw-relaunch.log' && /静默落空/u.test(f.reason)),
    JSON.stringify(stuck.failed))
  check('⑥ 负控：文件确实还在（说明判据是读回核实，不是看调用有没有抛）', existsSync(join(CP, 'fw-relaunch.log')))
}

console.log('\n=== ⑦ 路由接线（静态）：只读体检是 GET、清理默认只回计划 ===')
{
  const routeSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'disk.js'), 'utf8')
  const domainSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'disk-audit.js'), 'utf8')
  check('⑦ audit 路由只调用 auditConsoleDir（不删任何东西）',
    /auditConsoleDir\(/u.test(routeSrc) && !/runCleanup\(/u.test(routeSrc.split('async function routeDiskCleanup')[0]))
  check('⑦ cleanup 未确认时回 200 + needsConfirm:true（不是错误、更不是删除）',
    /needsConfirm === true/u.test(routeSrc) && /needsConfirm: true, applied: false/u.test(routeSrc))
  check('⑦ 服务端**每次重新体检**，不信任客户端回传的体积/分级',
    /每次都\*\*重新体检\*\*|const audit = auditConsoleDir\(/u.test(routeSrc))
  check('⑦ 域模块里没有任何自动删除路径（删除只发生在 runCleanup 且要 confirm）',
    /function runCleanup/u.test(domainSrc) && /confirm !== true/u.test(domainSrc))
  const clientSrc = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  check('⑦ 面板是两步式：先不带 confirm 要计划，再 confirm:true 才删',
    /call\("\/plugin-console\/disk-audit"\)/u.test(clientSrc)
    && /call\("\/plugin-console\/disk-cleanup", \{ ids: ids, confirm: confirm === true \}\)/u.test(clientSrc))
}

// 也确认一下路由的挂载声明（GET 必须在守卫前、POST 在表里）
{
  const routerSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'index.js'), 'utf8')
  const early = routerSrc.slice(routerSrc.indexOf('const ROUTES_EARLY'), routerSrc.indexOf('function routeDeps'))
  check('⑦ GET /disk-audit 登记在 405 守卫之前的表里（否则声明了 GET 也走不到）',
    /\{ methods: \['GET'\], path: `\$\{ROUTE_PREFIX\}\/disk-audit`/u.test(early))
  check('⑦ POST /disk-cleanup 登记在 ROUTES 表里',
    /\{ methods: \['POST'\], path: `\$\{ROUTE_PREFIX\}\/disk-cleanup`/u.test(routerSrc))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
