// 隔离记录 → 适配门清单 的合并回归测试（2026-09-11 事故）
// 事故：升级脚本用 PowerShell 写 fw-quarantine.json（PS5.1 的 UTF8 带 BOM），而合并逻辑
// **先复制+删除、再判断 JSON.parse** → BOM 让 parse 必失败 → 记录被销毁却从未进清单
// → 界面上那 20 行只剩一个没有解释的【停用】，用户完全不知道"谁被关了、为什么"。
// 本测试锁死：① 带 BOM 必须能合并；② 只有**合并成功并校验通过**才允许销毁记录；
// ③ 写失败/解析失败都必须保留记录并留错误日志。
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'quarantine-merge-home')
process.env.DSH_HOME = HOME // 必须在 import 前设置

const qFile = join(HOME, 'plugin-console', 'fw-quarantine.json')
const pFile = join(HOME, 'plugin-console', 'compat-pending.json')
const errFile = join(HOME, 'plugin-console', 'fw-merge-error.log')

const reset = (pending = { frameworkVersion: '0.1.2-rc.1', upgradedAt: null, pending: [] }) => {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
  writeFileSync(pFile, JSON.stringify(pending, null, 2), 'utf8')
}
/** 模拟 PowerShell `Set-Content -Encoding UTF8`：带 UTF-8 BOM 写出（事故的触发条件） */
const writeQuarantineBom = (record) => writeFileSync(qFile, `\uFEFF${JSON.stringify(record, null, 4)}`, 'utf8')
const readPending = () => JSON.parse(readFileSync(pFile, 'utf8'))

const { mergeQuarantineRecord } = await import('../lib/server/domain/quarantine.js')
let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const record = {
  at: '2026-09-11 12:04:53',
  mode: 'safe-mode',
  presets: [],
  rows: ['web-ui-market', 'web-all-settings', 'dsh-routing-suite'],
  lines: [],
}

// ① 带 BOM 的记录必须能合并（这就是真机上失败的那一条）
reset({ frameworkVersion: '0.1.2-rc.1', pending: [{ rowId: 'web-ui-market', status: 'adopted', checkNote: '旧记录' }] })
writeQuarantineBom(record)
mergeQuarantineRecord()
let after = readPending()
const merged = (after.pending ?? []).filter((p) => p.source === 'boot-quarantine')
check('带 BOM 的隔离记录能合并进清单（事故根因回归）', merged.length === 3, `合并 ${merged.length} 行`)
check('合并后状态为待适配（panding）', merged.every((p) => p.status === 'pending'))
check('合并写入了原因说明', merged.every((p) => typeof p.checkNote === 'string' && p.checkNote.includes('启动失败隔离')), merged[0]?.checkNote)
check('已存在的旧行被更新而不是重复追加', (after.pending ?? []).filter((p) => p.rowId === 'web-ui-market').length === 1)
check('quarantineAt 被记录', after.quarantineAt === '2026-09-11 12:04:53', String(after.quarantineAt))

// ② 校验通过才销毁原始记录（归档副本保留供审计）
check('合并成功后原记录被移除', !existsSync(qFile))
check('归档副本保留（.applied-）', readdirSync(join(HOME, 'plugin-console')).some((n) => n.startsWith('fw-quarantine.json.applied-')))
check('合并成功不写错误日志', !existsSync(errFile))

// ③ 清单写不进去时必须保留记录（用同名目录让 writeFileSync 抛错）
reset()
rmSync(pFile, { force: true })
mkdirSync(pFile, { recursive: true }) // pFile 变成目录 → 写入必失败
writeQuarantineBom(record)
mergeQuarantineRecord()
check('写入清单失败时保留隔离记录（绝不销毁证据）', existsSync(qFile))
check('写入失败留下错误日志', existsSync(errFile) && readFileSync(errFile, 'utf8').includes('校验失败'), '见 fw-merge-error.log')

// ④ 记录本身解析不了（真坏 JSON）→ 保留 + 留痕，不静默销毁
reset()
writeFileSync(qFile, '\uFEFF{ this is not json', 'utf8')
mergeQuarantineRecord()
check('坏 JSON 时保留记录', existsSync(qFile))
check('坏 JSON 留下错误日志', readFileSync(errFile, 'utf8').includes('无法解析'))

// ⑤ 幂等：同一记录合并两次不重复
reset()
writeQuarantineBom(record)
mergeQuarantineRecord()
writeQuarantineBom(record)
mergeQuarantineRecord()
after = readPending()
check('幂等：重复合并不产生重复行', (after.pending ?? []).length === 3, `共 ${(after.pending ?? []).length} 行`)

