// L1 · domain —— preset-declare.js（预设**声明行**：把 `.agent-presets/<id>/` 的内容写成 profile 补丁里的一行）
//
// 为什么必须有它（**框架 0.1.7-rc.x 的机制迁移**，2026-09-27 查实）：
//   · **0.1.5 及更早**：`@deepseek-ai/dsh-agent-presets` 扫描 `$DSH_HOME/.agent-presets/` 目录发现预设
//     （常量 `USER_PRESET_DIR = '.agent-presets'`，逐项校验 `PRESET_ID = /^[a-z0-9][a-z0-9-]*$/`）。
//   · **0.1.7-rc.2 起**：该包**不在依赖图里、也没被挂载**；`dsh-agent-preset-registry` 的 `definitions`
//     是**内存 Map，没有任何 fs 调用** —— 目录发现**彻底没了**。
//   · 现在的载体是 profile `cordis.patch.yml` 里的**声明行**：
//         - insert:
//             - id: preset-<x>
//               name: '@deepseek-ai/dsh-agent-preset'
//               config: { id, name?, description?, order?, plugins }
//     schema 见 `@deepseek-ai/dsh-agent-preset@0.1.7-rc.2/lib/index.js:13-25`（id/plugins 必填，name/description/order 可选）。
//     **只有落了文件、没有声明行的预设，用户在界面上根本看不到**（桌面端「自定义」分组为空就是这个原因）；
//     更糟的是老会话 resume 会 `RemoteError: Unknown agent preset: <id>`。
//
// 本模块只做一件事：**幂等地**把声明行写进目标 profile 的补丁文件（先备份 → 写 → 读回核实）。
//   · 行 id 固定 `preset-<id>`（与官方内置 `preset-standard` / `preset-minimal` … 同一命名法）；
//   · 同 id 行已存在 → **原地更新**，绝不重复插入（重复会让注册表 `Duplicate agent preset` 直接抛）；
//   · 块内容与磁盘预设逐字节一致 → **一个字节都不写、不建备份**（真正的幂等）；
//   · 写不成 → 如实返回 `ok:false + reason`，调用方**不许**再宣称"新建会话时选择"。
//
// ⚠️ **相对路径基准变了**（最容易踩的一脚）：声明行在 **profile 补丁**里，所以行内 `./x.mjs`
//   的相对基准是 **profile 目录**而不是预设目录。故 composition 里所有"确实存在于预设目录"的
//   `./x.mjs` 一律改写成 `file:///` 绝对 URL（`pathToFileURL` 会做百分号编码，中文用户名也安全）。
//   预设目录里**不存在**的同名文件**原样保留** —— 那种相对引用在 profile 下本来就不通，
//   我们没有依据替它猜一个绝对路径，硬改只会把指向别处的引用改坏（如实保留，不猜）。
//
// 分层：L1 domain —— 不认识 cordis ctx；时间戳 / 文件 IO / URL 转换均可注入（便于离线断言）。
// 行数预算：本模块与 preset-install.js 都必须留在 600 行架构硬顶之内（test-architecture-guard.mjs）。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { queuedWrite } from '../infra/fsx.js'
import { validateAgentConfig } from './preset-yaml.js'
import { migratePluginRowKeys, validatePresetPluginRows } from './preset-rows.js'

/** 声明行指向的模块名（框架侧预设插件，0.1.7-rc.2 起才有）。 */
const AGENT_PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
/** 行 id 前缀：官方内置行是 `preset-standard` / `preset-minimal` / `preset-ptc` / `preset-cordis`，照抄同一命名法。 */
const PRESET_ROW_PREFIX = 'preset-'
/** composition 的嵌套缩进：`plugins:` 在 `config:` 下 = 8 空格，其内容再缩进 2 = **10 空格**
 *  （与真机既有 `preset-router-*` 行逐字节同形）。 */
const CONFIG_KEY_INDENT = 8
const COMPOSITION_INDENT = CONFIG_KEY_INDENT + 2

/** 预设 id 判据（与旧 discovery 的 `PRESET_ID = /^[a-z0-9][a-z0-9-]*$/` 同源，另容忍下划线/点以便通用）。
 *  为什么必须校验：id 会进 YAML 的 `id:` 与注册表的 Map 键，形状可疑的值宁可拒绝也不写进用户补丁。 */
