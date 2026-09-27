// L1 · domain —— preset-yaml.js（预设配置 agent.cordis.yml 的**结构校验**；0.5.26 加法，修 F3）
//
// 为什么要有它（真机缺陷 F3，2026-09-27 独立对抗式复核抓到）：
//   预设装配会把源仓库里的 `agent.cordis.yml` 覆盖到用户 `~/.dsh/.agent-presets/<预设>/` 下。
//   一旦取到的内容**不是可用的配置**（空文件、被截断、带 tab 缩进、引号没闭合…），
//   覆盖就把**原本可用**的预设写坏了 —— 复核报告里的现场就是 `overwritten=["agent.cordis.yml"]`，
//   下次新建会话挂载这个预设时报错，而用户完全不知道是自己点的那次「安装」干的。
//   修法（改错）：**写盘之前**先做结构校验；不通过就**跳过这一个文件并如实报告**，绝不写坏。
//
// ⚠️ 判据宽严的分寸（为什么不用"顶层必须是 mapping"这类严格判据）：
//   框架的 agent 预设是**顶层 services 列表**（`- id: …` / `name: …` / `config:`），
//   里面还合法地使用 `!!js` 自定义标签、`>-` 折叠块、`|-` 字面块、注释与空行。
//   严格的通用 YAML 校验器（或"顶层必须是 mapping"）会把**真文件**判成非法 → 于是"修 F3"变成
//   "所有预设都装不上"，那是把缺陷换了个方向。所以这里只钉**能确证损坏**的形态（全部可离线判定）：
//     ① 空内容 / 全是注释与空行 —— 没有任何配置行，框架挂载它等于空预设；
//     ② 行首缩进里出现 **tab** —— YAML 明确禁止用 tab 做缩进（框架的解析器必然报错）；
//     ③ 明显**未闭合的引号**（引号从头到尾用反斜杠转义、真正的解析器能容忍跨行，这里只抓最常见的截断）；
//     ④ 缩进**跳级**（父级还没打开一个映射/序列就多缩进）—— 截断与坏编辑的典型形状。
//   `!!js` / 块标量 / 注释 / CRLF 一律按合法处理（见 passesStructure 的分支注释）。
//
// 分层：L1 domain —— 纯函数，无 IO、无 ctx、不抛（解析失败是正常结局，调用方按"不通过"处理）。

/** 缩进宽度（空格数；tab 会在这里被单独判掉，不参与计数）。 */
function indentOf(line) {
  const m = String(line).match(/^[ \t]*/u)
  return m === null ? 0 : m[0].length
}

/** 这一行的缩进里有没有 tab（YAML 禁止；框架解析器会直接报错）。 */
function hasTabIndent(line) {
  return /^[ \t]*\t/u.test(String(line))
}

/** 去掉行尾注释后的"有效内容"（只处理**不在引号里**的 `#`；`#` 前必须有空白或行首）。
 *  例：`name: '@deepseek-ai/dsh-persona'  # 注释` → `name: '@deepseek-ai/dsh-persona'`。 */
function stripTrailingComment(line) {
  const text = String(line)
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/u.test(text[i - 1]))) return text.slice(0, i)
  }
  return text
}

/** 值里的引号是否闭合（只判**单个标量内**的成对性；跨行的引号在 YAML 里合法，故不跨行判）。 */
function quotesBalanced(value) {
  const text = String(value)
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === null) {
      if (ch === "'" || ch === '"') quote = ch
      continue
    }
    if (quote === '"' && ch === '\\') { i += 1; continue }
    if (ch === quote) {
      // YAML 的单引号转义是 `''`（两个单引号），要一起吃掉
      if (quote === "'" && text[i + 1] === "'") { i += 1; continue }
      quote = null
    }
  }
  return quote === null
}

/** 块标量指示符（`|`、`>`、`|-`、`>+2`、`|2-`…）。返回 null 表示不是块标量。
 *  只有**整个值**就是指示符时才认（`> something` 是普通标量，不是块头），否则会把普通行误判成块。 */
function blockScalarIndicator(value) {
  const text = String(value).trim()
  const m = text.match(/^([|>])([+-]?\d*|\d*[+-]?)$/u)
  return m === null ? null : m[0]
}

