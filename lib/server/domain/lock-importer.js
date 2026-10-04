// L1 · domain —— lock-importer.js（pnpm-lock.yaml importer 条目的**定点写入** + **只读**校验；0.5.39 加法）
//
// 为什么存在（用户 2026-10-04 定案，两处真缺陷）：
//   ① `reconcileLockfile` 过去对 `link:` 漂移一律跑一次**完整** `pnpm add`（拉包、动 node_modules、
//      重写整份 lock）—— 而 lock 里 link 依赖的持久化**只需要 importer 里那两行**
//      （pnpm 对 link 依赖不写 packages/snapshots —— 本机 pnpm 11.21.0 实测）。所以非 registry 来源的
//      lock 持久化 = 本模块的定点写入（**唯一实现**；persist.js 走的 reconcile 通路就是这一条），
//      `pnpm add` **不再**充当持久化手段。
//   ② 写出后必须用 **只读** 的 pnpm 校验确认 lock 仍可解析：`install --lockfile-only --dry-run
//      --frozen-lockfile`（实测：成功与失败两种结局下 lock 都逐字节不变）；失败或无法确认 ⇒ 调用方
//      报「未持久化」+ 一键钉住，**绝不报成功**。
//
// ★ 现场事实（2026-10-04 实测，pnpm 11.21.0，本机 desktop profile 的副本）：
//   `pnpm install --lockfile-only`（**不加** `--dry-run`）会把**无关条目**的 peer 后缀剥掉 ——
//   实测把 `@deepseek-ai/dsh-experimental-schedule-bundle` / `dsh-schedule` 的
//   `(@deepseek-ai/dsh-brand@0.1.7-rc.2)` 去掉。⇒ 它**不是**"定点补一条"的无损工具，因此：
//     · 本模块的写入是**纯文本外科手术**（只动目标条目的那几行，其余字节逐字保留，见 planLockImporterEntry）；
//     · 校验只用 `--dry-run`（并且每次校验后核对 lock 字节，一旦发现被动过就**立即还原**并报未确认）。
//
// 分层：L1 domain —— 不认识 cordis ctx；IO 与 pnpm 执行都可注入（便于离线单测跑正控/负控）。
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { buildPnpmEnv, runPnpmWithFallback } from '../infra/exec.js'
import { queuedWrite } from '../infra/fsx.js'

/** importers 段里 pnpm 认的三个依赖分区（与 lockfile-health.js#DEP_SECTIONS 同一形状）。 */
const IMPORTER_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']

/**
 * 能由 importer 条目**完整**表达的来源（唯一白名单）：`link:`。
 * 为什么其余的不在这里（本机 pnpm 11.21.0 实测）：`file:` / `git+` / tarball URL 依赖除了 importer 那两行，
 * pnpm 还要写 `packages:` / `snapshots:` 里的**解析记录**（file: 目录 = `resolution: {directory: …}`，
 * file: tgz 与 URL = `integrity`），只留 importer 时 `pnpm install --lockfile-only` 会把 packages 段
 * 重新补出来 ⇒ 本地无法凭空确定，**绝不伪造**（也不退回 `pnpm add`；由调用方如实报未持久化 + 一键钉住）。
 */
const IMPORTER_ONLY_RE = /^link:/u

/** 该校验/写入用的 lock 文件名（唯一常量，别处不要再拼字面量）。 */
const LOCKFILE_NAME = 'pnpm-lock.yaml'

/** 只读校验的超时（`--dry-run --lockfile-only` 实测 0.5~1.5s；给足余量，失败即如实报）。 */
const VERIFY_TIMEOUT_MS = 60000

/** 该来源是否走「只写 lock importer 条目」的定点写入（唯一判据；调用方不许再各判一套）。 */
function canWriteImporterEntry(spec) {
  return typeof spec === 'string' && IMPORTER_ONLY_RE.test(spec.trim())
}

/**
 * lock 里 importer 键行的判据（**唯一真源**）：`name:` / `'name':` / `"name":` 三种形态都认。
 * 与 selfupdate.js#lockVersion 的键判据**逐字同一份**（真机证据：pnpm 对含 `/`、`@` 的包名加引号，
 * 对未加 scope 的裸名不加 —— 0.5.38 修过一次"裸键读不出来"，两处各写一份必然再次分叉）。
 */
