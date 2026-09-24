// 会话格式契约预检（Step 1 契约抓取 + Step 2 生产方扫描/补丁）离线回归测试。
//
// 为什么要有它：2026-09-24 真机事故——框架升到 0.1.7-rc.1 后会话消息格式升到 V4，运行期
// 生产方（agent-presets + 插件 runtime）仍写 V3 的 `kind: 'plugin'` 包装，导致「一发消息就报
// format v4 message requires a producer-owned source kind，整个会话不可用」。这个预检的全部
// 价值是「升级前先把本地适配好」，所以本测试把三件事钉死：
//   ① 契约解析：能从目标版本的依赖里认出迁移边（多一条边 = 一次契约变更）并抽出规则；
//   ② 扫描/补丁：真机同款写法必须能改、已修好的不误报、测试文件与名单外文件绝不触碰；
//   ③ 路由端到端：离线（DSH_TEST_SKIP_NETWORK=1）也能给出可用报告。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'format-preflight-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })

const profileDir = join(HOME, 'profiles', 'web')
const presetDir = join(HOME, 'agent-presets', 'router-react')
mkdirSync(presetDir, { recursive: true })
mkdirSync(join(profileDir, 'node_modules', '@fake', 'legacy-plugin'), { recursive: true })
mkdirSync(join(profileDir, 'node_modules', '@fake', 'clean-plugin'), { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(patchPath, '# user patch\n', 'utf8')

const writePkg = (name, files) => {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }), 'utf8')
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text, 'utf8')
}

// ① 预设文件：真机同款多行写法（标识符拼模板字符串）+ 字符串字面量
const PRESET_FILE = join(presetDir, 'router-bootstrap.mjs')
writeFileSync(PRESET_FILE, [
  'const SIDE_INJECTION_PLUGIN = "dsh-better-sidebar"',
  'export function admit(agent, injectionText) {',
  '  agent.inject(createUserMessage({',
  '    content: textPrompt(injectionText),',
  '    source: {',
  "      kind: 'plugin',",
  '      plugin: SIDE_INJECTION_PLUGIN',
  '    }',
  '  }))',
  '}',
  'export const literal = { source: { kind: "plugin", plugin: "acme" } }',
  'export const already = { source: { kind: `plugin:${SIDE_INJECTION_PLUGIN}` } }',
  '',
].join('\n'), 'utf8')

// ② 插件 runtime：旧包装 + 测试文件里的旧包装（必须被忽略）+ 已移除 API（只报告）
writePkg('@fake/legacy-plugin', {
  'index.js': [
    "const OPENVIKING_PLUGIN_SOURCE = 'openviking'",
    'export const msg = { source: { kind: "plugin", plugin: OPENVIKING_PLUGIN_SOURCE } }',
    'export const schema = z.boolean().default(false).volatile()',
    '',
  ].join('\n'),
  'index.test.js': 'export const t = { source: { kind: "plugin", plugin: "test-only" } }\n',
  'index.spec.js': 'export const t2 = { source: { kind: "plugin", plugin: "test-only" } }\n',
})
writePkg('@fake/clean-plugin', {
  'index.js': 'export const ok = { source: { kind: `plugin:${"already-fixed"}` } }\n',
})
// 框架作用域包（实网形态：profile 里手工铺的 @deepseek-ai/* 真实副本，路径判定认不出来）
writePkg('@deepseek-ai/dsh-fake-schedule', {
  'index.js': "const S = 'schedule'\nexport const z = { source: { kind: 'plugin', plugin: S } }\n",
})

