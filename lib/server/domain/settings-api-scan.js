// L1 · domain —— settings-api-scan.js（「已删除 dsh-settings API」源码扫描；0.5.33 改错时从 compat.js 搬出）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言）
//
// 为什么单独成模块：判据从"源码里出现过这个名字"改成"这个名字**真的从
// `@deepseek-ai/dsh-settings` 绑定进来**"——要先剥注释/字符串字面量，再解析 import/require 的
// 绑定子句，逻辑比原先的按行子串匹配长得多，而 compat.js 已经 544 行（守卫上限 600）。
// 搬移保持对外契约不变：`REMOVED_SETTINGS_SYMBOLS` / `referencesRemovedSymbol` /
// `scanSettingsApiUsage` 三个名字照旧由 compat.js 导出。
//
// ── 0.5.33 改错（真机误报，证据充分）────────────────────────────────────────────────
// 现症：`dshmarket` 被判 `check:'fail'`（= 「源码仍引用 0.1.2 起已删除的 dsh-settings API」），
// 于是**框架升级预扫会把这个好插件自动禁用**。逐条核对它的三处命中：
//   · dshmarket/lib/settings.js:45 / :53 / :73 —— 全在**注释**里；
//   · dshmarket/lib/routes.js:3136 `settingsNamespace: settingsNamespaceState(),` —— 一个
//     **HTTP 载荷对象的属性名**（值是自己的局部函数 `settingsNamespaceState`，与本包无关）；
//   · 该包对 `@deepseek-ai/dsh-settings` 的 **import 零命中**（它早已把那两个 helper 内联）。
// 旧判据（`text.includes(sym)` → v0.3.35 换成标识符边界 + 排除局部定义）挡不住这两类：
// 注释里的名字与对象键上的名字都不是"引用"，但它们都在**代码行**上、也不是本地定义。
//
// 新判据（更严格，不放宽任何真引用）：
//   ① 先掩掉注释、字符串/模板字面量、正则字面量（等长空格替换，保留换行与列偏移）；
//      唯一保留的是**模块说明符字符串**（`from 'x'` / `require('x')` / `import('x')`），
//      否则没法知道某个绑定来自哪个包。
//   ② 只在**真的对这个包**的 import/require 绑定子句里取名字：
//      `import { settingsNamespace } from '@deepseek-ai/dsh-settings'`、
//      `import settingsNamespace from …`、`import * as s from …` 后的 `s.settingsNamespace`、
//      `const { settingsNamespace } = require('@deepseek-ai/dsh-settings')`、
//      `const { installSettingsSection } = await import('@deepseek-ai/dsh-settings')`。
//   ③ 对象键、局部同名函数、别的模块的同名导入、注释与字符串里的名字 —— 一律不算。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 0.1.2-rc.1 起被官方删除的 dsh-settings API（命中即"实际不兼容"）。 */
const REMOVED_SETTINGS_SYMBOLS = ['settingsNamespace', 'installSettingsSection']

/**
 * **判据版本戳**（0.5.34 加法）：判据一变就必须改这个字符串。
 *
 * 为什么需要它（真机背景 2026-10-01）：`compat-pending.json` 里的结论是"当时的判据"写下的，
 * 但面板把它当**事实**一直展示：`dshmarket` 记录里压着
 * `check:"fail"` + `checkNote:"源码仍引用 0.1.2 起已删除的 dsh-settings API…"` ——
 * 那是 0.5.33 收紧判据**之前**的误报结论（真机复核：现在 0 命中），
 * 于是面板持续显示"实际不兼容，启用会让整个服务启动崩溃"，把用户永久钉在「待适配」。
 * 有了版本戳，"这条结论是哪一版判据算的"就可以被后续读取代发判读 → 过期即重算（见 compat-verdict.js）。
 *
 *   v1 = 0.3.35 的「标识符边界 + 排除局部定义」（挡不住注释里的名字与对象键上的名字）
 *   v2 = 0.5.33 的「真的从 `@deepseek-ai/dsh-settings` 绑定进来」（本文件实现）
 */
const SCAN_CRITERIA_VERSION = 'dsh-settings-scan/2'