function lockEntryKeyMatches(line, name) {
  const trimmed = String(line).trim()
  const bare = trimmed.replace(/^'|':?$/gu, '').replace(/'$/u, '')
  const bareKey = trimmed.replace(/'$/u, '').replace(/:$/u, '')
  const unquoted = trimmed.replace(/^"|":?$/gu, '').replace(/"$/u, '')
  return trimmed === `'${name}':` || trimmed === `"${name}":` || bare === name || bareKey === name || unquoted === name
}

/** YAML 明文标量安全吗（危险形态才加引号）。普通路径/URL/`link:…` 一律**明文** —— pnpm 自己就是
 *  这么写的（真机 lock 证据：`specifier: link:C:/Users/花火/.dsh/plugin-src/…` 未加引号；
 *  `@` 与 `:` 出现在**中间**是合法明文，只有出现在开头/结尾或后跟空格才是危险形态）。 */
function yamlScalar(value) {
  const text = String(value)
  const needsQuote = text === ''
    || /[\n\r\t]/u.test(text)
    || /^\s|\s$/u.test(text)
    || /:\s|:$/u.test(text)
    || /#/u.test(text)
    || /^[!&*?|>%@`"'[\]{},-]/u.test(text)
  return needsQuote ? `'${text.replace(/'/gu, "''")}'` : text
}

/**
 * `link:` 规格在 lock 里的 `version:` 形态（**pnpm 实际写出的形态**，真机 + 本机实测双重证据）：
 *   · 同盘 → 相对 profile 目录的路径（`link:../../plugin-src/x`）；
 *   · 跨盘（`path.relative` 只能给出绝对路径）→ 绝对路径（`link:D:/dsh-link/x`）；
 *   · 一律**正斜杠**（清单里的反斜杠目标也归一成正斜杠 —— 真机 desktop profile 的
 *     `link:D:\dsh-link\…` 在 lock 里就是 `link:D:/dsh-link/…`）。
 * 非 link: 规格返回 null（不在本模块的白名单里）。
 */
function lockVersionText(profileDir, spec) {
  if (!canWriteImporterEntry(spec)) return null
  const raw = spec.trim().slice('link:'.length).replace(/\\/gu, '/')
  if (raw === '') return null
  const abs = isAbsolute(raw) ? raw : resolve(String(profileDir), raw)
  let rel = ''
  try {
    rel = relative(String(profileDir), abs)
  } catch {
    rel = ''
  }
  const text = rel !== '' && !isAbsolute(rel) ? rel : abs
  return `link:${String(text).replace(/\\/gu, '/')}`
}

/**
 * 纯函数：把 lock 文本改成"该包在 importer 里有正确条目"的文本（**只动它自己那几行**）。
 * 返回 `{ ok, changed, text, reason }`；`changed:false` 表示磁盘上的形态已经就是目标形态（零写盘）。
 * 形态不认识的 lock（没有 importers 段 / 缩进不是 pnpm 的形状）→ `ok:false` + 原因，**绝不猜着改**。
 */
function planLockImporterEntry(lockText, { name, specifier, version, section = IMPORTER_SECTIONS[0] } = {}) {
  const text = typeof lockText === 'string' ? lockText : String(lockText ?? '')
  const eol = /\r\n/u.test(text) ? '\r\n' : '\n'
  const trailing = /\r?\n$/u.test(text)
  const lines = text.split(/\r?\n/u)
  if (trailing && lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const rebuild = (next) => next.join(eol) + (trailing ? eol : '')
  const fail = (reason) => ({ ok: false, changed: false, text, reason })

  const start = lines.findIndex((l) => /^importers:\s*$/u.test(l))
  if (start === -1) return fail('lock 里没有 importers 段（形态不认识），已跳过定点写入')
  // 根 importer（profile 是单项目工程 → 键是 `.`；找不到就退回第一个 importer）
  let importerAt = -1
  let importerEnd = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z]/u.test(lines[i])) {
      if (importerAt !== -1) importerEnd = i
      break
    }
    const key = /^\s{2}(\S.*?):\s*$/u.exec(lines[i])
    if (key !== null) {
      if (importerAt === -1) importerAt = i
      if (key[1] === '.') {
        importerAt = i
        // 该 importer 的结束位置：下一个缩进 ≤2 的非空行
        for (let k = i + 1; k < lines.length; k += 1) {
          if (lines[k].trim() !== '' && !/^\s{3,}/u.test(lines[k])) {
            importerEnd = k
            break
          }
        }
        break
      }
    }
  }
  if (importerAt === -1) return fail('lock 里读不到 importer 键（形态不认识），已跳过定点写入')

  const wanted = [yamlScalar(`specifier: ${specifier}`), yamlScalar(`version: ${version}`)]
  // 扫该 importer：既找该包现有条目（就地改），也记录目标分区的插入点
  let foundAt = -1
  let foundSection = null
  let foundBlockEnd = -1
  let target = IMPORTER_SECTIONS.includes(section) ? section : IMPORTER_SECTIONS[0]
  let currentSection = null
  let insertAt = -1
  for (let i = importerAt + 1; i < importerEnd; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const sec = /^\s{4}([A-Za-z]+):\s*$/u.exec(line)
    if (sec !== null) {
      currentSection = sec[1]
      if (currentSection === target) {
        // 目标分区的插入点：本分区最后一个条目之后（遇到缩进 ≤4 的非空行即本分区结束）
        let last = i
        for (let k = i + 1; k < importerEnd; k += 1) {
          if (lines[k].trim() !== '' && !/^\s{5,}/u.test(lines[k])) break
          last = k
        }
        insertAt = last + 1
      }
      continue
    }
    if (foundAt === -1 && /^\s{6}\S/u.test(line) && lockEntryKeyMatches(line, name)) {
      foundAt = i
      foundSection = currentSection
      // 该条目的块范围（键行 + 缩进更深的字段行）
      foundBlockEnd = i + 1
      for (let k = i + 1; k < importerEnd; k += 1) {
        if (lines[k].trim() !== '' && !/^\s{7,}/u.test(lines[k])) break
        foundBlockEnd = k + 1
      }
    }
  }

  if (foundAt !== -1) {
    // 就地改：只替换/补齐 specifier 与 version 两行，其它字段与所有无关行逐字保留
    const keyIndent = /^\s*/u.exec(lines[foundAt])[0]
    const fieldIndent = `${keyIndent}  `
    const block = lines.slice(foundAt + 1, foundBlockEnd)
    const next = [...block]
    let sawSpecifier = false
    let sawVersion = false
    for (let k = 0; k < next.length; k += 1) {
      const field = /^\s*(specifier|version):/u.exec(next[k])
      if (field === null) continue
      if (field[1] === 'specifier') {
        sawSpecifier = true
        next[k] = `${fieldIndent}specifier: ${yamlScalar(specifier)}`
      } else {
        sawVersion = true
        next[k] = `${fieldIndent}version: ${yamlScalar(version)}`
      }
    }
    if (!sawSpecifier) next.unshift(`${fieldIndent}specifier: ${yamlScalar(specifier)}`)
    if (!sawVersion) next.push(`${fieldIndent}version: ${yamlScalar(version)}`)
    if (next.join(eol) === block.join(eol)) {
      return { ok: true, changed: false, text, reason: null, section: foundSection ?? target, version, specifier }
    }
    return {
      ok: true,
      changed: true,
      text: rebuild([...lines.slice(0, foundAt + 1), ...next, ...lines.slice(foundBlockEnd)]),
      reason: null,
      section: foundSection ?? target,
      version,
      specifier,
    }
  }

  // 没有该条目 → 在目标分区末尾插入一条（分区不存在时先补分区头）
  const keyText = /[/@]/u.test(name) ? `'${name}':` : `${name}:`
  const block = [`      ${keyText}`, `        specifier: ${yamlScalar(specifier)}`, `        version: ${yamlScalar(version)}`]
  if (insertAt === -1) {
    // 分区不存在：插到该 importer 现有分区之后（没有分区就紧跟 importer 键行）
    let at = importerAt + 1
    for (let i = importerAt + 1; i < importerEnd; i += 1) {
      if (lines[i].trim() === '') continue
      at = i + 1
    }
    return {
      ok: true,
      changed: true,
      text: rebuild([...lines.slice(0, at), `    ${target}:`, ...block, ...lines.slice(at)]),
      reason: null,
      section: target,
      version,
      specifier,
    }
  }
  return {
    ok: true,
    changed: true,
    text: rebuild([...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)]),
    reason: null,
    section: target,
    version,
    specifier,
  }
}