/**
 * 结构校验（**纯函数**，永不抛）。返回 `{ ok, problems: string[] }`。
 * 只判"能确证损坏"的形态（见本文件顶部 ①~④），宁松勿误杀 —— 误杀的代价是预设装不上。
 */
function validateAgentConfig(text) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const problems = []
  const lines = source.split(/\r?\n/u)
  const significant = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim() === '') continue
    if (/^\s*#/u.test(raw)) continue
    significant.push({ line: i + 1, raw, indent: indentOf(raw), at: i })
  }
  // ① 空内容 / 全是注释与空行
  if (significant.length === 0) {
    problems.push('没有任何配置行（空文件，或只有注释与空行）—— 框架挂载它等于空预设')
    return { ok: false, problems }
  }
  /** 块标量（`>-` / `|` 等）的内容由框架按字面读，**不是** YAML 结构 —— 必须整段跳过，
   *  否则 persona 那种多行散文会被逐行当成"非法条目"（误杀三个真机预设，2026-09-27 实测）。
   *  结束判据：出现缩进 **小于等于** 块首行缩进的非空行（或文件结束）。 */
  const blockScalarEnd = (startIdx, parentIndent) => {
    let end = startIdx
    for (let i = startIdx + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim() === '') { end = i; continue }
      if (indentOf(line) > parentIndent) { end = i; continue }
      break
    }
    return end
  }
  const stack = []   // 已打开的父级：{ indent, opensNested }
  let skipThrough = -1
  for (const item of significant) {
    if (item.at <= skipThrough) continue
    // ② tab 缩进
    if (hasTabIndent(item.raw)) {
      problems.push(`第 ${item.line} 行的缩进里有 tab（YAML 禁止用 tab 缩进）`)
      continue
    }
    const content = stripTrailingComment(item.raw).replace(/\s+$/u, '')
    if (content.trim() === '') continue
    const body = item.raw.slice(item.indent)
    // ④ 缩进跳级：比当前父级深、但父级没有"还能放子项"的位置
    while (stack.length > 0 && item.indent < stack[stack.length - 1].indent) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1] : null
    if (parent !== null && item.indent > parent.indent && parent.opensNested !== true) {
      problems.push(`第 ${item.line} 行缩进 ${item.indent} 空格，但上一层的 \`${parent.label}\` 不接受子项（缩进跳级/文件被截断）`)
    }
    if (body.startsWith('- ') || body === '-') {
      stack.push({ indent: item.indent, opensNested: true, label: body.slice(0, 40) })
      continue
    }
    const kv = body.match(/^("[^"]*"|'[^']*'|[^\s:#][^:]*?)\s*:\s*(.*)$/u)
    if (kv === null) {
      problems.push(`第 ${item.line} 行不是合法的 YAML 条目（既不是 \`- \` 序列项，也不是 \`键: 值\`）：${body.slice(0, 60)}`)
      continue
    }
    const value = kv[2].trim()
    // ③ 未闭合的引号（只在单行内判；`#` 已剥掉，行尾也不会再有注释）
    if (!quotesBalanced(value)) {
      problems.push(`第 ${item.line} 行的值里有未闭合的引号：${value.slice(0, 60)}`)
    }
    const isBlock = blockScalarIndicator(value) !== null
    if (isBlock) skipThrough = blockScalarEnd(item.at, item.indent)
    stack.push({ indent: item.indent, opensNested: value === '' || isBlock, label: `${kv[1].trim()}:` })
  }
  return { ok: problems.length === 0, problems }
}

/** 校验一个**目录里**的 agent 配置文件（写盘前的调用点用这个）。
 *  返回 `{ ok, file, problems }`；目录里没有 agent.cordis.yml/.yaml 时 ok=true / file=null（不是预设，不归这里管）。 */
function validateAgentConfigDir(dir, { readFile = null } = {}) {
  const read = typeof readFile === 'function' ? readFile : null
  for (const name of ['agent.cordis.yml', 'agent.cordis.yaml']) {
    const text = read === null ? null : read(name)
    if (text === null || text === undefined) continue
    const result = validateAgentConfig(text)
    return { ...result, file: name }
  }
  return { ok: true, file: null, problems: [] }
}

export { validateAgentConfig, validateAgentConfigDir, stripTrailingComment, quotesBalanced, blockScalarIndicator, hasTabIndent, indentOf }
