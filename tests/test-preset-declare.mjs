// 0.5.28 改错（**预设机制迁移**：框架 0.1.7-rc.x 起预设不再靠目录发现，改为 profile 补丁里的**声明行**）。
//
// 真 bug：0.1.5 及更早由 @deepseek-ai/dsh-agent-presets 扫 `$DSH_HOME/.agent-presets/` 目录发现预设；
// 0.1.7-rc.2 起该包**不在依赖图、也没被挂载**，注册表 `definitions` 是内存 Map（无任何 fs 调用）——
// 目录发现彻底没了，载体变成 `cordis.patch.yml` 里的一行
//   - insert: { id: preset-<x>, name: '@deepseek-ai/dsh-agent-preset', config: {id,name?,description?,order?,plugins} }
// 而我们的产品仍只往 `.agent-presets` 写文件并提示"新建会话时选择" → **用户根本看不见预设**
// （官方桌面端「自定义」分组为空就是这么来的），老会话 resume 还会 Unknown agent preset。
//
// 本套把新模块 preset-declare.js 的判据与落盘全部钉死（**全离线**，复用真 DSH_HOME 之外的一次性临时 home）：
//   ① 声明行的形状：行 id `preset-<id>`、模块名、config 五个字段、plugins 缩进 10 空格
//   ② 相对文件 `./x.mjs` → `file:///` 绝对 URL（**基准是 profile 目录**，不是预设目录；非 ASCII/含空格路径要百分号编码）
//   ③ 预设目录里不存在同名文件 → **原样保留**（不猜路径）
//   ④ 幂等：同 id 行已存在且内容一致 → 一个字节都不写、不建备份
//   ⑤ 更新：同 id 行内容变了 → 原地替换（不重复插入），改前留 `.bak-preset-<ts>` 备份
//   ⑥ 已是绝对路径（file: / 绝对路径）→ 一动不动
//   ⑦ 重复的旧声明行 → 清掉多余的（否则注册表 `Duplicate agent preset` 直接抛）
//   ⑧ 顶层 `[]` 占位符 → 写入后被清掉（issue #7：`[]` 后面再跟条目是非法 YAML，启动直接崩）
//   ⑨ 读回核实：真解析回来逐字段比对（不是"写完就当成了"）
//   ⑩ 写失败如实报：目标 profile 目录不存在 / 读回被篡改 → ok:false + reason，**且 note 绝不能**
//      再出现"新建会话时选择"这类谎话
//   ⑪ assemblePreset 接线：给了 patchPath 就声明、给了不存在的目录就如实失败、**不给就一个字节都不写**
//   ⑫ 落盘文本必须"结构合法"：用一套独立的精简 YAML 结构校验器（不引第三方依赖）逐行核
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'preset-declare-home')
// 非 ASCII 用户名 + 带空格的目录在真机上很常见（如 `C:\Users\<非 ASCII 名>`）：
// 这种路径正好一起验"file: URL 必须百分号编码"与"空格不能被截断"（见 ③′）。
const PROFILE = join(HOME, 'profiles', 'web')
const AGENT_PRESET = '@deepseek-ai/dsh-agent-preset'

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(PROFILE), { recursive: true })

process.env.DSH_HOME = HOME

const {
  absolutizeComposition, buildPresetDeclaration, declarePresetRow, indentComposition, isValidPresetId,
  normalizeComposition, presetDeclarationNote, presetDisplayMeta, presetRowBackupPath, quoteScalar,
  readPresetManifest, readPresetRowConfig, renderPresetRow, resolvePatchPath, scanPresetRows,
  upsertPresetRow, verifyDeclaredRow,
} = await import('../lib/server/domain/preset-declare.js')
const { assemblePreset } = await import('../lib/server/domain/preset-install.js')
const { validateAgentConfig } = await import('../lib/server/domain/preset-yaml.js')

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

