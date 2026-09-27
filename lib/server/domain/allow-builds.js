// L1 · domain —— allow-builds.js（**只有用户显式点击时**才写盘：最小放行项 + 改前备份 + 写后读回核实）
//
// 为什么单开一个模块（2026-09-27 加法 + 改错）：
//   pnpm 11 的 `strictDepBuilds` 默认为 true —— 只要 profile 里存在**带安装脚本但未获批准**的依赖，
//   任何一次 pnpm 安装都会在**装完之后**抛 `ERR_PNPM_IGNORED_BUILDS` 并 exitCode=1，
//   哪怕这次操作真正想做的事（写清单 + 对齐 lock）已经做完了；用户看到的却是"失败"。
//   出路必须是**显式的**：用户自己点一下「允许这些构建脚本」，我们才在 profile 的 pnpm-workspace.yaml
//   里补上**具体包名**的放行项（pnpm 自己的 `approve-builds` 写的就是这个位置）。
//
// ⚠️ 安全边界（写死在这里，配套测试 tests/test-allow-builds.mjs 逐条钉死）：
//   ① **绝不自动执行**：本模块只被 domain/plugin-actions.js 的 `allow-builds` 动作调用，
//      而那个动作只由用户点击 -> POST /plugin-console/run-suggested 触发；安装/检测路径永不调用它。
//   ② **绝不下载、绝不执行任何脚本**：本模块只做文本改写（readFile/writeFile/copyFile），
//      不 spawn 任何进程、不碰 argv、不跑 pnpm。放行只影响"pnpm 下次安装是否还会因未批准而报错"；
//      真正的构建由 pnpm 在**用户之后自己发起**的安装里执行（本机实测首次 ≈19 分钟，note 里如实说清）。
//   ③ **只动最小必要行**：命中一个包就只改/加那一行；其它字段一字不动（写后按行比对核实）；
//      改前先复制 `.bak-<时间戳>`，写后读回核实（含 sha256 前后值）。
//   ④ 认不出形态就不硬来：退回 `strictDepBuilds: false`（需求里点名的兜底），
//      并在 note 里写清副作用（对所有依赖生效）。
//
// 分层：L1 domain —— 不认识 cordis ctx；时间戳可注入（便于离线断言）。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NPM_NAME_RE } from './dep-source.js'

const WORKSPACE_FILE = 'pnpm-workspace.yaml'
const MODULES_FILE = join('node_modules', '.modules.yaml')
const ALLOW_KEY = 'allowBuilds'
const ALLOWED_VALUE = 'true'
const DENIED_VALUE = 'false'
const ONLY_BUILT_KEY = 'onlyBuiltDependencies'
const STRICT_KEY = 'strictDepBuilds'
const IGNORED_KEY = 'ignoredBuilds'

