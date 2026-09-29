// L1 · domain —— patch-yaml-check.js（`cordis.patch.yml` 的**结构校验**；0.5.32 加法 D3）
//
// 为什么不能直接复用 `domain/preset-yaml.js#validateAgentConfig`（**真机实测**，2026-09-29）：
//   那把尺子是按 **agent 预设文件**（顶层 `- id:` 序列）校准的，拿它量真机补丁会**整片误杀**：
//   两个 live profile 的 `cordis.patch.yml`（web 56 KB / desktop 55 KB）实测各被判 17 / 12 条问题，
//   全部是**合法写法**：
//     · `description: '第一行…` + 后续行 `  续行…'` —— YAML 的**多行引号标量**（跨行合法），
//       逐行判「引号未闭合」→ 假红；
//     · 续行缩进比父级深 → 逐行判「缩进跳级/文件被截断」→ 假红。
//   误杀的代价在这里同样是反向的：D3 的恢复入口拿它当写盘前闸门 → **一恢复就被自家校验拒掉**。
//
// 所以这里只钉**能确证损坏**的形态（全部离线可判定，且对真机补丁 0 误报）：
//   ① 行首缩进里有 **tab** —— YAML 明确禁止用 tab 缩进（框架解析器必然报错）；
//   ② **顶层空数组占位符 `[]`**（issue #7 事故形态）：模板初始化的 `[]` 后面再追加 `- id:` 条目，
//      同一文档流里「数组结束符 + 后续项」= 非法 YAML → dsh 启动直接崩；
//   ③ 顶层（缩进 0）出现**不是** `- ` 序列项的行（既不是注释/空行/占位符）—— 补丁文件的形状是
//      「序列项 + 其子键」，顶层键值对说明文件被拼坏/截断；
//   ④ **多行引号标量未闭合**（真正的截断）：跨行扫描引号状态，直到文件末尾仍未闭合才判红
//      —— 这一条恰好是②之外最常见的"写坏"形态；
//   ⑤ 块标量（`|` / `>`）整段跳过判据（其内容是散文，不是 YAML 结构）。
//
// 分层：L1 domain —— 纯函数、无 IO、永不抛（解析失败是正常结局，调用方按 ok=false 处理）。

/** 缩进宽度（空格数；tab 会在 ① 里单独判掉，不参与计数）。 */
function indentWidth(line) {
  const m = String(line).match(/^ */u)
  return m === null ? 0 : m[0].length
}

/** 行首缩进里有没有 tab（YAML 禁止；框架解析器会直接报错）。 */
function hasTabIndent(line) {
  return /^[ \t]*\t/u.test(String(line))
}

/** 剥掉行尾注释（只认**不在引号里**且 `#` 前有空白或行首的 `#`）。 */
function stripTrailingComment(line) {
  const text = String(line)
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (quote === '"' && ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/u.test(text[i - 1]))) return text.slice(0, i)
  }
  return text
}

/** 块标量指示符（`|`、`>`、`|-`、`>+2`…）：只有**整个值**就是指示符时才算（`> foo` 是普通标量）。 */
function blockScalarIndicator(value) {
  const m = String(value).trim().match(/^([|>])([+-]?\d*|\d*[+-]?)$/u)
  return m === null ? null : m[0]
}

/**
 * 从一行里取出「值起点之后的引号状态」：
 *   · 值不以引号开头 → `{ opens: false, quote: null }`（引号在标量中间不算跨行开始）；
 *   · 以单/双引号开头 → 逐字符推进（双引号吃 `\\` 转义，单引号吃 `''`），返回是否仍未闭合。
 */
function scanValueQuotes(value, initialQuote = null) {
  const text = String(value)
  let quote = initialQuote
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === null) {
      if (ch === "'" || ch === '"') quote = ch
      continue
    }
    if (quote === '"' && ch === '\\') { i += 1; continue }
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") { i += 1; continue }
      quote = null
    }
  }
  return { quote }
}

/**
 * 结构校验（**纯函数**，永不抛）。返回 `{ ok, problems, summary }`。
 * `summary` 只放"看得懂的事实"（行数 / 顶层项数 / 多行标量数），供报告与面板短句使用。
 */
function validatePatchYaml(text) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const lines = source.replace(/\r\n/gu, '\n').split('\n')
  const problems = []
  let topItems = 0
  let multilineScalars = 0
  let placeholderLines = 0
  let inBlockScalar = false
  let blockIndent = 0
  let openQuote = null

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const lineNo = i + 1
    if (raw.trim() === '') continue
    if (/^\s*#/u.test(raw)) continue
    // ① tab 缩进（无论在哪一层都不合法）
    if (hasTabIndent(raw)) { problems.push(`第 ${lineNo} 行的缩进里有 tab（YAML 禁止用 tab 缩进）`); continue }
    const indent = indentWidth(raw)
    // 多行引号标量的续行：内容不参与结构判定，只继续找闭合
    if (openQuote !== null) {
      multilineScalars += 1
      const st = scanValueQuotes(raw, openQuote)
      openQuote = st.quote
      continue
    }
    // 块标量内容：整段跳过（缩进 ≤ 块首行缩进的非空行 = 块结束）
    if (inBlockScalar) {
      if (indent > blockIndent) continue
      inBlockScalar = false
    }
    const content = stripTrailingComment(raw)
    if (content.trim() === '') continue
    // ② 顶层空数组占位符（issue #7：`[]` 后面再跟条目 = 非法 YAML，启动直接崩）
    if (/^\s*\[\s*\]\s*$/u.test(content)) { placeholderLines += 1; continue }
    // ③ 顶层必须是序列项（补丁文件的形状：`- id:` / `- insert:` + 其子键）
    if (indent === 0) {
      if (!/^-\s/u.test(content) && content.trim() !== '-') {
        problems.push(`第 ${lineNo} 行是顶层键值对（补丁文件顶层必须是 \`- \` 序列项）：${content.trim().slice(0, 60)}`)
        continue
      }
      topItems += 1
    }
    // ④ / ⑤ 值里的块标量与跨行引号
    const kv = content.match(/^(\s*)(?:-\s+)?[^\s:#][^:]*:\s*(.*)$/u)
    if (kv === null) continue
    const value = kv[2].trim()
    if (blockScalarIndicator(value) !== null) { inBlockScalar = true; blockIndent = indent; continue }
    const st = scanValueQuotes(value, null)
    if (st.quote !== null) openQuote = st.quote
  }
  // ④ 收尾：跨行引号到文件末尾仍未闭合 = 真截断
  if (openQuote !== null) {
    problems.push(`文件末尾仍有未闭合的引号（${openQuote === "'" ? '单引号' : '双引号'}）—— 文件被截断或写坏`)
  }
  // ② 收尾：占位符与真实条目共存（真实事故形态）
  if (placeholderLines > 0 && topItems > 0) {
    problems.push(`顶层空数组占位符 \`[]\` 与 ${topItems} 个序列项共存（同一文档流非法，框架解析会崩）—— 写入前必须移除占位符`)
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: { lines: lines.length, topItems, multilineScalars, placeholderLines },
  }
}

export { blockScalarIndicator, hasTabIndent, indentWidth, scanValueQuotes, stripTrailingComment, validatePatchYaml }