// ── 自带的精简 YAML 结构校验器（零依赖；只判"能确证损坏"的形态）────────────────────────────
// 为什么自己写：本包没有运行时依赖，也不该为测试引一个 YAML 库（CI 里连 node_modules 都没有）。
// 历史上两次真事故都是**补丁文件语法坏掉**（尾随逗号 / 悬空逗号 → 桌面端起不来），所以要一条
// 结构断言兜底：缩进必须是 2 的倍数的纯空格、顶层只能是 `- ` 条目或注释/空行、引号必须闭合。
function yamlStructureProblem(text) {
  const lines = String(text).split('\n')
  let tabIndent = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    const indent = (line.match(/^ */u)[0]).length
    if (/^\s*\t/u.test(line)) { tabIndent += 1; return `第 ${i + 1} 行缩进里有 tab` }
    if (indent % 2 !== 0) return `第 ${i + 1} 行缩进 ${indent} 不是 2 的倍数（坏编辑/截断的典型形状）`
    if (indent === 0 && !/^- /u.test(line)) return `第 ${i + 1} 行是顶层行但不是 \`- \` 条目：${line.slice(0, 40)}`
    // 单行内的引号闭合（我们自己只写单引号标量，所以只需数成对的单引号）
    const singles = (line.match(/'/gu) ?? []).length
    if (singles % 2 !== 0) return `第 ${i + 1} 行的单引号没闭合：${line.slice(0, 50)}`
  }
  if (tabIndent > 0) return '存在 tab 缩进'
  if (/,\s*$/u.test(String(text).trimEnd())) return '文档以逗号结尾（悬空逗号）'
  return null
}

/** 造一个预设目录（agent.cordis.yml + preset.yml + 若干文件）。 */
function makePreset(name, { composition, manifest, files = {} }) {
  const dir = join(HOME, '.agent-presets', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), composition, 'utf8')
  if (manifest !== undefined) writeFileSync(join(dir, 'preset.yml'), manifest, 'utf8')
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content, 'utf8')
  return dir
}

const COMPOSITION = [
  '# 夹具 composition',
  'plugins:',
  '  - id: router-core',
  '    name: ./router-core.mjs',
  '  - id: bootstrap',
  '    name: ./router-bootstrap.mjs',
  '    config:',
  '      level: 3',
  '',
].join('\n')

const presetDir = makePreset('demo-preset', {
  composition: COMPOSITION,
  manifest: 'name: "Demo Preset"\ndescription: "演示用预设（含引号 \' 与逗号）"\norder: 7\n',
  files: { 'router-core.mjs': 'export const a = 1\n', 'router-bootstrap.mjs': 'export const b = 2\n' },
})

// ── ① 纯函数：id 判据 / 引号 / 缩进 / patch 路径推导 ─────────────────────────────────────
check('① 预设 id 判据：合法形状通过、大写/路径分隔符/空串拒绝',
  isValidPresetId('router-standard') && isValidPresetId('a1.b_c')
  && !isValidPresetId('Router') && !isValidPresetId('a/b') && !isValidPresetId('-x') && !isValidPresetId(''))
check('① YAML 单引号标量：内部单引号翻倍、换行折成空格',
  quoteScalar("it's a\nmultiline") === "'it''s a multiline'", quoteScalar("it's a\nmultiline"))
check('① 缩进：空行不补尾随空格', indentComposition('a\n\nb', 10) === `${' '.repeat(10)}a\n\n${' '.repeat(10)}b`)
check('① 补丁路径推导：patchPath 优先，其次 profileDir/cordis.patch.yml，都没有 → null',
  resolvePatchPath({ patchPath: 'X:/p.yml', profileDir: 'X:/d' }) === 'X:/p.yml'
  && resolvePatchPath({ profileDir: join('X:', 'd') }) === join('X:', 'd', 'cordis.patch.yml')
  && resolvePatchPath({}) === null)
check('① 备份路径唯一：同毫秒第二次不覆盖第一次',
  presetRowBackupPath('p.yml', 42, (p) => p === 'p.yml.bak-preset-42') === 'p.yml.bak-preset-42-2')

