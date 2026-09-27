// 0.5.29 改错+加法（**真机缺陷 D-⑦**：预设卡片红框「加载失败」）。
//
// 真机错误原文（2026-09-27，活体实例 `/api/agentPresets/list` 读回，见 CHANGELOG）：
//   BROKEN  router-spec
//           persona (@deepseek-ai/dsh-persona): invalid config:
//             - $.prefix missing required value (at prefix)
//
// 真根因：`router-spec/agent.cordis.yml` 的 persona 行写的是 `config.text`，而框架
// `@deepseek-ai/dsh-persona@0.1.7-rc.2` 的 Config 是 `prefix: z.string().required()` ——
// 框架 schema 读不到 `text`，装配时抛错，注册表 `activate()` 把它吞成 `record.broken`，
// 界面那张卡片于是永远顶着框架自己的 `brokenBadge: "加载失败"`。
//
// 为什么改前一条判据都拦不住 / 为什么迁移没生效（本套要钉死的两件事）：
//   ① preset-yaml.js 只判**结构**（空文件/tab/未闭合引号/缩进跳级）——`text:` 结构完全合法；
//   ② `file:///` 目标确实存在、包名也确实存在；
//   ③ 仓库**早就有** text → prefix 的迁移表（presets.js），但它只在**框架升级**那一步跑，
//      而预设还会经「装预设型子包 / 源码装配 / 手工放文件」落盘，那些路完全不过升级步骤
//      （本机事实：router-spec 是当天 21:27 装配落盘的，升级步骤根本没参与）。
//
// 本套断言（全离线；不碰真 DSH_HOME，不用网络）：
//   ① 判据：persona 缺 prefix → 判红且**如实点名**该行/该包/该键与框架会抛的原文
//   ② 判据：`file:///` 目标不存在 → 判红（**绝不写一行必然加载失败的声明**）
//   ③ 判据：行没有 name / composition 空 → 判红
//   ④ 判据：**不误杀** —— 三个真机预设的形状（含 CRLF、块标量 persona、空 config）全部放行
//   ⑤ 迁移：text → prefix（值一字不差、只动命中行）；已有 prefix 不动；非 persona 行的 text 不动
//   ⑥ 迁移的版本判据：低于引入版本 → 不动；**版本未知 → 按最新处理**（否则又写出坏行）
//   ⑦ 接线：declarePresetRow 拒绝写坏行（ok:false + reason + detail + 补丁零字节改动）+ 真迁移
//   ⑧ 接线：迁移后的行**通过自家校验**、另两条 preset 行不被牵连；note 如实点名迁移
//   ⑨ 归一路径的**幂等**（第二次声明不再报迁移）
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'preset-rows-home')
const PROFILE_DIR = join(HOME, 'profiles', 'web')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(PROFILE_DIR, { recursive: true })
process.env.DSH_HOME = HOME

const {
  PLUGIN_ROW_CONSTRAINTS, PRESET_CONFIG_KEY_MIGRATIONS, isVersionAtLeast, migratePluginRowKeys,
  normalizeConfigValue, parseCompositionRows, parseDottedVersion, validatePresetPluginRows,
} = await import('../lib/server/domain/preset-rows.js')
const { buildPresetDeclaration, declarePresetRow } = await import('../lib/server/domain/preset-declare.js')

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

/** 造一个预设目录。 */
function makePreset(name, composition, files = {}) {
  const dir = join(HOME, '.agent-presets', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), composition, 'utf8')
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content, 'utf8')
  return dir
}

const PERSONA_TEXT = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: You are a helpful software engineer assistant.',
  '',
  '- id: tool-fs',
  "  name: '@deepseek-ai/dsh-tool-fs'",
  '',
].join('\n')

