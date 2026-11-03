// L1 · domain —— patch.js（由 Step 2 从 lib/index.js 原样切出，只搬移未改逻辑）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言）

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { frameworkBases, isFrameworkModuleName } from '../infra/framework-root.js'
import { queuedWrite } from '../infra/fsx.js'
import { escapeRegExp } from '../infra/mask.js'
import { makePackageResolver } from '../infra/package-resolve.js'

/**
 * 写补丁前先建父目录（issue #27 的**派生缺口**，0.5.99 加法）。
 *
 * 为什么必须补：补丁路径是从 loader 的 `cordis:include` 条目推导出来的（见 infra/paths.js），
 * 推导一旦指向一个**还不存在**的 profile 目录，本文件里原先 7 处 `writeFile` 全是**裸写** ——
 * 父目录不在就 ENOENT。表现分两种，都很难查：
 *   ① 调用方 catch 了异常 ⇒ 面板显示"已启用"，文件里却一个字都没有（假成功）；
 *   ② 异常冒到接口 ⇒ 500，但真正的原因（profile 目录不存在）没人说出来。
 * ⇒ 现在写前 `mkdir(dirname(p), { recursive: true })`：只把"**本来该成功却失败**"的那条路补上；
 *   原本就写得成功的路径一个字节都不变（目录已存在时 recursive mkdir 是幂等 no-op）。
 *
 * mkdir 自己失败时**原样抛出**（绝不吞成"写成功"）：要么调用方 catch，要么接口如实报错 ——
 * 但绝不能出现"目录没建出来、函数却正常返回"。
 * `deps.mkdir` 只是给测试用的注入缝（模拟 EPERM），生产默认就是 node:fs/promises#mkdir。
 */
async function ensurePatchParentDir(patchPath, deps = {}) {
  const make = typeof deps.mkdir === 'function' ? deps.mkdir : mkdir
  await make(dirname(patchPath), { recursive: true })
}

/**
 * 父目录是不是**真的不存在**（`readPatchState` 区分"两种缺失"的判据）。
 *
 * 只在 readFile 已经 ENOENT 之后才被调用 —— 文件正常读取时一次 syscall 都不多。
 * 判据**保守**：只有确证（ENOENT / ENOTDIR）才说"父目录不存在"；
 * EPERM/EACCES 这类"读不到但不一定没有"的情况一律返回 false（宁可不说，不谎报路径错）。
 */
async function parentDirMissing(patchPath, statFn) {
  try {
    await statFn(dirname(patchPath))
    return false
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
  }
}

/** 读取补丁文件并扫描：停用块与 insert 行的 id。
 *
 *  ★ 0.5.99 加法：「文件不存在」过去被 ENOENT 一起吞成"空补丁"，于是**路径推导错了**与
 *    **文件真的是空的**在返回值上完全一样 —— issue #27 那个 bug（补丁全写到废弃的 web profile、
 *    在用的 desktop 静默收不到）正是靠这条配合才藏了三周。
 *    现在区分两种缺失，但**一个字都不改既有语义**：
 *      ① 父目录在、文件还没建（新 profile 第一次写补丁，**正常**）⇒ 空补丁，`parentMissing: false`；
 *      ② 父目录也不在（**路径推导错了**）⇒ 仍然返回空补丁（不抛错、既有调用方行为不变），
 *         只多带 `parentMissing: true` + `missingReason: 'parent-missing'`，让上层看得见。
 *    健康环境下的返回值只比过去多**一个**字段（`parentMissing`）——`missingReason` 仅在缺失时出现。
 *  `deps.stat` 是给测试用的注入缝；生产默认 node:fs/promises#stat。公开调用面仍是 `readPatchState(path)`。
 */
async function readPatchState(patchPath, deps = {}) {
  const statFn = typeof deps.stat === 'function' ? deps.stat : stat
  let text = ''
  let parentMissing = false
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    parentMissing = await parentDirMissing(patchPath, statFn)
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
  // ★ 只增字段：健康环境下 = 既有 4 个字段 + `parentMissing: false`；
  //   父目录缺失时才多一个 `missingReason`（见上面的注释）。
  const state = { disables, forced, inserts, text, parentMissing }
  if (parentMissing) state.missingReason = 'parent-missing'
  return state
}

/** 停用：追加 disabled:true 块（已存在则不动）。 */
async function disableEntry(patchPath, id) {
  return queuedWrite(async () => {
    const { disables, text } = await readPatchState(patchPath)
    if (disables.includes(id)) return { changed: false }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    await ensurePatchParentDir(patchPath)
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
      await ensurePatchParentDir(patchPath)
      await writeFile(patchPath, sanitizePatchText(text.replace(blockRe, '')), 'utf8')
      return { changed: true }
    }
    if (forced.includes(id)) return { changed: false }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    await ensurePatchParentDir(patchPath)
    await writeFile(patchPath, `${next}- id: ${id}\n  disabled: false\n`, 'utf8')
    return { changed: true }
  })
}

/** 读 profile 清单里的 `dsh.profile.bundles`（包名数组）。
 *  读不到就返回空数组 —— 绝不因为读清单失败而阻断既有写入行为。 */