/**
 * 写入（**唯一写入口**）：读 → 纯函数改造 → 写 → **读回核实**（既有规矩：写完必须读回，绝不凭返回值
 * 报成功）。走 fsx 的写队列（与清单/补丁写入同一把锁，避免并发读改写互相覆盖）。
 * 返回 `{ changed, unchanged, specifier, version, section, reason }`；任何一步不成 ⇒ `changed:false` + 原因。
 */
async function writeLockImporterEntry(profileDir, { name, spec, section = IMPORTER_SECTIONS[0], deps = {} } = {}) {
  const readText = typeof deps.readText === 'function' ? deps.readText : (p) => readFileSync(p, 'utf8')
  const writeText = typeof deps.writeText === 'function' ? deps.writeText : (p, text) => writeFileSync(p, text, 'utf8')
  const file = join(String(profileDir), LOCKFILE_NAME)
  const specifier = typeof spec === 'string' ? spec.trim() : ''
  const version = lockVersionText(profileDir, specifier)
  if (version === null) {
    return { changed: false, unchanged: false, specifier, version: null, section, reason: '该来源的 lock 记录不止 importer 一行，本地无法确定 ⇒ 未写入（不用 pnpm add 当持久化手段）' }
  }
  return queuedWrite(async () => {
    let text = null
    try {
      text = readText(file)
    } catch (error) {
      return { changed: false, unchanged: false, specifier, version, section, reason: `读不到 ${LOCKFILE_NAME}（${error instanceof Error ? error.message : String(error)}），未写入` }
    }
    const plan = planLockImporterEntry(text, { name, specifier, version, section })
    if (plan.ok !== true) return { changed: false, unchanged: false, specifier, version, section, reason: plan.reason }
    if (plan.changed !== true) return { changed: false, unchanged: true, specifier: plan.specifier, version: plan.version, section: plan.section, reason: null }
    try {
      writeText(file, plan.text)
    } catch (error) {
      return { changed: false, unchanged: false, specifier, version, section, reason: `写盘失败：${error instanceof Error ? error.message : String(error)}` }
    }
    let after = null
    try {
      after = readText(file)
    } catch (error) {
      return { changed: false, unchanged: false, specifier, version, section, reason: `写盘后读回失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (after !== plan.text) return { changed: false, unchanged: false, specifier, version, section, reason: '写盘后读回与预期不一致（未能核实），按未写入处理' }
    return { changed: true, unchanged: false, specifier: plan.specifier, version: plan.version, section: plan.section, reason: null }
  })
}

/**
 * 从 lock 自己的 `settings:` 段取出 pnpm 配置，供**只读**校验按 lock 的形态复算
 * （不镜像它时 pnpm 直接 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`：本机实测 `autoInstallPeers`）。
 * 只认单行标量；对象/数组等复杂设置一律不传（不猜）。
 */
function lockfileSettingsFlags(lockText) {
  const lines = String(lockText ?? '').split(/\r?\n/u)
  const start = lines.findIndex((l) => /^settings:\s*$/u.test(l))
  if (start === -1) return []
  const flags = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z]/u.test(lines[i])) break
    const m = /^\s{2}([A-Za-z][A-Za-z0-9]*):\s*(.+?)\s*$/u.exec(lines[i])
    if (m === null) continue
    const value = m[2].replace(/^'|'$/gu, '')
    if (!/^[A-Za-z0-9._-]+$/u.test(value)) continue
    flags.push(`--config.${m[1]}=${value}`)
  }
  return flags
}

/** 只读校验的 argv（**唯一产出点**，纯函数，便于单测断言"没有任何写盘开关"）。 */
function verifyArgsFor({ registry = null, settings = [], relaxReleaseAge = false } = {}) {
  const args = ['install', '--lockfile-only', '--dry-run', '--frozen-lockfile']
  if (typeof registry === 'string' && registry.trim() !== '') args.push('--registry', registry.trim())
  args.push(...settings)
  // ★ 供应链年龄闸（pnpm 的 minimumReleaseAge，默认 24h）会在**解析之前**卡住整份 lock：
  //   本机实测（刚发布的 @noob-stupid/dsh-plugin-console@0.5.37 在 24h 窗口内）不加它时任何
  //   `--lockfile-only` 调用都只报 ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION，看不出 lock 到底能不能解析。
  //   它与"lock 可解析"是两件事，所以**只读重试**时才放宽；`--dry-run` + `--lockfile-only` 下不装任何东西
  //   （实测 lock 逐字节不变）。**写盘路径永不出现这个开关**（修复 argv 由 lockfile-health#repairArgsFor
  //   唯一产出，那一处一个字没动）。
  if (relaxReleaseAge) args.push('--config.minimumReleaseAge=0')
  return args
}

/** 错误文本尾部（面板要能看到 pnpm 的原始输出，不允许只报"失败了"）。 */
function tailOf(error) {
  const message = String(error?.message ?? error ?? '')
  return message.split(/\r?\n/u).filter((l) => l.trim() !== '').slice(-3).join(' ⏎ ').slice(0, 400)
}

/**
 * **只读**校验：这条 lock 现在还能被 pnpm 解析吗（`install --lockfile-only --dry-run --frozen-lockfile`）。
 * 返回 `{ verified, via, reason, attempts, changed }`：
 *   · `verified:true`  —— pnpm 退出码 0，且 lock 字节**逐字节未变**；
 *   · `verified:false` —— pnpm 明确报错（lock 形态/配置有问题）；
 *   · `verified:null`  —— pnpm 根本跑不起来（执行方式不可用）⇒ "无法确认"，调用方按未持久化处理。
 * `changed:true` 表示校验过程**动过** lock（理论上不可能，`--dry-run` 的硬前提）——此时立即还原原字节
 * 并把结论降为未确认：宁可报"没确认"，也绝不留下被校验命令改过的 lock。
 */
async function verifyLockReadOnly({ profileDir, registry = null, run = runPnpmWithFallback, deps = {}, execOpts = {} } = {}) {
  const file = join(String(profileDir), LOCKFILE_NAME)
  let before = null
  try {
    before = readFileSync(file, 'utf8')
  } catch (error) {
    return { verified: false, via: null, changed: false, attempts: [], reason: `读不到 ${LOCKFILE_NAME}（${error instanceof Error ? error.message : String(error)}），无法校验` }
  }
  const settings = lockfileSettingsFlags(before)
  const attempts = []
  const once = async (relax) => {
    const args = verifyArgsFor({ registry, settings, relaxReleaseAge: relax })
    try {
      await run(args, { execOpts: { cwd: profileDir, timeout: VERIFY_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: buildPnpmEnv(registry), ...execOpts } })
      attempts.push({ args, ok: true, tail: null })
      return { ok: true, tail: null }
    } catch (error) {
      const tail = tailOf(error)
      attempts.push({ args, ok: false, tail })
      return { ok: false, tail, error }
    }
  }
  const guard = () => {
    // 校验必须是无损的：核对字节，被动过就还原（并如实标注 changed）
    let now = null
    try {
      now = readFileSync(file, 'utf8')
    } catch {
      return { changed: true, restored: false }
    }
    if (now === before) return { changed: false, restored: false }
    try {
      writeFileSync(file, before, 'utf8')
      return { changed: true, restored: true }
    } catch {
      return { changed: true, restored: false }
    }
  }
  let outcome = await once(false)
  if (outcome.ok !== true && /MINIMUM_RELEASE_AGE|minimumReleaseAge/iu.test(String(outcome.tail))) outcome = await once(true)
  const bytes = guard()
  const via = attempts.filter((a) => a.ok).length > 0 ? 'pnpm install --lockfile-only --dry-run --frozen-lockfile' : null
  if (bytes.changed) {
    return {
      verified: null,
      via,
      changed: true,
      restored: bytes.restored,
      attempts,
      reason: `只读校验**改动了** ${LOCKFILE_NAME}（违反只读前提）——已${bytes.restored ? '还原' : '尝试还原失败'}，按未确认处理`,
    }
  }
  if (outcome.ok === true) return { verified: true, via, changed: false, attempts, reason: null }
  const unavailable = /ENOENT|Cannot find module|已尝试：/u.test(String(outcome.tail)) && !/ERR_PNPM_/u.test(String(outcome.tail))
  return {
    verified: unavailable ? null : false,
    via,
    changed: false,
    attempts,
    reason: `${unavailable ? 'pnpm 执行方式不可用（无法确认）' : 'pnpm 只读校验未通过'}：${outcome.tail ?? '（无输出）'}`,
  }
}

export {
  IMPORTER_SECTIONS,
  IMPORTER_ONLY_RE,
  LOCKFILE_NAME,
  VERIFY_TIMEOUT_MS,
  canWriteImporterEntry,
  lockEntryKeyMatches,
  lockVersionText,
  lockfileSettingsFlags,
  planLockImporterEntry,
  verifyArgsFor,
  verifyLockReadOnly,
  writeLockImporterEntry,
}
