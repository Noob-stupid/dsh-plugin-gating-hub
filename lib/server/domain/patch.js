// L1 · domain —— patch.js（由 Step 2 从 lib/index.js 原样切出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L1 · domain

import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { queuedWrite } from '../infra/fsx.js'
import { escapeRegExp } from '../infra/mask.js'
import { resolvePackageJson } from '../infra/paths.js'

/** 读取补丁文件并扫描：停用块与 insert 行的 id。 */
async function readPatchState(patchPath) {
  let text = ''
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const disables = []
  const forced = []
  const inserts = []
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^- insert:\s*$/u.test(line)) {
      inInsert = true
      continue
    }
    if (/^- /u.test(line)) inInsert = false
    if (inInsert) {
      const insertRow = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)/u)
      if (insertRow) inserts.push(insertRow[1])
      continue
    }
    const disableRow = line.match(/^- id: ([A-Za-z0-9_.-]+)\s*$/u)
    if (!disableRow) continue
    const next = lines[index + 1] ?? ''
    if (/^ {2}disabled: true\s*$/u.test(next)) disables.push(disableRow[1])
    else if (/^ {2}disabled: false\s*$/u.test(next)) forced.push(disableRow[1])
  }
  return { disables, forced, inserts, text }
}

/** 停用：追加 disabled:true 块（已存在则不动）。 */
async function disableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, text } = await readPatchState(patchPath)
    if (disables.includes(id)) return { changed: false }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    await writeFile(patchPath, `${next}${disableBlock(id)}`, 'utf8')
    return { changed: true }
  })
}

/** 启用：移除 disabled:true 块；若仍被 bundle 停用则追加 disabled:false 覆盖。 */
async function enableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, forced, text } = await readPatchState(patchPath)
    const blockRe = new RegExp(`^- id: ${escapeRegExp(id)}\\r?\\n  disabled: true\\r?\\n`, 'mu')
    if (blockRe.test(text)) {
      await writeFile(patchPath, sanitizePatchText(text.replace(blockRe, '')), 'utf8')
      return { changed: true }
    }
    if (forced.includes(id)) return { changed: false }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    await writeFile(patchPath, `${next}- id: ${id}\n  disabled: false\n`, 'utf8')
    return { changed: true }
  })
}

/** 追加一条 insert 启用行（插件包需已安装到 profile）。 */
async function appendInsert(patchPath, entryId, packageName) {
  return queuedWrite(async () => {
    const { inserts, text } = await readPatchState(patchPath)
    if (inserts.includes(entryId)) return { changed: false }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    const block = `- insert:\n    - id: ${entryId}\n      name: '${packageName}'\n`
    await writeFile(patchPath, `${next}${block}`, 'utf8')
    return { changed: true }
  })
}

/** 从补丁文件移除某行的 insert 块与 disabled/forced 覆盖块。 */
async function removeInsertRow(patchPath, rowId) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    const blockRe = new RegExp(`^- insert:\\s*\\r?\\n {4}- id: ${escapeRegExp(rowId)}\\s*\\r?\\n( {6}name: [^\\r\\n]*\\r?\\n)?`, 'mu')
    let next = text.replace(blockRe, '')
    const overrideRe = new RegExp(`^- id: ${escapeRegExp(rowId)}\\s*\\r?\\n {2}disabled: (true|false)\\s*\\r?\\n`, 'mu')
    next = next.replace(overrideRe, '')
    if (next !== text) await writeFile(patchPath, sanitizePatchText(next), 'utf8')
  })
}

/** 移除补丁中的单行 disabled/forced 覆盖块（兼容门解锁用）。 */
function removeDisableBlock(patchPath, rowId) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    const overrideRe = new RegExp(`^- id: ${escapeRegExp(rowId)}\\s*\\r?\\n {2}disabled: (true|false)\\s*\\r?\\n`, 'mu')
    const next = text.replace(overrideRe, '')
    if (next !== text) await writeFile(patchPath, sanitizePatchText(next), 'utf8')
  })
}

/**
 * 清理补丁文件中的顶层空数组占位符（issue #7 事故教训）：
 * DSH profile 模板的 cordis.patch.yml 以注释 + 顶层 `[]` 占位符初始化（如 `# ...\n[]`）。
 * 直接追加条目会生成 `[]` 后又跟 `- id: xxx` 的非法 YAML（同文档流里数组结束符 + 后续项），
 * 导致 dsh 启动解析崩溃。写入前必须移除顶层独立的 `[]` / `[ ]` 占位行。
 * 仅处理"整行就是空数组"的占位符；合法内容（如 `- insert:` 列表）不受影响。
 */
