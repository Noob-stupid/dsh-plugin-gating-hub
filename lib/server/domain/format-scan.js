// L1 · domain —— format-scan.js：会话格式契约预检（Step 2 · 本地生产方扫描 + 补丁）
//
// 扫描面（这次事故的三类生产方，正是它们让「一发消息就炸」）：
//   ① ~/.dsh/agent-presets/**  —— 用户自己的 agent 预设（10 个文件 11 处）
//   ② profile 内已装插件包里的运行时代码 —— agent.inject / createUserMessage 的构造点（3 处）
//   ③ 插件里引用了目标版本已移除的框架 API（报告项，不自动改）
//
// 补丁原则（宁可少改，不可改错）：
//   · 只改 `kind: 'plugin'` 这个**字面量**，且要求同一对象字面量里确有 `plugin:` 字段（V3 包装形状）；
//   · `plugin:` 的值是字符串字面量 → 直接写 `kind: 'plugin:<值>'`；是标识符/成员表达式 → 写成
//     `` kind: `plugin:${表达式}` ``（与 2026-09-24 手工修复脚本产出的形状一致）；
//   · 任何无法安全内联的写法一律**只报告不修改**（unresolved），交人工处理；
//   · 保留 `plugin:` 字段本身：V4 的迁移器「保留其它自有字段」，少删一个键就少一份语法风险；
//   · 写盘前备份 `<file>.bak-preflight-<时间戳>`，且只允许改「本次上报名单内」的文件。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { parseFrameworkVersion } from '../infra/semver.js'

/** 走盘限制：预检是只读扫描，不能因为某个巨型包把服务拖死。 */
const MAX_FILES = 4000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage', '__tests__', 'test', 'tests'])
/** pnpm 中断安装留下的 `xxx_tmp_<pid>_<n>` 半成品目录：不是可加载插件，扫它只会制造噪音。 */
const SKIP_DIR_RE = /_tmp_\d+(?:_\d+)?$/u
const SKIP_FILE_RE = /\.(?:test|spec)\.[cm]?js$/u
const CODE_FILE_RE = /\.(?:mjs|cjs|js)$/u

/**
 * 已知的框架 API 破坏（报告项，永不自动改）。只收「有真机证据」的条目——
 * 每条都要能被复现、能指向报错原文，避免把猜测当规则到处误报。
 * ★ probe 字段：光看源码里有没有 `.volatile(` 是不够的 —— 2026-09-24 实测，插件只是**解析到了陈旧副本**
 *   （profile 作用域铺着 schemastery 3.18.1，而它声明 ^3.18.4），把依赖对齐后同一个文件立刻正常。
 *   所以带 probe 的规则必须先「按该文件的位置真的解析一次依赖」，确认那份副本确实缺这个 API 才报，
 *   否则修好依赖后规则会永远误报（自相矛盾的报告没人会信）。
 */