// ── ② 展示元数据：有 preset.yml 用它的，缺省要有合理默认 ─────────────────────────────────
{
  const meta = presetDisplayMeta(presetDir, 'demo-preset')
  check('② 有 preset.yml：name/description/order 取自它', meta.name === 'Demo Preset' && meta.order === 7 && meta.description.startsWith('演示用预设'), JSON.stringify(meta))
  const bare = makePreset('bare-preset', { composition: COMPOSITION })
  const bm = presetDisplayMeta(bare, 'bare-preset')
  check('② 没有 preset.yml：name 缺省 = 目录名、description 不提、order 缺省 1000（不抢内置预设位置）',
    bm.name === 'bare-preset' && bm.description === null && bm.order === 1000, JSON.stringify(bm))
  const weird = makePreset('weird-order', { composition: COMPOSITION, manifest: 'name: W\norder: abc\n' })
  check('② order 非数字：回落到 1000（不写 NaN 进用户补丁）', presetDisplayMeta(weird, 'weird-order').order === 1000)
  check('② readPresetManifest 仍从 preset-declare 导出（preset-source 的 re-export 不破）',
    (readPresetManifest(presetDir) ?? {}).name === 'Demo Preset')
}

// ── ③ 相对引用 → file:/// 绝对 URL（百分号编码；基准是 profile 目录不是预设目录）──────────
{
  const built = buildPresetDeclaration(presetDir, 'demo-preset')
  check('③ 组装成功', built.ok === true, JSON.stringify({ ok: built.ok, reason: built.reason, detail: built.detail }))
  check('③ 行 id = preset-demo-preset', built.rowId === 'preset-demo-preset', built.rowId)
  const urls = built.rewritten.map((r) => r.to)
  check('③ 两处相对引用都被改写为 file: URL', built.rewritten.length === 2, JSON.stringify(built.rewritten))
  check('③ file: URL 指向预设目录下的真实文件（不是 profile 目录）',
    urls.every((u) => u.startsWith(pathToFileURL(join(HOME, '.agent-presets', 'demo-preset')).href + '/')), urls.join(' | '))
  check('③ 中文 + 空格的绝对路径按 URL 规则百分号编码（不吃空格、不出现裸中文）',
    urls.every((u) => !u.includes(' ') && !/[\u4e00-\u9fff]/u.test(u)), urls[0])
  check('③ 行文本里没有残留的 `name: ./`',
    !/^\s+name:\s*\.\.?\//mu.test(built.rowText), built.rowText.split('\n').find((l) => l.includes('./')))
  check('③ 注释行里的 `# ./we-persona.txt` 一字不动（只改 name: 值）',
    absolutizeComposition('# ./x.txt\n  name: ./x.txt\n', presetDir, { exists: () => false }).text === '# ./x.txt\n  name: ./x.txt\n')
  const missing = absolutizeComposition('  name: ./not-here.mjs\n', presetDir)
  check('③ 预设目录里不存在的同名文件 → 原样保留（不猜路径）',
    missing.text === '  name: ./not-here.mjs\n' && missing.rewritten.length === 0, JSON.stringify(missing))
  const abs = absolutizeComposition("  name: file:///C:/x/y.mjs\n  name: /abs/y.mjs\n  name: 'pkg-name'\n", presetDir)
  check('③ 已是绝对路径 / 裸包名 → 一动不动',
    abs.text === "  name: file:///C:/x/y.mjs\n  name: /abs/y.mjs\n  name: 'pkg-name'\n" && abs.rewritten.length === 0)
}

// ── ③′ 非 ASCII + 含空格的目录（真机常见：用户名非 ASCII）→ 必须百分号编码 ──────────────
// 为什么单列：上面 ③ 的夹具路径全是 ASCII，「不吃空格、不出现裸中文」那两条在那种夹具上
// 是**空断言**（恒真）。这里用一个真含空格 + 非 ASCII 的目录把它变成有效断言。
{
  const cjkDir = makePreset('用户 测试', {
    composition: 'plugins:\n  - id: cjk\n    name: ./cjk-core.mjs\n',
    files: { 'cjk-core.mjs': 'export const c = 3\n' },
  })
  check('③′ 夹具前提：目录名同时含空格与非 ASCII', cjkDir.includes(' ') && /[\u4e00-\u9fff]/u.test(cjkDir), cjkDir)
  const built = buildPresetDeclaration(cjkDir, 'cjk-preset')
  const urls = built.rewritten.map((r) => r.to)
  check('③′ 含空格/非 ASCII 的绝对路径被百分号编码（不吃空格、不出现裸中文）',
    built.ok === true && urls.length === 1 && !urls[0].includes(' ') && !/[\u4e00-\u9fff]/u.test(urls[0]), urls[0])
  check('③′ 编码后仍能还原成真实文件（fileURLToPath 指回夹具里的 .mjs）',
    urls.length === 1 && fileURLToPath(urls[0]) === join(cjkDir, 'cjk-core.mjs'), urls[0])
}

// ── ④ 声明行形状（与官方内置行 `preset-standard` 同一命名法与缩进）─────────────────────
{
  const built = buildPresetDeclaration(presetDir, 'demo-preset')
  const lines = built.rowText.split('\n')
  check('④ 行首是顶级 `- insert:`', lines[0] === '- insert:')
  check('④ 行 id 缩进 4 空格、模块名单引号', lines[1] === '    - id: preset-demo-preset' && lines[2] === `      name: '${AGENT_PRESET}'`, lines.slice(1, 3).join(' / '))
  check('④ config 在 6 空格、字段在 8 空格', lines[3] === '      config:' && lines[4] === '        id: demo-preset')
  check('④ name/description/order 三件都在（顺序稳定）',
    lines[5] === `        name: 'Demo Preset'` && lines[6].startsWith('        description: ') && lines[7] === '        order: 7', lines.slice(5, 8).join(' | '))
  check('④ plugins: 在 8 空格、composition 在 10 空格（与真机既有行一致）',
    lines[8] === '        plugins:' && lines.slice(9).every((l) => l.trim() === '' || l.startsWith(' '.repeat(10))), lines[8])
  check('④ 行文本结构合法（自带 YAML 结构校验器）', yamlStructureProblem(built.rowText) === null, yamlStructureProblem(built.rowText))
  check('④ 行里有 JSON 风格的尾随逗号也不怕（这里本来就没有）', !/,\s*$/mu.test(built.rowText))
}

// ── ⑤ upsert：新增 / 幂等 / 更新 / 清重复 / 清 `[]` 占位符 ────────────────────────────────
{
  const built = buildPresetDeclaration(presetDir, 'demo-preset')
  const empty = '# 我的补丁\n[]\n'
  const first = upsertPresetRow(empty, built.rowText, built.rowId)
  check('⑤ 新增：changed/created', first.changed === true && first.created === true)
  check('⑤ 新增：顶层 `[]` 占位符被清掉（issue #7：`[]` 后再跟条目是非法 YAML）',
    !/^\s*\[\s*\]\s*$/mu.test(first.text), first.text.split('\n')[0])
  check('⑤ 新增：原注释保留', first.text.includes('# 我的补丁'))
  check('⑤ 新增：结构合法', yamlStructureProblem(first.text) === null, yamlStructureProblem(first.text))

  const again = upsertPresetRow(first.text, built.rowText, built.rowId)
  check('⑤ 幂等：同内容再写 → changed=false 且文本逐字节不变（不建备份、不动用户文件）',
    again.changed === false && again.text === first.text)

  const changedRow = built.rowText.replace("order: 7", "order: 99")
  const updated = upsertPresetRow(first.text, changedRow, built.rowId)
  check('⑤ 更新：同 id 原地替换（不是重复插入）', updated.changed === true && updated.created === false && scanPresetRows(updated.text).length === 1)
  check('⑤ 更新：新内容生效、旧内容消失', updated.text.includes('order: 99') && !updated.text.includes('order: 7'))

  const duplicated = `${first.text}\n\n${built.rowText}\n`
  check('⑤ 清重复：同 id 出现两次（老版本重复插入的残局）→ 只剩一行',
    scanPresetRows(duplicated).length === 2 && scanPresetRows(upsertPresetRow(duplicated, changedRow, built.rowId).text).length === 1)
  // 0.5.29 起「相对引用必须在预设目录里真的存在」（否则声明行必然加载失败，见 test-preset-rows.mjs），
  // 所以这个夹具也要把文件补齐 —— 否则 buildPresetDeclaration 会如实拒绝，拿不到 rowText。
  const twoPresets = upsertPresetRow(updated.text, buildPresetDeclaration(
    makePreset('other', { composition: COMPOSITION, files: { 'router-core.mjs': 'export const a = 1\n', 'router-bootstrap.mjs': 'export const b = 2\n' } }),
    'other',
  ).rowText, 'preset-other')
  check('⑤ 两个不同预设共存：各一行、互不覆盖', scanPresetRows(twoPresets.text).map((r) => r.id).join(',') === 'preset-demo-preset,preset-other')
}

// ── ⑥ 落盘：新增 → 幂等 → 更新（含备份）→ 读回核实 ──────────────────────────────────────
{
  const patchPath = join(PROFILE, 'cordis.patch.yml')
  writeFileSync(patchPath, '# 真机形状的补丁（夹具）\n- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n', 'utf8')
  const r1 = await declarePresetRow(presetDir, 'demo-preset', { patchPath, now: () => 1000 })
  check('⑥ 首次声明：status=created / ok / 写了', r1.status === 'created' && r1.ok === true && r1.changed === true, JSON.stringify({ s: r1.status, ok: r1.ok, d: r1.detail }))
  check('⑥ 首次声明：原补丁内容先备份（.bak-preset-<ts>）',
    typeof r1.backup === 'string' && existsSync(r1.backup) && r1.backup.endsWith('.bak-preset-1000'), String(r1.backup))
  check('⑥ 首次声明：备份内容 = 改前原文',
    readFileSync(r1.backup, 'utf8').includes('ui-settings'))
  check('⑥ 首次声明：读回核实通过（真解析回来逐字段比对，不是"写完就当成"）',
    r1.verified !== null && r1.verified.ok === true && r1.verified.checked === 6, JSON.stringify(r1.verified))
  check('⑥ 首次声明：note 说清"已声明为预设行 + 重启实例后在新会话可选"',
    /已声明为预设行 preset-demo-preset/u.test(r1.note) && /重启实例后/u.test(r1.note), r1.note)
  check('⑥ 首次声明：note 里**没有**"新建会话时选择"这类旧谎话', !/新建会话时选择/u.test(r1.note))

  const before = readFileSync(patchPath, 'utf8')
  const r2 = await declarePresetRow(presetDir, 'demo-preset', { patchPath, now: () => 2000 })
  check('⑥ 幂等落盘：status=unchanged、changed=false、**一个字节都没写**、**不建备份**',
    r2.status === 'unchanged' && r2.changed === false && r2.backup === null && readFileSync(patchPath, 'utf8') === before,
    JSON.stringify({ s: r2.status, c: r2.changed, b: r2.backup }))
  check('⑥ 幂等落盘：仍然读回核实通过（不改也要能证明它在）', r2.verified?.ok === true)
  check('⑥ 幂等落盘：note 明说"此前已声明…未改动任何字节"与"重启实例后可选"',
    /未改动任何字节/u.test(r2.note) && /重启实例后/u.test(r2.note), r2.note)

  // 预设目录内容变了 → 声明行必须跟着刷新（原地更新）
  writeFileSync(join(presetDir, 'preset.yml'), 'name: Demo Preset v2\norder: 8\n', 'utf8')
  const r3 = await declarePresetRow(presetDir, 'demo-preset', { patchPath, now: () => 3000 })
  check('⑥ 内容变了 → status=updated（不是重复插入）',
    r3.status === 'updated' && scanPresetRows(readFileSync(patchPath, 'utf8')).length === 1, JSON.stringify({ s: r3.status }))
  check('⑥ 更新后读回核实：name 已变成 v2', r3.verified?.ok === true && readFileSync(patchPath, 'utf8').includes("name: 'Demo Preset v2'"))
  check('⑥ 更新也留备份（改前原文）', typeof r3.backup === 'string' && existsSync(r3.backup) && r3.backup.endsWith('.bak-preset-3000'))
  check('⑥ 落盘文件整体结构合法', yamlStructureProblem(readFileSync(patchPath, 'utf8')) === null, yamlStructureProblem(readFileSync(patchPath, 'utf8')))
  check('⑥ 原补丁行（ui-settings）一个字节没丢', readFileSync(patchPath, 'utf8').includes('- id: ui-settings'))
}

// ── ⑦ 读回核实真的会"发现不一致"（不是恒真）────────────────────────────────────────────
{
  const built = buildPresetDeclaration(presetDir, 'demo-preset')
  // 真机上声明行前后都有别的顶级条目（web profile 就是如此）；这里也补一条在**后面**，
  // 因为"行级 `name:` 紧跟 composition"的边界识别正是最容易写错、也最该被这条断言钉住的地方。
  const asDoc = (row) => `# head\n${row}\n\n- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n`
  const tampered = asDoc(built.rowText).replace('id: demo-preset', 'id: something-else')
  const verdict = verifyDeclaredRow(tampered, built)
  check('⑦ 被篡改的 config.id → 核实不通过', verdict.ok === false && verdict.problems.some((p) => p.includes('config.id')), JSON.stringify(verdict.problems))
  const wrongPlugins = asDoc(`${built.rowText}\n${' '.repeat(10)}- id: 多出来的一行\n`)
  check('⑦ plugins 与源不一致 → 核实不通过', verifyDeclaredRow(wrongPlugins, built).ok === false)
  check('⑦ 找不到行 → 核实不通过', verifyDeclaredRow('# 空补丁\n', built).ok === false)
  check('⑦ 干净的行 → 核实通过', verifyDeclaredRow(asDoc(built.rowText), built).ok === true, JSON.stringify(verifyDeclaredRow(asDoc(built.rowText), built).problems))
  check('⑦ 块是文件最后一块（后面没有顶级条目）也要能核实通过 —— 边界不能一路吃到文件尾',
    verifyDeclaredRow(`# head\n${built.rowText}\n`, built).ok === true, JSON.stringify(verifyDeclaredRow(`# head\n${built.rowText}\n`, built).problems))
  check('⑦ readPresetRowConfig 能读回 config 的浅表字段（数字标量归一成 number）',
    Number(readPresetRowConfig(asDoc(built.rowText), 'preset-demo-preset')?.fields?.order) === built.config.order,
    `${readPresetRowConfig(asDoc(built.rowText), 'preset-demo-preset')?.fields?.order} vs ${built.config.order}`)
  check('⑦ composition 里的注释不会把核实判红（注释不是配置数据）',
    verifyDeclaredRow(asDoc(built.rowText), built).problems.every((p) => !p.includes('不一致')))
}

// ── ⑧ 失败路径必须**如实**（绝不谎报"已声明"）──────────────────────────────────────────
{
  const noProfile = await declarePresetRow(presetDir, 'demo-preset', {})
  check('⑧ 没给目标 profile → status=skipped/reason=no-patch-path（明确不宣称已声明）',
    noProfile.ok === false && noProfile.status === 'skipped' && noProfile.reason === 'no-patch-path', JSON.stringify({ s: noProfile.status, r: noProfile.reason }))
  check('⑧ skipped 的 note 明说"文件已就位，但当前框架版本需要声明行"',
    /文件已就位/u.test(noProfile.note) && /声明行/u.test(noProfile.note) && !/重启实例后/u.test(noProfile.note), noProfile.note)

  const ghostDir = join(HOME, 'profiles', 'ghost')
  const ghost = await declarePresetRow(presetDir, 'demo-preset', { profileDir: ghostDir })
  check('⑧ 目标 profile 目录不存在 → status=failed/reason=no-profile-dir（绝不凭空造 profile）',
    ghost.ok === false && ghost.status === 'failed' && ghost.reason === 'no-profile-dir', JSON.stringify({ s: ghost.status, r: ghost.reason }))
  check('⑧ 失败时没有写任何文件（那个 profile 目录依然不存在）', !existsSync(ghostDir))

  const bad = await declarePresetRow(join(HOME, '.agent-presets', 'nope'), 'nope', { profileDir: PROFILE })
  check('⑧ 预设目录不存在 → failed/preset-dir-missing', bad.ok === false && bad.reason === 'preset-dir-missing', bad.reason)
  const badId = await declarePresetRow(presetDir, 'Bad/Id', { profileDir: PROFILE })
  check('⑧ 预设 id 不合法 → failed/invalid-preset-id（不给注册表塞奇怪键）', badId.ok === false && badId.reason === 'invalid-preset-id', badId.reason)

  const brokenYaml = makePreset('broken-yaml', { composition: 'plugins:\n\t- id: x\n' })
  const broken = await declarePresetRow(brokenYaml, 'broken-yaml', { profileDir: PROFILE })
  check('⑧ composition 结构不合法（tab 缩进）→ failed/invalid-composition，绝不把坏 YAML 写进用户补丁',
    broken.ok === false && broken.reason === 'invalid-composition', `${broken.reason} / ${broken.detail}`)

  const patchBefore = readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8')
  const readOnly = join(PROFILE, 'readonly-patch.yml')
  writeFileSync(readOnly, 'x\n', 'utf8')
  // 用一个"父路径是文件"的目标让写入必失败（跨平台稳定，不依赖 chmod）
  const blocker = join(PROFILE, 'blocker.txt')
  writeFileSync(blocker, 'not a dir\n', 'utf8')
  const writeFail = await declarePresetRow(presetDir, 'demo-preset', { patchPath: join(blocker, 'cordis.patch.yml') })
  check('⑧ 写入失败 → status=failed 且 note 如实说"未写成"（不说"新建会话时选择"）',
    writeFail.ok === false && writeFail.status === 'failed' && !/重启实例后/u.test(String(writeFail.note)), JSON.stringify({ s: writeFail.status, r: writeFail.reason }))
  check('⑧ 失败场景没有污染真实补丁文件', readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8') === patchBefore)
}

// ── ⑨ presetDeclarationNote：成功/失败两种文案都要能生成 ─────────────────────────────────
{
  check('⑨ 成功文案：已声明为预设行 + 路径 + 重启实例后可选',
    /已声明为预设行 preset-x/u.test(presetDeclarationNote({ ok: true, status: 'created', rowId: 'preset-x', patchPath: 'P/cordis.patch.yml' }))
    && /重启实例后/u.test(presetDeclarationNote({ ok: true, status: 'created', rowId: 'preset-x', patchPath: 'P/cordis.patch.yml' })))
  const failure = presetDeclarationNote({ ok: false, status: 'failed', reason: 'write-failed', detail: 'EACCES' })
  check('⑨ 失败文案：文件已就位 + 需要声明行 + 给出出路（模板 id 与模块名）',
    /文件已就位/u.test(failure) && /EACCES/u.test(failure) && /preset-<预设 id>/u.test(failure) && failure.includes(AGENT_PRESET))
}

// ── ⑩ assemblePreset 接线：给 patchPath 就声明、没给就一个字节都不写 ─────────────────────
{
  // ⑩-1 没给目标 profile：落盘照旧，但**不写**任何声明行、且 note 不再说"新建会话时选择"
  const presetsRoot = join(HOME, 'presets-root')
  const bare = await assemblePreset(presetDir, 'demo-preset', { presetsRoot })
  check('⑩ 不给 patchPath：声明结果为 null 且 note 明说"文件已就位，但当前框架版本需要声明行"',
    bare.ok === true && bare.declaration === null && /文件已就位/u.test(bare.note) && /声明行/u.test(bare.note), `decl=${JSON.stringify(bare.declaration)} note=${bare.note.slice(0, 160)}`)
  check('⑩ 不给 patchPath：note 里**没有**"新建会话时选择"', !/新建会话时选择/u.test(bare.note))
  check('⑩ 不给 patchPath：文件照旧真的落盘', existsSync(join(presetsRoot, 'demo-preset', 'agent.cordis.yml')))

  // ⑩-2 给了 patchPath：落盘 + 声明都做，note 说清"已声明为预设行…重启实例后"
  const target = join(PROFILE, 'cordis.patch.yml')
  const withDecl = await assemblePreset(presetDir, 'demo-preset', { presetsRoot, patchPath: target, now: () => 4000 })
  check('⑩ 给 patchPath：declaration.status=created|updated|unchanged、读回核实通过',
    ['created', 'updated', 'unchanged'].includes(withDecl.declaration?.status) && withDecl.declaration?.verified?.ok === true, JSON.stringify(withDecl.declaration?.status))
  check('⑩ 给 patchPath：note 含"已声明为预设行 preset-demo-preset"与"重启实例后"',
    /已声明为预设行 preset-demo-preset/u.test(withDecl.note) && /重启实例后/u.test(withDecl.note), withDecl.note.slice(0, 220))
  check('⑩ 给 patchPath：声明行真的在补丁文件里、结构合法',
    scanPresetRows(readFileSync(target, 'utf8')).some((r) => r.id === 'preset-demo-preset') && yamlStructureProblem(readFileSync(target, 'utf8')) === null)

  // ⑩-3 注入失败的 declare → 如实进 note（且不影响装配本身的 ok）
  const forced = await assemblePreset(presetDir, 'demo-preset', {
    presetsRoot, profileDir: PROFILE,
    declare: () => ({ ok: false, status: 'failed', reason: 'write-failed', detail: '桩：磁盘满', rowId: 'preset-demo-preset', patchPath: target, backup: null, changed: false, verified: null, rewritten: [] }),
  })
  check('⑩ 声明失败：装配仍 ok，但 note **必须**说出"需要声明行"与失败原因（且不许说"重启实例后"）',
    forced.ok === true && /需要声明行/u.test(forced.note) && /桩：磁盘满/u.test(forced.note) && !/重启实例后/u.test(forced.note), forced.note.slice(0, 220))
  check('⑩ 声明失败：note 用**明确的失败口吻**（"本次声明未写成"），不说"已声明为预设行"',
    /本次声明未写成/u.test(forced.note) && !/已声明为预设行/u.test(forced.note), forced.note.slice(0, 220))

  // ⑩-4 声明抛异常也不能把装配带崩（诚实降级）
  const threw = await assemblePreset(presetDir, 'demo-preset', { presetsRoot, profileDir: PROFILE, declare: () => { throw new Error('桩：爆了') } })
  check('⑩ 声明抛异常：装配不崩，note 如实报 declare-threw',
    threw.ok === true && threw.declaration?.reason === 'declare-threw' && /爆了/u.test(threw.note), JSON.stringify(threw.declaration?.reason))
}

// ── ⑪ 与 preset-yaml 的判据不打架（声明行本身要能被同一套校验判为合法）──────────────────
{
  const built = buildPresetDeclaration(presetDir, 'demo-preset')
  const verdict = validateAgentConfig(built.rowText)
  check('⑪ 声明行通过 preset-yaml 的结构校验（不会一写就被自家校验判非法）', verdict.ok === true, JSON.stringify(verdict.problems))
  check('⑪ composition 归一：CRLF → LF、正好一个结尾换行',
    normalizeComposition('a\r\nb\r\n\r\n') === 'a\nb\n', JSON.stringify(normalizeComposition('a\r\nb\r\n\r\n')))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${pass} PASS / ${fail} FAIL`)
assert.equal(fail, 0, `${fail} 条断言失败`)
