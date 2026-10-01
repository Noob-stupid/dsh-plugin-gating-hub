// 0.5.33 改错 ①-3：i18n 键重复 → 「挂载失败」被印成「操作失败」
//
// 现症：client.js 的中英两本字典里都写了**两次** `failed:` ——
//   zh: `failed: "挂载失败"`（阶段名）之后又有 `failed: "操作失败"`（动作失败）
//   en: `failed: "Mount failed"` 之后又有 `failed: "Operation failed"`
// 同一个对象字面量里后写的那条**静默覆盖**前一条 ⇒ 插件行挂载失败的阶段标签
// （`phaseLabel` → `PHASE_KEYS.failed` → `t("failed")`）被印成「操作失败」，
// 而全站 47 处"动作失败"又都在用同一个键 —— 两件事挤在一个键上。
//
// 分工（本次定案）：**阶段名**用 `failed`（"挂载失败" / "Mount failed"）；
// **动作失败**用既有的 `safetySwitchFailed`（"操作失败" / "Action failed"）。
//
// 本套钉死（全离线，纯静态 + 自校验）：
//   ① 两本字典**各自** 0 重复键（正是这一类缺陷；检测器本身用构造样本自校验）
//   ② `failed` 每本恰好 1 条，且值就是阶段义（挂载失败 / Mount failed）
//   ③ 源码里不再有 `t("failed")`（否则动作失败会印成"挂载失败"），且真的都走 `safetySwitchFailed`
//   ④ `PHASE_KEYS.failed` 仍指向 `failed`（阶段标签的解析链不许断）
//   ⑤ 英文键不许有中文缺失的（避免"只修一边"）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

/** 取 `const <name> = {` 起花括号配对的行区间 + 该字典的 3 缩进顶层键（i18n 字典的形状）。 */
function dictOf(source, name) {
  const lines = source.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp(`^\\s*const ${name} = \\{$`, 'u').test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  let depth = 0
  let end = -1
  for (let i = start; i < lines.length && end < 0; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break } }
    }
  }
  if (end < 0) return null
  const keys = []
  for (let i = start + 1; i < end; i += 1) {
    const m = lines[i].match(/^\t{3}([A-Za-z_$][\w$]*):\s/u)
    if (m) keys.push({ key: m[1], line: i + 1, text: lines[i] })
  }
  return { keys, from: start + 1, to: end + 1 }
}
const duplicatesOf = (entries) => {
  const seen = new Set()
  const dups = []
  for (const { key, line } of entries) {
    if (seen.has(key)) dups.push(`${key}@${line}`)
    seen.add(key)
  }
  return dups
}
const valueOf = (dict, key) => {
  const hit = dict.keys.find((k) => k.key === key)
  if (hit === undefined) return null
  const m = hit.text.match(/:\s*"((?:[^"\\]|\\.)*)"/u)
  return m === null ? null : m[1]
}

const zh = dictOf(SRC, 'zh')
const en = dictOf(SRC, 'en')
check('能定位到中英两本 i18n 字典（const zh / const en）', zh !== null && en !== null,
  `zh=${zh === null ? '未找到' : `${zh.from}..${zh.to}`} en=${en === null ? '未找到' : `${en.from}..${en.to}`}`)

console.log('\n=== ① 字典内 0 重复键（本类缺陷的通用防线）===')
{
  check(`① 中文词典 0 重复键（${zh?.keys.length ?? 0} 键）`, duplicatesOf(zh.keys).length === 0, duplicatesOf(zh.keys).slice(0, 5).join(', ') || undefined)
  check(`① 英文词典 0 重复键（${en?.keys.length ?? 0} 键）`, duplicatesOf(en.keys).length === 0, duplicatesOf(en.keys).slice(0, 5).join(', ') || undefined)
  // 自校验：检测器必须能抓到构造出来的重复键（否则上面两条就是假绿）
  const sample = ['const zh = {', '\t\t\tfailed: "挂载失败",', '\t\t\tfailed: "操作失败",', '\t\t};'].join('\n')
  const sampleDict = dictOf(sample, 'zh')
  check('① 检测器本身有效（能抓到构造的重复键，含 0.5.32 的真实现场）',
    sampleDict !== null && duplicatesOf(sampleDict.keys).length === 1, JSON.stringify(duplicatesOf(sampleDict?.keys ?? [])))
}

console.log('\n=== ② failed 键：每本恰好 1 条，值是阶段义 ===')
{
  check('② failed 在中文词典恰好 1 条', zh.keys.filter((k) => k.key === 'failed').length === 1)
  check('② failed 在英文词典恰好 1 条', en.keys.filter((k) => k.key === 'failed').length === 1)
  check('② 中文 failed = 挂载失败（阶段名）', valueOf(zh, 'failed') === '挂载失败', String(valueOf(zh, 'failed')))
  check('② 英文 failed = Mount failed（阶段名）', valueOf(en, 'failed') === 'Mount failed', String(valueOf(en, 'failed')))
}

console.log('\n=== ③ 动作失败改走 safetySwitchFailed（分工明确）===')
{
  const actionKeyUses = (SRC.match(/t\("failed"\)/gu) ?? []).length
  const routed = (SRC.match(/t\("safetySwitchFailed"\)/gu) ?? []).length
  check('③ 源码里 0 处 t("failed")（否则动作失败会印成"挂载失败"）', actionKeyUses === 0, `count=${actionKeyUses}`)
  check('③ 动作失败真的都走 t("safetySwitchFailed")（≥40 处）', routed >= 40, `count=${routed}`)
  check('③ safetySwitchFailed 仍是动作义（中文=操作失败）', valueOf(zh, 'safetySwitchFailed') === '操作失败', String(valueOf(zh, 'safetySwitchFailed')))
  check('③ safetySwitchFailed 仍是动作义（英文=Action failed）', valueOf(en, 'safetySwitchFailed') === 'Action failed', String(valueOf(en, 'safetySwitchFailed')))
}

console.log('\n=== ④ 阶段标签的解析链没断 ===')
{
  check('④ PHASE_KEYS 仍把 failed 阶段映射到 failed 键', /failed:\s*"failed"/u.test(SRC))
  check('④ 阶段标签仍经 phaseLabel → t(PHASE_KEYS[phase])', /function phaseLabel\(phase, t\)/u.test(SRC) && /t\(PHASE_KEYS\[phase\]\)/u.test(SRC))
  check('④ 未挂载阶段的既有键没被动过（unobserved 仍在）', valueOf(zh, 'unobserved') !== null && valueOf(en, 'unobserved') !== null)
}

console.log('\n=== ⑤ 不许"只修一边"：英文键都得有中文 ===')
{
  const zhKeys = new Set(zh.keys.map((k) => k.key))
  const enOnly = en.keys.map((k) => k.key).filter((k) => !zhKeys.has(k))
  check('⑤ 英文词典里没有中文缺失的键（en ⊆ zh）', enOnly.length === 0, enOnly.slice(0, 8).join(', ') || undefined)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
