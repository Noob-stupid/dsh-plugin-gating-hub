// 契约规则库回归测试（lib/contracts/rules.json + domain/contract-rules.js）—— 2026-09-24。
//
// 规则库的价值在「能被社区 PR」，所以它必须**自证干净**：
//   · 字段齐全、取值合法、id 唯一、since 可解析；
//   · 声称 implementedBy 的规则，必须真有对应实现（不许登记幻影规则骗覆盖）；
//   · 数据随包发布（lib/contracts/）—— 用户装到的是同一份；读不到时如实回报 unavailable，
//     绝不能把「规则文件缺失」伪装成「零发现」。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
process.env.DSH_TEST_SKIP_NETWORK = '1'

const { KINDS, RULES_RELATIVE, SEVERITIES, loadContractRules, summarizeContractRules } = await import('../lib/server/domain/contract-rules.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const pack = loadContractRules()
check('规则库能从包里读到（数据随 lib/** 发布）', pack.source === 'pack' && pack.error === null, JSON.stringify({ source: pack.source, error: pack.error }))
check('规则库带版本号与更新时间', typeof pack.version === 'number' && typeof pack.updatedAt === 'string', `version=${pack.version} updatedAt=${pack.updatedAt}`)
check('规则非空', pack.rules.length >= 5, `rules=${pack.rules.length}`)

const ids = pack.rules.map((r) => r.id)
check('规则 id 唯一', new Set(ids).size === ids.length, ids.join(','))
check('每条规则字段齐全（id/title/detect/fix/evidence）', pack.rules.every((r) => r.id !== '' && r.title !== '' && r.detect !== '' && r.fix !== '' && r.evidence !== ''))
check('kind 取值合法', pack.rules.every((r) => KINDS.includes(r.kind)), [...new Set(pack.rules.map((r) => r.kind))].join(','))
check('severity 取值合法', pack.rules.every((r) => SEVERITIES.includes(r.severity)))
check('since 可解析为版本号', pack.rules.every((r) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(r.since)), pack.rules.map((r) => r.since).join(','))

// 核心诚实性检查：声称自动检测的规则，实现必须真的在（模块文件存在 或 探针 id 出现在扫描器里）
const scanSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'format-scan.js'), 'utf8')
const compatSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'compat.js'), 'utf8')
const presetSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'presets.js'), 'utf8')
const patchSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'patch.js'), 'utf8')
const haystack = `${scanSrc}\n${compatSrc}\n${presetSrc}\n${patchSrc}`
const claimed = pack.rules.filter((r) => r.implementedBy !== null)
check('有规则声称自动检测（否则规则库只是文档）', claimed.length >= 3, `claimed=${claimed.length}/${pack.rules.length}`)
for (const rule of claimed) {
  const marker = rule.implementedBy.split(/[（(]/u)[0].trim()
  const bare = marker.split('/').pop()
  check(`规则 ${rule.id} 的 implementedBy 真存在（${marker}）`, haystack.includes(bare), bare)
}
const notImplemented = pack.rules.filter((r) => r.implementedBy === null).map((r) => r.id)
if (notImplemented.length > 0) console.log(`提示：${notImplemented.length} 条规则仅登记、尚未自动检测（${notImplemented.join(',')}）—— 诚实标注，不算失败`)

const summary = summarizeContractRules(pack)
check('摘要字段完整（total/blockers/autoDetected/ids）', summary.total === pack.rules.length && typeof summary.blockers === 'number' && typeof summary.autoDetected === 'number' && Array.isArray(summary.ids), JSON.stringify(summary).slice(0, 160))
check('摘要里 blocker 数 = 规则里 blocker 数', summary.blockers === pack.rules.filter((r) => r.severity === 'blocker').length)

// 读不到规则文件时必须如实回报 unavailable（不能假装「零发现」）
const realPath = join(ROOT, '..', RULES_RELATIVE)
const backup = readFileSync(realPath, 'utf8')
const { existsSync, renameSync } = await import('node:fs')
const tmpPath = `${realPath}.test-hidden`
renameSync(realPath, tmpPath)
try {
  const missing = loadContractRules()
  check('规则文件缺失 → source=unavailable 且带原因（不谎报零发现）', missing.source === 'unavailable' && typeof missing.error === 'string' && missing.rules.length === 0, JSON.stringify(missing).slice(0, 140))
} finally {
  renameSync(tmpPath, realPath)
}
check('恢复后规则库仍能读到', existsSync(realPath) && loadContractRules().source === 'pack')

// 脏数据要被丢弃而不是让预检崩
const { normalizeRule } = await import('../lib/server/domain/contract-rules.js')
check('缺 id 的规则被丢弃', normalizeRule({ since: '1.0.0' }) === null)
check('缺 since 的规则被丢弃', normalizeRule({ id: 'x' }) === null)
check('非法 kind/severity 退化为安全默认值', normalizeRule({ id: 'x', since: '1.0.0', kind: 'nonsense', severity: 'nonsense' }).kind === 'contract-edge' && normalizeRule({ id: 'x', since: '1.0.0' }).severity === 'warn')

// 文档存在且指向同一份数据（用户 PR 的入口）
const doc = readFileSync(join(ROOT, '..', 'docs', 'contracts', 'README.md'), 'utf8')
check('docs/contracts/README.md 存在且指向 lib/contracts/rules.json', doc.includes('lib/contracts/rules.json') && doc.includes('implementedBy'))
check('规则库文件在随包发布的目录里', RULES_RELATIVE.replace(/\\/gu, '/') === 'lib/contracts/rules.json')

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
