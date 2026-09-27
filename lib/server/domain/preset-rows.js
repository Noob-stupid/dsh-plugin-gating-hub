// L1 · domain —— preset-rows.js（预设 **plugins 行**的契约校验 + 已知别名归一；0.5.29 改错+加法）
//
// 为什么必须有它（**真机缺陷 D-⑦**，2026-09-27 定位）：
//   `preset-declare.js` 把 `.agent-presets/<id>/agent.cordis.yml` 原样搬成 profile 补丁里的
//   `plugins:` —— 但**只做结构校验**（preset-yaml.js：空文件 / tab / 未闭合引号 / 缩进跳级）。
//   于是这样一份**结构完全合法、框架却挂不上**的 composition 被照写不误：
//       - id: persona
//         name: '@deepseek-ai/dsh-persona'
//         config:
//           text: You are a helpful software engineer assistant.   # ← 该插件不认 text
//   框架侧 `@deepseek-ai/dsh-persona` 的 Config 是 `prefix: z.string().required()`，
//   装配时抛 `$.prefix missing required value`；注册表 `activate()` 把它吞成 `record.broken`，
//   界面那张卡片就永远顶着一枚红框「加载失败」（框架自己的 `brokenBadge`），用户点也点不动。
//   而**改前判据一条都拦不住**：YAML 合法、文件都在、包名都在。
//
// 本模块只做三件事，全部**证据驱动、可离线判定**（判据表见 PLUGIN_ROW_CONSTRAINTS）：
//   ① 行结构：不是映射 / 没有非空 `name`（框架 `entryListProblem` 同样会拒）；
//   ② `file:///` 引用目标**必须存在**（不存在 → 如实拒绝，绝不写一行必然加载失败的声明）；
//   ③ **已确证的框架契约**逐条核（缺必填键 / 用了别名键）。命中即拒绝并给可执行出路。
//
// ⚠️ 判据表**故意不猜**：只收「本机拿真机错误 + 框架真 schema 双向确证过」的条目。
//   没有证据的插件一律放行 —— 宁可漏判，也绝不因为猜错而把一个**本来可用**的预设挡在门外
//   （那是把缺陷换个方向，与 preset-yaml.js 的宽严分寸同一取舍）。
//
// 分层：L1 domain —— 纯函数、无 IO、无 ctx；文件存在性 / 路径解码 / 包解析均可注入（便于离线断言）。
// 行数预算：本模块独立于 preset-declare.js，两者各自留在 600 行架构硬顶内。

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 已知插件的行契约。每条都必须有**真机错误原文**背书（见文件头 D-⑦）。 */
const PLUGIN_ROW_CONSTRAINTS = [
  {
    /** 行 `name:` 精确匹配该插件的行才受这条约束。 */
    module: '@deepseek-ai/dsh-persona',
    /** 必填键（缺了框架 schema 直接抛 `$.<key> missing required value`）。 */
    required: ['prefix'],
    /** 报错时给用户的可执行出路。 */
    hint: '@deepseek-ai/dsh-persona 只认 prefix/suffix/complete/includeRuntimeContext；'
      + 'config.text 是旧版字段（0.1.5 起改名为 prefix），框架 schema 读不到它 → 请把 config.text 改名为 config.prefix',
  },
]

/**
 * **插件 config 键改名迁移表 —— 全仓唯一出处。**
 *
 * ⚠️ 这张表原本只在 `presets.js`（`PRESET_CONFIG_MIGRATIONS`）里，**只在框架升级那一步**跑。
 * 真实缺口：预设的来源不止"框架升级"一条 —— 装一个预设型子包 / 源码装配 / 手工放文件，
 * 都会把 `agent.cordis.yml` 落到 `.agent-presets/`，**完全不经过升级步骤**，于是旧键原样留下。
 * 本机事实（2026-09-27）：`router-spec/agent.cordis.yml` 是当天 21:27 装配落盘的，
 * 内容里仍是 `text:` → 声明行照写 → 卡片永远「加载失败」。所以判据要挂在**写行那一刻**。
 *
 * `presets.js` 从这里取同一张表，两处判据不会再分叉。
 */
