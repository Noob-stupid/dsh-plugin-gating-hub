// L1 · domain —— plugin-annotations.js（用户注解：备注 / 用户徽章 / 用户自建分组；issue #22 ②③）
// 分层分组：L1 · domain（tests/test-architecture-guard.mjs 断言边界；不认识 cordis ctx）
//
// ── 这个文件存在的原因 ────────────────────────────────────────────────────────
//   issue #22 ②③：每个已装插件要能写一段**用户备注**（"这是干什么的、为什么装它"）、打自己的**徽章**，
//   并把插件归进**用户自建分组**。这三件事必须是**用户数据**，与框架/补丁/profile 清单完全无关 ——
//   所以落在一个独立文件里：`<DSH_HOME>/plugin-console/plugin-annotations.json`。
//
// ── 硬边界（每一条都有对应的测试）─────────────────────────────────────────────
//   ① **绝不影响插件本身**：注解读不出来、写不进去、文件被手工改坏 —— 都不许让 /state、开关、
//      安装这些路径受一点影响。因此本模块不被 /state 引用，路由失败也只回自己的错误。
//   ② **坏文件不覆盖**：文件存在但不是合法对象 ⇒ 读的时候**降级为空结构并报错**，写的时候**拒绝**
//      （409），绝不用"我们的空结构"盖掉用户手写/被别的东西写坏的文件。空文件（0 字节）是另一回事：
//      那是"还没有内容"，按空结构处理、写入时正常覆盖（并照常备份）。
//   ③ **写盘四步**：备份 → 临时文件 + rename（原子）→ **读回核实预期事实** → 核实不过就回滚。
//      "写了但没生效"是最坏的一种假绿（本仓 0.5.87 的"更新成功但版本没落住"就是这一族）。
//   ④ **并发不丢更新**：所有写都过 infra/fsx.js 的 `queuedWrite`（同一个进程级队列），
//      于是"读-改-写"不会互相覆盖（10 个并发写 10 个包，10 条都必须在，测试 ③ 钉死）。
//   ⑤ **只增不毁**：删分组只解除归属，**不动**插件的备注/徽章；删徽章/改备注都只是改这一条记录。
//
// ── 数据形状（version 1）──────────────────────────────────────────────────────
//   {
//     "version": 1,
//     "updatedAt": 1700000000000,
//     "plugins": {
//       "<包名或 rowId>": { "note": "…", "badges": ["必装","记忆类"], "rowId": "dsh-memory", "updatedAt": 0 }
//     },
//     "groups": [
//       { "id": "gxxx", "name": "记忆类", "packages": ["@openviking/dsh-memory-plugin"], "collapsed": false, "createdAt": 0 }
//     ]
//   }
//   · `plugins` 键优先用**包名**（用户看到的就是包名），记录里另存 `rowId` 供"只给了 rowId"的调用命中；
//   · `groups` 的**数组顺序就是展示顺序**（新建追加、撤销删除回到原位置）；
//   · 一个包**最多属于一个用户分组**（assign 到 B 会自动从 A 移出）—— 分组是"区块"，一个插件同时出现在
//     两个区块里只会让人怀疑数据坏了。官方 family 区块（dsh-web 那类）优先级更高，由客户端处理：
//     **属于官方 family 的插件不进入用户分组区块**（本模块不参与该判定，只存归属）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { queuedWrite } from '../infra/fsx.js'
import { dshHome } from '../infra/paths.js'

const ANNOTATIONS_FILE = 'plugin-annotations.json'
const ANNOTATIONS_VERSION = 1
const NOTE_MAX = 2000
const BADGE_MAX_COUNT = 12
const BADGE_MAX_LEN = 16
const GROUP_NAME_MAX = 24
const GROUP_MAX = 40
const PACKAGE_NAME_MAX = 214
/** 包名形态（允许子路径行，如 `@linxin666/dsh-web-all/plugin-manager`）；用户注解只能挂在包上。 */
const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/u

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** 注解文件路径（`<DSH_HOME>/plugin-console/plugin-annotations.json`）。 */
function annotationsPath() {
  return join(dshHome(), 'plugin-console', ANNOTATIONS_FILE)
}

/** 空结构（读不到 / 空文件 / 降级读取都用它；**永远返回新对象**，避免调用方改到共享状态）。 */
function emptyAnnotations() {
  return { version: ANNOTATIONS_VERSION, updatedAt: 0, plugins: {}, groups: [] }
}

