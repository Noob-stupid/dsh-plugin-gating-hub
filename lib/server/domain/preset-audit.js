// L1 · domain —— preset-audit.js（用户预设 ↔ profile 声明行 的跨源对账；0.5.30 加法）
//
// 真机背景（2026-09-28）：框架 0.1.7-rc.1 起官方移除了磁盘发现，老会话 resume 靠 profile 补丁里的
// **声明行**；而预设目录里的 `agent.cordis.yml` 会随后续装配被更新（本机 router-spec 在升级前 1 分钟
// 被改成 v10），补丁里的行却还是旧的（meta 指向 v1）→ 老会话 resume 到错的模块。
// 真机证据：`profiles/web/cordis.patch.yml` 指向 `router-bootstrap-v1.mjs`，
//          而 `router-spec/agent.cordis.yml` 自己写的是 `./router-bootstrap-v10.mjs`。
//
// 本模块只做**纯对账**（IO 全注入）：
//   · parsePresetDeclarations(text)  预设自身声明的 `{ id → 目标 }`（相对引用保留原样）
//   · auditPresetDeclarations({...}) 与补丁里的 file:/// 行逐条比对，输出四类差异
//
// 判据（保守、不猜）：
//   · **目标按目录归属**匹配 —— 补丁行落在哪个预设目录下就算哪个预设的（router-* 三个预设各有
//     同名 id `router-bootstrap`，只能靠目录区分，不能靠 id 全局匹配）。
//   · 只报"能证明不一致"的：id 相同但目标不同（陈旧）、预设里有补丁里没有（缺失）、
//     补丁里有但预设目录里查无此 id（悬空）、任一目标文件不存在（悬空）。
//   · 行**显式 disabled** 的，降级为 warning（用户已经关掉它了，不算错，但要看得见）。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePatchRows } from './patch-composition-audit.js'