const KNOWN_BREAKAGES = [
  {
    id: 'schemastery-volatile',
    // 真机 2026-09-24：@linxin666 的 skin-center / task-board / git-graph / pet / model-capabilities /
    // ssh / liangshen 七个包导入失败，报 `z.boolean(...).default(...).volatile is not a function`。
    pattern: /\.volatile\s*\(/gu,
    since: '0.1.7',
    fixable: false,
    probe: 'schemastery-volatile',
    note: '调用方声明 @deepseek-ai/schemastery ^3.18.4，但它实际解析到的副本缺少 .volatile()（3.18.4 起在 Schema.prototype 上提供）——把该副本对齐到声明版本即可，不必改插件源码',
  },
]

/** 探针缓存（同一个包目录只解析一次）。 */
const probeCache = new Map()

/**
 * 探针：某个源码文件在**运行时**会解析到哪份 @deepseek-ai/schemastery，那份副本有没有 .volatile()。
 * @returns { ok: boolean|null, version: string|null, dir: string|null, error: string|null }（ok=null 表示无法判定）
 */
function probeSchemasteryVolatile(file, cache = probeCache) {
  const key = file
  if (cache.has(key)) return cache.get(key)
  let result = { ok: null, version: null, dir: null, error: null }
  try {
    const require = createRequire(join(file, '..', 'package.json'))
    const pkgPath = require.resolve('@deepseek-ai/schemastery/package.json')
    const dir = pkgPath.slice(0, pkgPath.length - 'package.json'.length - 1)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const main = typeof pkg.main === 'string' && pkg.main !== '' ? pkg.main : 'lib/index.cjs'
    let text = ''
    try { text = readFileSync(join(dir, main), 'utf8') } catch {}
    if (text === '') {
      // main 不是 CJS（或路径不同）：兜底扫 lib 下的入口文件
      for (const candidate of ['lib/index.mjs', 'lib/index.js', 'lib/index.cjs']) {
        try { text = readFileSync(join(dir, candidate), 'utf8'); break } catch {}
      }
    }
    result = { ok: /prototype\.volatile\s*=|\.volatile\s*=\s*function|volatile\s*\(\)\s*\{/u.test(text), version: pkg.version ?? null, dir, error: null }
  } catch (error) {
    result = { ok: null, version: null, dir: null, error: error instanceof Error ? error.message : String(error) }
  }
  cache.set(key, result)
  return result
}

/** 版本比较：target ≥ since 才报（只比 major.minor.patch，与框架内其它判断一致）。 */
function versionAtLeast(target, since) {
  const t = parseFrameworkVersion(target)
  const s = parseFrameworkVersion(since)
  if (t === -1 || s === -1) return false
  if (t.maj !== s.maj) return t.maj > s.maj
  if (t.min !== s.min) return t.min > s.min
  return t.pat >= s.pat
}

/** 行号（1 基）——报告里要能直接跳过去。 */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

/**
 * 把**注释**替换成等长空格（保留换行），字符串原样保留。
 * ★ 为什么必须做：真实数据里 `dsh-better-sidebar` 的 JSDoc 写着
 *   "is stamped `kind: 'plugin'` so recognition is structural" —— 纯文本扫描会把注释当代码，
 *   报出一条「可自动改」的假 blocker（改注释毫无意义，还会污染 diff）。
 *   ★ 为什么不连字符串一起抹：合法写法本身就是字符串字面量（`kind: 'plugin'`），抹了就再也认不出来。
 *   掩码等长 ⇒ 偏移量与原文一一对应，行号/片段都还能用原文取。
 */
function maskComments(text) {
  let out = ''
  let i = 0
  let state = 'code'
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (ch === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (ch === "'" || ch === '"' || ch === '`') { state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template'; out += ch; i += 1; continue }
      out += ch; i += 1; continue
    }
    if (state === 'line') { if (ch === '\n') { state = 'code'; out += ch } else out += ' '; i += 1; continue }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += ch === '\n' ? '\n' : ' '; i += 1; continue
    }
    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (ch === '\\') { out += text.slice(i, i + 2); i += 2; continue }
    if (ch === quote) { state = 'code'; out += ch; i += 1; continue }
    out += ch; i += 1
  }
  return out
}

/** 包住 index 的对象字面量边界（向前找 `{`、向后配平 `}`）；找不到返回 null。 */
function objectBounds(text, index) {
  const backLimit = Math.max(0, index - 2000)
  let start = -1
  for (let i = index; i >= backLimit; i -= 1) {
    if (text[i] === '{') { start = i; break }
    if (text[i] === '}') return null
  }
  if (start === -1) return null
  let depth = 0
  const fwdLimit = Math.min(text.length, index + 4000)
  for (let i = start; i < fwdLimit; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { start, end: i + 1 }
    }
  }
  return null
}

