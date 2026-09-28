// 0.5.30 加法：补丁「行 → 包」可解析性体检（真机事故 2026-09-28 的判据固化）
//
// 真机事故原文（web profile，框架 0.2.0-rc.1 升级后）：
//   resume failed for session "session-ba73e81e-…": RemoteError: tool-workflow (@deepseek-ai/dsh-tool-workflow):
//     waiting for workflowEngine tool-ralph (@deepseek-ai/dsh-tool-ralph): waiting for workflowEngine (gateway/internal)
//   根因：0.2.0-rc.1 移除了 `@deepseek-ai/dsh-workflow-worker-thread`（引擎改为 `…-workflow-ptc`），
//   而补丁里三处行仍指向旧包名 → 该行解析失败 → workflowEngine 无提供方 → 两个工具永久 waiting。
//
// 本套断言（全离线：`resolve` / `existsFile` 全部注入，不碰真 profile、不用网络）：
//   ① 解析：嵌套行 / disabled / file:// / 行号 / CRLF 归一
//   ② 分类：解析失败=blocker；**已 disabled 的失败=warning**；子路径失败=warning；file:// 缺失=blocker；无 name=warning
//   ③ 建议：疑似改名要选对（`…-workflow-worker-thread` → `…-workflow-ptc`），不能乱指到 `…-tool-workflow`
//   ④ **不误杀**：`cordis:group` / 相对引用 / 真机修好后的补丁形状 → 0 blocker
import { strict as assert } from 'node:assert'
const {
  auditPatchText, classifyPatchRows, classifyTargetAvailability, frameworkPackageRows, parsePatchRows,
  scopeOf, suggestRenames, tokensOf, unquote,
} = await import('../lib/server/domain/patch-composition-audit.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

// 注：下面这段刻意用 CRLF，模拟真机磁盘上的补丁
const PATCH = [
  '  - id: delegation',
  '    name: cordis:group',
  '    config:',
  '      - id: tool-workflow',
  "        name: '@deepseek-ai/dsh-tool-workflow'",
  '',
  '      - id: workflow-worker-thread',
  "        name: '@deepseek-ai/dsh-workflow-worker-thread'",
  '        config:',
  '          provider: spawn',
  '',
  '      - id: tool-ralph',
  "        name: '@deepseek-ai/dsh-tool-ralph'",
  '',
  '- id: ui-settings',
  "  name: '@deepseek-ai/dsh-client-ui-settings'",
  '',
  '- id: old-thing',
  "  name: '@deepseek-ai/dsh-something-removed'",
  '  disabled: true',
  '',
  '- id: local-script',
  "  name: 'file:///C:/nope/missing.mjs'",
  '',
  '- id: no-name-row',
  '',
  '- id: subpath-row',
  "  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents-v2'",
].join('\r\n')

const AVAILABLE = [
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-workflow-ptc',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-tool-subagent-control',
]
const resolver = (ok) => (name) => (ok.includes(name) ? { ok: true, from: `/tree/${name}` } : { ok: false, reason: 'Cannot find module' })
const deps = { resolve: resolver(AVAILABLE), existsFile: () => false, candidates: AVAILABLE }

check('解析：行数/id/name/disabled/行号（含嵌套行）', () => {
  const rows = parsePatchRows(PATCH)
  const ids = rows.map((r) => r.id)
  assert.deepEqual(ids, ['delegation', 'tool-workflow', 'workflow-worker-thread', 'tool-ralph', 'ui-settings', 'old-thing', 'local-script', 'no-name-row', 'subpath-row'])
  const ww = rows.find((r) => r.id === 'workflow-worker-thread')
  assert.equal(ww.name, '@deepseek-ai/dsh-workflow-worker-thread')
  assert.equal(ww.disabled, false)
  assert.equal(ww.line, 7)
  const old = rows.find((r) => r.id === 'old-thing')
  assert.equal(old.disabled, true)
  const grp = rows.find((r) => r.id === 'delegation')
  assert.equal(grp.name, 'cordis:group')
})

check('分类：被移除的包 → blocker，且给出改名建议', () => {
  const r = auditPatchText(PATCH, deps)
  const hit = r.blockers.find((b) => b.name === '@deepseek-ai/dsh-workflow-worker-thread')
  assert.ok(hit, '旧包行必须进 blocker')
  assert.equal(hit.code, 'package-unresolvable')
  assert.equal(hit.row, 'workflow-worker-thread')
  assert.equal(hit.line, 7)
  assert.deepEqual(hit.suggestions, ['@deepseek-ai/dsh-workflow-ptc'], `建议应指向 ptc，实际 ${JSON.stringify(hit.suggestions)}`)
})

check('分类：已 disabled 的失败 → 只进 warning（不阻塞）', () => {
  const r = auditPatchText(PATCH, deps)
  assert.ok(!r.blockers.some((b) => b.name === '@deepseek-ai/dsh-something-removed'), 'disabled 行不该进 blocker')
  const w = r.warnings.find((x) => x.name === '@deepseek-ai/dsh-something-removed')
  assert.ok(w, 'disabled 行应进 warning')
  assert.equal(w.disabled, true)
})

check('分类：子路径失败 → warning（父包还在，只是导出变了）', () => {
  const r = auditPatchText(PATCH, deps)
  const w = r.warnings.find((x) => x.code === 'subpath-unresolvable')
  assert.ok(w, '子路径应进 warning')
  assert.equal(w.name, '@deepseek-ai/dsh-tool-subagent-control/list-agents-v2')
  assert.ok(!r.blockers.some((b) => b.code === 'subpath-unresolvable'))
})

check('分类：file:// 目标缺失 → blocker；行没有 name → warning', () => {
  const r = auditPatchText(PATCH, deps)
  assert.ok(r.blockers.some((b) => b.code === 'file-target-missing'), 'file:// 缺失必须是 blocker')
  assert.ok(r.warnings.some((w) => w.code === 'row-without-name'))
})

check('不误杀：cordis:group / 相对引用 不参与包解析', () => {
  const text = ['- id: g', '  name: cordis:group', '- id: rel', "  name: './x.mjs'"].join('\n')
  const r = auditPatchText(text, { resolve: () => ({ ok: false, reason: 'should-not-be-called' }) })
  assert.equal(r.blockers.length, 0)
  assert.equal(r.warnings.length, 0)
})

check('不误杀：真机修好后的形状（全可解析）→ 0 blocker 0 warning', () => {
  const r = auditPatchText(PATCH, { ...deps, resolve: () => ({ ok: true, from: '/ok' }), existsFile: () => true })
  assert.equal(r.blockers.length, 0, JSON.stringify(r.blockers))
  assert.equal(r.warnings.filter((w) => w.code !== 'row-without-name').length, 0)
})

check('建议启发式：同 scope + 前两词根一致者优先，不乱指 tool-*', () => {
  const { names: got, source } = suggestRenames('@deepseek-ai/dsh-workflow-worker-thread', AVAILABLE)
  assert.equal(got[0], '@deepseek-ai/dsh-workflow-ptc')
  assert.equal(source, 'known')
  assert.ok(!got.includes('@deepseek-ai/dsh-tool-workflow'), `不该建议 tool-*，实际 ${JSON.stringify(got)}`)
  assert.deepEqual(suggestRenames('@deepseek-ai/dsh-tool-workflow', AVAILABLE).names, [])
})

check('不误杀：补丁行（只改 config / 只改 disabled）不报警', () => {
  const text = ['- id: webserver', '  config:', "    host: '127.0.0.1'"].join('\n')
  const r = auditPatchText(text, { resolve: () => ({ ok: false, reason: 'x' }) })
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings))
  assert.deepEqual(r.patchOnly, ['webserver'])
  const toggle = auditPatchText(['- id: web-ui-pet', '  disabled: true'].join('\n'), { resolve: () => ({ ok: false, reason: 'x' }) })
  assert.equal(toggle.warnings.length, 0, JSON.stringify(toggle.warnings))
  assert.deepEqual(toggle.patchOnly, ['web-ui-pet'])
})

