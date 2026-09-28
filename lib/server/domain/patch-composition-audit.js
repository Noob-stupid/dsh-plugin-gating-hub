// L1 · domain —— patch-composition-audit.js（补丁「行 → 包」可解析性体检；0.5.30 加法）
//
// 为什么必须有它（**真机事故 2026-09-28**）：
//   框架 0.2.0-rc.1 移除了 `@deepseek-ai/dsh-workflow-worker-thread`（引擎重构为 `…-workflow-ptc`），
//   而 `profiles/web/cordis.patch.yml` 里三处行仍指向旧包名。该行解析失败 → 隔离组里
//   `workflowEngine` 就没有提供方 → `dsh-tool-workflow` / `dsh-tool-ralph`（`inject` 含 `workflowEngine`）
//   永久 waiting → 老会话 resume 失败，真机报错原文：
//     resume failed for session "…": RemoteError: tool-workflow (@deepseek-ai/dsh-tool-workflow):
//       waiting for workflowEngine tool-ralph (@deepseek-ai/dsh-tool-ralph): waiting for workflowEngine
//   而现有 format-scan / framework-preflight **只扫「生产方源码里的 API 引用」**，
//   不扫「补丁里引用的包在当前框架树里还在不在」→ 升级前判「无 blocker」，升级后才炸。
//
// 本模块只做三件事（纯函数；`resolve` / `existsFile` 全部可注入，便于离线断言）：
//   ① 解析补丁行：`- id:` / `name:` / `disabled: true`（嵌套行同样收；缩进语义与 preset-rows.js 同源）；
//   ② 分类：解析失败=blocker；**已 disabled** 的解析失败=warning；`file://` 目标缺失=blocker；
//      子路径（`pkg/sub`）解析失败=warning（父包还在，只是导出变了）；
//   ③ 疑似改名建议：同 scope + 公共 token，纯启发式 —— **只提示，绝不自动改写用户补丁**。
//
// 行数预算：独立模块，留在 600 行架构硬顶内。

const ROW_RE = /^(\s*)-\s*id:\s*(\S+)\s*$/u
const NAME_RE = /^(\s*)name:\s*(.+?)\s*$/u
const DISABLED_RE = /^(\s*)disabled:\s*true\s*$/u
const CONFIG_RE = /^(\s*)config:\s*$/u

/** 去引号（单/双）；空串视作未提供。 */
function unquote(raw) {
  const text = String(raw ?? '').trim()
  const quoted = text.length >= 2
    && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))
  return quoted ? text.slice(1, -1) : text
}

/** 解析补丁文本 → 行数组 `{ id, name, disabled, indent, line }`（CRLF 先归一：真机补丁是 CRLF）。 */
function parsePatchRows(text) {
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  const rows = []
  let cur = null
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim() === '' || /^\s*#/u.test(raw)) continue
    const item = raw.match(ROW_RE)
    if (item !== null) {
      cur = { id: unquote(item[2]), indent: item[1].length, name: null, disabled: false, config: false, keys: 0, line: i + 1 }
      rows.push(cur)
      continue
    }
    if (cur === null) continue
    const indent = (raw.match(/^ */u) ?? [''])[0].length
    if (indent < cur.indent) { cur = null; continue }
    const name = raw.match(NAME_RE)
    if (name !== null && indent > cur.indent && cur.name === null) { cur.name = unquote(name[2]); continue }
    if (DISABLED_RE.test(raw) && indent > cur.indent) cur.disabled = true
    if (CONFIG_RE.test(raw) && indent > cur.indent) cur.config = true
    // 行里出现的**任何**键（config / disabled / isolate / …）都说明这是「补丁行」（改已存在条目的配置或开关），
    // 不是「声明行」—— 声明行才需要 name。真机补丁里 `- id: web-ui-pet` + `disabled: true` 就是这种。
    const kv = raw.match(/^(\s*)([A-Za-z_][\w-]*):/u)
    if (kv !== null && indent > cur.indent && kv[2] !== 'id') cur.keys += 1
  }
  return rows
}

