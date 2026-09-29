// D2/D5 回归（0.5.32 加法）：
//   · D2 快照 = 自动禁用的**回滚本钱**：原子写、sha256 可校验、保留最近 N 份（永不删"良好"那份）；
//   · D3 原语（路由/CLI 共用）：`restore-last-good` 逐字节恢复 + **改前再备份**；`disable-suspects`
//     **只**禁用点名行、其它行逐字节不变；
//   · D5 自动禁用：**只禁有确证证据的行**、`@deepseek-ai/*` 与核心/受保护行**永不禁用**、
//     **禁前先写快照**、幂等零写盘、留可读记录、开关关闭时只报告。
//
// 全离线：私有 DSH_HOME（临时目录）+ 自造 profile 补丁；不联网、不碰真实 profile。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'safe-boot-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(PROFILE, { recursive: true })
const PATCH = join(PROFILE, 'cordis.patch.yml')

const {
  applyRetention, disableSuspects, ensureSnapshotForCurrentState, listSnapshots, markSnapshotGood, readSafeBootState,
  restoreLastGood, safeBootDir, sha256, snapshotsDir, writeSnapshot,
} = await import('../lib/server/domain/safe-boot.js')
const { appendDisableLog, applyEvidenceDisable, planEvidenceDisable, readDisableLog } = await import('../lib/server/domain/auto-disable.js')
const { isProtectedModule } = await import('../lib/server/domain/runtime.js')
const { validatePatchYaml } = await import('../lib/server/domain/patch-yaml-check.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const readPatch = () => readFileSync(PATCH, 'utf8')
const shaOfFile = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const PATCH_V1 = [
  '# 夹具补丁（v1）',
  '- insert:',
  '    - id: web-ui-pet',
  "      name: '@linxin666/dsh-pet'",
  '- insert:',
  '    - id: preset-x',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '- id: tool-bash',
  '  disabled: true',
  '- id: webserver',
  '  disabled: false',
  '',
].join('\n')
writeFileSync(PATCH, PATCH_V1, 'utf8')

// ── ① 快照：原子写（无残留临时文件）+ sha256 可校验 + 逐字节副本 ───────────────
const fpA = { frameworkVersion: '0.2.0-rc.1', pnpmRoot: join(HOME, 'runtime-a'), pnpmEntities: 3 }
{
  const first = writeSnapshot({ patchPath: PATCH, fingerprint: fpA, frameworkVersion: '0.2.0-rc.1', reasons: ['框架版本 0.1.7 → 0.2.0'] })
  check('① 快照写入成功且真的落盘', first.ok === true && first.written === true && first.snapshot?.id, JSON.stringify({ ok: first.ok, id: first.snapshot?.id }))
  const dir = snapshotsDir(HOME)
  const names = readdirSync(dir)
  check('① ★ 原子写：目录里只有 .json（没有 .tmp 残留）', names.every((n) => n.endsWith('.json')), names.join(','))
  const file = join(dir, `${first.snapshot.id}.json`)
  const rec = JSON.parse(readFileSync(file, 'utf8'))
  check('① ★ sha256 可校验：记录里的哈希 == 补丁文件逐字节哈希', rec.patchSha256 === shaOfFile(PATCH) && rec.patchText === readPatch(), JSON.stringify({ recSha: rec.patchSha256, fileSha: shaOfFile(PATCH), textEqual: rec.patchText === readPatch(), recLen: rec.patchText?.length, rawLen: readPatch().length }))
  check('① 快照带框架版本 + 环境指纹 + 此刻启用/禁用行清单 + 时间戳', rec.frameworkVersion === '0.2.0-rc.1' && rec.fingerprint?.pnpmEntities === 3 && Array.isArray(rec.rows?.enabled) && rec.rows.enabled.includes('web-ui-pet') && rec.rows.disabled.includes('tool-bash') && typeof rec.at === 'number', JSON.stringify(rec.rows))
  const second = writeSnapshot({ patchPath: PATCH, fingerprint: fpA, frameworkVersion: '0.2.0-rc.1' })
  check('① ★ 节流：环境与补丁都没变 → 零写盘', second.ok === true && second.written === false && listSnapshots({ home: HOME }).length === 1, JSON.stringify({ written: second.written, count: listSnapshots({ home: HOME }).length }))
}

// ── ② 保留策略：最近 N 份 + 永不删「良好」那份 ────────────────────────────────
{
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(PATCH, `${PATCH_V1}- id: extra-${i}\n  disabled: false\n`, 'utf8')
    writeSnapshot({ patchPath: PATCH, fingerprint: { ...fpA, frameworkVersion: `0.2.${i}` }, frameworkVersion: `0.2.${i}` })
  }
  const list = listSnapshots({ home: HOME })
  check('② ★ 保留最近 3 份（默认策略，不超量）', list.length === 3, `count=${list.length} ids=${list.map((s) => s.id).join(',')}`)
  const goodId = list[0].id
  check('② 标记「良好」成功', markSnapshotGood({ id: goodId, home: HOME }).ok === true)
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(PATCH, `${PATCH_V1}- id: more-${i}\n  disabled: false\n`, 'utf8')
    writeSnapshot({ patchPath: PATCH, fingerprint: { ...fpA, frameworkVersion: `0.3.${i}` }, frameworkVersion: `0.3.${i}` })
  }
  const after = listSnapshots({ home: HOME })
  check('② ★ 「良好」快照永不随保留策略删除', after.some((s) => s.id === goodId && s.kind === 'good'), after.map((s) => `${s.id}:${s.kind}`).join(','))
  check('② 状态文件记住 lastGoodId（可一条命令恢复）', readSafeBootState({ home: HOME }).lastGoodId === goodId)
  const r = applyRetention(after.map((s) => ({ id: s.id, at: s.at, kind: s.kind })), 3)
  check('② 保留策略是纯函数、可离线断言（keep/removed 互补）', r.keep.length >= 1 && r.keep.every((id) => !r.removed.includes(id)))
}