/** 预设自身声明的模块：`{ id, target, line, disabled }`（只收有 name 的行）。 */
function parsePresetDeclarations(text) {
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  const out = []
  let cur = null
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim() === '' || /^\s*#/u.test(raw)) continue
    const item = raw.match(/^(\s*)-\s*id:\s*(\S+)\s*$/u)
    if (item !== null) {
      cur = { id: item[2].replace(/^['"]|['"]$/gu, ''), target: null, line: i + 1, disabled: false, indent: item[1].length }
      out.push(cur)
      continue
    }
    if (cur === null) continue
    const indent = (raw.match(/^ */u) ?? [''])[0].length
    if (indent <= cur.indent) continue
    const name = raw.match(/^\s*name:\s*(.+?)\s*$/u)
    if (name !== null && cur.target === null) { cur.target = name[1].replace(/^['"]|['"]$/gu, ''); continue }
    if (/^\s*disabled:\s*true\s*$/u.test(raw)) cur.disabled = true
  }
  // 2026-09-28 改错（真机试跑抓到 89 条假"缺失"）：预设里的 `name:` 大量是**包名**（`@deepseek-ai/dsh-persona` 等），
  // 它们在补丁里也是包名行、不归"按目录归属"的文件匹配管 —— 只有**文件型声明**（相对/绝对路径）
  // 才会被改写成 `file:///…` 的声明行。这里只收文件型，避免把包名行误判成"声明行缺失"。
  return out.filter((row) => typeof row.target === 'string' && row.target !== '' && /^(\.\.?[\\/]|[A-Za-z]:[\\/]|file:)/u.test(row.target))
}

/**
 * 跨源对账（纯函数，IO 注入）。
 * 入参：
 *   · presets: `[{ dir, modules: parsePresetDeclarations(text) }]`
 *   · patchRows: `[{ id, name, line, disabled }]`（补丁里的行；`name` 可以是 file:/// 也可以是别的）
 *   · toLocalPath(url) / joinPath(dir, rel) / exists(path) / dirnameOf(path)（可注入，便于离线断言）
 * 返回 `{ stale, missing, orphan, targetMissing, ok }`。
 */
function auditPresetDeclarations({ presets = [], patchRows = [], toLocalPath, joinPath, exists, dirnameOf } = {}) {
  const stale = []
  const missing = []
  const orphan = []
  const targetMissing = []
  const patchFileRows = []
  for (const row of (Array.isArray(patchRows) ? patchRows : [])) {
    if (row === null || typeof row !== 'object') continue
    const name = typeof row.name === 'string' ? row.name : ''
    if (!/^file:\/\//iu.test(name)) continue
    let local = null
    try { local = toLocalPath(name) } catch { local = null }
    if (local === null) continue
    patchFileRows.push({ id: row.id ?? null, local, line: row.line ?? null, disabled: row.disabled === true })
  }
  for (const preset of (Array.isArray(presets) ? presets : [])) {
    if (preset === null || typeof preset !== 'object' || typeof preset.dir !== 'string') continue
    const mine = patchFileRows.filter((row) => dirnameOf(row.local) === preset.dir)
    const declared = Array.isArray(preset.modules) ? preset.modules : []
    for (const mod of declared) {
      const target = joinPath(preset.dir, mod.target)
      const hit = mine.find((row) => row.id === mod.id) ?? null
      if (hit === null) {
        missing.push({ preset: preset.dir, id: mod.id, expected: target, declaredAt: mod.line, disabled: mod.disabled === true })
        continue
      }
      if (hit.local !== target) {
        stale.push({ preset: preset.dir, id: mod.id, declared: target, patchTarget: hit.local, patchLine: hit.line, disabled: hit.disabled })
        continue
      }
      let present = null
      try { present = exists(target) } catch { present = null }
      if (present === false) targetMissing.push({ preset: preset.dir, id: mod.id, target, source: 'declaration' })
    }
    const ids = new Set(declared.map((m) => m.id))
    for (const row of mine) {
      if (ids.has(row.id)) continue
      orphan.push({ preset: preset.dir, id: row.id, patchTarget: row.local, patchLine: row.line, disabled: row.disabled })
      let present = null
      try { present = exists(row.local) } catch { present = null }
      if (present === false) targetMissing.push({ preset: preset.dir, id: row.id, target: row.local, source: 'patch' })
    }
  }
  const blockers = stale.length + missing.length + orphan.filter((o) => o.disabled !== true).length
    + targetMissing.length
  return { stale, missing, orphan, targetMissing, blockers, ok: blockers === 0 }
}


/** IO 收集层（preset-audit 路由与升级前预检共用）：扫磁盘预设 + 读补丁行 → 出报告。 */
function collectPresetAudit({ presetsRoot, patchPath, deps = {} } = {}) {
  const {
    exists = existsSync, readdir = readdirSync, readText = (p) => readFileSync(p, 'utf8'),
    toLocal = (url) => fileURLToPath(url), joinPath = join, dirOf = dirname,
  } = deps
  if (typeof presetsRoot !== 'string' || presetsRoot === '' || !exists(presetsRoot)) {
    return { ok: false, error: '没有用户预设目录（无需体检）', presetCount: 0, stale: [], missing: [], orphan: [], targetMissing: [], blockers: 0 }
  }
  const presets = []
  try {
    for (const entry of readdir(presetsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (name.startsWith('.') || name.startsWith('_') || name.includes('.bak')) continue
      const dir = joinPath(presetsRoot, name)
      const file = joinPath(dir, 'agent.cordis.yml')
      if (!exists(file)) continue
      const modules = parsePresetDeclarations(readText(file))
      if (modules.length > 0) presets.push({ dir, modules })
    }
  } catch {}
  let patchRows = []
  try { patchRows = parsePatchRows(readText(patchPath)) } catch { patchRows = [] }
  const report = auditPresetDeclarations({
    presets,
    patchRows: patchRows.map((r) => ({ id: r.id, name: r.name, line: r.line, disabled: r.disabled })),
    toLocalPath: toLocal,
    joinPath,
    exists,
    dirnameOf: dirOf,
  })
  return { ok: report.ok, presetCount: presets.length, ...report }
}

export { auditPresetDeclarations, collectPresetAudit, parsePresetDeclarations }