/** scope 名（`@a/b` → `@a`；裸名 → 空串）。 */
function scopeOf(name) {
  return String(name).startsWith('@') ? String(name).split('/')[0] : ''
}

/** 词根集合：去掉 scope、按 `-`/`_`/`/` 切，丢弃长度 < 3 的碎片。 */
function tokensOf(name) {
  return String(name)
    .replace(/^@[^/]+\//u, '')
    .split(/[-_/]/u)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3)
}

/**
 * **真机确证的改名片 —— 建议的权威来源**（每条都有真机错误/发布物背书，同 preset-rows.js 的判据文化）。
 * 表里没有的一律只给「严格启发式候选」，猜不到就不猜（宁缺勿滥）。
 */
const KNOWN_RENAMES = [
  {
    from: '@deepseek-ai/dsh-workflow-worker-thread',
    to: '@deepseek-ai/dsh-workflow-ptc',
    since: '0.2.0-rc.1',
    evidence: '2026-09-28 真机：升级 0.2.0-rc.1 后 web profile 老会话 resume 失败'
      + '（RemoteError: tool-workflow … waiting for workflowEngine）；旧包已从 .pnpm store 消失，'
      + '新引擎 README「最小配置」列出 ptc，且 config.provider 默认 spawn（与旧行一致）',
  },
]

/** 疑似改名建议：① 真机确证表命中即权威返回；② 否则严格启发式（同 scope + 前两词根一致 + 交集 ≥ 3）。
 *  返回 `{ names, source }`，`source: 'known' | 'heuristic' | null`。 */
function suggestRenames(name, candidates, limit = 3) {
  const known = KNOWN_RENAMES.filter((r) => r.from === name).map((r) => r.to)
  if (known.length > 0) return { names: known.slice(0, limit), source: 'known' }
  const scope = scopeOf(name)
  const want = tokensOf(name)
  const scored = []
  for (const cand of (Array.isArray(candidates) ? candidates : [])) {
    if (cand === name || scopeOf(cand) !== scope) continue
    const have = tokensOf(cand)
    const common = want.filter((t) => have.includes(t)).length
    const headSame = want.length >= 2 && have.length >= 2 && want[0] === have[0] && want[1] === have[1]
    if (!headSame || common < 3) continue
    scored.push({ name: cand, score: common })
  }
  scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
  const names = scored.slice(0, limit).map((s) => s.name)
  return { names, source: names.length > 0 ? 'heuristic' : null }
}

/**
 * 分类体检（纯函数）。`resolve(name)` → `{ ok: true, from }` / `{ ok: false, reason }`；
 * `existsFile(name)` → boolean（`file://` 目标存在性，未注入则跳过该项）。
 */