const PRESET_CONFIG_KEY_MIGRATIONS = [
  { pkg: '@deepseek-ai/dsh-persona', from: 'text', to: 'prefix', since: '0.1.5' },
]

/** 粗粒度版本解析（只认 `maj.min.pat`，`-rc.n` 之类预发布尾缀忽略）；不可解析返回 null。 */
function parseDottedVersion(value) {
  const m = String(value ?? '').match(/(\d+)\.(\d+)\.(\d+)/u)
  return m === null ? null : { maj: Number(m[1]), min: Number(m[2]), pat: Number(m[3]) }
}

/** `target >= since`？任一侧不可解析 → false（**不敢迁移**比乱迁移安全）。 */
function isVersionAtLeast(target, since) {
  const t = parseDottedVersion(target)
  const s = parseDottedVersion(since)
  if (t === null || s === null) return false
  if (t.maj !== s.maj) return t.maj > s.maj
  if (t.min !== s.min) return t.min > s.min
  return t.pat >= s.pat
}

/**
 * 纯文本版的键改名迁移（不碰盘）：只改 `name:` 精确命中 `mig.pkg` 的行，且**仅当该行 config
 * 里还没有真键**（已有 `prefix` 就一个字节都不动 —— 绝不覆盖用户自己写的值）。
 * 返回 `{ text, migrated: [{ pkg, from, to, line }], skippedReason }`。
 *
 * ⚠️ `targetVersion` 为 `null`/不可解析时的取舍（**很要紧，别随手改**）：
 *   声明行这套机制**只在框架 0.1.7-rc.x 起才存在**（0.1.5 及更早靠目录发现，写行没有意义），
 *   能走到本函数的场景必然 ≥ 0.1.7，因此**未知版本按「全部迁移都适用」处理**。
 *   反过来若按 `isVersionAtLeast(null, …) === false` 处理，就会在"拿不到版本"时静默不动 ——
 *   于是又写出那行必然「加载失败」的声明，把本函数存在的意义整条抹掉。
 *   真机 D-⑦ 的现场正是"拿不到版本"（装配服务不知道框架版本）。
 */
