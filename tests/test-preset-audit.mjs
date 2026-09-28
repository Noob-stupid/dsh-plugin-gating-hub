// 0.5.30 加法：预设声明行体检（磁盘预设 ↔ profile 声明行 跨源对账）。
//
// 真机背景（2026-09-28）：`profiles/web/cordis.patch.yml` 的 router-bootstrap 行指向
// `router-bootstrap-v1.mjs`，而 `router-spec/agent.cordis.yml` 自己写的是
// `./router-bootstrap-v10.mjs` → 老会话 resume 到错的模块，且没有任何地方会报。
//
// 本套钉死（全离线；IO 全注入）：
//   ① 解析：**只收文件型声明**（相对/绝对/file:）—— 包名行（`@deepseek-ai/dsh-persona` 之类）
//      不参与"按目录归属"的补丁匹配（真机试跑曾因此报 89 条假"缺失"）
//   ② 回归：`name:` 行在 `- id:` 下一行、缩进 2 时必须被读到（真机试跑抓到的"假绿"缺陷：
//      原来拿缩进和 id 的**字符长度**比 → 模块恒为 0 个、体检恒报"无差异"）
//   ③ 四类差异：陈旧（同 id 目标不同）/ 缺失（预设声明了补丁里没有）/ 悬空（补丁有预设没有）/
//      目标文件不存在；`disabled` 的悬空只算 warning 不算 blocker
//   ④ collectPresetAudit：端到端（注入 deps）；缺预设目录时如实返回 ok:false 而不是假绿
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const { auditPresetDeclarations, collectPresetAudit, parsePresetDeclarations } = await import('../lib/server/domain/preset-audit.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

const presetDir = 'C:\\U\\.agent-presets\\router-spec'
const presetText = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: hi',
  '- id: router-bootstrap',
  '  name: ./router-bootstrap-v10.mjs',
  '- id: pressure-sensor',
  '  name: ./pressure-sensor.mjs',
  '- id: off-thing',
  '  name: ./disabled.mjs',
  '  disabled: true',
].join('\n')

check('① 解析：只收文件型声明（包名行被过滤），id/target/line/disabled 正确', () => {
  const mods = parsePresetDeclarations(presetText)
  assert.deepEqual(mods.map((m) => m.id), ['router-bootstrap', 'pressure-sensor', 'off-thing'])
  assert.equal(mods[0].target, './router-bootstrap-v10.mjs')
  assert.equal(mods[0].line, 5, '行号要指向 - id: 那一行（router-bootstrap 在第 5 行）')
  assert.equal(mods[2].disabled, true)
  assert.ok(!mods.some((m) => m.id === 'persona'), '包名行不能进文件型声明')
})

check('② 回归（假绿缺陷）：name 在 id 下一行、缩进 2 → 必须被读到', () => {
  const mods = parsePresetDeclarations(['- id: a', '  name: ./a.mjs'].join('\n'))
  assert.equal(mods.length, 1, '缩进 2 的 name 必须被读到（旧实现恒为空 → 体检假绿）')
  assert.equal(mods[0].target, './a.mjs')
})

