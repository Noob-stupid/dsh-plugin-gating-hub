// L1 · domain —— preset-install.js（预设**装配**：只补不覆盖 / 显式覆盖 / 校验 / 备份 / 读回核实）
//
// 为什么单开一个模块（0.5.26 改错 F2 + F3 + F4，独立对抗式复核抓到）：
//   · **F2**：`assemblePreset` 旧语义是"已存在同名预设 → 整目录备份 + 逐文件**合并覆盖**"。
//     真机一次装配改写了 3 个在用预设、**11 个文件**（router-standard 4 个，含 `agent.cordis.yml`）。
//     它有备份、有逐条报告（不静默），但**与上游 `install.ps1` 的语义相反** ——
//     上游是「预设已存在 → 请先手动删除」= **跳过**。默认写别人的文件就是错的方向。
//     新语义：**默认只补缺失文件，绝不覆盖已存在的同名文件**；覆盖必须由用户**显式**点
//     「覆盖该预设」（白名单动作 `overwrite-preset`）才发生，且改前整目录备份 + 写后读回核实。
//   · **F3**：装配前必须校验 `agent.cordis.yml` 可解析（见 preset-yaml.js）——
//     旧代码把非法 YAML 覆盖到原本可用的文件上（`overwritten=["agent.cordis.yml"]`），
//     下次新建会话挂载这个预设就报错。校验不通过 → **跳过该文件并如实报告，绝不写**。
//   · **F4**：同一毫秒的两次装配会生成**同一个**备份路径（`<name>.bak-<Date.now()>`），
//     第二次把第一次的备份覆盖掉 → 用户以为有两个回滚点，其实只剩一个。
//     新语义：备份路径加唯一后缀（`-2`、`-3`… 直到不冲突），两次装配的备份**各自完整**。
//
// 与 preset-source.js 的分工：那边负责"把源码取下来"（稀疏 clone / git 定位 / 网络），
// 这边只负责"往 `.agent-presets` 里写"（判据 / 校验 / 备份 / 核实）—— 写盘路径全项目只有这一处。
//
// 分层：L1 domain —— 不认识 cordis ctx；时间戳与 IO 可注入（便于离线断言）。

import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { dshHome } from '../infra/paths.js'
import { validateAgentConfig } from './preset-yaml.js'
import { declarePresetRow, presetDeclarationNote } from './preset-declare.js'

/** 预设的判别文件（框架发现预设看的就是这个：`<presetsRoot>/<name>/agent.cordis.yml`）。 */
const PRESET_MARKER_FILES = ['agent.cordis.yml', 'agent.cordis.yaml']
/** 预设清单（可选，面板文案用）。 */
const PRESET_MANIFEST_FILE = 'preset.yml'
/** 记录"每个已装配预设的源码出处"的文件（`overwrite-preset` 动作据此重新取源码）。
 *  为什么不放 `<presetsRoot>` 里：那里是**框架**读的目录，多一个非预设文件会污染预设列表。 */
const PRESET_SOURCE_RECORD_LIMIT = 80

function presetSourcesFile(home = undefined) {
  return join(home ?? dshHome(), 'plugin-console', 'preset-sources.json')
}

function sha256Of(text) {
  return createHash('sha256').update(typeof text === 'string' ? text : String(text ?? ''), 'utf8').digest('hex')
}

/** 目录树里的文件清单（相对路径 + 字节数）——只读，best-effort，绝不抛。 */
function listTreeFiles(root, { maxDepth = 8 } = {}) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const child = join(dir, e.name)
      try {
        if (e.isDirectory()) walk(child, depth + 1)
        else if (e.isFile()) out.push({ rel: relative(root, child).split(sep).join('/'), bytes: statSync(child).size })
      } catch {}
    }
  }
  walk(String(root), 0)
  return out
}

/** 备份路径：`<dest>.bak-<timeValue>`，已存在就自增后缀直到不冲突（**F4**）。
 *  旧实现直接 `${dest}.bak-${now()}` —— 同一毫秒的两次装配拿到同一个路径，
 *  第二次 `copyTree` 把第一次的备份**覆盖**掉：用户以为有两个回滚点，其实只剩一个。 */