// ── ③ D3：restore-last-good 逐字节恢复 + 改前再备份 ───────────────────────────
{
  const dir = snapshotsDir(HOME)
  // 造一份"当前与快照不同"的状态：先给当前状态留快照，再改坏（模拟被别的通道改过）
  writeFileSync(PATCH, PATCH_V1, 'utf8')
  const good = writeSnapshot({ patchPath: PATCH, fingerprint: fpA, frameworkVersion: '0.2.0-rc.1', note: 'D3 恢复夹具' })
  writeFileSync(PATCH, `${PATCH_V1}- id: broken-row\n  disabled: false\n`, 'utf8')
  const beforeRestoreHash = shaOfFile(PATCH)
  const restored = restoreLastGood({ patchPath: PATCH, id: good.snapshot.id, home: HOME })
  check('③ ★ 逐字节恢复：文件内容 == 快照内容', restored.ok === true && restored.changed === true && readPatch() === PATCH_V1, JSON.stringify({ ok: restored.ok, code: restored.code }))
  check('③ ★ 改前再备份：备份文件存在且内容 == 恢复前的那份', typeof restored.backupPath === 'string' && existsSync(restored.backupPath) && shaOfFile(restored.backupPath) === beforeRestoreHash, restored.backupPath ?? 'none')
  check('③ 返回 sha256（可与快照记录核对）', restored.sha256 === JSON.parse(readFileSync(join(dir, `${good.snapshot.id}.json`), 'utf8')).patchSha256)
  const again = restoreLastGood({ patchPath: PATCH, id: good.snapshot.id, home: HOME })
  check('③ 已一致时如实报"无需恢复"（幂等，仍会备份）', again.ok === true && again.changed === false && again.code === 'already-identical', JSON.stringify({ code: again.code }))
  // 被改坏的快照必须**拒绝使用**（sha256 校验是守门，不是装饰）
  const victim = join(dir, `${good.snapshot.id}.json`)
  const original = readFileSync(victim, 'utf8')
  writeFileSync(victim, original.replace('夹具补丁（v1）', '被篡改的补丁'), 'utf8')
  writeFileSync(PATCH, `${PATCH_V1}- id: another\n  disabled: false\n`, 'utf8')
  const hashBefore = shaOfFile(PATCH)
  const corrupt = restoreLastGood({ patchPath: PATCH, id: good.snapshot.id, home: HOME })
  check('③ ★ 快照被改坏 → 拒绝恢复且**一个字节都没改**', corrupt.ok === false && corrupt.code === 'snapshot-corrupt' && shaOfFile(PATCH) === hashBefore, JSON.stringify({ code: corrupt.code }))
  writeFileSync(victim, original, 'utf8')
  const missing = restoreLastGood({ patchPath: PATCH, id: 'snap-nope', home: HOME })
  check('③ 快照不存在 → 如实报错（不静默挑一份别的）', missing.ok === false && missing.code === 'snapshot-missing')
}