// ── ① 判据：persona 缺 prefix（**真机 D-⑦ 的原形**）────────────────────────────────────
{
  const v = validatePresetPluginRows(PERSONA_TEXT)
  check('① persona 用 config.text → 判红（不许放行）', v.ok === false, JSON.stringify(v.problems.map((p) => p.code)))
  const p = v.problems[0] ?? {}
  check('① 判红点名 code=missing-required-config', p.code === 'missing-required-config', p.code)
  check('① 判红点名行 id=persona', p.row === 'persona', p.row)
  check('① 判红点名包名与缺失键，并引框架会抛的原文',
    String(p.detail).includes('@deepseek-ai/dsh-persona') && String(p.detail).includes('`prefix`')
    && String(p.detail).includes('$.prefix missing required value'), p.detail)
  check('① 判红给出可执行出路（说清是 0.1.5 起的改名）',
    String(p.hint).includes('prefix') && String(p.hint).includes('text'), p.hint)
  check('① 行数如实=2（判据不吞行）', v.rows === 2, String(v.rows))
}

// ── ② 判据：file:/// 目标不存在（写它 = 必然「加载失败」）───────────────────────────────
{
  const text = ['- id: boot', '  name: file:///C:/definitely/not/here/router-bootstrap.mjs', ''].join('\n')
  const gone = validatePresetPluginRows(text, { exists: () => false })
  check('② file:/// 目标不存在 → 判红', gone.ok === false && gone.problems[0].code === 'file-target-missing', JSON.stringify(gone.problems))
  check('② 判红里含**解码后**的真实磁盘路径（用户能照着找）',
    /C:[\\/]definitely[\\/]not[\\/]here[\\/]router-bootstrap\.mjs/u.test(String(gone.problems[0].detail)), gone.problems[0].detail)
  const here = validatePresetPluginRows(text, { exists: () => true })
  check('② 同一行、目标存在 → 放行（判据钉的是存在性，不是形状）', here.ok === true, JSON.stringify(here.problems))
  const bad = validatePresetPluginRows('- id: boot\n  name: file:///%zz\n', { exists: () => true })
  check('② 坏 file: URL → 判红 file-url-unparsable', bad.ok === false && bad.problems[0].code === 'file-url-unparsable', JSON.stringify(bad.problems.map((p) => p.code)))
  const off = validatePresetPluginRows(text, { exists: () => false, checkFiles: false })
  check('② checkFiles:false 时跳过存在性（判据可单独使用）', off.ok === true)
}

// ── ③ 判据：行结构 / 空 composition ──────────────────────────────────────────────────
{
  const noName = validatePresetPluginRows('- id: ghost\n  config:\n    a: 1\n')
  check('③ 行没有 name → 判红 row-names-no-plugin', noName.ok === false && noName.problems[0].code === 'row-names-no-plugin', JSON.stringify(noName.problems.map((p) => p.code)))
  const empty = validatePresetPluginRows('# 只有注释\n\n')
  check('③ 没有任何插件行 → 判红 no-plugin-rows', empty.ok === false && empty.problems[0].code === 'no-plugin-rows')
}