function isPackageName(value) {
  return typeof value === 'string' && value !== '' && value.length <= PACKAGE_NAME_MAX && PACKAGE_NAME_RE.test(value)
}

/** 徽章列表规范化（去空白、去重、上限）；不合法 ⇒ ok:false + 可读原因。 */
function sanitizeBadges(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'badges 必须是字符串数组（清空请传 []）' }
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: '徽章必须是字符串' }
    const text = item.trim()
    if (text === '') continue
    if (text.length > BADGE_MAX_LEN) return { ok: false, error: `徽章「${text.slice(0, 12)}…」太长（上限 ${BADGE_MAX_LEN} 字）` }
    if (/[\u0000-\u001f\u007f]/u.test(text)) return { ok: false, error: '徽章里不能有控制字符' }
    if (!out.includes(text)) out.push(text)
    if (out.length > BADGE_MAX_COUNT) return { ok: false, error: `徽章最多 ${BADGE_MAX_COUNT} 个（收到 ${out.length} 个）` }
  }
  return { ok: true, value: out }
}

/** 备注规范化（trim、限制长度）；空串表示"清空这条备注"。 */
function sanitizeNote(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'note 必须是字符串（清空请传空串）' }
  const text = raw.replace(/\r\n/gu, '\n').trim()
  if (text.length > NOTE_MAX) return { ok: false, error: `备注太长（${text.length} 字，上限 ${NOTE_MAX}）` }
  return { ok: true, value: text }
}

/** 分组名规范化。 */
function sanitizeGroupName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'name 必须是字符串' }
  const text = raw.trim()
  if (text === '') return { ok: false, error: '分组名不能为空' }
  if (text.length > GROUP_NAME_MAX) return { ok: false, error: `分组名太长（${text.length} 字，上限 ${GROUP_NAME_MAX}）` }
  if (/[\u0000-\u001f\u007f]/u.test(text)) return { ok: false, error: '分组名里不能有控制字符' }
  return { ok: true, value: text }
}

/** 把磁盘上的（可能被手工改过的）对象规范化成可信结构，并如实报告修了几处。 */
function normalizeAnnotations(raw) {
  const repaired = []
  const data = emptyAnnotations()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { data, repaired: ['整体结构不是对象'] }
  if (Number.isFinite(raw.updatedAt)) data.updatedAt = raw.updatedAt
  // plugins
  const plugins = raw.plugins !== null && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins) ? raw.plugins : {}
  if (raw.plugins !== undefined && plugins !== raw.plugins) repaired.push('plugins 不是对象，已忽略')
  for (const [key, record] of Object.entries(plugins)) {
    if (!isPackageName(key)) { repaired.push(`键不是合法包名：${String(key).slice(0, 40)}`); continue }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) { repaired.push(`记录不是对象：${key}`); continue }
    const noteResult = typeof record.note === 'string' ? sanitizeNote(record.note) : { ok: false }
    const badgesResult = Array.isArray(record.badges) ? sanitizeBadges(record.badges) : { ok: false }
    const note = noteResult.ok === true ? noteResult.value : ''
    const badges = badgesResult.ok === true ? badgesResult.value : []
    if (typeof record.note === 'string' && !noteResult.ok) repaired.push(`备注不合法已丢弃：${key}`)
    if (Array.isArray(record.badges) && !badgesResult.ok) repaired.push(`徽章不合法已丢弃：${key}`)
    if (note === '' && badges.length === 0) continue
    const out = {}
    if (note !== '') out.note = note
    if (badges.length > 0) out.badges = badges
    if (typeof record.rowId === 'string' && record.rowId !== '') out.rowId = record.rowId
    if (Number.isFinite(record.updatedAt)) out.updatedAt = record.updatedAt
    data.plugins[key] = out
  }
  // groups
  const groups = Array.isArray(raw.groups) ? raw.groups : []
  if (raw.groups !== undefined && !Array.isArray(raw.groups)) repaired.push('groups 不是数组，已忽略')
  const seenIds = new Set()
  const seenNames = new Set()
  for (const group of groups) {
    if (group === null || typeof group !== 'object' || Array.isArray(group)) { repaired.push('分组记录不是对象'); continue }
    const id = typeof group.id === 'string' ? group.id.trim() : ''
    const nameResult = sanitizeGroupName(group.name)
    if (id === '' || !nameResult.ok) { repaired.push('分组缺 id 或缺名字'); continue }
    if (seenIds.has(id)) { repaired.push(`分组 id 重复：${id}`); continue }
    if (seenNames.has(nameResult.value)) { repaired.push(`分组名重复：${nameResult.value}`); continue }
    seenIds.add(id)
    seenNames.add(nameResult.value)
    const out = { id, name: nameResult.value, packages: [], collapsed: group.collapsed === true }
    if (Array.isArray(group.packages)) {
      for (const pkg of group.packages) {
        if (!isPackageName(pkg)) { repaired.push(`分组 ${nameResult.value} 里的包名不合法：${String(pkg).slice(0, 40)}`); continue }
        if (!out.packages.includes(pkg)) out.packages.push(pkg)
      }
    } else if (group.packages !== undefined) repaired.push(`分组 ${nameResult.value} 的 packages 不是数组`)
    if (Number.isFinite(group.createdAt)) out.createdAt = group.createdAt
    data.groups.push(out)
  }
  if (data.groups.length > GROUP_MAX) {
    repaired.push(`分组超过上限 ${GROUP_MAX}，多余的已被丢弃`)
    data.groups = data.groups.slice(0, GROUP_MAX)
  }
  return { data, repaired }
}