function textOf(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}
function sha256Of(text) {
  return createHash('sha256').update(textOf(text), 'utf8').digest('hex')
}
/** 文件行：统一按 LF 认识（CRLF 也拆得开；写回时统一 LF，符合"LF / 无 BOM"的要求）。 */
function linesOf(text) {
  return textOf(text).split(/\r?\n/u)
}
function unquote(value) {
  return textOf(value).trim().replace(/^['"]|['"]$/gu, '')
}
/** 顶层键（容忍 pnpm 写的带引号形态：`"allowBuilds":`）。 */
function isTopLevelKey(line, key) {
  return new RegExp(`^["']?${key}["']?\\s*:`, 'u').test(line)
}
/** 表头行上是否直接写了值（如 `allowBuilds: { ssh2: true }` 这种行内/flow 形态）。
 *  这种形态**不能**再往下面追加块条目（会写出坏 YAML）—— 判为"形态不允许"，走 strictDepBuilds 兜底。 */
function headerHasInlineValue(line, key) {
  const m = textOf(line).match(new RegExp(`^["']?${key}["']?\\s*:(.*)$`, 'u'))
  if (m === null) return false
  const rest = m[1].trim()
  return rest !== '' && !rest.startsWith('#')
}
/** 顶层块 = `<key>:` 顶格那行 + 其后所有缩进行（空行/注释算块内，直到下一个顶格实义行）。 */
function topLevelBlock(lines, key) {
  const headerIndex = lines.findIndex((line) => isTopLevelKey(line, key))
  if (headerIndex < 0) return null
  let endIndex = headerIndex
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/u.test(line) || /^\s/u.test(line)) { endIndex = i; continue }
    break
  }
  return { headerIndex, endIndex, body: lines.slice(headerIndex + 1, endIndex + 1) }
}
/** 块里的 `name: value` 条目（只认简单标量；认不出返回 null → 调用方走兜底）。 */
function mapEntries(block) {
  const entries = []
  for (let i = 0; i < block.body.length; i += 1) {
    const raw = block.body[i]
    if (raw.trim() === '' || /^\s*#/u.test(raw)) continue
    const m = raw.match(/^(\s+)([^\s:#][^:]*?)\s*:\s*(.*)$/u)
    if (m === null) return null
    entries.push({ offset: i, indent: m[1], name: unquote(m[2]), value: m[3].trim(), raw })
  }
  return entries
}
/** 块里的 `- name` 列表项（同上）。 */
function listEntries(block) {
  const entries = []
  for (let i = 0; i < block.body.length; i += 1) {
    const raw = block.body[i]
    if (raw.trim() === '' || /^\s*#/u.test(raw)) continue
    const m = raw.match(/^(\s*)-\s+(.+?)\s*$/u)
    if (m === null) return null
    entries.push({ offset: i, indent: m[1], name: unquote(m[2]), raw })
  }
  return entries
}
function normalizeNames(packages) {
  return [...new Set((Array.isArray(packages) ? packages : []).map((n) => textOf(n).trim()).filter((n) => n !== ''))]
}

/** 纯函数：从文本读出放行状态。
 *  blocked = 还卡在"未决"的包（pnpm 写的占位值，如 `set this to true or false`）；
 *  allowed = 已明确放行（true）的包。`false` 两边都不算 —— 它本身就是一个已做的决定（不会再报错）。 */
function readApprovalState(text) {
  const lines = linesOf(text)
  const allow = topLevelBlock(lines, ALLOW_KEY)
  if (allow !== null) {
    if (headerHasInlineValue(lines[allow.headerIndex], ALLOW_KEY)) {
      return { form: ALLOW_KEY, parsed: false, blocked: [], allowed: [], reason: `${ALLOW_KEY} 写成了行内形态（不是逐行映射）` }
    }
    const entries = mapEntries(allow)
    if (entries === null) {
      return { form: ALLOW_KEY, parsed: false, blocked: [], allowed: [], reason: `${ALLOW_KEY} 不是简单的逐行映射` }
    }
    return {
      form: ALLOW_KEY,
      parsed: true,
      blocked: entries.filter((e) => e.value !== ALLOWED_VALUE && e.value !== DENIED_VALUE).map((e) => e.name),
      allowed: entries.filter((e) => e.value === ALLOWED_VALUE).map((e) => e.name),
      reason: null,
    }
  }
  const list = topLevelBlock(lines, ONLY_BUILT_KEY)
  if (list !== null) {
    if (headerHasInlineValue(lines[list.headerIndex], ONLY_BUILT_KEY)) {
      return { form: ONLY_BUILT_KEY, parsed: false, blocked: [], allowed: [], reason: `${ONLY_BUILT_KEY} 写成了行内形态（不是简单列表）` }
    }
    const entries = listEntries(list)
    if (entries === null) {
      return { form: ONLY_BUILT_KEY, parsed: false, blocked: [], allowed: [], reason: `${ONLY_BUILT_KEY} 不是简单列表` }
    }
    return { form: ONLY_BUILT_KEY, parsed: true, blocked: [], allowed: entries.map((e) => e.name), reason: null }
  }
  return { form: null, parsed: true, blocked: [], allowed: [], reason: null }
}

/** 兜底：`strictDepBuilds: false`（形态不允许逐包放行时）。 */
function fallbackPlan(lines, names, why) {
  const out = [...lines]
  const index = out.findIndex((line) => isTopLevelKey(line, STRICT_KEY))
  if (index >= 0) {
    if (new RegExp(`^["']?${STRICT_KEY}["']?\\s*:\\s*${DENIED_VALUE}\\s*$`, 'u').test(out[index])) {
      return { ok: true, added: [], form: STRICT_KEY, fallback: true, reason: why, changed: false, text: out.join('\n') }
    }
    out[index] = `${STRICT_KEY}: ${DENIED_VALUE}`
  } else {
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
    out.push(`${STRICT_KEY}: ${DENIED_VALUE}`, '')
  }
  return { ok: true, added: names, form: STRICT_KEY, fallback: true, reason: why, changed: true, text: out.join('\n') }
}

/** 纯函数：算出"要写什么"（**不碰盘**）。
 *  返回 { ok, changed, added[], form, fallback, reason, text }；changed === false 表示无需改动。 */
function planApprovalEdit(text, packages) {
  const names = normalizeNames(packages)
  if (names.length === 0) return { ok: false, changed: false, added: [], form: null, fallback: false, reason: '没有给出要放行的包名', text: textOf(text) }
  const bad = names.filter((n) => !NPM_NAME_RE.test(n))
  if (bad.length > 0) return { ok: false, changed: false, added: [], form: null, fallback: false, reason: `不是合法的 npm 包名：${bad.join('、')}`, text: textOf(text) }
  const source = textOf(text)
  const lines = linesOf(source)
  const allow = topLevelBlock(lines, ALLOW_KEY)
  if (allow !== null) {
    if (headerHasInlineValue(lines[allow.headerIndex], ALLOW_KEY)) return fallbackPlan(lines, names, `${ALLOW_KEY} 写成了行内形态`)
    const entries = mapEntries(allow)
    if (entries === null) return fallbackPlan(lines, names, `${ALLOW_KEY} 不是简单的逐行映射`)
    const byName = new Map(entries.map((e) => [e.name, e]))
    const added = names.filter((n) => byName.get(n)?.value !== ALLOWED_VALUE)
    if (added.length === 0) return { ok: true, changed: false, added: [], form: ALLOW_KEY, fallback: false, reason: null, text: source }
    const out = [...lines]
    for (const name of added) {
      const entry = byName.get(name)
      if (entry === undefined) continue
      out[allow.headerIndex + 1 + entry.offset] = `${entry.indent}${entry.name}: ${ALLOWED_VALUE}`
    }
    const fresh = added.filter((n) => !byName.has(n))
    if (fresh.length > 0) {
      const last = entries[entries.length - 1]
      const indent = last === undefined ? '  ' : last.indent
      const at = last === undefined ? allow.headerIndex + 1 : allow.headerIndex + 1 + last.offset + 1
      out.splice(at, 0, ...fresh.map((n) => `${indent}${n}: ${ALLOWED_VALUE}`))
    }
    return { ok: true, changed: true, added, form: ALLOW_KEY, fallback: false, reason: null, text: out.join('\n') }
  }
  const list = topLevelBlock(lines, ONLY_BUILT_KEY)
  if (list !== null) {
    if (headerHasInlineValue(lines[list.headerIndex], ONLY_BUILT_KEY)) return fallbackPlan(lines, names, `${ONLY_BUILT_KEY} 写成了行内形态`)
    const entries = listEntries(list)
    if (entries === null) return fallbackPlan(lines, names, `${ONLY_BUILT_KEY} 不是简单列表`)
    const known = new Set(entries.map((e) => e.name))
    const added = names.filter((n) => !known.has(n))
    if (added.length === 0) return { ok: true, changed: false, added: [], form: ONLY_BUILT_KEY, fallback: false, reason: null, text: source }
    const out = [...lines]
    const last = entries[entries.length - 1]
    const indent = last === undefined ? '  ' : last.indent
    const at = last === undefined ? list.headerIndex + 1 : list.headerIndex + 1 + last.offset + 1
    out.splice(at, 0, ...added.map((n) => `${indent}- ${n}`))
    return { ok: true, changed: true, added, form: ONLY_BUILT_KEY, fallback: false, reason: null, text: out.join('\n') }
  }
  // 两个键都没有：新建一个 allowBuilds 块（pnpm 11 的规范位置；pnpm 自己的 writeSettings 也这么干），
  // 其余内容原样保留。
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  out.push(`${ALLOW_KEY}:`, ...names.map((n) => `  ${n}: ${ALLOWED_VALUE}`), '')
  return { ok: true, changed: true, added: names, form: ALLOW_KEY, fallback: false, reason: null, text: out.join('\n') }
}

/** 读该 profile 的 pnpm-workspace.yaml（不存在时 exists=false，仍可走"新建"分支）。 */
function readWorkspaceApprovals(profileDir) {
  const file = join(textOf(profileDir), WORKSPACE_FILE)
  if (!existsSync(file)) {
    return { file, exists: false, text: '', sha256: null, form: null, parsed: true, blocked: [], allowed: [], reason: null }
  }
  const text = readFileSync(file, 'utf8')
  return { file, exists: true, text, sha256: sha256Of(text), ...readApprovalState(text) }
}

/** 读 pnpm 自己记的"被忽略的构建"（node_modules/.modules.yaml 的 ignoredBuilds，flow 或列表形态都能认）。 */
function readIgnoredBuilds(profileDir) {
  const file = join(textOf(profileDir), MODULES_FILE)
  if (!existsSync(file)) return []
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const flow = text.match(new RegExp(`["']?${IGNORED_KEY}["']?\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'u'))
  const body = flow !== null ? flow[1] : (() => {
    const block = topLevelBlock(linesOf(text), IGNORED_KEY)
    if (block === null) return null
    const entries = listEntries(block)
    return entries === null ? null : entries.map((e) => e.name).join(',')
  })()
  if (body === null || body === '') return []
  const found = []
  for (const part of body.split(',')) {
    const dep = unquote(part).replace(/[[\]{}]/gu, '').trim()
    if (dep === '') continue
    const at = dep.lastIndexOf('@')
    const name = at > 0 ? dep.slice(0, at) : dep
    if (!NPM_NAME_RE.test(name)) continue
    if (!found.includes(name)) found.push(name)
  }
  return found
}

/** 「已放行、但 pnpm 还没真正构建过」= .modules.yaml 里仍有被忽略的构建，且放行项里已经有 true。
 *  安装动作据此选超时预算：真构建可能十几分钟，180 秒的上限会把**成功**的安装杀成"失败"。 */
function pendingApprovedBuilds(profileDir) {
  const ignored = readIgnoredBuilds(profileDir)
  const state = readWorkspaceApprovals(profileDir)
  let modulesAllowed = []
  try {
    const modules = readFileSync(join(textOf(profileDir), MODULES_FILE), 'utf8')
    const flow = modules.match(new RegExp(`["']?${ALLOW_KEY}["']?\\s*:\\s*\\{([^}]*)\\}`, 'u'))
    if (flow !== null) {
      modulesAllowed = [...flow[1].matchAll(/([^\s,:{}"']+)\s*:\s*true/gu)].map((m) => m[1])
    } else {
      const block = topLevelBlock(linesOf(modules), ALLOW_KEY)
      const entries = block === null ? null : mapEntries(block)
      modulesAllowed = entries === null ? [] : entries.filter((e) => e.value === ALLOWED_VALUE).map((e) => e.name)
    }
  } catch {}
  const approved = [...new Set([...state.allowed, ...modulesAllowed])]
  return { ignored, approved, pending: ignored.length > 0 && approved.length > 0 }
}

/** 时间戳（可注入，便于离线断言）：`2026-09-27T16-12-33-123Z`。 */
function backupStamp(now) {
  const date = typeof now === 'function' ? now() : (now instanceof Date ? now : new Date())
  return date.toISOString().replace(/[:.]/gu, '-')
}

/** **唯一的写盘点**（只由显式动作调用）：备份 -> 写最小放行项 -> 读回核实。
 *  返回 { ok, changed, added[], file, form, fallback, sha256Before, sha256After, backup, verified, note, reason }。 */
function applyAllowBuilds({ profileDir, packages, now = () => new Date() } = {}) {
  const state = readWorkspaceApprovals(profileDir)
  if (state.exists !== true) {
    return { ok: false, changed: false, added: [], file: state.file, reason: `本 profile 里没有 ${WORKSPACE_FILE}，拒绝凭空创建` }
  }
  const planned = planApprovalEdit(state.text, packages)
  if (planned.ok !== true) {
    return { ok: false, changed: false, added: [], file: state.file, form: planned.form, fallback: false, reason: planned.reason }
  }
  if (planned.changed !== true) {
    return {
      ok: true, changed: false, added: [], file: state.file, form: planned.form, fallback: planned.fallback === true,
      sha256Before: state.sha256, sha256After: state.sha256, backup: null,
      verified: { targetsAllowed: true, othersIntact: true, sha256Matches: true },
      reason: `无需改动：${planned.form} 里已经是放行状态`,
      note: '这些构建脚本已经是放行状态，本次没有改动任何文件。',
    }
  }
  const before = state.text
  const backup = `${state.file}.bak-${backupStamp(now)}`
  copyFileSync(state.file, backup) // ① 改前备份
  writeFileSync(state.file, planned.text, 'utf8') // ② 写回（LF / 无 BOM：行由 linesOf 拆分后 join('\n')）
  const after = readFileSync(state.file, 'utf8') // ③ 写后读回核实
  const sha256After = sha256Of(after)
  const stateAfter = readApprovalState(after)
  const targetsAllowed = planned.fallback === true
    ? new RegExp(`^["']?${STRICT_KEY}["']?\\s*:\\s*${DENIED_VALUE}\\s*$`, 'mu').test(after)
    : planned.added.every((n) => stateAfter.allowed.includes(n))
  // "其它字段一字未动"：原文里**没有**被丢掉的行，必须原样、同序地出现在写回结果里。
  const afterLines = linesOf(after)
  const dropped = new Set(linesOf(before).filter((line) => !afterLines.includes(line)))
  const kept = linesOf(before).filter((line) => !dropped.has(line))
  let cursor = -1
  let othersIntact = true
  for (const line of kept) {
    const at = afterLines.indexOf(line, cursor + 1)
    if (at < 0) { othersIntact = false; break }
    cursor = at
  }
  const verified = { targetsAllowed, othersIntact, sha256Matches: true }
  const note = planned.fallback === true
    ? `该 profile 的 ${WORKSPACE_FILE} 形态不允许逐包放行（${planned.reason ?? '结构无法安全改写'}），已写入 \`${STRICT_KEY}: ${DENIED_VALUE}\`：`
      + 'pnpm 之后**不再因任何**未批准的构建脚本报错（副作用：对所有依赖生效；构建仍然不会被执行）。本动作本身不下载、不执行任何脚本。'
    : `已把 ${planned.added.length} 个包写进 ${WORKSPACE_FILE} 的 ${planned.form}（只加/改这几行，其它字段一字未动）。`
      + '放行后**下一次 pnpm 安装**才会真正执行这些脚本（二进制要下载、原生模块要编译，本机实测首次可能十几分钟）；'
      + '本动作本身不下载、不执行任何脚本。'
  return {
    ok: verified.targetsAllowed && verified.othersIntact && verified.sha256Matches,
    changed: true, added: [...planned.added], file: state.file, form: planned.form, fallback: planned.fallback === true,
    sha256Before: state.sha256, sha256After, backup, verified, reason: null, note,
  }
}

export {
  ALLOW_KEY, ALLOWED_VALUE, DENIED_VALUE, MODULES_FILE, ONLY_BUILT_KEY, STRICT_KEY, WORKSPACE_FILE,
  applyAllowBuilds, backupStamp, headerHasInlineValue, linesOf, pendingApprovedBuilds, planApprovalEdit,
  readApprovalState, readIgnoredBuilds, readWorkspaceApprovals, sha256Of,
}