const {
  parseFormatEdge,
  formatEdgesFromDependencies,
  extractContractRules,
  buildContract,
  discoverFormatContract,
  summarizeContract,
} = await import('./lib/server/domain/format-contract.js')
const {
  planSourceKindRewrites,
  applyRewrites,
  scanProducerText,
  scanProducerFiles,
  collectProducerTargets,
  applyFormatPatch,
  probeSchemasteryVolatile,
} = await import('./lib/server/domain/format-scan.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── ① 契约解析 ──────────────────────────────────────────────────────────────
check('迁移边识别：v3-to-v4', JSON.stringify(parseFormatEdge('@deepseek-ai/dsh-session-format-v3-to-v4')) === JSON.stringify({ name: '@deepseek-ai/dsh-session-format-v3-to-v4', from: 3, to: 4 }))
check('非迁移边返回 null', parseFormatEdge('@deepseek-ai/dsh-session-format') === null && parseFormatEdge('foo') === null)
const edges = formatEdgesFromDependencies({
  '@deepseek-ai/dsh-session-format': '^0.1.7-rc.1',
  '@deepseek-ai/dsh-session-format-v0-to-v1': '^0.1.7-rc.1',
  '@deepseek-ai/dsh-session-format-v2-to-v3': '^0.1.7-rc.1',
  '@deepseek-ai/dsh-session-format-v3-to-v4': '^0.1.7-rc.1',
  '@deepseek-ai/dsh-agent': '^0.1.7-rc.1',
})
check('依赖表里只挑迁移边并按 to 升序', edges.length === 3 && edges[2].to === 4 && edges[0].to === 1, JSON.stringify(edges.map((e) => `${e.from}->${e.to}`)))

const README = [
  '## Table of Contents',
  '',
  '- [Message-source conversion](#message-sources)',
  '- [Parent catalog prerequisites](#parent-catalog)',
  '',
  '| Producer attribution | Interpreted message slots require an object source with a nonempty, non-`plugin` kind. Unknown attribution and own JSON metadata survive. |',
  '',
  '### Tool-result representation',
  '',
  '| `data.message.role: \'user\'` | `role: \'tool\'` |',
  '| `user/message` | `data.content[]` |',
  '',
  '### Message-source conversion',
  '',
  'The walker visits only these payload positions.',
  '',
  '| Owning event | Message position |',
  '|---|---|',
  '| `user/message` | `data` |',
  '',
  'A plugin source requires a string `plugin`.',
  '',
  '| Exact V3 `plugin` | V4 `kind` |',
  '|---|---|',
  '| `compact` | `compact-checkpoint` |',
  '| `tools-code-mode`, `tools-ptc` | `ptc-mode` |',
  '| `dsh-compaction-basic` | `compact-basic` |',
  '| Any other plugin name | `plugin:` followed by the complete original name |',
  '',
  '### Parent catalog prerequisites',
  '',
  '| `childId` | `descriptorCount` |',
].join('\n')
const rules = extractContractRules(README)
check('抽出 producer-attribution 规则（要求 producer-owned kind）', rules.producerKindRequired === true, rules.attributionExcerpt)
check('抽出 plugin: 前缀规则', rules.pluginPrefix === 'plugin:', String(rules.pluginPrefix))
check('抽出重命名表（compact→compact-checkpoint）', rules.renames.compact === 'compact-checkpoint' && rules.renames['dsh-compaction-basic'] === 'compact-basic', JSON.stringify(rules.renames))
check('角色敏感的复合行不进重命名表（避免误改）', rules.renames['tools-code-mode'] === undefined)
check('只在小节内解析重命名表（不混入其它表格噪音）', rules.renames['user/message'] === undefined && rules.renames['childId'] === undefined && Object.keys(rules.renames).length === 2, JSON.stringify(rules.renames))
check('目录（ToC）里的同名条目不会顶替真正的小节', rules.renames.compact === 'compact-checkpoint')

const contract = buildContract({
  targetVersion: '0.1.7-rc.1',
  dependencies: { '@deepseek-ai/dsh-session-format-v3-to-v4': '^0.1.7-rc.1' },
  edgeReadmes: { '@deepseek-ai/dsh-session-format-v3-to-v4': README },
})
check('契约：会话格式版本 = 4', contract.sessionFormatVersion === 4, String(contract.sessionFormatVersion))
check('契约：规则取自最高那条边', contract.rules.pluginPrefix === 'plugin:' && contract.edges.length === 1)
check('契约摘要可读', /会话格式 v4/u.test(summarizeContract(contract)), summarizeContract(contract))

// 发现路径①：catalog 是迁移边全集的权威载体（实网确认：顶层 dsh 只挂中间包，边在 catalog 依赖里）
const catalogCalls = []
const discCatalog = await discoverFormatContract({
  targetVersion: '0.1.7-rc.1',
  currentVersion: '0.1.5-rc.2',
  fetchJson: async (url) => {
    catalogCalls.push(url)
    if (url.includes('session-format-catalog') && url.includes('0.1.7-rc.1')) {
      return { dependencies: {
        '@deepseek-ai/dsh-session-format': '^0.1.7-rc.1',
        '@deepseek-ai/dsh-session-format-v2-to-v3': '^0.1.7-rc.1',
        '@deepseek-ai/dsh-session-format-v3-to-v4': '^0.1.7-rc.1',
      } }
    }
    if (url.includes('session-format-catalog') && url.includes('0.1.5-rc.2')) {
      return { dependencies: { '@deepseek-ai/dsh-session-format-v2-to-v3': '^0.1.5-rc.2' } }
    }
    return { dependencies: {} }
  },
  fetchText: async () => README,
})
check('catalog 优先作为迁移边来源', discCatalog.contract.edgeSource === 'catalog' && discCatalog.contract.sessionFormatVersion === 4, discCatalog.contract.edgeSource)
check('新增迁移边被识别为契约变更信号（v3→v4）', discCatalog.contract.edgesAdded.length === 1 && discCatalog.contract.edgesAdded[0].to === 4, JSON.stringify(discCatalog.contract.edgesAdded))
check('摘要明确提示「新增迁移边」', /新增迁移边/u.test(summarizeContract(discCatalog.contract)), summarizeContract(discCatalog.contract))

// 发现路径②：catalog 不可用时退回顶层 dsh 依赖（不能因为没有 catalog 就放弃预检）
const discFallback = await discoverFormatContract({
  targetVersion: '0.1.7-rc.1',
  fetchJson: async (url) => {
    if (url.includes('session-format-catalog')) throw new Error('HTTP 404')
    return { dependencies: { '@deepseek-ai/dsh-session-format-v3-to-v4': '^0.1.7-rc.1' } }
  },
  fetchText: async () => README,
})
check('catalog 缺失时退回顶层 dsh 依赖', discFallback.contract.edgeSource === 'dsh' && discFallback.contract.sessionFormatVersion === 4, discFallback.contract.edgeSource)

// discoverFormatContract：注入 fetch，验证「首选通道失败 → 次选通道兜底」
const fetched = []
const discovered = await discoverFormatContract({
  targetVersion: '0.1.7-rc.1',
  fetchJson: async () => ({ dependencies: { '@deepseek-ai/dsh-session-format-v3-to-v4': '^0.1.7-rc.1' } }),
  fetchText: async (url) => { fetched.push(url); if (url.includes('jsdelivr')) throw new Error('CDN 不可达'); return README },
})
check('README 多通道兜底（jsDelivr 失败后走 npmmirror）', discovered.contract.rules.pluginPrefix === 'plugin:' && fetched.length === 2, fetched.join(' | '))
const failedDiscovery = await discoverFormatContract({ targetVersion: '9.9.9', fetchJson: async () => { throw new Error('registry 不可达') } })
check('registry 不可达时返回 error 而不抛（降级为内置规则扫描）', failedDiscovery.contract === null && /registry 不可达/u.test(String(failedDiscovery.error)), String(failedDiscovery.error))

// ── ② 重写引擎（纯文本）──────────────────────────────────────────────────────
const { rewrites, unresolved } = planSourceKindRewrites(readFileSync(PRESET_FILE, 'utf8'))
const afters = rewrites.map((r) => r.after)
check('标识符写法 → 模板字符串', afters.includes('`plugin:${SIDE_INJECTION_PLUGIN}`'), JSON.stringify(afters))
check('字符串字面量写法 → plugin:acme（保留原引号风格）', afters.some((a) => /^['"]plugin:acme['"]$/u.test(a)), JSON.stringify(afters))
check('已符合 v4 的写法不重复重写', rewrites.length === 2 && !JSON.stringify(afters).includes('plugin:${SIDE_INJECTION_PLUGIN}`,'))
const rewritten = applyRewrites(readFileSync(PRESET_FILE, 'utf8'), rewrites)
check('重写后原文件里的旧形状消失', !/kind:\s*['"]plugin['"]/u.test(rewritten) && rewritten.includes('`plugin:${SIDE_INJECTION_PLUGIN}`'))
const bare = planSourceKindRewrites("export const x = { source: { kind: 'plugin' } }")
check("只有 kind:'plugin' 没有 plugin: 字段 → 只报告不修改", bare.rewrites.length === 0 && bare.unresolved.length === 1, JSON.stringify(bare.unresolved))
// 真实数据里的假阳性来源：JSDoc 注释里写着 kind: 'plugin'（dsh-better-sidebar:4086 实网抓到过）
const commented = [
  "// kind: 'plugin' 只是文档里的字样，不是代码",
  '/* export const fake = { source: { kind: "plugin", plugin: "doc-only" } } */',
  "export const real = { source: { kind: 'plugin', plugin: 'real-one' } }",
].join('\n')
const cPlan = planSourceKindRewrites(commented)
check('注释里的旧形状不算代码（不误报、不改写）', cPlan.rewrites.length === 1 && cPlan.rewrites[0].after.includes('plugin:real-one'), JSON.stringify(cPlan.rewrites.map((r) => r.after)))
const renameCase = planSourceKindRewrites("export const x = { source: { kind: 'plugin', plugin: 'compact' } }", rules)
check('重命名表命中时用专名（compact→compact-checkpoint）', renameCase.rewrites[0]?.after === "'compact-checkpoint'", JSON.stringify(renameCase.rewrites.map((r) => r.after)))

// ── ②b 探针门控（修好依赖后规则必须自动静默，否则报告自相矛盾）───────────────
const VOLATILE_SRC = 'const s = z.boolean().default(false).volatile()\n'
const probeCase = (probe) => scanProducerText({ file: '/x/index.js', text: VOLATILE_SRC, targetVersion: '0.1.7-rc.1', probe })
check('探针确认副本有 .volatile → 不报告（依赖对齐后自动静默）', probeCase(() => ({ ok: true, version: '3.18.4', dir: '/x' })).length === 0)
const badProbe = probeCase(() => ({ ok: false, version: '3.18.1', dir: '/x' }))
check('探针确认副本缺 .volatile → 报告并写明实测版本', badProbe.some((f) => f.rule === 'schemastery-volatile' && /3\.18\.1/u.test(f.note)), JSON.stringify(badProbe.map((f) => f.note)))
const unknownProbe = probeCase(() => ({ ok: null, version: null, dir: null, error: '解析失败' }))
check('探针无法判定 → 仍报告且如实说明（不假装通过）', unknownProbe.some((f) => f.rule === 'schemastery-volatile' && /无法判定/u.test(f.note)))
check('探针缺省（未注入）时保守报告', scanProducerText({ file: '/x/index.js', text: VOLATILE_SRC, targetVersion: '0.1.7-rc.1' }).some((f) => f.rule === 'schemastery-volatile'))

// ── ③ 扫描 + 补丁（夹具落盘）─────────────────────────────────────────────────
const roots = [
  { root: join(HOME, 'agent-presets'), kind: 'preset' },
  { root: join(profileDir, 'node_modules', '@fake', 'legacy-plugin'), kind: 'plugin', moduleName: '@fake/legacy-plugin' },
  { root: join(profileDir, 'node_modules', '@fake', 'clean-plugin'), kind: 'plugin', moduleName: '@fake/clean-plugin' },
]
const targets = collectProducerTargets(roots)
const scanned = scanProducerFiles({ targets, rules, targetVersion: '0.1.7-rc.1' })
const fixedPaths = [...new Set(scanned.findings.map((f) => f.file))]
check('扫描覆盖到预设与两个插件包（测试文件已排除，共 3 个文件）', targets.length === 3, targets.map((t) => t.file.replace(HOME, '.')).join(' , '))
check('测试文件被忽略（.test.js / .spec.js 不进扫描面）', !targets.some((t) => /\.(test|spec)\.js$/u.test(t.file)))
check('旧形状全部判为 blocker（预设 2 处 + 插件 1 处）', scanned.blockers === 3, `blockers=${scanned.blockers}`)
check('已修好的插件零告警', !scanned.findings.some((f) => f.file.includes('clean-plugin')))
check('schemastery .volatile() 被报告且不可自动修', scanned.findings.some((f) => f.rule === 'schemastery-volatile' && f.fixable === false))
check('扫描结论 ok=false（有 blocker）', scanned.ok === false)
check('扫描报告带按规则聚合的计数', scanned.byRule['legacy-source-kind'] === 3 && scanned.byRule['schemastery-volatile'] === 1, JSON.stringify(scanned.byRule))

// 框架自带包（真实数据里 @deepseek-ai/dsh-schedule 就是这种）与 pnpm 中断残留目录
const fwDir = join(HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-fake')
mkdirSync(fwDir, { recursive: true })
writeFileSync(join(fwDir, 'index.js'), "const S = 'schedule'\nexport const z = { source: { kind: 'plugin', plugin: S } }\n", 'utf8')
const tmpDir = join(profileDir, 'node_modules', '@fake', 'legacy-plugin', 'legacy_tmp_13824_1')
mkdirSync(tmpDir, { recursive: true })
writeFileSync(join(tmpDir, 'index.js'), "export const t = { source: { kind: 'plugin', plugin: 'tmp' } }\n", 'utf8')
const targets2 = collectProducerTargets([...roots, { root: fwDir, kind: 'framework', moduleName: '@deepseek-ai/dsh-fake' }])
const scanned2 = scanProducerFiles({ targets: targets2, rules, targetVersion: '0.1.7-rc.1' })
check('pnpm _tmp_ 残留目录不进扫描面', !targets2.some((t) => /_tmp_\d+/u.test(t.file)), targets2.map((t) => t.file.replace(HOME, '.')).join(' , '))
check('框架自带包命中旧形状 → 降级为提示且不可自动改', scanned2.findings.some((f) => f.rule === 'legacy-source-kind-framework' && f.fixable === false && f.severity === 'warn'))
check('框架自带包不计入 blocker（正确处置是回滚/适配门，不是改框架文件）', scanned2.blockers === 3, `blockers=${scanned2.blockers}`)
const fwApply = applyFormatPatch({ targets: targets2.filter((t) => t.kind === 'framework'), rules, targetVersion: '0.1.7-rc.1', stamp: 'fw' })
check('apply 不碰框架自带包（即使它命中旧形状）', fwApply.changes.length === 0 && fwApply.backups.length === 0)

const stamp = 'testfix'
const dry = applyFormatPatch({ targets, rules, targetVersion: '0.1.7-rc.1', stamp, dryRun: true })
check('dry-run 出 diff 但不落盘、不产生备份', dry.changes.length === 3 && dry.backups.length === 0 && existsSync(`${PRESET_FILE}.bak-preflight-${stamp}`) === false)
check('dry-run 后文件内容未变', readFileSync(PRESET_FILE, 'utf8').includes("kind: 'plugin'"))

const applied = applyFormatPatch({ targets, rules, targetVersion: '0.1.7-rc.1', stamp })
check('apply 落盘 3 处改动 + 2 个文件备份', applied.changes.length === 3 && applied.backups.length === 2, JSON.stringify(applied.backups.map((b) => b.replace(HOME, '.'))))
check('备份保留旧内容（可回滚）', readFileSync(`${PRESET_FILE}.bak-preflight-${stamp}`, 'utf8').includes("kind: 'plugin'"))
check('落盘后旧形状消失', !/kind:\s*['"]plugin['"]/u.test(readFileSync(PRESET_FILE, 'utf8')) && !/kind:\s*['"]plugin['"]/u.test(readFileSync(join(profileDir, 'node_modules', '@fake', 'legacy-plugin', 'index.js'), 'utf8')))
const rescan = scanProducerFiles({ targets, rules, targetVersion: '0.1.7-rc.1' })
check('复扫后 blocker 归零（只剩报告项 .volatile）', rescan.blockers === 0 && rescan.warnings === 1, `blockers=${rescan.blockers} warnings=${rescan.warnings}`)
const idempotent = applyFormatPatch({ targets, rules, targetVersion: '0.1.7-rc.1', stamp: 'again' })
check('幂等：再跑不产生新改动/新备份', idempotent.changes.length === 0 && idempotent.backups.length === 0)

const outside = applyFormatPatch({ targets: targets.filter((t) => t.file.includes('clean-plugin')), rules, targetVersion: '0.1.7-rc.1', stamp: 'nope' })
check('名单外文件绝不触碰（越权写入被 skipped）', outside.changes.length === 0 && outside.backups.length === 0)

// ── ③b 真实探针：按文件位置解析依赖（复现 2026-09-24 profile 副本漂移）─────────
const probePkgDir = join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery')
mkdirSync(join(probePkgDir, 'lib'), { recursive: true })
const legacyFile = join(profileDir, 'node_modules', '@fake', 'legacy-plugin', 'index.js')
const writeSchemastery = (version, body) => {
  writeFileSync(join(probePkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version, main: 'lib/index.cjs' }), 'utf8')
  writeFileSync(join(probePkgDir, 'lib', 'index.cjs'), body, 'utf8')
}
writeSchemastery('3.18.1', 'module.exports = { Schema: function Schema() {} }\n')
const probeBad = probeSchemasteryVolatile(legacyFile, new Map())
check('真实探针：解析到 3.18.1 副本 → 判定缺少 .volatile()', probeBad.ok === false && probeBad.version === '3.18.1', JSON.stringify(probeBad))
writeSchemastery('3.18.4', 'Schema.prototype.volatile = function volatile() { return this }\n')
const probeGood = probeSchemasteryVolatile(legacyFile, new Map())
check('真实探针：换成 3.18.4 副本 → 判定通过（真实修复后 66 条告警应当归零）', probeGood.ok === true && probeGood.version === '3.18.4', JSON.stringify(probeGood))

// ── ④ 路由端到端（离线）──────────────────────────────────────────────────────
// 重新铺一份「未修过」的夹具，避免上面 apply 的结果影响路由断言
writeFileSync(PRESET_FILE, "export const x = { source: { kind: 'plugin', plugin: 'router' } }\n", 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'legacy-plugin', 'index.js'), "export const y = { source: { kind: 'plugin', plugin: 'legacy' } }\n", 'utf8')
const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      { id: 'include:legacy-plugin', options: { name: '@fake/legacy-plugin' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:clean-plugin', options: { name: '@fake/clean-plugin' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:dsh-fake-schedule', options: { name: '@deepseek-ai/dsh-fake-schedule' }, disabled: false, fiber: { state: 2 } },
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const mod = await import('./lib/index.js')
mod.apply(ctx)
const route = globalThis.__route
const fakeReq = (method, pathname, body) => ({
  method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
  signal: { aborted: false, addEventListener: () => {} },
  [Symbol.asyncIterator]() {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    let i = 0
    return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
  },
})
const fakeRes = () => { const r = { status: 0, body: null }; r.writeHead = (s) => { r.status = s }; r.end = (p) => { r.body = p }; return r }
const call = async (method, path, body) => { const r = fakeRes(); await route.handler(fakeReq(method, path, body), r); return { status: r.status, json: r.body === null ? null : JSON.parse(r.body) } }

const pre = await call('POST', '/plugin-console/framework-preflight', { targetVersion: '0.1.7-rc.1' })
check('预检路由可达且返回报告', pre.status === 200 && pre.json.ok === true && pre.json.scan !== undefined, `status=${pre.status}`)
check('框架包命中旧形状只算提示、不算 blocker', pre.json.scan.blockers === 2 && pre.json.scan.warnings >= 1, `blockers=${pre.json.scan.blockers} warnings=${pre.json.scan.warnings}`)
check('离线模式如实说明契约未知（不假装成功）', pre.json.contract === null && /跳过网络/u.test(String(pre.json.contractError)), String(pre.json.contractError))
check('离线模式用内置规则仍能扫出 blocker', pre.json.scan.blockers >= 2, `blockers=${pre.json.scan.blockers}`)
check('报告带扫描面（预设 + 插件包）', Array.isArray(pre.json.roots) && pre.json.roots.some((r) => r.kind === 'preset') && pre.json.roots.some((r) => r.kind === 'plugin'))
check('框架作用域包（@deepseek-ai/*）即使物理在 profile 内也判为框架包', pre.json.roots.some((r) => r.kind === 'framework' && r.moduleName === '@deepseek-ai/dsh-fake-schedule'), JSON.stringify(pre.json.roots.map((r) => `${r.kind}:${r.moduleName ?? '-'}`)))

const plan = await call('POST', '/plugin-console/framework-preflight-patch', { targetVersion: '0.1.7-rc.1', mode: 'plan' })
check('补丁路由 plan 模式只出 diff', plan.status === 200 && plan.json.mode === 'plan' && plan.json.changes.length === 2 && plan.json.backups.length === 0, `changes=${plan.json.changes?.length}`)
const applyRoute = await call('POST', '/plugin-console/framework-preflight-patch', { targetVersion: '0.1.7-rc.1', mode: 'apply' })
check('补丁路由 apply 模式写回并留下备份', applyRoute.status === 200 && applyRoute.json.backups.length === 2 && applyRoute.json.remaining.blockers === 0, JSON.stringify(applyRoute.json.backups?.map((b) => b.replace(HOME, '.'))))
check('应用后文件已是 v4 形状', readFileSync(PRESET_FILE, 'utf8').includes("'plugin:router'"), readFileSync(PRESET_FILE, 'utf8').trim())

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