function classifyPatchRows(rows, { resolve, existsFile = null, candidates = [] } = {}) {
  const blockers = []
  const warnings = []
  const resolvable = []
  const patchOnly = []
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (typeof row?.name !== 'string' || row.name === '') {
      // 只改配置的行（`- id: webserver` + `config:`）是**合法的补丁形态**：它在改已存在条目的配置，
      // 没有 name 可言 —— 真机补丁前 30 行全是这种，判红就是误杀（2026-09-28 真机实测抓到）。
      if ((row?.keys ?? 0) > 0) { patchOnly.push(row.id ?? null); continue }
      warnings.push({ code: 'row-without-name', row: row?.id ?? null, line: row?.line ?? null, detail: `行 ${row?.id ?? '?'} 既没有 name 也没有 config`, hint: '补上 name（包名或 file:/// URL），或确认它是配置补丁行' })
      continue
    }
    const name = row.name
    if (/^file:\/\//iu.test(name)) {
      if (existsFile === null) continue
      let present = null
      try { present = existsFile(name) } catch { present = null }
      if (present === false) {
        blockers.push({ code: 'file-target-missing', row: row.id, line: row.line, name, detail: `行 ${row.id} 的 file:// 目标不存在：${name}`, hint: '补齐文件或修正引用（写一行必然加载失败的声明等于把缺陷留给运行期）' })
      }
      continue
    }
    if (/^\.\.?\//u.test(name) || /^cordis:/iu.test(name)) continue
    const res = (() => { try { return resolve(name) } catch (error) { return { ok: false, reason: String(error?.message ?? error) } } })()
    if (res?.ok === true) { resolvable.push(name); continue }
    const segments = name.split('/')
    const isSubpath = segments.length > (name.startsWith('@') ? 2 : 1)
    const entry = {
      code: isSubpath ? 'subpath-unresolvable' : 'package-unresolvable',
      row: row.id,
      line: row.line,
      name,
      reason: res?.reason ?? null,
      ...(() => {
        const s = isSubpath ? { names: [], source: null } : suggestRenames(name, candidates)
        return { suggestions: s.names, suggestionSource: s.source }
      })(),
      detail: isSubpath
        ? `行 ${row.id} 的 ${name} 解析不到（父包在，子路径不在？）`
        : `行 ${row.id} 引用的包 ${name} 在当前框架树里解析不到`,
      hint: isSubpath
        ? '该子路径可能已改名/移除 —— 请对照当前框架版本的 exports 修正'
        : '该包可能已被移除或改名：先确认新包名再改这一行；**在修好之前，依赖它提供的服务的行会永久 waiting**',
    }
    if (isSubpath) warnings.push(entry)
    else if (row.disabled === true) warnings.push({ ...entry, disabled: true })
    else blockers.push(entry)
  }
  return { blockers, warnings, resolvable, patchOnly }
}

/** 组合入口：文本 + 依赖 → 报告。 */
function auditPatchText(text, deps = {}) {
  const rows = parsePatchRows(text)
  const report = classifyPatchRows(rows, deps)
  return { rows: rows.length, ...report }
}

/**
 * 从行里挑出「随框架版本走」的包名（`@deepseek-ai/*`）并带上行号 ——
 * 预检要拿它们去**目标版本的 registry** 上核对（真机事故：0.2.0-rc.1 移除了
 * `@deepseek-ai/dsh-workflow-worker-thread`，而补丁三处仍引用它 → 该行解析失败 →
 * 隔离组里 workflowEngine 没有提供方 → 老会话 resume 失败）。
 * 子路径归一成父包（`pkg/sub` → `pkg`）：版本随框架走的是包，不是子路径。
 */
function frameworkPackageRows(rows) {
  const map = new Map()
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const name = typeof row?.name === 'string' ? row.name : ''
    if (!name.startsWith('@deepseek-ai/')) continue
    if (/^file:\/\//iu.test(name) || /^\.\.?\//u.test(name)) continue
    const base = name.split('/').slice(0, 2).join('/')
    if (!map.has(base)) map.set(base, [])
    map.get(base).push(row.line ?? null)
  }
  return [...map.entries()].map(([name, lines]) => ({ name, lines }))
}

/**
 * 目标版本可用性判定（纯函数）：`publishedBy` 是 `Map<name, true|false|null>`
 * （true=目标版本已发布 / false=没有该版本 / null=未知，网络失败或元数据缺失）。
 * **未知一律不判死**（宁可漏报，也不因为查不动就把用户吓住）——只进 `unknown`。
 */
function classifyTargetAvailability(entries, { publishedBy, targetVersion, candidates = [] } = {}) {
  const missing = []
  const unknown = []
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const name = entry?.name
    if (typeof name !== 'string' || name === '') continue
    const state = publishedBy && typeof publishedBy.get === 'function' ? publishedBy.get(name) : null
    if (state === true) continue
    const base = { name, lines: Array.isArray(entry.lines) ? entry.lines : [], targetVersion: targetVersion ?? null }
    if (state === false) missing.push({ ...base, suggestions: suggestRenames(name, candidates).names })
    else unknown.push(base)
  }
  return { missing, unknown }
}
export {
  KNOWN_RENAMES, auditPatchText, classifyPatchRows, classifyTargetAvailability, frameworkPackageRows,
  parsePatchRows, scopeOf, suggestRenames, tokensOf, unquote,
}