check('预检：只挑随框架版本走的包（@deepseek-ai/*），子路径归一成父包', () => {
  const rows = parsePatchRows([
    '- id: a',
    "  name: '@deepseek-ai/dsh-tool-workflow'",
    '- id: b',
    "  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
    '- id: c',
    "  name: '@linxin666/dsh-i18n'",
    '- id: d',
    "  name: 'cordis:group'",
    '- id: e',
    "  name: 'file:///x/y.mjs'",
  ].join('\n'))
  const fw = frameworkPackageRows(rows)
  assert.deepEqual(fw.map((x) => x.name).sort(), ['@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-workflow'])
  // 行号记的是『- id: 那一行』（不是 name 行）—— 报错时指回补丁里可定位的锚点
  assert.deepEqual(fw.find((x) => x.name === '@deepseek-ai/dsh-tool-subagent-control').lines, [3])
})

check('预检：目标版本核对 —— false=missing（带权威建议）/ true=通过 / null=unknown 不判死', () => {
  const entries = [
    { name: '@deepseek-ai/dsh-workflow-worker-thread', lines: [317, 615, 922] },
    { name: '@deepseek-ai/dsh-tool-workflow', lines: [321] },
    { name: '@deepseek-ai/dsh-mystery-pkg', lines: [9] },
  ]
  const publishedBy = new Map([
    ['@deepseek-ai/dsh-workflow-worker-thread', false],
    ['@deepseek-ai/dsh-tool-workflow', true],
    ['@deepseek-ai/dsh-mystery-pkg', null],
  ])
  const r = classifyTargetAvailability(entries, { publishedBy, targetVersion: '0.2.0-rc.1', candidates: AVAILABLE })
  assert.equal(r.missing.length, 1)
  assert.equal(r.missing[0].name, '@deepseek-ai/dsh-workflow-worker-thread')
  assert.deepEqual(r.missing[0].suggestions, ['@deepseek-ai/dsh-workflow-ptc'])
  assert.deepEqual(r.missing[0].lines, [317, 615, 922])
  assert.equal(r.missing[0].targetVersion, '0.2.0-rc.1')
  assert.equal(r.unknown.length, 1)
  assert.equal(r.unknown[0].name, '@deepseek-ai/dsh-mystery-pkg')
})
check('工具函数：scopeOf / tokensOf / unquote（两边引号与裸值）', () => {
  assert.equal(scopeOf('@deepseek-ai/x'), '@deepseek-ai')
  assert.equal(scopeOf('plain'), '')
  assert.deepEqual(tokensOf('@deepseek-ai/dsh-workflow-ptc'), ['dsh', 'workflow', 'ptc'])
  assert.equal(unquote("'a'"), 'a')
  assert.equal(unquote('"a"'), 'a')
  assert.equal(unquote('a'), 'a')
})

console.log(`\n${passed} PASS${process.exitCode === 1 ? ' / 有失败' : ' / 全绿'}`)