async function readProfileBundles(patchPath) {
  try {
    const manifest = JSON.parse(await readFile(join(dirname(patchPath), 'package.json'), 'utf8'))
    const list = manifest?.dsh?.profile?.bundles
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim() !== '') : []
  } catch {
    return []
  }
}

/** 追加一条 insert 启用行（插件包需已安装到 profile）。
 *
 *  幂等护栏（2026-10-03 用户实测事故后加）：以下三种情况都**不写**，只回报 `changed:false` + `reason`：
 *    ① `same-id`        同 id 已经在 insert 里（原有行为）；
 *    ② `same-package`   **同一个包名**已由别的 insert 行声明 —— 再写一行 = 重复装配，
 *                       第二行会因重复注册而挂载失败；
 *    ③ `bundle`         **同一个包名**已由 `dsh.profile.bundles` 声明 —— bundle 自带的
 *                       patch 会在启动时自动装配它自己的行，我们再插一行同样是重复装配。
 *
 *  事故复现：用户先用**官方插件管理**启用插件（= 走 bundle 声明），再在我们面板点「启用」
 *  → 我们多写了一条 insert 行 → 同一插件被装配两次 → 第二行抛 `already registered`
 *  → 面板显示「已启用 + 挂载失败」。 */
async function appendInsert(patchPath, entryId, packageName) {
  return queuedWrite(async () => {
    const { inserts, text } = await readPatchState(patchPath)
    if (inserts.includes(entryId)) return { changed: false, reason: 'same-id' }
    const name = String(packageName ?? '').trim()
    if (name !== '') {
      for (const declared of parseInsertNames(text).values()) {
        if (String(declared ?? '').trim() === name) return { changed: false, reason: 'same-package' }
      }
      const bundles = await readProfileBundles(patchPath)
      if (bundles.includes(name)) return { changed: false, reason: 'bundle' }
    }
    const clean = sanitizePatchText(text)
    const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
    const block = `- insert:\n    - id: ${entryId}\n      name: '${packageName}'\n`
    await ensurePatchParentDir(patchPath)
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
    if (next !== text) {
      await ensurePatchParentDir(patchPath)
      await writeFile(patchPath, sanitizePatchText(next), 'utf8')
    }
  })
}