/**
 * 读取注解（**永不抛**）：缺文件 / 空文件 / 坏文件都降级成空结构，并把原因如实带出。
 * @param {string} [file] 显式路径（单测注入；生产不传 = annotationsPath()）
 * @returns {{ ok: boolean, exists: boolean, emptyFile: boolean, file: string,
 *             data: object, error: string|null, repaired: string[] }}
 */
function readAnnotations(file) {
  const target = typeof file === 'string' && file !== '' ? file : annotationsPath()
  const result = { ok: true, exists: false, emptyFile: false, file: target, data: emptyAnnotations(), error: null, repaired: [] }
  if (!existsSync(target)) return result
  result.exists = true
  let text = ''
  try {
    text = readFileSync(target, 'utf8')
  } catch (error) {
    return { ...result, ok: false, error: `读取注解文件失败：${messageOf(error)}` }
  }
  if (text.trim() === '') {
    // 空文件 = "还没有内容"：正常降级为空结构（写入时正常覆盖，但仍先备份）
    return { ...result, emptyFile: true }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ...result, ok: false, error: `注解文件不是合法 JSON（${messageOf(error)}）—— 已按空结构降级读取；写入会被拒绝，以免覆盖你的文件` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...result, ok: false, error: `注解文件的顶层不是对象（${Array.isArray(parsed) ? '数组' : typeof parsed}）—— 已按空结构降级读取；写入会被拒绝` }
  }
  const normalized = normalizeAnnotations(parsed)
  return { ...result, data: normalized.data, repaired: normalized.repaired }
}

/** 键解析：优先包名精确命中，其次 rowId（旧记录只带 rowId 时也能命中），最后按包名新建。 */
function resolvePluginKey(data, { packageName, rowId } = {}) {
  const name = typeof packageName === 'string' ? packageName.trim() : ''
  const rid = typeof rowId === 'string' ? rowId.trim() : ''
  if (name !== '' && Object.hasOwn(data.plugins, name)) return name
  if (rid !== '') {
    if (Object.hasOwn(data.plugins, rid)) return rid
    for (const [key, record] of Object.entries(data.plugins)) {
      if (record !== null && typeof record === 'object' && record.rowId === rid) return key
    }
  }
  if (name !== '') return name
  if (rid !== '') return rid
  return null
}

function findGroupIndex(data, id) {
  const wanted = typeof id === 'string' ? id.trim() : ''
  return data.groups.findIndex((group) => group.id === wanted)
}

/**
 * 记录里**用户可见的事实**（备注 / 徽章 / rowId）——比较"变了没有"和"读回是否如预期"都只认这三项。
 * 为什么不直接比整个对象（本轮实测踩到的坑）：
 *   · `updatedAt` 每次写都变 ⇒ 用它比会把"内容没变的重复提交"判成 changed（于是多写一次盘）；
 *   · JSON.stringify 还依赖**键序**；读回来的是规范化后的固定键序（note/badges/rowId/updatedAt），
 *     而写入时是"在原记录上追加" ⇒ 键序天然不同 ⇒ 读回核实会**误判成失败并回滚**
 *     （第一版实现就是这样：写徽章永远回滚，测试 ① 当场红）。
 * 判据落在"事实"上，这两个坑一起消失。
 */