/** 表达式能否安全内联进模板字符串（标识符 / 成员访问 / 模板字符串）。 */
function inlineExpression(expr) {
  const trimmed = expr.trim()
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/u.test(trimmed)) return { kind: 'identifier', value: trimmed }
  if (/^`[\s\S]*`$/u.test(trimmed)) return { kind: 'template', value: trimmed.slice(1, -1) }
  return null
}

/**
 * 纯函数：在源码文本里规划「V3 插件来源包装 → V4 producer-owned kind」的重写。
 * @returns { rewrites: [{start,end,before,after,line}], unresolved: [{line,reason,snippet}] }
 */
function planSourceKindRewrites(text, rules = {}) {
  const prefix = typeof rules.pluginPrefix === 'string' && rules.pluginPrefix !== '' ? rules.pluginPrefix : 'plugin:'
  const renames = rules.renames ?? {}
  const rewrites = []
  const unresolved = []
  // 只在「去掉注释」的等长掩码上匹配：注释里的同名字样不是代码，绝不能被改写
  const masked = maskComments(text)
  const re = /kind\s*:\s*(['"])plugin\1/gu
  let m
  while ((m = re.exec(masked)) !== null) {
    const bounds = objectBounds(masked, m.index)
    if (bounds === null) {
      unresolved.push({ line: lineOf(text, m.index), reason: '无法确定所属对象字面量（括号不配平或跨度过大）', snippet: m[0] })
      continue
    }
    const window = masked.slice(bounds.start, bounds.end)
    const pluginKey = /\bplugin\s*:\s*([^,}\n]+)/u.exec(window)
    if (pluginKey === null) {
      unresolved.push({ line: lineOf(text, m.index), reason: "kind: 'plugin' 所在对象里没有 plugin: 字段（不是 V3 包装形状，需人工确认）", snippet: m[0] })
      continue
    }
    const exprRaw = pluginKey[1].trim()
    // kind 字面量 `'plugin'` 的绝对区间：m[0] 结尾就是闭引号之后
    const literalStart = m.index + m[0].length - ('plugin'.length + 2)
    const literalEnd = m.index + m[0].length
    const quote = m[1]
    const stringLiteral = new RegExp(`^${quote === "'" ? "'" : '"'}([\\s\\S]*)${quote === "'" ? "'" : '"'}$`, 'u').exec(exprRaw)
    let after = null
    if (stringLiteral !== null) {
      const name = stringLiteral[1]
      const mapped = renames[name]
      after = mapped === undefined ? `${quote}${prefix}${name}${quote}` : `${quote}${mapped}${quote}`
    } else {
      const inline = inlineExpression(exprRaw)
      if (inline === null) {
        unresolved.push({ line: lineOf(text, m.index), reason: `plugin: 的写法无法安全内联（${exprRaw.slice(0, 40)}…），需人工改成 \`${prefix}\${…}\``, snippet: m[0] })
        continue
      }
      after = '`' + prefix + '${' + inline.value + '}`'
    }
    rewrites.push({
      start: literalStart,
      end: literalEnd,
      before: text.slice(literalStart, literalEnd),
      after,
      line: lineOf(text, m.index),
    })
  }
  return { rewrites, unresolved }
}

/** 按区间（倒序）写回文本。 */
function applyRewrites(text, rewrites) {
  let out = text
  for (const rw of [...rewrites].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, rw.start) + rw.after + out.slice(rw.end)
  }
  return out
}