function migratePluginRowKeys(compositionText, targetVersion, opts = {}) {
  const rules = opts.rules ?? PRESET_CONFIG_KEY_MIGRATIONS
  const unknownVersion = parseDottedVersion(targetVersion) === null
  const apply = unknownVersion ? [...rules] : rules.filter((r) => isVersionAtLeast(targetVersion, r.since))
  const lines = String(compositionText ?? '').replace(/\r\n/gu, '\n').split('\n')
  const migrated = []
  if (apply.length === 0) {
    return { text: lines.join('\n'), migrated, skippedReason: `目标版本 ${JSON.stringify(String(targetVersion ?? ''))} 低于全部迁移的引入版本 —— 不动用户配置` }
  }
  let rowName = null
  let configIndent = -1
  let rowIndent = -1
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim() === '' || /^\s*#/u.test(raw)) continue
    const indent = (raw.match(/^ */u) ?? [''])[0].length
    const item = raw.match(/^(\s*)- id:\s*(\S+)\s*$/u)
    if (item !== null) { rowIndent = indent; rowName = null; configIndent = -1; continue }
    if (rowIndent < 0) continue
    if (indent <= rowIndent) { rowName = null; configIndent = -1; continue }
    const kv = raw.match(/^(\s*)([A-Za-z_][\w-]*):(.*)$/u)
    if (kv === null) continue
    const directKey = indent === rowIndent + 2
    if (directKey && kv[2] === 'name') { rowName = kv[3].trim().replace(/^['"]|['"]$/gu, ''); configIndent = -1; continue }
    if (directKey && kv[2] === 'config' && kv[3].trim() === '') { configIndent = indent; continue }
    if (configIndent < 0 || indent <= configIndent) continue
    for (const rule of apply) {
      if (rule.pkg !== rowName || rule.from !== kv[2]) continue
      // 该行 config 里已有真键 → 本次跳过（绝不覆盖用户自己的值）
      let hasNew = false
      for (let j = configIndent + 1; j < lines.length; j += 1) {
        const l = lines[j]
        if (l.trim() === '') continue
        const ind = (l.match(/^ */u) ?? [''])[0].length
        if (ind <= configIndent) break
        if (new RegExp(`^\\s*${rule.to}:`, 'u').test(l)) { hasNew = true; break }
      }
      if (hasNew) continue
      lines[i] = `${kv[1]}${rule.to}:${kv[3]}`
      migrated.push({ pkg: rule.pkg, from: rule.from, to: rule.to, line: i + 1 })
    }
  }
  return { text: lines.join('\n'), migrated, skippedReason: null }
}

/** 值归一：去引号、折行、`''`→`'`；空串一律视作**未提供**（框架 schema 对 `''` 与缺失的处理不同，这里只判存在性）。 */
/** 行解析：composition 里的 `- id:` / `name:` / `config:` + config 直属子键（只认缩进语义，不做通用 YAML）。 */
function parseCompositionRows(text) {
  // ⚠️ 必须先归一 CRLF：真机磁盘上的 agent.cordis.yml 就是 CRLF（本机三个预设全是），
  //    行尾的 `\r` 会让 `^(\s*)- id:\s*(\S+)\s*$` 这类判据整体失配（自测真抓到过：归一一条都不命中）。
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  const rows = []
  let row = null
  let configIndent = null
  let blockKey = null
  let blockIndent = 0
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim() === '' || /^\s*#/u.test(raw)) {
      if (blockKey !== null && row !== null) row.config[blockKey] += '\n'
      continue
    }
    const indent = (raw.match(/^ */u) ?? [''])[0].length
    if (blockKey !== null && indent > blockIndent) {
      row.config[blockKey] += `${raw}\n`
      continue
    }
    blockKey = null
    const item = raw.match(/^(\s*)- id:\s*(\S+)\s*$/u)
    if (item !== null) {
      row = {
        id: item[2].replace(/^['"]|['"]$/gu, ''),
        indent,
        name: null,
        config: {},
        line: index + 1,
      }
      rows.push(row)
      configIndent = null
      continue
    }
    if (row === null) continue
    const kv = raw.match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/u)
    if (kv === null) continue
    const key = kv[1]
    const value = kv[2].trim()
    if (indent <= row.indent) { row = null; configIndent = null; continue }
    if (indent === row.indent + 2 && key === 'name') { row.name = value.replace(/^['"]|['"]$/gu, ''); configIndent = null; continue }
    if (indent === row.indent + 2 && key === 'config' && value === '') { configIndent = indent; continue }
    if (key === 'id') continue
    // config 直属子键：缩进必须比 `config:` 更深
    if (configIndent !== null && indent > configIndent) {
      row.config[key] = value
      if (/^[|>][-+]?\d*$/u.test(value)) { blockKey = key; blockIndent = indent }
    }
  }
  return rows
}

/** 默认解码器：`file:` URL → 磁盘路径（Node 自己的实现会拒绝坏百分号编码）。 */
const defaultToLocalPath = (url) => fileURLToPath(url)
/** 默认路径拼接（相对引用以预设目录为基准）。 */
const defaultJoinPath = (dir, relative) => join(dir, relative)

/** 值归一：去引号、折行、`''`→`'`；空串一律视作**未提供**（框架 schema 对 `''` 与缺失的处理不同，这里只判存在性）。 */
function normalizeConfigValue(raw) {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (text === '') return null
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/gu, "'")
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return text.slice(1, -1)
  return text
}

/**
 * ① 行结构 + ② `file:///` 目标存在性 + ③ 已确证契约。返回 `{ ok, problems: [{ code, row, detail, hint }] }`。
 * `exists` 可注入（离线断言用）；`checkFile` 为 false 时跳过 ②（只想要契约判据时用）。
 */
function validatePresetPluginRows(compositionText, opts = {}) {
  // `exists` 吃**磁盘路径**（不是 URL）；`toLocalPath` / `joinPath` 可注入，便于离线断言。
  const {
    exists = null, checkFiles = true, presetDir = null,
    toLocalPath = defaultToLocalPath, joinPath = defaultJoinPath,
  } = opts
  const problems = []
  const rows = parseCompositionRows(compositionText)

  if (rows.length === 0) {
    problems.push({ code: 'no-plugin-rows', row: null, detail: 'composition 里没有任何 `- id:` 插件行', hint: '框架挂载空预设没有意义，请检查 agent.cordis.yml' })
    return { ok: false, problems, rows: 0 }
  }

  for (const row of rows) {
    // ① 结构：框架 `entryListProblem` 会先拒掉没有 name 的行
    if (typeof row.name !== 'string' || row.name === '') {
      problems.push({ code: 'row-names-no-plugin', row: row.id, detail: `行 ${row.id} 没有 name（框架要求非空字符串）`, hint: '补上 `name:`（包名或 file:/// URL）' })
      continue
    }
    // ② file:/// 目标必须存在 —— 写一行指向不存在文件的声明，等于必然「加载失败」
    if (checkFiles && /^file:\/\//iu.test(row.name)) {
      let localPath = null
      try {
        const url = new URL(row.name)
        if (url.protocol !== 'file:') throw new Error('不是 file: 协议')
        // 必须真的解码成磁盘路径：坏百分号编码（`%zz`）在 URL 层是"合法"的，
        // 到加载器才知道读不了 —— 那正是要在**写行之前**拦下的形状。
        localPath = toLocalPath(url)
      } catch (error) {
        problems.push({ code: 'file-url-unparsable', row: row.id, detail: `行 ${row.id} 的 file: 引用无法解析成磁盘路径：${row.name}（${error.message}）`, hint: '改成合法的 file:/// 绝对 URL（路径片段要按 URL 规则百分号编码）' })
        continue
      }
      let present = null
      try { present = exists === null ? null : exists(localPath) } catch { present = null }
      if (present === false) {
        problems.push({ code: 'file-target-missing', row: row.id, detail: `行 ${row.id} 引用的文件不存在：${localPath}`, hint: '该预设引用了磁盘上没有的文件 —— 请补齐文件或修正引用（绝不写必然加载失败的行）' })
      }
    }
    // ②′ 相对引用（`./x.mjs` / `../x.mjs`）：声明行落在 **profile 补丁**里，相对基准变成 profile 目录，
    //     所以预设目录里不存在同名文件的相对引用**改不过去、留着也必然加载失败**。
    //     改前行为是"照写、留给读回核实判红" —— 那已经**写坏用户补丁**了（自测真抓到过这个形状：
    //     ok:false + verify-failed + 补丁已被改动）。契约校验必须在**动手写之前**拦下它。
    if (checkFiles && /^\.\.?\//u.test(row.name) && presetDir !== null) {
      const target = joinPath(presetDir, row.name)
      let present = null
      try { present = exists === null ? null : exists(target) } catch { present = null }
      if (present === false) {
        problems.push({
          code: 'relative-target-missing',
          row: row.id,
          detail: `行 ${row.id} 用相对引用 \`${row.name}\`，但预设目录里没有这个文件（${target}）`,
          hint: '相对引用在 profile 补丁里以 **profile 目录**为基准、且预设目录里没有该文件可改写 —— '
            + '请补齐该文件，或把这一行改成真实存在的包名 / file:/// 绝对 URL（绝不写必然加载失败的行）',
        })
      }
    }
    // ③ 已确证的框架契约
    for (const rule of PLUGIN_ROW_CONSTRAINTS) {
      if (row.name !== rule.module) continue
      const keys = Object.keys(row.config)
      const present = keys.filter((k) => normalizeConfigValue(row.config[k]) !== null)
      const missing = rule.required.filter((k) => !present.includes(k))
      if (missing.length > 0) {
        problems.push({
          code: 'missing-required-config',
          row: row.id,
          detail: `行 ${row.id}（${row.name}）缺少必填 config 键 ${missing.map((k) => `\`${k}\``).join('、')}`
            + `（现有键：${keys.length === 0 ? '无' : keys.map((k) => `\`${k}\``).join('、')}）—— 框架 schema 会抛 \`$.${missing[0]} missing required value\``,
          hint: rule.hint,
        })
      }
    }
  }
  return { ok: problems.length === 0, problems, rows: rows.length }
}

export {
  PLUGIN_ROW_CONSTRAINTS, PRESET_CONFIG_KEY_MIGRATIONS, isVersionAtLeast, migratePluginRowKeys,
  normalizeConfigValue, parseCompositionRows, parseDottedVersion, validatePresetPluginRows,
}