// ── ④ 不误杀：三个真机预设的形状必须全部放行 ────────────────────────────────────────────
{
  const good = [
    '# 注释行里的 text: 不是配置',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: You are a helpful software engineer assistant.',
    '',
    '- id: empty-config',
    "  name: '@x/y'",
    '  config: {}',
    '',
    '- id: no-config',
    "  name: '@z/w'",
    '',
    '- id: disabled-row',
    "  name: '@q/r'",
    '  disabled: true',
    '',
  ].join('\n')
  const v = validatePresetPluginRows(good)
  check('④ 已有 prefix / 空 config / 无 config / disabled 行 → 全放行', v.ok === true, JSON.stringify(v.problems))
  // 块标量 persona（router-standard 的真形状）：多行散文不能被当成配置行
  const block = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: >-',
    '      We are the collective. text: 这行是散文正文，不是配置',
    '      prefix: 也不是',
    '',
    '- id: tool-fs',
    "  name: '@deepseek-ai/dsh-tool-fs'",
    '',
  ].join('\n')
  const bv = validatePresetPluginRows(block)
  check('④ 块标量（>-）里的伪键不算配置、persona 有 prefix → 放行', bv.ok === true, JSON.stringify(bv.problems))
  // CRLF（真机磁盘上的 agent.cordis.yml 就是 CRLF）
  const crlf = PERSONA_TEXT.replace(/^(\s*)text:/mu, '$1prefix:').replace(/\n/gu, '\r\n')
  const cv = validatePresetPluginRows(crlf)
  check('④ CRLF 文件里的 prefix 照样认得出（行尾 \\r 不能把判据整条打歪）', cv.ok === true, JSON.stringify(cv.problems))
  const crlfBad = PERSONA_TEXT.replace(/\n/gu, '\r\n')
  check('④ CRLF 文件里的 text 照样判红（不是"CRLF 就一律放行"）',
    validatePresetPluginRows(crlfBad).ok === false)
  // 非 persona 行的 text 不该被 persona 的契约牵连
  const otherText = ['- id: other', "  name: '@x/y'", '  config:', '    text: 别的插件的 text', ''].join('\n')
  check('④ 非 persona 行的 text 不判红（契约只挂 name 精确命中的行）', validatePresetPluginRows(otherText).ok === true)
}

// ── ⑤ 迁移：text → prefix ───────────────────────────────────────────────────────────
{
  const m = migratePluginRowKeys(PERSONA_TEXT, '0.1.7-rc.2')
  check('⑤ 迁移命中 1 处，pkg/from/to 如实', m.migrated.length === 1 && m.migrated[0].pkg === '@deepseek-ai/dsh-persona'
    && m.migrated[0].from === 'text' && m.migrated[0].to === 'prefix', JSON.stringify(m.migrated))
  check('⑤ 迁移点名第几行（第 4 行）', m.migrated[0].line === 4, String(m.migrated[0].line))
  check('⑤ 值一字不差（只改键名）',
    m.text.includes('    prefix: You are a helpful software engineer assistant.')
    && !/^\s*text:/mu.test(m.text), m.text.split('\n')[3])
  check('⑤ 迁移后的文本**通过**自家判据（迁移不是把红的挪个位置）', validatePresetPluginRows(m.text).ok === true)
  check('⑤ 行数与其它行一字不动（只动命中那一行）',
    parseCompositionRows(m.text).length === parseCompositionRows(PERSONA_TEXT).length
    && m.text.includes("- id: tool-fs") && m.text.includes("  name: '@deepseek-ai/dsh-tool-fs'"))

  // 已有 prefix → 一个字节都不动
  const withPrefix = PERSONA_TEXT.replace('    text:', '    prefix:')
  const m2 = migratePluginRowKeys(withPrefix, '0.1.7-rc.2')
  check('⑤ 已有 prefix → 不迁移、文本一字不动', m2.migrated.length === 0 && m2.text === withPrefix)
  // 两个键都在（脏数据）→ 仍不覆盖真键
  const both = PERSONA_TEXT.replace('    text:', '    prefix: 用户自己写的\n    text: 旧的')
  const m3 = migratePluginRowKeys(both, '0.1.7-rc.2')
  check('⑤ prefix 与 text 并存 → 不覆盖用户写的 prefix', m3.migrated.length === 0 && m3.text === both)
  // 非 persona 行的 text 不动
  const other = ['- id: other', "  name: '@x/y'", '  config:', '    text: 别动我', ''].join('\n')
  const m4 = migratePluginRowKeys(other, '0.1.7-rc.2')
  check('⑤ 非 persona 行的 text 一动不动（不误伤别的插件）', m4.migrated.length === 0 && m4.text === other)
  // CRLF 也能迁移
  const m5 = migratePluginRowKeys(PERSONA_TEXT.replace(/\n/gu, '\r\n'), '0.1.7-rc.2')
  check('⑤ CRLF 文件也能迁移（真机磁盘就是 CRLF）', m5.migrated.length === 1 && m5.text.includes('prefix:'), JSON.stringify(m5.migrated))
}