/** 扫一段源码文本（纯函数，no fs；探针通过参数注入以便测试）。 */
function scanProducerText({ file, text, rules = {}, targetVersion = null, knownBreakages = KNOWN_BREAKAGES, probe = null }) {
  const findings = []
  const { rewrites, unresolved } = planSourceKindRewrites(text, rules)
  for (const rw of rewrites) {
    findings.push({
      file, line: rw.line, rule: 'legacy-source-kind', severity: 'blocker', fixable: true,
      before: rw.before, after: rw.after,
    })
  }
  for (const item of unresolved) {
    findings.push({
      file, line: item.line, rule: 'legacy-source-kind-unresolved', severity: 'blocker', fixable: false,
      reason: item.reason, snippet: item.snippet,
    })
  }
  for (const kb of knownBreakages) {
    if (typeof kb.since === 'string' && targetVersion !== null && !versionAtLeast(targetVersion, kb.since)) continue
    const matches = [...text.matchAll(new RegExp(kb.pattern.source, kb.pattern.flags.includes('g') ? kb.pattern.flags : kb.pattern.flags + 'g'))]
    if (matches.length === 0) continue
    // 带探针的规则：先确认运行时真的缺这个 API，否则不报（避免修好依赖后永远误报）
    let extra = ''
    let probed = null
    if (kb.probe !== null && kb.probe !== undefined && typeof probe === 'function') {
      probed = probe(file)
      if (probed !== null && probed !== undefined) {
        if (probed.ok === true) continue
        extra = probed.ok === false
          ? `（实测解析到 @deepseek-ai/schemastery@${probed.version ?? '?'}，该副本没有 .volatile()）`
          : `（无法判定解析到的副本：${probed.error ?? '未知'}）`
      }
    }
    for (const m of matches) {
      findings.push({
        file, line: lineOf(text, m.index), rule: kb.id, severity: 'warn', fixable: kb.fixable === true,
        note: `${kb.note}${extra}`, snippet: m[0].trim(), probe: probed,
      })
    }
  }
  return findings
}

/** 递归收集一个根目录下的生产方源码文件（带文件数/体积上限）。 */
function walkProducerRoot({ root, kind, moduleName = null, out, counters }) {
  if (typeof root !== 'string' || root === '' || !existsSync(root)) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (counters.files >= MAX_FILES) return
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_DIR_RE.test(entry.name)) continue
      walkProducerRoot({ root: full, kind, moduleName, out, counters })
      continue
    }
    if (!entry.isFile() || !CODE_FILE_RE.test(entry.name) || SKIP_FILE_RE.test(entry.name)) continue
    try { if (statSync(full).size > MAX_FILE_BYTES) continue } catch { continue }
    out.push({ file: full, kind, moduleName })
    counters.files += 1
  }
}