/** 移除补丁中的单行 disabled/forced 覆盖块（兼容门解锁用）。 */
function removeDisableBlock(patchPath, rowId) {
  return queuedWrite(async () => {
    const { text } = await readPatchState(patchPath)
    const overrideRe = new RegExp(`^- id: ${escapeRegExp(rowId)}\\s*\\r?\\n {2}disabled: (true|false)\\s*\\r?\\n`, 'mu')
    const next = text.replace(overrideRe, '')
    if (next !== text) {
      await ensurePatchParentDir(patchPath)
      await writeFile(patchPath, sanitizePatchText(next), 'utf8')
    }
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

/** 解析用户补丁中 insert 块的 id → moduleName（name 字段）。
 *  ★ 2026-10-04 改错（真机发现，0.5.38）：`name:` 的值**加了引号才算**是错的 —— YAML 里
 *    `name: dsh-whale-widget` 与 `name: 'dsh-whale-widget'` 完全等价，而本机真装的
 *    `dsh-whale-widget`（插件市场里的真实第三方插件）写的正是**不带引号**的那种。
 *    旧判据只认带引号的值 ⇒ 那一行在解析结果里**根本不存在**：补丁自愈看不见它、
 *    装后校验看不见它、撤销安装也看不见它（"行明明在文件里，程序却说没有"）。
 *    现在两种形态都认（末尾的行内注释也剥掉），解析结果只多不少。 */
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
        const nameMatch = line.match(/^\s+name:\s*(.+?)\s*$/u)
        if (nameMatch) {
          const raw = nameMatch[1].replace(/\s+#.*$/u, '').trim()
          const value = /^(['"]).*\1$/u.test(raw) ? raw.slice(1, -1) : raw
          if (value !== '') map.set(curId, value)
          curId = null
        }
      }
    }
  }
  return map
}

/**
 * 补丁安全自愈（服务永不崩机制）：
 * ① 核心行被误禁用 → 自动移除禁用块恢复；
 * ② 启用态用户 insert 行的模块**确证缺失**（如引用未安装包的行）→ 自动禁用（loader 对缺失模块会致命崩溃）。
 *
 * ★ 2026-09-30 改错（真机事故 2026-09-29 01:05:44）：② 过去只用**单基准**
 *   `resolvePackageJson(name, profileDir)` 判定"缺失"，而框架 0.2.0-rc.1 起 `@deepseek-ai/*` 的实体
 *   全在 `.pnpm` **内部**那层、profile 顶层只剩旧版残影 → 框架**真存在**的内置包
 *   `dsh-agent-preset` / `dsh-workflow-ptc` 被判成缺失 → 给它们自动写了 4 个 `disabled: true` 块，
 *   把用户的 preset-router-spec/standard/react 三条全停掉。
 *   现在改为**多基准并集**（profile 目录 + 框架运行时根，见 infra/framework-root.js）：
 *   任一基准能解析即算命中 → 不再误判。
 *
 * 语义收紧（三条硬约束）：
 *   · **确证缺失才禁用**：解析不确定（resolver 报 uncertain / 一个基准都没有 / 解析器抛异常）→ 只报告不写盘；
 *   · **框架命名空间 `@deepseek-ai/*` 永不自动禁用**：它们是框架自带包（随版本增删由框架自己管），
 *     写 `disabled: true` 等于用旧判断把新框架的组件停掉 —— 命中一律只报告；
 *   · **幂等零写盘**：没有真正需要修复的内容时，一个字节都不写（`healedAt=0`），
 *     且即便算出了新内容也要与原文逐字节比较后才落盘（`GET /state` 每 ≤2min 调一次本函数）。
 * 写盘失败**如实回报**（`written:false` + `writeError`），绝不静默吞掉。
 *
 * return { healed:[], autoDisabled:[], skipped:[], uncertain:[], healedAt, written, writeError }
 *   healedAt=0 表示本次无修改。
 */
async function healPatchSafety(patchPath, deps = {}) {
  const profileDir = dirname(patchPath)
  const readText = deps.readText ?? ((p) => readFile(p, 'utf8'))
  // 默认写盘实现也走「先建父目录」：注入缝只是把 writeFile 换成别的写盘手段，
  // 不该因此丢掉父目录保证（过去注入 readText/writeText 的调用方拿到的行为不变）。
  const writeText = deps.writeText ?? (async (p, data) => {
    await ensurePatchParentDir(p, deps)
    await writeFile(p, data, 'utf8')
  })
  const { text } = await readPatchState(patchPath)
  const healed = []
  const autoDisabled = []
  const skipped = []
  const uncertain = []
  let next = text

  // ① 核心行被误禁用 → 恢复（与判据无关，先做）
  for (const id of CORE_PATCH_ROW_IDS) {
    const re = new RegExp(`^- id: ${escapeRegExp(id)}\\s*\\r?\\n {2}disabled: true\\s*\\r?\\n`, 'mu')
    if (re.test(next)) {
      next = next.replace(re, '')
      healed.push(id)
    }
  }

  // ② 启用态 insert 行的模块缺失 → 自动禁用（仅在**确证缺失**时）
  if (healed.length === 0) {
    const insertNames = parseInsertNames(next)
    const bases = Array.isArray(deps.bases)
      ? deps.bases.filter((b) => typeof b === 'string' && b !== '')
      : frameworkBases(deps.baseDir ?? null, profileDir)
    const resolve = deps.resolve ?? (bases.length > 0 ? makePackageResolver(bases) : null)
    for (const [id, moduleName] of insertNames) {
      if (!moduleName || moduleName.startsWith('cordis:')) continue
      const alreadyDisabled = new RegExp(`^- id: ${escapeRegExp(id)}\\s*\\r?\\n {2}disabled: true\\s*\\r?\\n`, 'mu').test(next)
      if (alreadyDisabled) continue
      // framework 命名空间：随框架版本走，永不自动禁用（只报告）
      if (isFrameworkModuleName(moduleName)) { skipped.push({ id, moduleName, reason: 'framework-owned' }); continue }
      // 没有解析器 / 没有任何基准 → 无法判定，只报告
      if (resolve === null) { uncertain.push({ id, moduleName, reason: 'no-resolution-base' }); continue }
      let res = null
      try { res = resolve(moduleName) } catch (error) { res = { ok: false, uncertain: true, reason: String(error?.message ?? error) } }
      // 兼容两种 resolver 契约：布尔（旧测试桩）/ `{ ok, uncertain, reason }`（infra/package-resolve.js）
      const ok = res === true || res?.ok === true
      if (ok) continue
      if (res?.uncertain === true) { uncertain.push({ id, moduleName, reason: res?.reason ?? 'uncertain' }); continue }
      next = `${next.trimEnd()}\n- id: ${id}\n  disabled: true\n`
      autoDisabled.push(id)
    }
  }

  // ③ 幂等零写盘：没有任何需要修复的内容 / 内容与原文逐字节相同 → 一个字节都不写
  if (next === text) {
    return { healed, autoDisabled, skipped, uncertain, healedAt: 0, written: false, writeError: null }
  }
  const payload = sanitizePatchText(next)
  if (payload === text) {
    return { healed, autoDisabled, skipped, uncertain, healedAt: 0, written: false, writeError: null }
  }
  // ④ 写盘失败如实回报（不静默）
  try {
    await writeText(patchPath, payload)
  } catch (error) {
    return { healed, autoDisabled, skipped, uncertain, healedAt: 0, written: false, writeError: String(error?.message ?? error) }
  }
  // 读回核实：写盘后重新读一次，只有内容真的落盘才算 healedAt
  let verified = false
  try { verified = (await readText(patchPath)) === payload } catch { verified = false }
  return { healed, autoDisabled, skipped, uncertain, healedAt: Date.now(), written: true, writeError: verified ? null : '写盘后读回内容与期望不一致' }
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