function sanitizePatchText(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*\[\s*\]\s*$/u.test(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\s+$/u, '') + '\n'
}

/** 解析用户补丁中 insert 块的 id → moduleName（name 字段）。 */
function parseInsertNames(text) {
  const map = new Map()
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  let curId = null
  for (const line of lines) {
    if (/^- insert:\s*$/u.test(line)) { inInsert = true; curId = null; continue }
    if (inInsert && /^- /u.test(line)) inInsert = false
    if (inInsert) {
      const idMatch = line.match(/^\s+- id: ([A-Za-z0-9_.-]+)/u)
      if (idMatch) { curId = idMatch[1]; continue }
      if (curId !== null) {
        const nameMatch = line.match(/^\s+name: ['"]([^'"]+)['"]/u)
        if (nameMatch) { map.set(curId, nameMatch[1]); curId = null }
      }
    }
  }
  return map
}

/**
 * 补丁安全自愈（服务永不崩机制）：
 * ① 核心行被误禁用 → 自动移除禁用块恢复；
 * ② 启用态用户 insert 行的模块缺失（如引用未安装包的行）→ 自动禁用（loader 对缺失模块会致命崩溃）。
 * return { healed:[], autoDisabled:[], healedAt } —— healedAt=0 表示本次无修改。
 */
async function healPatchSafety(patchPath) {
  const profileDir = dirname(patchPath)
  const { text } = await readPatchState(patchPath)
  let next = text
  const healed = []
  const autoDisabled = []
  for (const id of CORE_PATCH_ROW_IDS) {
    const re = new RegExp(`^- id: ${escapeRegExp(id)}\\s*\\r?\\n {2}disabled: true\\s*\\r?\\n`, 'mu')
    if (re.test(next)) {
      next = next.replace(re, '')
      healed.push(id)
    }
  }
  if (healed.length === 0) {
    const insertNames = parseInsertNames(next)
    let require = null
    for (const [id, moduleName] of insertNames) {
      if (!moduleName || moduleName.startsWith('cordis:')) continue
      let ok = true
      try { ok = resolvePackageJson(moduleName, profileDir) !== null } catch { ok = false }
      if (!ok && !new RegExp(`^- id: ${escapeRegExp(id)}\\s*\\r?\\n {2}disabled: true\\s*\\r?\\n`, 'mu').test(next)) {
        next = `${next.trimEnd()}\n- id: ${id}\n  disabled: true\n`
        autoDisabled.push(id)
      }
    }
  }
  if (next !== text) {
    await writeFile(patchPath, sanitizePatchText(next), 'utf8')
  }
  return { healed, autoDisabled, healedAt: next !== text ? Date.now() : 0 }
}

/** 从「子包版本对齐」记录解析纯包名（如 '@linxin666/dsh-pet@0.2.1（新装）'）。 */
function syncNameFromNote(note) {
  const m = String(note ?? '').match(/^((?:@[^/]+\/)?[^@]+)/u)
  return m ? m[1] : null
}

/** 框架核心行：误禁用会导致启动失败（2026-09-04 session-persistence-jsonl 事故：6 行 pending、
 * 启动断言失败）。任何补丁写入（适配门/脚本/工具）都禁止禁用这些行；自愈机制自动恢复误禁。 */
const CORE_PATCH_ROW_IDS = new Set([
  'session-persistence-jsonl', 'webserver', 'timer', 'hmr', 'session', 'session-checkpoint-policy',
  'message-feedback', 'workspace', 'storage', 'storage-json', 'storage-domain', 'api-gateway',
  'api-session-controller', 'api-workspace-controller', 'credentials', 'settings', 'attachment-local',
  'subprocess', 'sandbox', 'sandbox-policy', 'shell-env', 'agent', 'agent-loop', 'llm', 'web-runtime', 'web-startup',
])

function disableBlock(id) {
  return `- id: ${id}\n  disabled: true\n`
}

export { readPatchState, disableEntry, enableEntry, appendInsert, removeInsertRow, removeDisableBlock, sanitizePatchText, parseInsertNames, healPatchSafety, syncNameFromNote, CORE_PATCH_ROW_IDS, disableBlock }