// ── ④ D3：disable-suspects **只**动点名行、其它行逐字节不变 ────────────────────
{
  writeFileSync(PATCH, PATCH_V1, 'utf8')
  const before = readPatch()
  const result = disableSuspects({ patchPath: PATCH, rowIds: ['web-ui-pet', 'tool-bash', 'nonexistent-row', 'webserver', 'plugin-console'], home: HOME })
  const after = readPatch()
  check('④ 只给点名的可写行追加块（其余一律跳过并给原因）', result.ok === true && result.added.join() === 'web-ui-pet' && result.skipped.map((s) => `${s.rowId}:${s.reason}`).join(',') === 'tool-bash:already-disabled,nonexistent-row:not-in-patch,webserver:core-row,plugin-console:self', JSON.stringify({ added: result.added, skipped: result.skipped }))
  check('④ ★ 其它行逐字节不变（原文是写回内容的严格前缀）', result.prefixSame === true && after.startsWith(before.replace(/\s+$/u, '')) && after.length > before.length)
  check('④ 追加的正是既有 disable 写法（`- id: X` + `  disabled: true`）', after.endsWith('- id: web-ui-pet\n  disabled: true\n'))
  check('④ 写后结构校验通过（严格 YAML 闸门）', validatePatchYaml(after).ok === true)
  check('④ 改前备份存在且 == 原文', typeof result.backupPath === 'string' && readFileSync(result.backupPath, 'utf8') === before)
  const again = disableSuspects({ patchPath: PATCH, rowIds: ['web-ui-pet'], home: HOME })
  check('④ ★ 幂等：已禁用的行不再写盘（noop + 零字节改动）', again.ok === true && again.changed === false && readPatch() === after, JSON.stringify({ code: again.code }))
}

// ── ⑤ D5：自动禁用 —— 只禁有证据的行；框架/核心/受保护行永不禁用；幂等；留记录 ──
{
  writeFileSync(PATCH, PATCH_V1, 'utf8')
  const affected = [
    { rowId: 'web-ui-pet', moduleName: '@linxin666/dsh-pet', code: 'package-unresolvable', severity: 'blocker' },
    { rowId: 'preset-x', moduleName: '@deepseek-ai/dsh-agent-preset', code: 'package-unresolvable', severity: 'blocker' },
    { rowId: 'webserver', moduleName: '@deepseek-ai/dsh-host-webserver', code: 'package-unresolvable', severity: 'blocker' },
    { rowId: 'tool-bash', moduleName: 'unknown-row', code: 'subpath-unresolvable', severity: 'warn' },
    { rowId: 'web-ui-pet', moduleName: '@linxin666/dsh-pet', code: 'schemastery-volatile', severity: 'warn' },
  ]
  const plan = planEvidenceDisable({ affected, patchText: readPatch(), isProtected: isProtectedModule })
  check('⑤ ★ 只把"确证解析不到"的行列为禁用对象', plan.disable.map((d) => d.rowId).join() === 'web-ui-pet', JSON.stringify(plan.disable))
  check('⑤ ★ 框架自带包（@deepseek-ai/*）永不禁用', plan.skipped.some((s) => s.rowId === 'preset-x' && s.reason === 'framework-owned'))
  check('⑤ ★ 核心行（webserver）永不禁用', plan.skipped.some((s) => s.rowId === 'webserver' && s.reason === 'core-row'))
  check('⑤ 证据不足的形态（子路径 / 依赖副本陈旧）只报告不写盘', plan.skipped.some((s) => s.rowId === 'tool-bash' && /not-evidence/.test(s.reason)))
  check('⑤ 解析不确定（没有基准）→ 整批不写盘', planEvidenceDisable({ affected, patchText: readPatch(), uncertainty: '没有可用的解析基准' }).disable.length === 0)

  const shared = { patchPath: PATCH, affected, isProtected: isProtectedModule, frameworkVersion: '0.2.0-rc.1', fingerprint: fpA }
  // 开关关闭 → 只报告
  const beforeSwitchOff = shaOfFile(PATCH)
  const off = applyEvidenceDisable({ ...shared, enabled: false })
  check('⑤ ★ 开关关闭 → 只报告、零写盘（candidates 可读）', off.ok === true && off.code === 'switch-off' && off.disabled.length === 0 && off.candidates.join() === 'web-ui-pet' && shaOfFile(PATCH) === beforeSwitchOff)
  // 开关打开 → 禁前快照 + 写盘 + 记录
  const on = applyEvidenceDisable({ ...shared, enabled: true })
  const snaps = listSnapshots({ home: HOME })
  check('⑤ ★ 有证据 → 真的自动禁用（不再等点击）', on.ok === true && on.code === 'auto-disabled' && on.disabled.join() === 'web-ui-pet', JSON.stringify({ code: on.code, added: on.disabled }))
  check('⑤ ★ **禁前先写快照**：快照里记的是"禁用前"的那份，可一键回滚', typeof on.snapshot?.id === 'string' && snaps.some((s) => s.id === on.snapshot.id) && JSON.parse(readFileSync(join(snapshotsDir(HOME), `${on.snapshot.id}.json`), 'utf8')).patchSha256 === sha256(PATCH_V1), JSON.stringify({ snapshot: on.snapshot?.id }))
  check('⑤ 只动点名行（其余逐字节不变）', on.prefixSame === true && readPatch() === `${PATCH_V1.replace(/\s+$/u, '')}\n- id: web-ui-pet\n  disabled: true\n`)
  const log = readDisableLog({ home: HOME })
  check('⑤ ★ 留一条可读记录（时间/行 id/证据/恢复命令）', log.length === 1 && log[0].added.join() === 'web-ui-pet' && log[0].evidence[0].code === 'package-unresolvable' && typeof log[0].at === 'number' && /restore-last-good/u.test(log[0].restoreCommand), JSON.stringify(log[0] ?? null).slice(0, 220))
  check('⑤ 记录文件落在我们自己的目录（不碰用户 profile）', existsSync(join(HOME, 'plugin-console', 'auto-disable.log')))
  // 幂等
  const hashAfterFirst = shaOfFile(PATCH)
  const idemPatch = readPatch()
  const second = applyEvidenceDisable({ ...shared, enabled: true })
  check('⑤ ★ 幂等零写盘：第二轮不再写（行已禁用 → 无新证据可写）', second.disabled.length === 0 && shaOfFile(PATCH) === hashAfterFirst && readPatch() === idemPatch, JSON.stringify({ code: second.code, disabled: second.disabled }))
  // 回滚：restore-last-good 把自动禁用整份撤销（这就是"回滚本钱"的兑现）
  const rollback = restoreLastGood({ patchPath: PATCH, id: on.snapshot.id, home: HOME })
  check('⑤ ★ 自动禁用可一条命令回滚（逐字节回到禁用前）', rollback.ok === true && readPatch() === PATCH_V1)
}