// ── ⑥ 迁移的版本判据（含"未知版本"这条最要紧的分支）────────────────────────────────────
{
  check('⑥ 版本比较：0.1.7-rc.2 ≥ 0.1.5 / 0.1.2 < 0.1.5 / 不可解析 → false',
    isVersionAtLeast('0.1.7-rc.2', '0.1.5') && !isVersionAtLeast('0.1.2-rc.1', '0.1.5') && !isVersionAtLeast(null, '0.1.5'))
  check('⑥ 版本解析：忽略预发布尾缀 / 不可解析返回 null',
    JSON.stringify(parseDottedVersion('0.1.7-rc.2')) === '{"maj":0,"min":1,"pat":7}' && parseDottedVersion('nope') === null)
  const low = migratePluginRowKeys(PERSONA_TEXT, '0.1.2-rc.1')
  check('⑥ 目标版本低于引入版本 → 不迁移（老框架要的正是 text，不能乱改）',
    low.migrated.length === 0 && low.text === PERSONA_TEXT && String(low.skippedReason).includes('0.1.2-rc.1'))
  const unknown = migratePluginRowKeys(PERSONA_TEXT, null)
  check('⑥ **版本未知 → 按最新处理并迁移**（否则拿不到版本时又写出坏行，D-⑦ 现场正是这个）',
    unknown.migrated.length === 1 && validatePresetPluginRows(unknown.text).ok === true, JSON.stringify(unknown.migrated))
  check('⑥ 版本未知时 skippedReason 为空（如实：没有跳过）', unknown.skippedReason === null)
  check('⑥ 迁移表是全仓唯一出处（presets.js 从这里取同一张表）',
    Array.isArray(PRESET_CONFIG_KEY_MIGRATIONS) && PRESET_CONFIG_KEY_MIGRATIONS[0].pkg === '@deepseek-ai/dsh-persona'
    && PRESET_CONFIG_KEY_MIGRATIONS[0].since === '0.1.5')
  check('⑥ 契约表里 persona 的必填键就是 prefix', PLUGIN_ROW_CONSTRAINTS[0].required.includes('prefix'))
  check('⑥ normalizeConfigValue：空串/空白视作未提供，单引号去壳',
    normalizeConfigValue('') === null && normalizeConfigValue('   ') === null && normalizeConfigValue("'x'") === 'x' && normalizeConfigValue('y') === 'y')
}