function pluginFactsOf(record) {
  const src = record !== null && typeof record === 'object' ? record : {}
  return {
    note: typeof src.note === 'string' ? src.note : '',
    badges: Array.isArray(src.badges) ? src.badges : [],
    rowId: typeof src.rowId === 'string' ? src.rowId : '',
  }
}

function cloneData(data) {
  return { version: data.version ?? ANNOTATIONS_VERSION, updatedAt: data.updatedAt ?? 0, plugins: { ...data.plugins }, groups: data.groups.map((group) => ({ ...group, packages: [...group.packages] })) }
}

function groupPayload(input) {
  const raw = input?.group !== null && typeof input?.group === 'object' && !Array.isArray(input?.group) ? input.group : input
  const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
  const nameResult = sanitizeGroupName(raw?.name)
  if (id === '') return { ok: false, error: '缺少分组 id' }
  if (!nameResult.ok) return { ok: false, error: nameResult.error }
  const packages = []
  for (const pkg of Array.isArray(raw?.packages) ? raw.packages : []) {
    if (!isPackageName(pkg)) return { ok: false, error: `分组里的包名不合法：${String(pkg).slice(0, 40)}` }
    if (!packages.includes(pkg)) packages.push(pkg)
  }
  const group = { id, name: nameResult.value, packages, collapsed: raw?.collapsed === true }
  if (Number.isFinite(raw?.createdAt)) group.createdAt = raw.createdAt
  return { ok: true, group }
}

/**
 * 规划一次注解写入（**纯函数：不写盘、不读盘**）。所有动作都在这里校验，路由只做映射。
 *
 * action 一览：
 *   · note            { packageName|rowId, note }            note='' ⇒ 删除这条备注
 *   · badges          { packageName|rowId, badges }          badges=[] ⇒ 删除全部徽章
 *   · group-create    { name }                               → meta.group
 *   · group-rename    { id, name }
 *   · group-delete    { id }                                 → meta.deleted = { group, index }（供撤销）
 *   · group-restore   { group }                              用 meta.deleted.group 原样回填
 *   · group-assign    { id, packageName, member=true }       一个包**可以同时在多个分组里**（重叠允许；assign 只加入，不移出）
 *   · group-collapse  { id, collapsed }
 *
 * @param {object} data 规范化后的当前数据（readAnnotations().data）
 * @param {object} input 请求体
 * @returns {{ ok: boolean, status: number, error: string|null, changed: boolean,
 *             next: object|null, meta: object, verify: ((d: object) => boolean)|null }}
 */