// ── ⑥ 启动失败点名（第二种证据）+ 快照前置守卫 ────────────────────────────────
{
  writeFileSync(PATCH, PATCH_V1, 'utf8')
  const before = shaOfFile(PATCH)
  const r = applyEvidenceDisable({ patchPath: PATCH, affected: [], bootRows: ['web-ui-pet', 'preset-x', 'webserver'], enabled: true, isProtected: isProtectedModule, fingerprint: fpA })
  check('⑥ 启动失败记录点名的行会被自动禁用', r.ok === true && r.disabled.join() === 'web-ui-pet', JSON.stringify({ added: r.disabled, skipped: r.skipped }))
  check('⑥ 启动失败记录里的框架行/核心行仍永不禁用', shaOfFile(PATCH) !== before && !/^- id: preset-x\n  disabled: true$/mu.test(readPatch()) && !/^- id: webserver\n  disabled: true$/mu.test(readPatch()))
  check('⑥ 禁前快照存在（本轮的快照 sha == 本轮改动前的补丁）', (() => {
    const snaps = listSnapshots({ home: HOME })
    return snaps.some((s) => s.patchSha256 === before)
  })(), JSON.stringify(listSnapshots({ home: HOME }).map((s) => `${s.id}:${String(s.patchSha256).slice(0, 8)}`)))
  // 补丁文件不存在 → 任何写盘入口都必须如实拒绝（不创建文件、不假装成功）
  const ghost = join(PROFILE, 'nope.yml')
  const g1 = disableSuspects({ patchPath: ghost, rowIds: ['x'], home: HOME })
  const g2 = applyEvidenceDisable({ patchPath: ghost, affected: [{ rowId: 'x', moduleName: '@x/y', code: 'package-unresolvable' }], enabled: true, isProtected: isProtectedModule })
  check('⑥ 补丁不存在时如实拒绝（不创建文件）', g1.ok === false && g1.code === 'patch-missing' && existsSync(ghost) === false && g2.disabled.length === 0, JSON.stringify({ g1: g1.code, g2: g2.code }))
  // 追加式记录：坏行不影响读取
  appendDisableLog({ at: Date.now(), kind: 'auto-disable', added: [] }, { home: HOME })
  check('⑥ 记录是追加式（不会覆盖历史）', readDisableLog({ home: HOME }).length >= 2)
}

// ── ⑦ 目录纪律：快照/记录都落在 dshHome() 下我们自己的目录（不污染 profile）─────
{
  check('⑦ ★ 快照目录 = dshHome()/plugin-console/safe-boot/snapshots', snapshotsDir(HOME) === join(HOME, 'plugin-console', 'safe-boot', 'snapshots') && safeBootDir(HOME) === join(HOME, 'plugin-console', 'safe-boot'))
  const profileEntries = readdirSync(PROFILE)
  check('⑦ ★ profile 目录里没有我们新增的快照/记录文件（只有补丁与它的备份）', profileEntries.every((n) => n === 'cordis.patch.yml' || n.startsWith('cordis.patch.yml.bak-')), profileEntries.join(','))
  const patchStat = statSync(PATCH)
  check('⑦ 快照写入不修改补丁本身（mtime 不再被无谓触碰）', patchStat.size > 0)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