// ── ⑦ 接线：写行前的拒绝（**绝不写坏行**）─────────────────────────────────────────────
{
  const patchPath = join(PROFILE_DIR, 'cordis.patch.yml')
  const BASE = '- id: keep-me\n  name: "@x/keep"\n'
  // 7a: 指向不存在的文件 → 拒绝，且补丁一个字节不动
  {
    writeFileSync(patchPath, BASE, 'utf8')
    const dir = makePreset('bad-file', '- id: boot\n  name: ./missing-bootstrap.mjs\n')
    const r = await declarePresetRow(dir, 'bad-file', { patchPath })
    check('⑦ 引用不存在的文件 → ok:false', r.ok === false && r.status === 'failed', JSON.stringify({ ok: r.ok, status: r.status }))
    check('⑦ reason 如实=unresolvable-plugin-file（相对引用在预设目录里不存在、profile 基准下也改不过去）',
      r.reason === 'unresolvable-plugin-file', r.reason)
    check('⑦ detail 说出是哪一行、哪个文件', String(r.detail).includes('boot') && String(r.detail).includes('missing-bootstrap.mjs'), r.detail)
    check('⑦ 补丁文件**一个字节都没动**（拒绝 = 不写）', readFileSync(patchPath, 'utf8') === BASE)
    check('⑦ 没有建备份（没写就没必要备份）', !existsSync(`${patchPath}.bak-preset-${Date.now()}`))
  }
  // 7b: 包名存在但契约不满足、且迁移救不了（persona 换成别的包）→ 拒绝
  {
    writeFileSync(patchPath, BASE, 'utf8')
    const dir = makePreset('bad-contract', '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n    suffix: only-suffix\n')
    const r = await declarePresetRow(dir, 'bad-contract', { patchPath })
    check('⑦ persona 只有 suffix（迁移救不了）→ 拒绝写入', r.ok === false && r.reason === 'invalid-plugin-rows', r.reason)
    check('⑦ 拒绝时补丁零字节改动', readFileSync(patchPath, 'utf8') === BASE)
  }
  // 7c: 真机形状（persona text + 相对 bootstrap 文件都在）→ **写成**，且行里是 prefix
  {
    writeFileSync(patchPath, BASE, 'utf8')
    const dir = makePreset('real-shape', PERSONA_TEXT.replace("  name: '@deepseek-ai/dsh-tool-fs'", '  name: ./bootstrap.mjs'), { 'bootstrap.mjs': 'export const v = 1\n' })
    const r = await declarePresetRow(dir, 'real-shape', { patchPath, now: () => 111 })
    check('⑦ 真机形状 → 写成（created）', r.ok === true && r.status === 'created', JSON.stringify({ ok: r.ok, status: r.status, reason: r.reason, detail: r.detail }))
    check('⑦ 结果里如实记录迁移（pkg/from/to/行号）',
      r.aliased.length === 1 && r.aliased[0].from === 'text' && r.aliased[0].to === 'prefix' && r.aliased[0].pkg === '@deepseek-ai/dsh-persona', JSON.stringify(r.aliased))
    check('⑦ note 如实点名迁移，且**不出现 undefined**',
      String(r.note).includes('@deepseek-ai/dsh-persona') && String(r.note).includes('prefix') && !String(r.note).includes('undefined'), r.note)
    const written = readFileSync(patchPath, 'utf8')
    // 缩进：plugins 内容 = 10 空格，行级键 12，config 直属键 14（与 renderPresetRow 同形）
    check('⑦ 写出来的行里 persona 是 prefix（不是 text）',
      /^ {14}prefix: You are a helpful software engineer assistant\.$/mu.test(written) && !/^ {14}text:/mu.test(written),
      written.split(/\r?\n/u).find((l) => l.includes('prefix:') || l.includes('text:')))
    check('⑦ 写出来的行把 ./bootstrap.mjs 改写成 file: URL（基准是 profile 目录）',
      written.includes(pathToFileURL(join(HOME, '.agent-presets', 'real-shape', 'bootstrap.mjs')).href))
    check('⑦ 原补丁的既有行一个不少（update 不是 replace 整份）', written.includes('- id: keep-me'))
    check('⑦ 读回核实 6 项全过', r.verified?.ok === true && r.verified?.checked === 6, JSON.stringify(r.verified))
    // 7d: 幂等 —— 再声明一次：不再迁移、内容一致 → unchanged
    const again = await declarePresetRow(dir, 'real-shape', { patchPath, now: () => 222 })
    check('⑦ 幂等：第二次声明 status=unchanged（一个字节都不写）',
      again.ok === true && again.status === 'unchanged' && again.changed === false, JSON.stringify({ status: again.status, changed: again.changed }))
    check('⑦ 幂等：第二次不再报"迁移"（磁盘上的源文件仍写着 text，但写出的行没有变化）',
      again.aliased.length === 1 && again.changed === false, JSON.stringify(again.aliased))
    check('⑦ 幂等后补丁字节不变', readFileSync(patchPath, 'utf8') === written)
  }
}

console.log(fail === 0 ? `\nALL PASS（PASS ${pass} / FAIL ${fail}）` : `\n${fail} FAILED（PASS ${pass} / FAIL ${fail}）`)
assert.equal(fail, 0)
process.exit(fail === 0 ? 0 : 1)