function planAnnotationAction(data, input, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now()
  const base = { ok: false, status: 400, error: null, changed: false, next: null, meta: {}, verify: null }
  const action = typeof input?.action === 'string' ? input.action : ''
  const current = data !== null && typeof data === 'object' && data.plugins !== undefined && Array.isArray(data.groups) ? data : emptyAnnotations()
  const next = cloneData(current)

  if (action === 'note' || action === 'badges') {
    const key = resolvePluginKey(next, input)
    if (key === null) return { ...base, error: '缺少 packageName（或 rowId）' }
    if (!isPackageName(key)) return { ...base, error: `不是合法的包名：${String(key).slice(0, 40)}` }
    const record = next.plugins[key] !== undefined ? { ...next.plugins[key] } : {}
    const rowId = typeof input?.rowId === 'string' && input.rowId.trim() !== '' ? input.rowId.trim() : (record.rowId ?? null)
    let metaExtra = {}
    if (action === 'note') {
      const noteResult = sanitizeNote(input?.note)
      if (!noteResult.ok) return { ...base, error: noteResult.error }
      if (noteResult.value === '') delete record.note
      else record.note = noteResult.value
      metaExtra = { note: noteResult.value }
    } else {
      const badgesResult = sanitizeBadges(input?.badges)
      if (!badgesResult.ok) return { ...base, error: badgesResult.error }
      if (badgesResult.value.length === 0) delete record.badges
      else record.badges = badgesResult.value
      metaExtra = { badges: badgesResult.value }
    }
    const hasNote = typeof record.note === 'string' && record.note !== ''
    const hasBadges = Array.isArray(record.badges) && record.badges.length > 0
    if (!hasNote && !hasBadges) delete next.plugins[key]
    else next.plugins[key] = { ...record, ...(rowId === null ? {} : { rowId }), updatedAt: now }
    const expected = pluginFactsOf(next.plugins[key] ?? null)
    const changed = JSON.stringify(pluginFactsOf(current.plugins[key] ?? null)) !== JSON.stringify(expected)
    return {
      ...base,
      ok: true,
      status: 200,
      changed,
      next: changed ? next : current,
      meta: { key, ...metaExtra },
      // 读回只认**事实**（见 pluginFactsOf 注释：整对象比较会因键序/时间戳误判）
      verify: (read) => JSON.stringify(pluginFactsOf(read.plugins[key] ?? null)) === JSON.stringify(expected),
    }
  }

  if (action === 'group-create') {
    const nameResult = sanitizeGroupName(input?.name)
    if (!nameResult.ok) return { ...base, error: nameResult.error }
    if (next.groups.length >= GROUP_MAX) return { ...base, status: 409, error: `分组最多 ${GROUP_MAX} 个（当前 ${next.groups.length} 个）` }
    if (next.groups.some((group) => group.name === nameResult.value)) {
      return { ...base, status: 409, error: `已经有一个叫「${nameResult.value}」的分组了` }
    }
    const stamp = Number.isFinite(now) ? now : Date.now()
    const group = { id: `g${stamp.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, name: nameResult.value, packages: [], collapsed: false, createdAt: stamp }
    next.groups.push(group)
    return {
      ...base,
      ok: true,
      status: 200,
      changed: true,
      next,
      meta: { group },
      verify: (read) => read.groups.some((g) => g.id === group.id && g.name === group.name),
    }
  }

  if (action === 'group-rename') {
    const index = findGroupIndex(next, input?.id)
    if (index < 0) return { ...base, status: 404, error: `没有这个分组（id=${String(input?.id ?? '')}）` }
    const nameResult = sanitizeGroupName(input?.name)
    if (!nameResult.ok) return { ...base, error: nameResult.error }
    if (next.groups.some((group, i) => i !== index && group.name === nameResult.value)) {
      return { ...base, status: 409, error: `已经有一个叫「${nameResult.value}」的分组了` }
    }
    const before = next.groups[index].name
    next.groups[index] = { ...next.groups[index], name: nameResult.value }
    const changed = before !== nameResult.value
    const id = next.groups[index].id
    return {
      ...base,
      ok: true,
      status: 200,
      changed,
      next: changed ? next : current,
      meta: { id, from: before, to: nameResult.value },
      verify: (read) => read.groups.some((g) => g.id === id && g.name === nameResult.value),
    }
  }

  if (action === 'group-delete') {
    const index = findGroupIndex(next, input?.id)
    if (index < 0) return { ...base, status: 404, error: `没有这个分组（id=${String(input?.id ?? '')}）` }
    // ★ 只解除归属：插件记录（备注/徽章）一律不动，插件本身更不会被删。
    const [deleted] = next.groups.splice(index, 1)
    return {
      ...base,
      ok: true,
      status: 200,
      changed: true,
      next,
      meta: { deleted: { group: deleted, index } },
      verify: (read) => !read.groups.some((g) => g.id === deleted.id),
    }
  }

  if (action === 'group-restore') {
    const parsed = groupPayload(input)
    if (!parsed.ok) return { ...base, error: parsed.error }
    const group = parsed.group
    if (next.groups.some((g) => g.id === group.id)) return { ...base, status: 409, error: `分组 id 已存在：${group.id}` }
    if (next.groups.some((g) => g.name === group.name)) return { ...base, status: 409, error: `已经有一个叫「${group.name}」的分组了` }
    if (next.groups.length >= GROUP_MAX) return { ...base, status: 409, error: `分组最多 ${GROUP_MAX} 个` }
    const at = Number.isFinite(input?.index) ? Math.max(0, Math.min(next.groups.length, Math.floor(input.index))) : next.groups.length
    next.groups.splice(at, 0, group)
    // 一个包只能属于一个分组：回填时把同名包从别处移出
    const moved = []
    for (const other of next.groups) {
      if (other.id === group.id) continue
      for (const pkg of group.packages) {
        if (other.packages.includes(pkg)) {
          other.packages = other.packages.filter((x) => x !== pkg)
          moved.push({ packageName: pkg, from: other.id })
        }
      }
    }
    return {
      ...base,
      ok: true,
      status: 200,
      changed: true,
      next,
      meta: { group, index: at, moved },
      verify: (read) => read.groups.some((g) => g.id === group.id),
    }
  }

  if (action === 'group-assign') {
    const pkg = typeof input?.packageName === 'string' ? input.packageName.trim() : ''
    if (!isPackageName(pkg)) return { ...base, error: `不是合法的包名：${String(input?.packageName ?? '').slice(0, 40)}` }
    const member = input?.member !== false
    if (!member) {
      // 从分组移除（id 省略 = 从所有分组移除）。插件的备注/徽章不动。
      const id = typeof input?.id === 'string' && input.id !== '' ? input.id.trim() : null
      if (id !== null && findGroupIndex(next, id) < 0) return { ...base, status: 404, error: `没有这个分组（id=${id}）` }
      const removedFrom = []
      for (const group of next.groups) {
        if (id !== null && group.id !== id) continue
        if (!group.packages.includes(pkg)) continue
        group.packages = group.packages.filter((x) => x !== pkg)
        removedFrom.push(group.id)
      }
      return {
        ...base,
        ok: true,
        status: 200,
        changed: removedFrom.length > 0,
        next: removedFrom.length > 0 ? next : current,
        meta: { packageName: pkg, removedFrom },
        verify: (read) => read.groups.every((g) => !g.packages.includes(pkg)),
      }
    }
    const index = findGroupIndex(next, input?.id)
    if (index < 0) return { ...base, status: 404, error: `没有这个分组（id=${String(input?.id ?? '')}）` }
    // ★ 用户 2026-10-27：**分组允许重叠** —— 一个插件可以同时属于 A 和 B。
    //   旧实现会把它从别的分组里移出（"一个包最多一个分组"），现在只做**加入**（幂等），不再动其它分组。
    const already = next.groups[index].packages.includes(pkg)
    if (!already) next.groups[index].packages.push(pkg)
    const id = next.groups[index].id
    return {
      ...base,
      ok: true,
      status: 200,
      changed: !already,
      next: already ? current : next,
      meta: { packageName: pkg, id, movedFrom: [] },
      verify: (read) => read.groups.some((g) => g.id === id && g.packages.includes(pkg)),
    }
  }

  if (action === 'group-collapse') {
    const index = findGroupIndex(next, input?.id)
    if (index < 0) return { ...base, status: 404, error: `没有这个分组（id=${String(input?.id ?? '')}）` }
    const collapsed = input?.collapsed === true
    const changed = next.groups[index].collapsed !== collapsed
    next.groups[index] = { ...next.groups[index], collapsed }
    const id = next.groups[index].id
    return {
      ...base,
      ok: true,
      status: 200,
      changed,
      next: changed ? next : current,
      meta: { id, collapsed },
      verify: (read) => read.groups.some((g) => g.id === id && g.collapsed === collapsed),
    }
  }

  return { ...base, error: `不认识的 action：${action === '' ? '(空)' : action}（可用：note / badges / group-create / group-rename / group-delete / group-restore / group-assign / group-collapse）` }
}

/**
 * 执行一次注解写入：排队 → 备份 → 原子写 → **读回核实** → 失败回滚。
 * 绝不谎报成功；坏文件一律拒绝（409），绝不用空结构覆盖。
 *
 * @param {object} input 请求体（见 planAnnotationAction）
 * @param {{ file?: string, now?: () => number, deps?: object }} [options]
 */
async function applyAnnotation(input, options = {}) {
  const file = typeof options.file === 'string' && options.file !== '' ? options.file : annotationsPath()
  return queuedWrite(() => applyAnnotationSync(input, { ...options, file }))
}

/** 同步实现（`applyAnnotation` 在队列里调它；单测也可直接调，但仍应经 applyAnnotation 以覆盖并发语义）。 */
function applyAnnotationSync(input, options = {}) {
  const file = typeof options.file === 'string' && options.file !== '' ? options.file : annotationsPath()
  const now = typeof options.now === 'function' ? options.now : Date.now
  const deps = options.deps !== null && typeof options.deps === 'object' ? options.deps : {}
  const readFile = typeof deps.read === 'function' ? deps.read : readAnnotations
  const writeRaw = typeof deps.writeFileSync === 'function' ? deps.writeFileSync : writeFileSync
  const rename = typeof deps.renameSync === 'function' ? deps.renameSync : renameSync
  const copy = typeof deps.copyFileSync === 'function' ? deps.copyFileSync : copyFileSync
  const remove = typeof deps.rmSync === 'function' ? deps.rmSync : rmSync
  const read = readFile(file)
  if (read.ok !== true) {
    // 坏文件：降级读出了空结构，但**写**必须拒绝（否则就是拿空结构盖掉用户的文件）
    return { ok: false, status: 409, changed: false, error: read.error, file, data: read.data, meta: {}, backup: null }
  }
  const plan = planAnnotationAction(read.data, input, { now })
  if (plan.ok !== true) return { ok: false, status: plan.status ?? 400, changed: false, error: plan.error, file, data: read.data, meta: plan.meta ?? {}, backup: null }
  const payload = { ...plan.next, version: ANNOTATIONS_VERSION, updatedAt: now() }
  if (plan.changed !== true) {
    return { ok: true, status: 200, changed: false, error: null, file, data: read.data, meta: plan.meta ?? {}, backup: null }
  }
  const backup = `${file}.bak-${Date.now()}`
  const stamp = Date.now()
  const tmp = `${file}.tmp-${stamp}`
  let hadFile = false
  try {
    mkdirSync(dirname(file), { recursive: true })
    hadFile = existsSync(file)
    if (hadFile) copy(file, backup)
    writeRaw(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    rename(tmp, file)
  } catch (error) {
    // 写失败 ⇒ 清掉临时文件、把备份放回去（有的话），如实报错
    try { if (existsSync(tmp)) remove(tmp, { force: true }) } catch {}
    try { if (hadFile && existsSync(backup)) copy(backup, file) } catch {}
    return { ok: false, status: 500, changed: false, error: `写入注解文件失败：${messageOf(error)}`, file, data: read.data, meta: plan.meta ?? {}, backup: hadFile ? backup : null }
  }
  // ★ 读回核实：不是"文件改名成功"就算，要**读出预期事实**（"写了但没生效"是最坏的假绿）
  const verify = readFile(file)
  const verified = verify.ok === true && typeof plan.verify === 'function' ? plan.verify(verify.data) === true : false
  if (!verified) {
    try { if (hadFile && existsSync(backup)) copy(backup, file) } catch {}
    try { if (!hadFile && existsSync(file)) remove(file, { force: true }) } catch {}
    return { ok: false, status: 500, changed: false, error: '写入后读回核实失败（文件内容与预期不符），已回滚到写入前的状态', file, data: read.data, meta: plan.meta ?? {}, backup: hadFile ? backup : null }
  }
  return { ok: true, status: 200, changed: true, error: null, file, data: verify.data, meta: plan.meta ?? {}, backup: hadFile ? backup : null }
}

/** 面板用的摘要（不写盘）：给"备注插件"面板与卡片渲染提供一次算好的统计。 */
function annotationsSummary(data) {
  const src = data !== null && typeof data === 'object' ? data : emptyAnnotations()
  const plugins = src.plugins !== null && typeof src.plugins === 'object' ? src.plugins : {}
  const groups = Array.isArray(src.groups) ? src.groups : []
  let notes = 0
  let badges = 0
  for (const record of Object.values(plugins)) {
    if (record !== null && typeof record === 'object') {
      if (typeof record.note === 'string' && record.note !== '') notes += 1
      if (Array.isArray(record.badges)) badges += record.badges.length
    }
  }
  return { packages: Object.keys(plugins).length, notes, badges, groups: groups.length, members: groups.reduce((sum, g) => sum + (Array.isArray(g.packages) ? g.packages.length : 0), 0) }
}

export {
  ANNOTATIONS_FILE,
  ANNOTATIONS_VERSION,
  NOTE_MAX,
  BADGE_MAX_COUNT,
  BADGE_MAX_LEN,
  GROUP_NAME_MAX,
  GROUP_MAX,
  PACKAGE_NAME_RE,
  annotationsPath,
  emptyAnnotations,
  isPackageName,
  sanitizeBadges,
  sanitizeNote,
  sanitizeGroupName,
  normalizeAnnotations,
  readAnnotations,
  resolvePluginKey,
  planAnnotationAction,
  applyAnnotation,
  applyAnnotationSync,
  annotationsSummary,
}