const io = {
  toLocalPath: (url) => url.replace('file:///', '').replace(/\//gu, '\\'),
  joinPath: (dir, rel) => join(dir, rel.replace(/^\.\//u, '')),
  dirnameOf: (p) => dirname(p),
  exists: () => true,
}

check('③ 陈旧：同 id 但目标不同（真机形态 v10 vs v1）→ blocker', () => {
  const r = auditPresetDeclarations({
    ...io,
    presets: [{ dir: presetDir, modules: parsePresetDeclarations(presetText) }],
    patchRows: [
      { id: 'router-bootstrap', name: 'file:///C:/U/.agent-presets/router-spec/router-bootstrap-v1.mjs', line: 113 },
      { id: 'pressure-sensor', name: 'file:///C:/U/.agent-presets/router-spec/pressure-sensor.mjs', line: 200 },
    ],
  })
  assert.equal(r.stale.length, 1)
  assert.equal(r.stale[0].id, 'router-bootstrap')
  assert.ok(r.stale[0].declared.endsWith('router-bootstrap-v10.mjs'))
  assert.ok(r.stale[0].patchTarget.endsWith('router-bootstrap-v1.mjs'))
  assert.equal(r.stale[0].patchLine, 113)
  assert.ok(r.blockers >= 1)
})

check('④ 缺失 / 悬空 / 目标不存在 / disabled 悬空只降级', () => {
  const r = auditPresetDeclarations({
    ...io,
    presets: [{ dir: presetDir, modules: parsePresetDeclarations(presetText) }],
    patchRows: [
      { id: 'router-bootstrap', name: 'file:///C:/U/.agent-presets/router-spec/router-bootstrap-v10.mjs', line: 113 },
      { id: 'pressure-sensor', name: 'file:///C:/U/.agent-presets/router-spec/pressure-sensor.mjs', line: 200 },
      { id: 'ghost', name: 'file:///C:/U/.agent-presets/router-spec/ghost.mjs', line: 300 },
      { id: 'ghost-off', name: 'file:///C:/U/.agent-presets/router-spec/ghost-off.mjs', line: 301, disabled: true },
    ],
  })
  assert.equal(r.stale.length, 0, '目标和预设一致时不该报陈旧')
  assert.deepEqual(r.missing.map((m) => m.id), ['off-thing'], '预设声明了但补丁没有 → 缺失')
  assert.deepEqual(r.orphan.map((o) => o.id).sort(), ['ghost', 'ghost-off'], '补丁有但预设没有 → 悬空')
  assert.equal(r.blockers, 1 + 1, '缺失 1 + 非 disabled 悬空 1')
})

check('⑤ 目标不存在：声明与补丁一致但文件缺失 → targetMissing', () => {
  const r = auditPresetDeclarations({
    toLocalPath: io.toLocalPath, joinPath: io.joinPath, dirnameOf: io.dirnameOf,
    exists: (p) => !String(p).includes('pressure-sensor'),
    presets: [{ dir: presetDir, modules: parsePresetDeclarations(presetText) }],
    patchRows: [
      { id: 'router-bootstrap', name: 'file:///C:/U/.agent-presets/router-spec/router-bootstrap-v10.mjs', line: 113 },
      { id: 'pressure-sensor', name: 'file:///C:/U/.agent-presets/router-spec/pressure-sensor.mjs', line: 200 },
    ],
  })
  assert.deepEqual(r.targetMissing.map((t) => t.id), ['pressure-sensor'])
})

check('⑥ collectPresetAudit：端到端（注入 deps）+ 缺预设目录时如实 ok:false', () => {
  const presetFile = 'C:\\U\\presets\\router-spec\\agent.cordis.yml'
  const patchFile = 'C:\\U\\profiles\\web\\cordis.patch.yml'
  const files = {
    [presetFile]: presetText,
    [patchFile]: '- id: router-bootstrap\n  name: file:///C:/U/presets/router-spec/router-bootstrap-v1.mjs\n',
  }
  const r = collectPresetAudit({
    presetsRoot: 'C:\\U\\presets',
    patchPath: patchFile,
    deps: {
      exists: (p) => p === 'C:\\U\\presets' || p in files,
      readdir: () => [{ name: 'router-spec', isDirectory: () => true }],
      readText: (p) => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p] },
      toLocal: (url) => url.replace('file:///', '').replace(/\//gu, '\\'),
      joinPath: (a, b) => (a === 'C:\\U\\presets' ? 'C:\\U\\presets\\' + b : a + '\\' + b.replace(/^\.\//u, '')),
      dirOf: (p) => p.replace(/\\[^\\]+$/u, ''),
    },
  })
  assert.equal(r.presetCount, 1)
  assert.equal(r.stale.length, 1, '端到端也要抓到 v10 vs v1')
  const empty = collectPresetAudit({ presetsRoot: 'Y:\\nope', patchPath: 'Y:\\p.yml', deps: { exists: () => false } })
  assert.equal(empty.ok, false)
  assert.equal(empty.blockers, 0)
})
console.log(passed === 6 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)