/** 这些 API 原本来自哪个包（只有真的从它绑定进来的名字才算引用）。 */
const SETTINGS_MODULE = '@deepseek-ai/dsh-settings'

const SPECIFIER_RE = `['"]${SETTINGS_MODULE.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&')}['"]`

/**
 * 把注释、字符串/模板字面量、正则字面量掩成**等长空格**（换行/回车保留，行号与列偏移不变）。
 * `keepSpecifier` 为真时保留"模块说明符"字符串的原样内容（`from 'x'` / `require('x')` / `import('x')`）。
 *
 * 这是**掩码**而不是删除：后续判据仍然按整份源码做正则，位置对得上才好排查。
 */
function maskLiterals(text, keepSpecifier) {
  const src = String(text ?? '')
  const out = src.split('')
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_$]/u.test(ch)
  const wordBefore = (index) => {
    let j = index
    while (j > 0 && (src[j - 1] === ' ' || src[j - 1] === '\t')) j -= 1
    let k = j
    while (k > 0 && isWordChar(src[k - 1])) k -= 1
    return src.slice(k, j)
  }
  const prevMeaningful = (index) => {
    for (let k = index - 1; k >= 0; k -= 1) {
      const ch = src[k]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue
      return ch
    }
    return ''
  }
  /** 当前位置若是 `word(` 的第一个实参，返回 `word`（用于 require(...) / import(...) 的说明符判定）。 */
  const callWordBefore = (index) => {
    let k = index - 1
    while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k -= 1
    if (k < 0 || src[k] !== '(') return ''
    k -= 1
    while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k -= 1
    const end = k + 1
    while (k >= 0 && isWordChar(src[k])) k -= 1
    return src.slice(k + 1, end)
  }
  // 正则字面量的判定沿用仓库既有启发式（tests/test-architecture-guard.mjs 的 stripCode 同款）：
  // 前一个有效字符说明这里不可能是除法，或者前一个词是 return/typeof 这类关键字。
  const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', ''])
  const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'void', 'delete', 'new', 'instanceof', 'yield', 'await'])
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i)
      const to = end < 0 ? src.length : end
      blank(i, to)
      i = to
      continue
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      const to = end < 0 ? src.length : end + 2
      blank(i, to)
      i = to
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1
        j += 1
      }
      const end = j < src.length ? j + 1 : src.length
      // 说明符字符串保留：紧跟在 `from` 之后，或作为 require(...) / import(...) 的第一个实参。
      const asCallArgument = /^(?:require|import)$/u.test(callWordBefore(i))
      const isSpecifier = keepSpecifier === true && c !== '`' && (wordBefore(i) === 'from' || asCallArgument)
      if (!isSpecifier) blank(i + 1, end - 1)
      i = end
      continue
    }
    if (c === '/') {
      const pm = prevMeaningful(i)
      if (REGEX_PREV.has(pm) || REGEX_KEYWORDS.has(wordBefore(i))) {
        let j = i + 1
        let inClass = false
        while (j < src.length) {
          const ch = src[j]
          if (ch === '\\') { j += 2; continue }
          if (ch === '[') inClass = true
          else if (ch === ']') inClass = false
          else if (ch === '/' && !inClass) { j += 1; break }
          else if (ch === '\n') break
          j += 1
        }
        blank(i, j)
        i = j
        continue
      }
    }
    i += 1
  }
  return out.join('')
}

/** 从一个绑定子句里取出**被导入的名字**（`a as b` 取 `a`；默认导入取它自己；`*` 交给命名空间那条路）。 */
function importedNamesOf(clause) {
  const names = new Set()
  const text = String(clause ?? '')
  const brace = text.match(/\{([^}]*)\}/u)
  if (brace !== null) {
    for (const part of brace[1].split(',')) {
      const seg = part.trim()
      if (seg === '') continue
      const imported = seg.split(/\s+as\s+/u)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/u.test(imported)) names.add(imported)
    }
  }
  const rest = brace === null ? text : text.replace(brace[0], ' ')
  for (const seg of rest.split(',')) {
    const t = seg.trim()
    if (t === '' || t === '*' || /\s/u.test(t)) continue
    if (/^[A-Za-z_$][\w$]*$/u.test(t)) names.add(t)
  }
  return names
}