function uniqueBackupPath(dest, timeValue) {
  const base = `${dest}.bak-${timeValue}`
  if (!existsSync(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!existsSync(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/** 读回核实（**写后必做**）：每个本该落盘的文件都真的在盘上、且字节与源一致。
 *  返回 { ok, checked, mismatched[] }；读不到/不一致都算不通过（绝不"写没写成"靠假设）。 */
function verifyWrittenFiles(dest, srcDir, rels) {
  const mismatched = []
  for (const rel of rels) {
    const target = join(dest, ...String(rel).split('/'))
    const source = join(srcDir, ...String(rel).split('/'))
    try {
      if (!existsSync(target)) { mismatched.push(`${rel}（写后不存在）`); continue }
      if (!readFileSync(target).equals(readFileSync(source))) mismatched.push(`${rel}（字节与源不一致）`)
    } catch (error) {
      mismatched.push(`${rel}（读回失败：${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return { ok: mismatched.length === 0, checked: rels.length, mismatched }
}

/**
 * 装配后要不要写**声明行**（框架 0.1.7-rc.x 的机制迁移，见 preset-declare.js 顶部）：
 *   0.1.5 及更早靠"扫 `$DSH_HOME/.agent-presets/` 目录"发现预设；rc.2 起目录发现被彻底移除，
 *   注册表只认 profile `cordis.patch.yml` 里的 `preset-<id>` 声明行。所以"只把文件铺上去"在
 *   新框架上等于**用户看不见这个预设**（桌面端「自定义」为空就是这么来的），老会话 resume 还会
 *   `RemoteError: Unknown agent preset`。
 *
 * 语义边界（默认**不动**用户补丁）：
 *   · 只在显式给了 `patchPath`/`profileDir` 时才写 —— 离线单测、无 profile 场景不凭空造文件；
 *   · 写前备份、写后读回核实（preset-declare.js 内部做全）；
 *   · 写不成 → **如实返回失败原因**，调用方据此生成文案，**绝不**再说"新建会话时选择"。
 * 返回声明结果对象，或 null（没给目标 profile / 调用方显式关闭）。**异步**：写盘走 fsx 的 queuedWrite
 * 串行队列（与补丁文件的其它写者互斥），所以调用方必须 await —— 忘了 await 会拿到一个 Promise，
 * `declaration.ok` 恒为 undefined，于是"明明写成了却报没写成"（自测真抓到过这个形状）。
 */
async function runPresetDeclaration(srcDir, name, { patchPath = null, profileDir = null, declare = null, now = Date.now } = {}) {
  if (typeof declare === 'function') {
    try { return await declare(srcDir, name) } catch (error) {
      return { ok: false, status: 'failed', reason: 'declare-threw', detail: error instanceof Error ? error.message : String(error), rowId: null, patchPath: null, backup: null, changed: false, verified: null, rewritten: [] }
    }
  }
  if (patchPath === null && profileDir === null) return null
  try {
    return await declarePresetRow(srcDir, name, { patchPath, profileDir, now })
  } catch (error) {
    return {
      ok: false, status: 'failed', reason: 'declare-threw', rowId: null, patchPath: patchPath ?? null, backup: null,
      changed: false, verified: null, rewritten: [],
      detail: `写声明行时异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 面板文案里"这个预设到底能不能被看见"的那一句（**按实际结果生成**，绝不无脑说"新建会话时选择"）。
 *  `null`（调用方没给目标 profile → 根本没尝试声明）也必须**明说**：文件已就位、但当前框架版本
 *  需要声明行才显示，并给出出路 —— 这正是旧文案"新建会话时选择"撒谎的那一格。 */
function declarationClause(declaration) {
  if (declaration === null || declaration === undefined) {
    return '；**文件已就位，但当前框架版本（0.1.7-rc.x 起预设改为声明行）需要声明行才能在界面上显示** —— '
      + '本次没有目标 profile 可写，请在目标 profile 的 cordis.patch.yml 里补 `preset-<预设 id>` 声明行'
  }
  if (declaration.ok === true) return `；${presetDeclarationNote(declaration)}`
  return `；⚠️ ${presetDeclarationNote(declaration)}`
}

/** 多个预设装配报告 → 一句话（**成功逐条点名、失败如实报因**，两类都在，绝不只报好消息）。
 *  为什么不是"有一个成功就整体乐观"：一次装配可能有 3 个预设，2 个声明成功、1 个写失败 ——
 *  用户必须知道**哪个**看不见，否则他会对着"已装配"这三个字找不到那一个预设。 */
function declarationClauseForReports(reports) {
  const list = (Array.isArray(reports) ? reports : []).filter((r) => r !== null && typeof r === 'object')
  const decls = list.map((r) => r.declaration).filter((d) => d !== null && d !== undefined)
  if (decls.length === 0) {
    return '；**文件已就位，但当前框架版本（0.1.7-rc.x 起预设改为声明行）需要声明行才能在界面上显示** —— '
      + '本次没有目标 profile 可写，请在目标 profile 的 cordis.patch.yml 里补 `preset-<预设 id>` 声明行'
  }
  const okDecls = decls.filter((d) => d.ok === true)
  const badDecls = decls.filter((d) => d.ok !== true)
  const parts = []
  if (okDecls.length > 0) {
    const rows = okDecls.map((d) => d.rowId).filter((r) => typeof r === 'string' && r !== '')
    const unchanged = okDecls.filter((d) => d.changed === false).length
    parts.push(`已声明为预设行 ${rows.join('、')}`
      + `${unchanged > 0 ? `（其中 ${unchanged} 个此前已声明、内容一致未改动）` : ''}`
      + `${typeof okDecls[0].patchPath === 'string' ? `（写入 ${okDecls[0].patchPath}）` : ''}；**重启实例后**在新会话可选`)
  }
  if (badDecls.length > 0) {
    parts.push(`${badDecls.length} 个预设**未写成声明行**（${badDecls.map((d) => d.detail ?? d.reason ?? '未知原因').join('；')}）`
      + '—— 文件已就位，但当前框架版本需要声明行才能显示')
  }
  return `；${parts.join('；')}`
}

/**
 * 装配一个预设到 `<presetsRoot>/<name>`（**唯一实现**）。
 *
 * 两种模式（`overwrite` 必须由**用户显式动作**打开，安装路径永不传 true）：
 *   · 默认（`overwrite !== true`）：**只补缺失文件**。已存在且内容不同的同名文件一律**不写**，
 *     逐个记进 `conflicts` 并在 note 里点名，提示"如需覆盖，请点「覆盖该预设」"。
 *     这个模式**不建备份**：一个字节都不改，建备份只会让用户以为目录被改过。
 *   · `overwrite: true`：先整目录备份（唯一路径）→ 再按文件合并（新增 + 覆盖同名）→ 写后读回核实。
 *
 * F3 校验（两种模式都做）：源里的 `agent.cordis.yml/.yaml` 必须通过结构校验；
 * 不通过 → **这个文件不写**，进 `skippedInvalid` 并如实报告（其它文件照常）。
 *
 * 返回 { ok, name, dest, backup, mode, added, skipped, overwritten, identical, conflicts,
 *        skippedInvalid, verified, verifiedConfig, hashes, bytes, files, declaration, note, error }。
 * `declaration` = 声明行结果（见 preset-declare.js）；**没给目标 profile 时为 null**（那时 note 会
 * 明说"文件已就位，但当前框架版本需要声明行才能显示"，绝不宣称"新建会话时选择"）。
 */
async function assemblePreset(srcDir, name, { presetsRoot = null, now = Date.now, overwrite = false, verify = true, patchPath = null, profileDir = null, declare = null } = {}) {
  const root = presetsRoot ?? join(dshHome(), '.agent-presets')
  const presetName = String(name ?? basename(srcDir)).trim()
  if (presetName === '' || presetName === '.' || /[\\/]/u.test(presetName)) {
    return { ok: false, name: presetName, dest: null, error: `预设目录名不合法：${JSON.stringify(name)}` }
  }
  const dest = join(root, presetName)
  const srcFiles = listTreeFiles(srcDir)
  if (srcFiles.length === 0) return { ok: false, name: presetName, dest, error: `源目录里没有任何文件：${srcDir}` }
  const bytes = srcFiles.reduce((sum, f) => sum + f.bytes, 0)
  const existed = existsSync(dest)

  // ── F3 校验（**写盘之前**）：预设的判别文件必须结构合法，否则绝不写 ──────────────────────
  const skippedInvalid = []
  const invalidConfig = []
  for (const file of srcFiles) {
    if (!PRESET_MARKER_FILES.includes(file.rel)) continue
    let text = null
    try { text = readFileSync(join(srcDir, ...file.rel.split('/')), 'utf8') } catch { text = null }
    if (text === null) { invalidConfig.push({ rel: file.rel, problems: ['读不到内容'] }); continue }
    const verdict = validateAgentConfig(text)
    if (verdict.ok !== true) invalidConfig.push({ rel: file.rel, problems: verdict.problems })
  }
  if (invalidConfig.length > 0) {
    for (const bad of invalidConfig) skippedInvalid.push({ rel: bad.rel, problems: bad.problems })
  }
  /** 预设的判别文件被拦下 = 这个预设**装不成**（框架发现预设看的就是它）→ 整个预设拒绝，
   *  不做半成品（只铺 preset.yml/脚本、没有配置）—— 那种目录会让用户以为装上了，实际挂载不了。
   *  这是**加法**：旧代码会把非法 YAML 直接覆盖上去，比"不装"更糟。 */
  const markerBlocked = skippedInvalid.length > 0
  if (markerBlocked) {
    return {
      ok: false, name: presetName, dest, existed, mode: overwrite === true ? 'overwrite' : 'add-only',
      error: `预设配置未通过结构校验，拒绝装配（绝不写坏现有预设）：${skippedInvalid.map((s) => `${s.rel}（${s.problems[0]}）`).join('；')}`,
      added: [], skipped: [], overwritten: [], identical: [], conflicts: [], skippedInvalid,
      verified: null, verifiedConfig: null, hashes: [], bytes, files: srcFiles.map((f) => f.rel),
      note: `预设 ${presetName} **未装配**：${skippedInvalid.length} 个预设配置文件未通过结构校验（${skippedInvalid.map((s) => s.rel).join('、')}），`
        + '已跳过未写入 —— 避免把原本可用的预设写坏；现有文件一个字节都没动',
    }
  }

  // ── 备份（**只在真要覆盖时**）：改前整目录复制；备份失败就不合并（绝不在没备份的情况下覆盖）──
  let backup = null
  if (existed && overwrite === true) {
    backup = uniqueBackupPath(dest, now())
    try {
      copyTreeStrict(dest, backup)
    } catch (error) {
      return {
        ok: false, name: presetName, dest, existed, mode: 'overwrite', backup: null,
        error: `已存在同名预设且备份失败（绝不在没备份的情况下覆盖）：${error instanceof Error ? error.message : String(error)}`,
        conflicts: srcFiles.map((f) => f.rel), added: [], skipped: [], overwritten: [], identical: [], skippedInvalid, verified: null, bytes,
      }
    }
  }

  mkdirSync(root, { recursive: true })
  const added = []
  const skipped = []
  const overwritten = []
  const identical = []
  const written = []
  for (const file of srcFiles) {
    const from = join(srcDir, ...file.rel.split('/'))
    const target = join(dest, ...file.rel.split('/'))
    const had = existsSync(target)
    if (had) {
      let same = false
      try { same = readFileSync(target).equals(readFileSync(from)) } catch { same = false }
      if (same) { identical.push(file.rel); continue }
      // ★ F2 的核心：默认**不覆盖**用户在用同名预设里的任何文件
      if (overwrite !== true) { skipped.push(file.rel); continue }
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readFileSync(from))
      written.push(file.rel)
    } catch (error) {
      return {
        ok: false, name: presetName, dest, existed, mode: overwrite === true ? 'overwrite' : 'add-only', backup,
        error: `合并 ${file.rel} 失败：${error instanceof Error ? error.message : String(error)}`,
        added, skipped, overwritten, identical, conflicts: skipped, skippedInvalid, verified: null, bytes,
      }
    }
    if (had) overwritten.push(file.rel)
    else added.push(file.rel)
  }

  // ── 写后读回核实（只在真的写了东西时）────────────────────────────────────────────────
  const verified = verify === true && written.length > 0 ? verifyWrittenFiles(dest, srcDir, written) : null
  const destConfigValid = PRESET_MARKER_FILES.some((f) => existsSync(join(dest, f)))
    ? PRESET_MARKER_FILES.map((f) => (existsSync(join(dest, f)) ? validateAgentConfig(readFileSync(join(dest, f), 'utf8')) : null)).find((v) => v !== null) ?? { ok: true }
    : { ok: false, problems: ['目标目录里没有 agent.cordis.yml/.yaml'] }
  const mode = overwrite === true ? 'overwrite' : 'add-only'

  // ── 声明行（**框架 0.1.7-rc.x 的机制迁移**的落点）──────────────────────────────────────
  // 判据：磁盘上的预设配置合法（`destConfigValid.ok`）才声明 —— 声明一个挂不起来的预设会让
  // 用户在新会话里选中它然后炸掉，比"不声明"更糟。写盘/备份/读回核实全在 preset-declare.js。
  const declaration = destConfigValid.ok === true
    ? await runPresetDeclaration(srcDir, presetName, { patchPath, profileDir, declare, now })
    : null

  const noteParts = []
  if (existed !== true) {
    noteParts.push(`预设 ${presetName} 已装配到 ${dest}（新增 ${added.length} 个文件）`)
  } else if (mode === 'overwrite') {
    // 逐条点名被覆盖的文件（旧实现有这句，改错时不能丢：用户要知道**具体哪几个文件**被动过）
    noteParts.push(`预设 ${presetName}：已按你的显式要求**覆盖**（原目录整份备份到 ${backup}；本次覆盖 ${overwritten.length} 个、新增 ${added.length} 个、内容一致 ${identical.length} 个）`
      + (overwritten.length > 0 ? `（被覆盖的：${overwritten.slice(0, 6).join('、')}${overwritten.length > 6 ? ' 等' : ''}）` : ''))
  } else {
    noteParts.push(`预设 ${presetName}：**默认只补缺失文件、不覆盖**（本次新增 ${added.length} 个）`)
    if (skipped.length > 0) {
      noteParts.push(`已存在同名预设，其中 ${skipped.length} 个同名文件内容与你手上的不同，**已原样保留未动**：${skipped.slice(0, 6).join('、')}`
        + `${skipped.length > 6 ? ' 等' : ''} —— 如需用仓库里的版本覆盖，请点「覆盖该预设」（会先把原目录整份备份）`)
    }
    if (identical.length > 0) noteParts.push(`另有 ${identical.length} 个文件与你手上的内容一致，未改动`)
  }
  // 「这个预设到底能不能被看见」必须**按实际结果**说（旧文案无条件说"新建会话时选择"，
  // 在 rc.2 上是一句谎话：没有声明行的预设根本不会出现在选择器里）
  const declNote = declarationClause(declaration)
  if (declNote !== '') noteParts.push(declNote.replace(/^；/u, ''))
  if (skippedInvalid.length > 0) {
    noteParts.push(`${skippedInvalid.length} 个预设配置文件**未通过结构校验、已跳过未写入**：`
      + skippedInvalid.map((s) => `${s.rel}（${s.problems[0]}）`).join('、'))
  }
  if (skipped.length > 0) {
    noteParts.push(`${skipped.length} 个同名文件因默认"只补不覆盖"而保留了你手上的版本`)
  }
  if (verified !== null && verified.ok !== true) {
    noteParts.push(`⚠️ 写后读回核实不通过：${verified.mismatched.join('、')}`)
  }
  const result = {
    ok: true,
    name: presetName,
    dest,
    backup,
    existed,
    mode,
    added,
    skipped,
    overwritten,
    identical,
    conflicts: skipped,
    skippedInvalid,
    verified,
    verifiedConfig: destConfigValid,
    declaration,
    hashes: written.map((rel) => ({ rel, sha256: sha256Of(readFileSync(join(dest, ...rel.split('/')))) })),
    bytes,
    files: srcFiles.map((f) => f.rel),
    note: noteParts.join('；'),
  }
  // ok 的判据：真写成的文件都通过了读回核实 + 落盘后的配置结构合法。
  // 两点必须说清，否则"改错"会变成"动不动报失败"：
  //   · 一个文件都没写（内容全一致）**不是失败** —— 那是幂等重装的正常结局（verified 为 null）；
  //   · 默认模式下"跳过同名冲突文件"**不是失败** —— 那正是"只补不覆盖"的设计目的，
  //     但要靠 note 里逐条点名 + `skipped` 字段让面板看得见（绝不静默）。
  const writtenOk = written.length === 0 || (verified !== null && verified.ok === true)
  result.ok = writtenOk && destConfigValid.ok === true
  if (!result.ok) {
    result.error = writtenOk !== true
      ? `写后读回核实不通过：${(verified?.mismatched ?? []).join('、')}`
      : `落盘后的预设配置未通过结构校验：${(destConfigValid.problems ?? []).join('；')}`
  }
  return result
}

/** 逐文件复制目录树（不用 fs.cpSync：见 infra/fsx.js#copyTree 的本环境 EIO 说明）。
 *  与 fsx.copyTree 的差别：这里**先清掉**同名的旧备份残留（绝不会发生，uniqueBackupPath 已保证），
 *  并在复制后清掉只读位，保证备份可删可读。 */
function copyTreeStrict(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) { copyTreeStrict(from, to); continue }
    if (!entry.isFile()) continue
    copyFileSync(from, to)
    try { chmodSync(to, 0o666) } catch {}
  }
  return dest
}

// ── 源码出处记录（`overwrite-preset` 动作据此重新取源码）──────────────────────────────

/** 读全部记录（读不到/坏文件 → 空对象，绝不抛）。 */
function readPresetSources(home = undefined) {
  try {
    const parsed = JSON.parse(readFileSync(presetSourcesFile(home), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 记下"这个预设是从哪个仓库的哪个子目录装配来的"（唯一写盘点，由装配路径调用）。
 *  只记**可重新定位源码**的最小信息：repo / candidateName / subdir / sparse。 */
function recordPresetSource(entries, { home = undefined, now = Date.now } = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e !== null && typeof e === 'object' && typeof e.name === 'string' && e.name !== '') : []
  if (list.length === 0) return { ok: false, written: 0 }
  const all = readPresetSources(home)
  const at = new Date(typeof now === 'function' ? now() : now).toISOString()
  for (const e of list) {
    all[e.name] = {
      repo: typeof e.repo === 'string' ? e.repo : null,
      candidateName: typeof e.candidateName === 'string' ? e.candidateName : null,
      subdir: typeof e.subdir === 'string' ? e.subdir : null,
      sparse: e.sparse === true,
      dest: typeof e.dest === 'string' ? e.dest : null,
      at,
    }
  }
  // 只保留最近 N 条（防无限增长）：对象键顺序 = 插入顺序，从最老的开始丢
  const names = Object.keys(all)
  for (const name of names.slice(0, Math.max(0, names.length - PRESET_SOURCE_RECORD_LIMIT))) delete all[name]
  try {
    mkdirSync(dirname(presetSourcesFile(home)), { recursive: true })
    writeFileSync(presetSourcesFile(home), JSON.stringify(all, null, 2), 'utf8')
    return { ok: true, written: list.length, file: presetSourcesFile(home) }
  } catch (error) {
    return { ok: false, written: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 取一个预设记下的源码出处（没有 → null）。 */
function presetSourceOf(name, home = undefined) {
  const all = readPresetSources(home)
  const hit = all[String(name ?? '').trim()]
  return hit !== null && typeof hit === 'object' ? hit : null
}

/** 面板的「覆盖该预设」显式动作（**结构化**，与 pin-dependency / allow-builds 同一套安全语义）：
 *  `command` 只供展示/复制；执行侧只认 `payload.action` 白名单类型，`presetName` 由服务端自己校验
 *  （必须真的是 `<DSH_HOME>/.agent-presets/<name>` 下已存在的目录，客户端说了不算）。 */
function suggestedOverwritePresetAction({ presetName, repo = null, reason = null } = {}) {
  const name = typeof presetName === 'string' ? presetName.trim() : ''
  return {
    kind: 'overwrite-preset',
    label: '覆盖该预设（先用仓库版本覆盖，自动整目录备份）',
    command: `dsh-plugin-console: overwrite-preset ${name}`,
    payload: { action: 'overwrite-preset', presetName: name, repo: typeof repo === 'string' && repo !== '' ? repo : null },
    reason,
  }
}

/** 面板视图里的**预设字段簇**（0.5.26 加法）：`installJobView` 只做一行展开。
 *  为什么放这里：`domain/install.js` 贴着 600 行架构硬顶（test-architecture-guard.mjs），
 *  而"预设这条通道要下发什么"本来就属于本模块 —— 字段与它的产出者放在一起，才不会漂移。 */
function presetJobView(job) {
  const j = job ?? {}
  return {
    presetNote: j.presetNote ?? null,
    presetInstalled: j.presetInstalled ?? null,
    presetSource: j.presetSource ?? null,
    // 默认只补不覆盖：出现同名冲突时下发的**显式**「覆盖该预设」动作（老客户端忽略该字段，向后兼容）
    suggestedAction: j.suggestedAction ?? null,
    presetOverwriteCandidates: j.presetOverwriteCandidates ?? null,
  }
}

export {
  PRESET_MARKER_FILES, PRESET_MANIFEST_FILE, PRESET_SOURCE_RECORD_LIMIT,
  assemblePreset, copyTreeStrict, declarationClause, declarationClauseForReports, listTreeFiles,
  presetJobView, presetSourceOf, presetSourcesFile, readPresetSources, recordPresetSource,
  runPresetDeclaration, sha256Of, suggestedOverwritePresetAction, uniqueBackupPath, verifyWrittenFiles,
}