/** 收集全部生产方文件（root 由路由层给出：预设目录 + 各插件包目录）。 */
function collectProducerTargets(roots) {
  const out = []
  const counters = { files: 0 }
  for (const item of roots ?? []) walkProducerRoot({ ...item, out, counters })
  // 去重（同一文件被多个包目录覆盖时只扫一次）
  const seen = new Set()
  return out.filter((t) => {
    const key = resolve(t.file).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 框架自带包（与框架同源安装、位于 npx 缓存里）命中旧形状时**降级为提示且不可自动改**：
 * 改它等于污染框架安装树（下次升级就被覆盖），正确处置是回滚框架 / 等官方修复 / 由适配门禁用它。
 * 实网只读扫描抓到过真例子：@deepseek-ai/dsh-schedule 仍写 `kind: 'plugin'`（它正是被适配门自动禁用的包）。
 */
function downgradeForFramework(hits) {
  return hits.map((f) => (f.fixable === true ? {
    ...f,
    rule: `${f.rule}-framework`,
    severity: 'warn',
    fixable: false,
    reason: '框架自带包（与框架同源安装）：预检不会改框架文件，正确处置是回滚框架或等官方修复',
  } : f))
}

/**
 * 扫描全部生产方文件。
 */
function scanProducerFiles({ targets, rules = {}, targetVersion = null, readFile = (f) => readFileSync(f, 'utf8'), probe = probeSchemasteryVolatile }) {
  const findings = []
  const files = []
  for (const target of targets ?? []) {
    let text = null
    try { text = readFile(target.file) } catch { continue }
    const raw = scanProducerText({ file: target.file, text, rules, targetVersion, probe })
    const hits = target.kind === 'framework' ? downgradeForFramework(raw) : raw
    files.push({ file: target.file, kind: target.kind, moduleName: target.moduleName, findings: hits.length })
    findings.push(...hits)
  }
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : (a.file < b.file ? -1 : 1)))
  const blockers = findings.filter((f) => f.severity === 'blocker')
  const warnings = findings.filter((f) => f.severity === 'warn')
  const byRule = {}
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  return {
    filesScanned: files.length,
    files,
    findings,
    byRule,
    blockers: blockers.length,
    warnings: warnings.length,
    ok: blockers.length === 0,
  }
}

/** 路径落在允许名单内（写盘前的最后一道闸：绝不允许改名单外的文件）。 */
function isInsideAllowed(file, allowed) {
  const target = resolve(file).toLowerCase()
  return allowed.some((root) => {
    const base = resolve(root).toLowerCase()
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
  })
}

/**
 * 应用补丁：只改「本次扫描出的 blocker 且 fixable」的位置，逐文件备份后写回。
 * @returns { changes, backups, skipped, unresolved }
 */
function applyFormatPatch({ targets, rules = {}, targetVersion = null, stamp = String(Date.now()), dryRun = false, readFile = (f) => readFileSync(f, 'utf8'), writeFile = (f, t) => writeFileSync(f, t, 'utf8'), copyFile = null } = {}) {
  const allowedRoots = (targets ?? []).map((t) => t.file)
  const changes = []
  const backups = []
  const skipped = []
  const unresolved = []
  for (const target of targets ?? []) {
    let text = null
    try { text = readFile(target.file) } catch { continue }
    const rawHits = scanProducerText({ file: target.file, text, rules, targetVersion })
    // 框架自带包：降级为提示 → 下面按 severity==='blocker' 过滤时自然被排除，绝不会被写盘
    const hits = (target.kind === 'framework' ? downgradeForFramework(rawHits) : rawHits).filter((f) => f.severity === 'blocker')
    if (hits.length === 0) continue
    const fixable = hits.filter((f) => f.fixable)
    for (const notFixable of hits.filter((f) => !f.fixable)) unresolved.push(notFixable)
    if (fixable.length === 0) continue
    const { rewrites } = planSourceKindRewrites(text, rules)
    if (rewrites.length === 0) continue
    if (!isInsideAllowed(target.file, allowedRoots)) { skipped.push({ file: target.file, reason: '不在本次上报名单内（拒绝写入）' }); continue }
    let next = text
    try { next = applyRewrites(text, rewrites) } catch (error) {
      skipped.push({ file: target.file, reason: `重写失败：${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (next === text) continue
    if (dryRun) {
      for (const rw of rewrites) changes.push({ file: target.file, line: rw.line, before: rw.before, after: rw.after, moduleName: target.moduleName ?? null })
      continue
    }
    const backup = `${target.file}.bak-preflight-${stamp}`
    try {
      if (typeof copyFile === 'function') copyFile(target.file, backup)
      else writeFile(backup, text)
    } catch (error) {
      skipped.push({ file: target.file, reason: `备份失败，已放弃改动：${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    try { writeFile(target.file, next) } catch (error) {
      skipped.push({ file: target.file, reason: `写入失败：${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    backups.push(backup)
    for (const rw of rewrites) changes.push({ file: target.file, line: rw.line, before: rw.before, after: rw.after, moduleName: target.moduleName ?? null })
  }
  return { changes, backups, skipped, unresolved }
}

export {
  MAX_FILES,
  MAX_FILE_BYTES,
  SKIP_DIRS,
  SKIP_DIR_RE,
  KNOWN_BREAKAGES,
  versionAtLeast,
  lineOf,
  maskComments,
  objectBounds,
  inlineExpression,
  planSourceKindRewrites,
  applyRewrites,
  probeSchemasteryVolatile,
  scanProducerText,
  collectProducerTargets,
  scanProducerFiles,
  downgradeForFramework,
  isInsideAllowed,
  applyFormatPatch,
}