// ⑥ 预设隔离也进清单
reset()
writeQuarantineBom({ at: '2026-09-11 13:00:00', mode: 'targeted', presets: ['router-spec'], rows: [], lines: ['preset "router-spec" failed to mount'] })
mergeQuarantineRecord()
after = readPending()
check('预设隔离写进 presetsQuarantined', Array.isArray(after.presetsQuarantined) && after.presetsQuarantined[0]?.name === 'router-spec', JSON.stringify(after.presetsQuarantined))

// ⑦ 没有记录时静默返回（不报错、不动清单）
reset()
const before = readFileSync(pFile, 'utf8')
const r = mergeQuarantineRecord()
check('无记录时返回 null 且不改清单', r === null && readFileSync(pFile, 'utf8') === before)

// ── ⑧ v0.3.45：合并时补 moduleName + 已启用的行不留 pending ────────────────────
// 用户实测：点「一键启用已适配」得到「该全家桶没有待适配行」，因为隔离记录里只有 rowId，
// 而"全家桶"是按 moduleName 前缀匹配的 → 匹配不到。
const webDir = join(HOME, 'profiles', 'web')
mkdirSync(join(webDir, 'node_modules', '@fake'), { recursive: true })
const cordisUrl = `file:///${join(webDir, 'cordis.yml').replace(/\\/gu, '/')}`
writeFileSync(join(webDir, 'cordis.yml'), '[]\n', 'utf8')
const makeCtx = (rows) => ({
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      ...rows.map((row) => ({
        id: 'include:' + row.rowId,
        options: { name: row.moduleName },
        disabled: row.enabled !== true,
        fiber: row.enabled === true ? { state: 2 } : undefined,
      })),
    ],
  },
})
const { reconcileCompatPending } = await import('../lib/server/domain/quarantine.js')

reset()
writeQuarantineBom({ at: '2026-09-11 14:00:00', mode: 'safe-mode', presets: [], rows: ['web-ui-market', 'web-ui-i18n'], lines: [] })
mergeQuarantineRecord(makeCtx([
  { rowId: 'web-ui-market', moduleName: '@linxin666/dsh-web-all/market', enabled: false },
  { rowId: 'web-ui-i18n', moduleName: '@linxin666/dsh-i18n', enabled: true },
]))
after = readPending()
const byRow = (id) => (after.pending ?? []).find((p) => p.rowId === id)
check('合并时按 loader 补上 moduleName', byRow('web-ui-market')?.moduleName === '@linxin666/dsh-web-all/market', String(byRow('web-ui-market')?.moduleName))
check('合并时已启用的行直接记成已适配（不留 pending）', byRow('web-ui-i18n')?.status === 'adopted' && byRow('web-ui-i18n')?.adoptedBy === 'row-enabled', JSON.stringify(byRow('web-ui-i18n')))

// ── ⑨ 启动对账 reconcileCompatPending：补 moduleName + 已启用的转已适配 ──────────
reset({ frameworkVersion: '0.1.5-rc.2', pending: [
  { rowId: 'web-ui-market', moduleName: null, version: null, status: 'pending', check: 'unknown', checkNote: '启动失败隔离（safe-mode）' },
  { rowId: 'web-ui-i18n', moduleName: null, version: null, status: 'pending', check: 'unknown', checkNote: '启动失败隔离（safe-mode）' },
  { rowId: 'web-ui-settings', moduleName: '@linxin666/dsh-web-all/settings', version: null, status: 'pending', check: 'unknown' },
] })
const fixed = reconcileCompatPending(makeCtx([
  { rowId: 'web-ui-market', moduleName: '@linxin666/dsh-web-all/market', enabled: false },
  { rowId: 'web-ui-i18n', moduleName: '@linxin666/dsh-i18n', enabled: true },
  { rowId: 'web-ui-settings', moduleName: '@linxin666/dsh-web-all/settings', enabled: false },
]))
after = readPending()
const rows2 = after.pending ?? []
check('对账：老记录补上 moduleName', rows2.filter((p) => p.moduleName !== null && p.moduleName !== undefined).length >= 2, JSON.stringify(rows2.map((p) => [p.rowId, p.moduleName])))
check('对账：已启用的行从 pending 转为 adopted（你实测的核心问题）', rows2.find((p) => p.rowId === 'web-ui-i18n')?.status === 'adopted', JSON.stringify(rows2.find((p) => p.rowId === 'web-ui-i18n')))
check('对账：仍禁用的保持 pending（不误判为已适配）', rows2.find((p) => p.rowId === 'web-ui-market')?.status === 'pending')
check('对账：保留原有判定痕迹（checkNote 不丢）', typeof rows2.find((p) => p.rowId === 'web-ui-market')?.checkNote === 'string')
check('对账返回值可供日志核对', fixed.backfilled >= 1 && fixed.adopted === 1, JSON.stringify(fixed))

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