/**
 * 从源码里取出「真的从 `@deepseek-ai/dsh-settings` 绑定进来的名字」。
 * 返回 `{ named, namespaces }`：`named` 是直接绑定的符号，`namespaces` 是包级命名空间
 * （`import * as s` / `const s = require(…)`），它们的成员访问 `s.settingsNamespace` 也算引用。
 */
function settingsApiBindings(text) {
  // 掩码只做一次：注释/字符串/正则变空格，模块说明符字符串保留 —— 判据据此认包。
  const code = maskLiterals(text, true)
  const named = new Set()
  const namespaces = new Set()
  // ① ESM 命名空间导入：`import * as s from '<mod>'`
  for (const m of code.matchAll(new RegExp(`\\bimport\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*${SPECIFIER_RE}`, 'gu'))) {
    namespaces.add(m[1])
  }
  // ② ESM 具名/默认导入：`import { a, b as c } from '<mod>'` / `import d from '<mod>'`
  //    子句里不允许再出现 import/from，长度封顶 2000 —— 挡住"跨到上一条 import 语句"的假匹配。
  for (const m of code.matchAll(new RegExp(`\\bimport\\s+(?!\\*)((?:(?!\\bimport\\b|\\bfrom\\b)[\\s\\S]){0,2000}?)\\s+from\\s*${SPECIFIER_RE}`, 'gu'))) {
    for (const name of importedNamesOf(m[1])) named.add(name)
  }
  // ③ CJS / 动态导入的解构绑定：`const { a } = require('<mod>')` / `= await import('<mod>')`
  const callRe = `(?:require|import)\\s*\\(\\s*${SPECIFIER_RE}\\s*\\)`
  for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:await\\s+)?${callRe}`, 'gu'))) {
    for (const name of importedNamesOf(`{${m[1]}}`)) named.add(name)
  }
  // ④ CJS / 动态导入的命名空间绑定：`const s = require('<mod>')`
  for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${callRe}`, 'gu'))) {
    namespaces.add(m[1])
  }
  return { named, namespaces }
}

/** 命中的已删除符号列表（空数组 = 干净）。判据见文件头：只有真绑定/真成员访问才算。 */
function settingsApiReferences(text) {
  const { named, namespaces } = settingsApiBindings(text)
  const found = []
  for (const sym of REMOVED_SETTINGS_SYMBOLS) {
    if (named.has(sym)) { found.push(sym); continue }
    for (const ns of namespaces) {
      if (new RegExp(`(?<![\\w$.])${ns}\\s*\\.\\s*${sym}(?![\\w$])`, 'u').test(maskLiterals(text, true))) { found.push(sym); break }
    }
  }
  return found
}

/** 源码是否**引用**了某个已删除符号（对外契约不变；判据已收紧到"真绑定/真成员访问"）。 */
function referencesRemovedSymbol(text, sym) {
  return settingsApiReferences(text).includes(sym)
}

/**
 * 扫描已安装包源码，检测对已删除的 dsh-settings API 的引用。
 *
 * 2026-09-04 教训：0.1.2-rc.1 起 settingsNamespace / installSettingsSection 已删除，
 * 静态声明检查判 pass 是假通过；真实兼容性只有模块 import 时见分晓，而 loader 单行失败
 * = 整个服务启动崩溃。
 *
 * 扫描预算（未改）：限深 3 层、上限 120 个文件、单文件读前 400KB。
 */
function scanSettingsApiUsage(pkgDir) {
  const found = []
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/u.test(entry.name)) continue
      if (seen.has(full)) continue
      seen.add(full)
      if (seen.size > 120) return
      try {
        const text = readFileSync(full, 'utf8').slice(0, 400000)
        for (const sym of settingsApiReferences(text)) {
          if (!found.includes(sym)) found.push(sym)
        }
      } catch {}
    }
  }
  walk(pkgDir, 0)
  return found
}

export { REMOVED_SETTINGS_SYMBOLS, SCAN_CRITERIA_VERSION, SETTINGS_MODULE, maskLiterals, settingsApiBindings, settingsApiReferences, referencesRemovedSymbol, scanSettingsApiUsage }