function isValidPresetId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]*$/u.test(id)
}

/** YAML 单引号标量（`'` 用 `''` 转义；换行折成空格——单行值最不容易写坏用户补丁）。 */
function quoteScalar(value) {
  const text = String(value).replace(/\r?\n/gu, ' ').trim()
  return `'${text.replace(/'/gu, "''")}'`
}

/** 归一 composition 文本：CRLF → LF、去尾部空行、正好一个结尾换行。 */
function normalizeComposition(text) {
  return `${String(text).replace(/\r\n/gu, '\n').replace(/\s+$/u, '')}\n`
}

/** 读预设清单（`preset.yml` 的 name/description/order；读不到返回 null，不抛）。
 *  **本模块是它的唯一定义处**：preset-source.js 从这里 re-export —— 这样依赖方向是
 *  `preset-source → preset-declare`（单向），不会出现"声明模块反过来依赖取源码模块"的循环。 */
function readPresetManifest(dir) {
  try {
    const text = readFileSync(join(dir, 'preset.yml'), 'utf8')
    const pick = (key) => {
      const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mu'))
      return m === null ? null : m[1].trim().replace(/^["']|["']$/gu, '')
    }
    return { name: pick('name'), description: pick('description'), order: pick('order') }
  } catch {
    return null
  }
}

/** 读预设目录里的 composition（`agent.cordis.yml` 优先，回退 `.yaml`）。读不到返回 null。 */
function readPresetComposition(dir) {
  for (const name of ['agent.cordis.yml', 'agent.cordis.yaml']) {
    const file = join(dir, name)
    try {
      if (existsSync(file)) return { file, text: readFileSync(file, 'utf8') }
    } catch {}
  }
  return null
}

/**
 * 读预设展示元数据（`preset.yml` 的 name/description/order），带**合理缺省**：
 *   · name 缺省 = 目录名（面板至少有个能认的名字；绝不发 `name: ''` 这种空标量）；
 *   · description 缺省 = 不提这个键（可选字段，比编一句话诚实）；
 *   · order 缺省 = 1000（排在内置预设之后，不抢它们的位置）。
 * `preset.yml` 缺 name 时**也**回退目录名（readPresetManifest 会返回 null 值的 name）。
 */
function presetDisplayMeta(dir, id) {
  const raw = (() => {
    try { return readPresetManifest(dir) } catch { return null }
  })() ?? {}
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : String(id)
  const description = typeof raw.description === 'string' && raw.description.trim() !== '' ? raw.description.trim() : null
  const orderNum = Number(raw.order)
  const order = Number.isFinite(orderNum) ? orderNum : 1000
  return { name, description, order }
}

/**
 * composition 里的相对文件引用 → `file:///` 绝对 URL（**只改真存在于预设目录的那些**）。
 * 形态判据：`name:` 的值是 `./x` 或 `../x`（`.mjs`/`.js`/`.cjs`/`.json`/任意相对文件）。
 * 返回 `{ text, rewritten[] }`：rewritten 逐条记下 `<相对> → <file: URL>`，供调用方如实上报。
 */
function absolutizeComposition(text, dir, { toFileUrl = pathToFileURL, exists = existsSync } = {}) {
  const rewritten = []
  const out = String(text).replace(/^([ \t]*name:[ \t]*)(\.\.?\/[^\s#]+)[ \t]*$/gmu, (all, head, spec) => {
    let target = null
    try { target = resolve(dir, spec) } catch { return all }
    let present = false
    try { present = exists(target) === true } catch { present = false }
    if (!present) return all    // 不在预设目录里 → 原样保留（我们没有依据替它猜路径，不猜）
    let url = null
    try { url = toFileUrl(target).href } catch { return all }
    rewritten.push({ from: spec, to: url })
    return `${head}${url}`
  })
  return { text: out, rewritten }
}

/** 把 composition 整段缩进成 `plugins:` 的嵌套列表（空行保持空行，不留尾随空格）。 */
function indentComposition(text, spaces = COMPOSITION_INDENT) {
  const pad = ' '.repeat(spaces)
  return String(text)
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${pad}${line}`))
    .join('\n')
}

/** 渲染一行完整的预设声明（`- insert:` 顶级项 + `- id:` 子项 + `config:`）。 */
function renderPresetRow(config, compositionText) {
  const lines = [
    '- insert:',
    `    - id: ${PRESET_ROW_PREFIX}${config.id}`,
    `      name: '${AGENT_PRESET_MODULE}'`,
    '      config:',
    `        id: ${config.id}`,
  ]
  if (typeof config.name === 'string' && config.name !== '') lines.push(`        name: ${quoteScalar(config.name)}`)
  if (typeof config.description === 'string' && config.description !== '') lines.push(`        description: ${quoteScalar(config.description)}`)
  if (config.order !== null && config.order !== undefined) lines.push(`        order: ${config.order}`)
  lines.push('        plugins:')
  lines.push(indentComposition(compositionText).replace(/\s+$/u, ''))
  return lines.join('\n')
}

/** 声明成功后那句核心文案（**成功/未改动两条路共用**，避免一边说"重启后可选"、另一边忘了说）。 */
function presetDeclarationSentence(rowId, patchPath, { unchanged = false } = {}) {
  const tail = unchanged ? '（此前已声明、内容一致，本次未改动任何字节）' : ''
  return `已声明为预设行 ${rowId}（写入 ${patchPath}）${tail}；**重启实例后**在新会话可选`
}

/**
 * 找一个 `- insert:` 块的**结束**下标（独占）—— 这是本模块最容易写错的一处，故单独成函数。
 *
 * 为什么不能只判"下一个列 0 的 `^- `"：那样在**声明行是文件最后一块**时（我们新写的行正是如此），
 * 块的边界会一路吃到文件末尾，于是行级的 `      name: '…'` 被当成 `config.plugins` 的内容 ——
 * 读回核实会报"plugins 与 agent.cordis.yml 不一致"，而文件其实完全正确（自测真抓到过这个假红）。
 *
 * 判据（与真机 `dev-*.yml` 的缩进惯例一致：insert 子项 4 空格、行级键 6 空格、嵌套 6+）：
 *   · 列 0 的 `^- ` → 新的顶级条目，块到此为止；
 *   · 缩进 **≤ 2** 的非空行 → 也是新的顶级条目（写成 `- id: x` 或 `-id` 都算）；
 *   · 缩进 ≥ 4 → 仍是本块内容（`- id:` / `name:` / `config:` / composition…）。
 * 返回下标 **不含**块尾的空行（尾随空行属于块与块之间的分隔，不该被搬来搬去）。
 */
function findInsertBlockEnd(lines, start) {
  let end = lines.length
  let lastContent = start
  for (let j = start + 1; j < lines.length; j += 1) {
    const line = lines[j]
    if (line.trim() === '') continue
    const indent = (line.match(/^ */u) ?? [''])[0].length
    if (/^- /u.test(line) || indent <= 2) { end = j; break }
    lastContent = j
  }
  if (end === lines.length) return lastContent + 1
  return end
}

/**
 * 从整个补丁文件文本里找出**所有** `preset-*` 声明行（含它们的块边界）。
 * 返回 `[{ id, start, end, text }]`（end 为**独占**下标，指向块后的第一个顶级行或文件末）。
 */
function scanPresetRows(text) {
  const lines = String(text ?? '').split(/\r?\n/u)
  const rows = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^- insert:\s*$/u.test(lines[i])) continue
    const end = findInsertBlockEnd(lines, i)
    let id = null
    for (let j = i + 1; j < end; j += 1) {
      const m = lines[j].match(new RegExp(`^ {4}- id: (${PRESET_ROW_PREFIX}[A-Za-z0-9._-]+)\\s*$`, 'u'))
      if (m !== null) { id = m[1]; break }
    }
    if (id === null) { i = Math.max(i, end - 1); continue }
    rows.push({ id, start: i, end, text: lines.slice(i, end).join('\n').replace(/\s+$/u, '') })
    i = Math.max(i, end - 1)
  }
  return rows
}

/** 把一个区间（行下标，独占 end）从行数组里删掉。 */
function spliceOut(lines, start, end) {
  return lines.slice(0, start).concat(lines.slice(end))
}

/** 收拾块间空行：不留连续空行，不留文件头/尾空行；结尾正好一个换行。 */
function tidyBlankLines(lines) {
  const out = []
  for (const line of lines) {
    if (line.trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') continue
    out.push(line)
  }
  while (out.length > 0 && out[0].trim() === '') out.shift()
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return `${out.join('\n')}\n`
}

/**
 * 把声明行**幂等**地写进补丁文本（纯文本变换，不碰盘；写盘与核实见 declarePresetRow）。
 * 返回 `{ text, changed, created, removed }`：
 *   · 同 id 已有行 → 用新块替换（`created:false`）；`removed` 记下被清掉的重复行 id；
 *   · 没有 → 追加到末尾（`created:true`）；
 *   · 新块与旧块逐字节一致 → `changed:false`，`text` 与输入一致（**真正的幂等**）。
 * 老的 `[]` 顶层占位符在这里就被去掉（issue #7 事故：`[]` 后面再跟条目是非法 YAML，启动直接崩）。
 */
function upsertPresetRow(patchText, rowText, rowId) {
  const original = String(patchText ?? '')
  const withoutPlaceholder = original
    .split(/\r?\n/u)
    .filter((line) => !/^\s*\[\s*\]\s*$/u.test(line))
    .join('\n')
  const lines = withoutPlaceholder.split(/\r?\n/u)
  const rows = scanPresetRows(lines.join('\n'))
  const same = rows.filter((r) => r.id === rowId)
  // 块尾补一个空行 = 与下一个顶级条目之间留出分隔（补丁文件的可读性；YAML 里空行无意义）。
  // 旧实现不带它，于是"原地替换"会把原来那句 `- id: …` 贴到 composition 的最后一行上（自测抓到的形状退化）。
  const block = [...rowText.split('\n'), '']
  if (same.length > 0) {
    if (same.length === 1 && same[0].text === rowText) {
      const tidy = tidyBlankLines(lines)
      return { text: tidy, changed: tidy !== original, created: false, removed: [] }
    }
    // 从后往前替换/删除，下标才不会失效
    const removed = []
    const ordered = [...same].sort((a, b) => b.start - a.start)
    let next = lines
    for (const [index, row] of ordered.entries()) {
      if (index === 0) {
        next = next.slice(0, row.start).concat(block, next.slice(row.end))
      } else {
        removed.push(row.id)
        next = spliceOut(next, row.start, row.end)
      }
    }
    return { text: tidyBlankLines(next), changed: true, created: false, removed }
  }
  const inserted = [...lines]
  while (inserted.length > 0 && inserted[inserted.length - 1].trim() === '') inserted.pop()
  inserted.push(...block)
  return { text: tidyBlankLines(inserted), changed: true, created: true, removed: [] }
}

// ── 读回核实（**写后必做**）：YAML 关键字段比对，逐条给出证据 ────────────────────────────

/** 从补丁文本里抽出某个 preset 行的 `config:` 段落，转成「键 → 值」的浅表（只认 config 的直接子键）。
 *  值一律做"去掉包裹引号 + 折行拼接"的归一，用来做**关键字段比对**（不是通用 YAML 解析器）。 */
function readPresetRowConfig(patchText, rowId) {
  const lines = String(patchText ?? '').split(/\r?\n/u)
  const rows = scanPresetRows(lines.join('\n'))
  const hit = rows.find((r) => r.id === rowId)
  if (hit === undefined) return null
  const block = lines.slice(hit.start, hit.end)
  let cfgAt = -1
  for (let i = 0; i < block.length; i += 1) {
    if (new RegExp(`^ {6}config:\\s*$`, 'u').test(block[i])) { cfgAt = i; break }
  }
  if (cfgAt === -1) return null
  const fields = {}
  const plugins = []
  let inPlugins = false
  for (let i = cfgAt + 1; i < block.length; i += 1) {
    const line = block[i]
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    const indent = (line.match(/^ */u) ?? [''])[0].length
    if (indent < CONFIG_KEY_INDENT) break                    // 回到行级键（`- id:` / `name:`）
    if (indent === CONFIG_KEY_INDENT) {
      // ⚠️ `^ {8}`（= 至少 8 空格，后面直接是键名）而**不是**"正好 8 空格"的写法 —— 后者在 config 是
      // 文档**最后一块**时会把每一行都当成 `plugins` 的内容，config 字段全部读成 undefined，
      // 于是"写成功了却报核实不通过"（自测真抓到过）。
      const kv = line.match(new RegExp(`^ {${CONFIG_KEY_INDENT}}([A-Za-z_][\\w-]*):\\s*(.*)$`, 'u'))
      if (kv === null) continue
      inPlugins = kv[1] === 'plugins'
      if (!inPlugins) fields[kv[1]] = kv[2].trim()
      continue
    }
    if (inPlugins) plugins.push(line.slice(COMPOSITION_INDENT))
  }
  return { fields, plugins }
}

/** 把「键 → 原始标量」归一成可比较的值（去引号、`''`→`'`、数字字面量转数字）。 */
function normalizeScalar(raw) {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (text === '') return ''
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/gu, "'")
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return text.slice(1, -1)
  const num = Number(text)
  return Number.isFinite(num) && text !== '' ? num : text
}

/**
 * 写后读回核实：① 行在；② 模块名对；③ `config.id` 对；④ name/description/order 与期望一致；
 * ⑤ `plugins` 与磁盘 `agent.cordis.yml` 逐行一致（已把相对引用改写成 file: URL 之后）；
 * ⑥ 没有残留的相对 `./` 引用（除非源目录里本来就没有那个文件）。
 * 返回 `{ ok, problems[], checked }` —— 任一条不通过都算不通过（绝不"写没写成"靠假设）。
 */
function verifyDeclaredRow(patchText, { rowId, config, compositionText }) {
  const problems = []
  const block = scanPresetRows(patchText).find((r) => r.id === rowId)
  if (block === undefined) {
    return { ok: false, problems: [`读回时找不到声明行 ${rowId}`], checked: 0 }
  }
  if (!block.text.includes(`name: '${AGENT_PRESET_MODULE}'`)) problems.push(`声明行的 name 不是 ${AGENT_PRESET_MODULE}`)
  const parsed = readPresetRowConfig(patchText, rowId)
  if (parsed === null) problems.push('声明行里读不到 config 段')
  else {
    const gotId = normalizeScalar(parsed.fields.id)
    if (gotId !== config.id) problems.push(`config.id 读回是 ${JSON.stringify(gotId)}，期望 ${JSON.stringify(config.id)}`)
    if (typeof config.name === 'string' && normalizeScalar(parsed.fields.name) !== config.name) {
      problems.push(`config.name 读回是 ${JSON.stringify(normalizeScalar(parsed.fields.name))}，期望 ${JSON.stringify(config.name)}`)
    }
    if (typeof config.description === 'string' && normalizeScalar(parsed.fields.description) !== config.description) {
      problems.push('config.description 与源 preset.yml 不一致')
    }
    if (config.order !== null && config.order !== undefined && normalizeScalar(parsed.fields.order) !== config.order) {
      problems.push(`config.order 读回是 ${JSON.stringify(normalizeScalar(parsed.fields.order))}，期望 ${JSON.stringify(config.order)}`)
    }
    const want = normalizeComposition(compositionText).replace(/\s+$/u, '').split('\n')
    // 注释/空行不做逐字比对：YAML 里它们不是数据（config 顶层注释会被解析器丢掉，缩进更深的
    // 注释会作为块标量内容留下）—— 逐字比对会把"文件完全正确"判成不一致（自测真抓到过这个假红）。
    // 真正要钉的是**配置行**逐行一致，那才是框架读进去的东西。
    const significant = (list) => list.filter((line) => line.trim() !== '' && !/^\s*#/u.test(line))
    if (significant(parsed.plugins).join('\n') !== significant(want).join('\n')) {
      const at = significant(want).findIndex((line, i) => significant(parsed.plugins)[i] !== line)
      problems.push(`config.plugins 与 agent.cordis.yml 不一致（第 ${at + 1} 行起）`)
    }
  }
  const residual = block.text.split('\n').filter((line) => /^\s+name:\s*\.\.?\//u.test(line))
  if (residual.length > 0) problems.push(`声明行里仍有 ${residual.length} 处相对引用未改写：${residual[0].trim()}`)
  return { ok: problems.length === 0, problems, checked: 6 }
}

// ── 落盘入口 ────────────────────────────────────────────────────────────────────────

/** 组装一行预设声明的**全部输入**（纯函数式，不写盘）：composition / config / rowText。 */
function buildPresetDeclaration(dir, id, opts = {}) {
  const presetId = String(id ?? '').trim()
  if (!isValidPresetId(presetId)) return { ok: false, reason: 'invalid-preset-id', detail: `预设 id 不合法：${JSON.stringify(id)}` }
  if (typeof dir !== 'string' || dir === '' || !existsSync(dir)) {
    return { ok: false, reason: 'preset-dir-missing', detail: `预设目录不存在：${dir}` }
  }
  const composition = readPresetComposition(dir)
  if (composition === null) return { ok: false, reason: 'no-composition', detail: `预设目录里没有 agent.cordis.yml/.yaml：${dir}` }
  const verdict = validateAgentConfig(composition.text)
  if (verdict.ok !== true) {
    return { ok: false, reason: 'invalid-composition', detail: `agent.cordis.yml 未通过结构校验：${verdict.problems[0] ?? ''}` }
  }
  // ① 插件 config 旧键迁移（**加法**：把框架 schema 根本读不到的旧键改成真键；表见 preset-rows.js）。
  //    与框架升级那一步**同一张表**（PRESET_CONFIG_KEY_MIGRATIONS），只是判据挂在**写行那一刻** ——
  //    预设还会经「装预设型子包 / 源码装配 / 手工放文件」落盘，那些路完全不过升级步骤（真机 D-⑦）。
  //    只动唯一命中、且**该行还没有真键**的那一行；版本判据过不去就一个字都不动。
  const migrationVersion = opts.frameworkVersion ?? null
  const migratedKeys = migratePluginRowKeys(composition.text, migrationVersion)
  // ② 写行**之前**的契约校验：行结构 / `file:///` 目标存在性 / 已确证的框架契约。
  //    命中即**如实拒绝写入** —— 绝不往用户 profile 里写一行必然「加载失败」的声明。
  const rowsVerdict = validatePresetPluginRows(migratedKeys.text, {
    checkFiles: true,
    presetDir: dir,
    exists: (localPath) => existsSync(localPath),
  })
  if (rowsVerdict.ok !== true) {
    const first = rowsVerdict.problems[0]
    return {
      ok: false,
      reason: first.code === 'file-target-missing' || first.code === 'file-url-unparsable' || first.code === 'relative-target-missing'
        ? 'unresolvable-plugin-file'
        : 'invalid-plugin-rows',
      detail: `预设的 plugins 行未通过契约校验：${rowsVerdict.problems.map((p) => p.detail).join('；')}`
        + `（出路：${first.hint}）`,
      problems: rowsVerdict.problems,
    }
  }
  const absolutized = absolutizeComposition(migratedKeys.text, dir, opts)
  const compositionText = normalizeComposition(absolutized.text)
  const meta = presetDisplayMeta(dir, presetId)
  const config = { id: presetId, name: meta.name, description: meta.description, order: meta.order }
  const rowId = `${PRESET_ROW_PREFIX}${presetId}`
  return {
    ok: true, id: presetId, rowId, dir, config, compositionText,
    compositionFile: composition.file, rewritten: absolutized.rewritten, aliased: migratedKeys.migrated,
    migrationNote: migratedKeys.skippedReason,
    rowText: renderPresetRow(config, compositionText),
  }
}

/** 补丁文件路径：显式 `patchPath` 优先，否则 `profileDir/cordis.patch.yml`；两者都没有 → null。 */
function resolvePatchPath({ patchPath = null, profileDir = null } = {}) {
  if (typeof patchPath === 'string' && patchPath !== '') return patchPath
  if (typeof profileDir === 'string' && profileDir !== '') return join(profileDir, 'cordis.patch.yml')
  return null
}

/** 备份名：`<补丁>.bak-preset-<时间戳>`（与既有 `.bak-<ts>` 家族同形状，可被同一套清理识别）。
 *  已存在就自增后缀 —— 同一毫秒的两次声明绝不互相覆盖（F4 的同族教训）。 */
function presetRowBackupPath(patchPath, timeValue, exists = existsSync) {
  const base = `${patchPath}.bak-preset-${timeValue}`
  if (!exists(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!exists(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * **装配预设后写声明行**（唯一写盘点）。返回结构化结果，字段全部如实：
 *   `{ ok, status: 'created'|'updated'|'unchanged'|'skipped'|'failed', reason?, detail?, rowId, patchPath,
 *      backup, changed, verified: {ok, problems, checked} | null, rewritten[], note }`
 *
 * 五种结局（`reason` 只在非 created/updated/unchanged 时出现）：
 *   · `created`   — 新写了 `preset-<id>` 行（先备份原有补丁）；
 *   · `updated`   — 已有同 id 行，原地换成新内容（先备份原有补丁）；
 *   · `unchanged` — 已有同 id 行且**逐字节一致**：一个字节都没写、不建备份（真正的幂等）；
 *   · `skipped`   — `no-patch-path`：调用方没给 profile（离线单测/无 profile 场景），**明确不宣称已声明**；
 *   · `failed`    — 预设目录/id 不合法、YAML 校验不过、写盘失败、读回核实不通过（**绝不谎报**）。
 */
function declarePresetRow(dir, id, opts = {}) {
  const {
    patchPath = null, profileDir = null, now = Date.now,
    backup = true, verify = true, toFileUrl = pathToFileURL, exists = existsSync,
    frameworkVersion = null,
  } = opts
  const built = buildPresetDeclaration(dir, id, { toFileUrl, exists, frameworkVersion })
  if (built.ok !== true) {
    return { ok: false, status: 'failed', reason: built.reason, detail: built.detail, rowId: null, patchPath: null, backup: null, changed: false, verified: null, rewritten: [], aliased: [], problems: built.problems ?? [], note: built.detail }
  }
  const target = resolvePatchPath({ patchPath, profileDir })
  if (target === null) {
    return {
      ok: false, status: 'skipped', reason: 'no-patch-path', rowId: built.rowId, patchPath: null, backup: null,
      changed: false, verified: null, rewritten: built.rewritten, aliased: built.aliased, config: built.config,
      note: `未写入声明行：本次调用没有目标 profile（既没有 patchPath 也没有 profileDir）—— `
        + `**文件已就位，但当前框架版本（0.1.7-rc.x 起）需要声明行才能显示**；请在目标 profile 的 cordis.patch.yml 里补一行 preset-${built.id}`,
    }
  }
  // 补丁文件所在目录不存在 = 调用方给的 profile 是错的：宁可 skipped 也不凭空造一个 profile 目录
  try {
    if (!exists(dirname(target))) {
      return {
        ok: false, status: 'failed', reason: 'no-profile-dir', rowId: built.rowId, patchPath: target, backup: null,
        changed: false, verified: null, rewritten: built.rewritten, aliased: built.aliased, config: built.config,
        detail: `目标 profile 目录不存在：${dirname(target)}`,
        note: `未写入声明行：目标 profile 目录不存在（${dirname(target)}）—— **文件已就位，但当前框架版本需要声明行才能显示**`,
      }
    }
  } catch {}
  return queuedWrite(() => {
    let before = ''
    try { if (exists(target)) before = readFileSync(target, 'utf8') } catch { before = '' }
    const outcome = upsertPresetRow(before, built.rowText, built.rowId)
    if (outcome.changed !== true) {
      return {
        ok: true, status: 'unchanged', rowId: built.rowId, patchPath: target, backup: null, changed: false,
        verified: verify === true ? verifyDeclaredRow(before, built) : null, rewritten: built.rewritten, aliased: built.aliased, config: built.config,
        removed: outcome.removed,
        // 与 created/updated 用**同一句**核心文案：幂等重装时用户同样要看懂"它在、重启后可选"，
        // 只多一句"本次未改动任何字节"（诚实交代用户的文件没被动过）。
        note: presetDeclarationSentence(built.rowId, target, { unchanged: true }),
      }
    }
    let backupPath = null
    if (before.trim() !== '' && backup === true) {
      backupPath = presetRowBackupPath(target, typeof now === 'function' ? now() : now, exists)
      try {
        copyFileSync(target, backupPath)
      } catch (error) {
        return {
          ok: false, status: 'failed', reason: 'backup-failed', rowId: built.rowId, patchPath: target, backup: null,
          changed: false, verified: null, rewritten: built.rewritten, aliased: built.aliased, config: built.config,
          detail: `备份失败（绝不在没备份的情况下改用户补丁）：${error instanceof Error ? error.message : String(error)}`,
          note: '未写入声明行：改前备份失败，已放弃写入（补丁文件一个字节都没动）',
        }
      }
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, outcome.text, 'utf8')
    } catch (error) {
      return {
        ok: false, status: 'failed', reason: 'write-failed', rowId: built.rowId, patchPath: target, backup: backupPath,
        changed: false, verified: null, rewritten: built.rewritten, aliased: built.aliased, config: built.config,
        detail: `写入失败：${error instanceof Error ? error.message : String(error)}`,
        note: `写入声明行失败（${error instanceof Error ? error.message : String(error)}）—— `
          + '**文件已就位，但当前框架版本（0.1.7-rc.x 起）需要声明行才能显示**',
      }
    }
    let readBack = null
    try { readBack = readFileSync(target, 'utf8') } catch { readBack = null }
    if (readBack === null) {
      return {
        ok: false, status: 'failed', reason: 'readback-failed', rowId: built.rowId, patchPath: target, backup: backupPath,
        changed: false, verified: null, rewritten: built.rewritten, aliased: built.aliased, config: built.config,
        detail: '写后读回失败（读不到文件）', note: '写入声明行后读回失败：无法确认是否写成，请人工检查该补丁文件',
      }
    }
    const checked = verify === true ? verifyDeclaredRow(readBack, built) : null
    const ok = checked === null || checked.ok === true
    const extra = outcome.removed.length > 0 ? `；顺带清掉 ${outcome.removed.length} 行重复的同 id 声明` : ''
    return {
      ok, status: ok ? (outcome.created ? 'created' : 'updated') : 'failed',
      reason: ok ? null : 'verify-failed',
      detail: ok ? null : `读回核实不通过：${checked.problems.join('；')}`,
      rowId: built.rowId, patchPath: target, backup: backupPath, changed: true,
      verified: checked, rewritten: built.rewritten, aliased: built.aliased, config: built.config, removed: outcome.removed,
      note: ok
        ? presetDeclarationSentence(built.rowId, target)
          + (built.rewritten.length > 0 ? `；composition 里 ${built.rewritten.length} 处相对文件已改写为 file: URL（基准是 profile 目录，不是预设目录）` : '')
          + (built.aliased.length > 0
            ? `；composition 里 ${built.aliased.length} 处插件旧键已按框架 schema 迁移（`
              + `${built.aliased.map((r) => `${r.pkg} 的 ${r.from} → ${r.to}（第 ${r.line} 行）`).join('、')}）`
            : '')
          + extra
        : `声明行写入后读回核实不通过：${checked.problems.join('；')}（已备份到 ${backupPath}，请人工检查）`,
    }
  })
}

/** 面板/日志用的一句话（**按实际落盘与声明结果生成**，绝不无脑说"新建会话时选择"）：
 *   · 声明成功 → 「已声明为预设行 preset-x（写入 …）；**重启实例后**在新会话可选」；
 *   · 只落了文件 → 明确说「文件已就位，但当前框架版本需要声明行才能显示」并给出出路。 */
function presetDeclarationNote(result) {
  const r = result ?? {}
  if (r.ok === true && (r.status === 'created' || r.status === 'updated' || r.status === 'unchanged')) {
    return presetDeclarationSentence(r.rowId, r.patchPath, { unchanged: r.status === 'unchanged' })
  }
  const why = r.detail ?? r.reason ?? '未知原因'
  // ⚠️ 失败分支**不能**说"重启实例后即可选"：那时还没写成，重启也不会出现它。
  // （"重启实例后可选"是**声明成功**那一路的语义，只出现在 presetDeclarationSentence 里。）
  return `**文件已就位，但当前框架版本（0.1.7-rc.x 起预设改为声明行）需要声明行才能在界面上显示** —— `
    + `本次声明未写成（${why}）。出路：在目标 profile 的 cordis.patch.yml 里补一行 `
    + `\`- insert:\` / \`- id: preset-<预设 id>\` / \`name: '${AGENT_PRESET_MODULE}'\`（config 取该预设的 agent.cordis.yml 作为 plugins），补上后即可选用`
}

export {
  AGENT_PRESET_MODULE, COMPOSITION_INDENT, CONFIG_KEY_INDENT, PRESET_ROW_PREFIX,
  absolutizeComposition, buildPresetDeclaration, declarePresetRow, findInsertBlockEnd,
  indentComposition, isValidPresetId, normalizeComposition, presetDeclarationNote, presetDisplayMeta,
  presetRowBackupPath, quoteScalar, readPresetComposition, readPresetManifest, readPresetRowConfig,
  renderPresetRow, resolvePatchPath, scanPresetRows, tidyBlankLines, upsertPresetRow, verifyDeclaredRow,
}
