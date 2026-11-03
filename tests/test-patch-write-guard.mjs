// 0.5.99 加法（issue #27 的**派生缺口**，用户红线「不能修复过度损坏原有功能」）：
//
// 现场（已核实）：lib/server/domain/patch.js 里 7 处 `writeFile` 全是**裸写**、`mkdir` 调用数 = 0；
// 而补丁路径是从 loader 的 `cordis:include` 条目推导出来的 —— 推导指向一个还不存在的 profile 目录时，
// 写盘直接 ENOENT（被 catch 就是"面板说已启用、文件里一个字节都没有"的假成功）。
// 同时 `readPatchState` 把 ENOENT 一律吞成"空补丁" ⇒「路径推错了」与「文件真的是空的」在返回值上
// 完全一样 —— issue #27（补丁全写到废弃的 web profile、在用的 desktop 静默收不到）正是靠这条
// 配套才藏了三周。
//
// 本套钉死 6 段（全离线：私有临时目录，不碰真实 profile、不联网、不起子进程、不用真机绝对路径）：
//   ① **正控**：父目录不存在 ⇒ 写入**成功**、目录被建出来、内容逐字节正确（加校验不许把正常写盘弄坏）
//   ② 负控 A：父目录在真实文件系统上**建不出来**（祖先路径上是普通文件）⇒ 如实抛错，绝不谎报 changed:true
//   ③ 负控 B + 正控对照：注入 mkdir 抛 EPERM ⇒ `written:false` + `writeError` 带真因 + `healedAt:0`；
//      改注入「计数 + 转发真 mkdir」⇒ 照常 `written:true`，且**证明默认写盘实现真的先建父目录**；
//      注入自己的 `writeText` 时我们**不**插手（counter 为 0 —— 既有注入缝行为一字不改）
//   ④ 读：文件不存在但父目录在（**正常**：新 profile 第一次写补丁）⇒ 空补丁 + `parentMissing === false`
//   ⑤ 读：父目录也不存在（**路径推导错了**）⇒ 仍返回空补丁、**不抛错**（既有调用方行为不变）
//      + `parentMissing === true` + `missingReason === 'parent-missing'`；stat 报 EACCES 时不许谎报
//   ⑥ 读：正常文件 ⇒ 内容与解析结果一字不差，多出来的字段**只有** `parentMissing`（既有字段清单对照）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  appendInsert, disableEntry, enableEntry, healPatchSafety, readPatchState, removeDisableBlock, sanitizePatchText,
} from '../lib/server/domain/patch.js'

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-patch-guard-'))
const PATCH = 'cordis.patch.yml'

// ══ ① 正控：父目录不存在 ⇒ 写入成功、目录建出来、内容正确 ═════════════════════════
{
  const profile = join(SANDBOX, 'fresh-profile')               // ★ 这个目录**不存在**
  const patchPath = join(profile, PATCH)
  let r = null
  let error = null
  try { r = await appendInsert(patchPath, 'row-a', '@scope/pkg-a') } catch (e) { error = e }
  check('① 父目录不存在时 appendInsert 不抛错（过去裸写必 ENOENT）', error === null, String(error?.message ?? ''))
  check('① 回报 changed=true（真的写成功了，不是假成功）', r?.changed === true, JSON.stringify(r))
  check('① 父目录被真建出来了', existsSync(profile), profile)
  const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  // 期望值 = **改动前就有的**逐字节形态：空补丁经 sanitizePatchText 归一成 '\n'，
  // 于是新块前多一个空行（不是本次改动引入的；下面单独把这条既有语义也钉住）。
  check('① 内容逐字节正确（与既有 insert 块格式一致）',
    text === "\n- insert:\n    - id: row-a\n      name: '@scope/pkg-a'\n", JSON.stringify(text))
  check('① 既有归一语义未变：sanitizePatchText(\'\') 仍是 "\\n"（空补丁前导空行是改动前就有的）',
    sanitizePatchText('') === '\n', JSON.stringify(sanitizePatchText('')))
  // 其余写入点在"刚建出来的树"上照旧工作（既有路径零回归）
  const r2 = await disableEntry(patchPath, 'row-a')
  check('① disableEntry 同样写成功且块格式不变',
    r2.changed === true && readFileSync(patchPath, 'utf8').includes('- id: row-a\n  disabled: true'),
    JSON.stringify(readFileSync(patchPath, 'utf8')))
  const r3 = await enableEntry(patchPath, 'row-a')
  check('① enableEntry 在既有文件上照旧工作（覆盖块被移除）',
    r3.changed === true && !readFileSync(patchPath, 'utf8').includes('disabled: true'), JSON.stringify(r3))
  writeFileSync(patchPath, '- id: row-a\n  disabled: true\n', 'utf8')
  await removeDisableBlock(patchPath, 'row-a')
  check('① removeDisableBlock 照旧生效', !readFileSync(patchPath, 'utf8').includes('disabled: true'))
}
{
  // 另一个正控：全新目录 + 第一次就是 disableEntry（父目录、文件都不存在）
  const patchPath = join(SANDBOX, 'fresh-disable', PATCH)
  const r = await disableEntry(patchPath, 'ghost')
  check('① 全新目录第一次 disableEntry：写成功、目录建出来、内容正确',
    r.changed === true && existsSync(dirname(patchPath))
    && readFileSync(patchPath, 'utf8').includes('- id: ghost\n  disabled: true'),
    JSON.stringify(r))
}

// ══ ② 负控 A：真实文件系统上父目录**建不出来** ⇒ 如实抛错（不谎报成功）═════════════
{
  const blocker = join(SANDBOX, 'blocker-file')
  writeFileSync(blocker, 'not a directory', 'utf8')
  const patchPath = join(blocker, 'profiles', 'x', PATCH)   // 祖先路径上是普通文件 ⇒ mkdir 必失败
  let error = null
  let value = null
  try { value = await disableEntry(patchPath, 'row-b') } catch (e) { error = e }
  check('② 父目录建不出来时 disableEntry **抛错**（绝不返回 changed:true）',
    error !== null && value === null, `error=${String(error?.message ?? error)} value=${JSON.stringify(value)}`)
  check('② 抛的是真实错误（带 code，不是被吞掉后的空异常）',
    typeof error?.code === 'string' && error.code !== '', String(error?.code))
  check('② 磁盘上没有任何半成品文件', !existsSync(patchPath), patchPath)
}

// ══ ③ 负控 B + 正控对照：默认写盘实现确实"先建父目录"，失败不谎报 ══════════════════
{
  const profile = join(SANDBOX, 'heal-profile')
  const patchPath = join(profile, PATCH)
  mkdirSync(profile, { recursive: true })
  writeFileSync(patchPath, '- id: webserver\n  disabled: true\n', 'utf8')
  const before = readFileSync(patchPath, 'utf8')

  let mkdirCalls = 0
  const r = await healPatchSafety(patchPath, {
    mkdir: async () => {
      mkdirCalls += 1
      const e = new Error('EPERM: operation not permitted, mkdir')
      e.code = 'EPERM'
      throw e
    },
  })
  check('③ mkdir 失败 ⇒ written=false（不谎报"已修复"）', r.written === false, JSON.stringify({ written: r.written }))
  check('③ writeError 如实带真因（EPERM）', /EPERM/u.test(String(r.writeError)), String(r.writeError))
  check('③ healedAt=0（没写成就不许说已修复）', r.healedAt === 0, String(r.healedAt))
  check('③ 判定出的待修内容仍如实上报（信息不丢）', r.healed.includes('webserver'), JSON.stringify(r.healed))
  check('③ 文件逐字节未变', readFileSync(patchPath, 'utf8') === before)
  check('③ **默认 writeText 实现真的调用了 mkdir**（这正是 EPERM 能生效的原因）', mkdirCalls >= 1, String(mkdirCalls))

  // 正控对照：计数 + 转发真实 mkdir ⇒ 同一份内容照常写成
  let forwardingCalls = 0
  const r2 = await healPatchSafety(patchPath, {
    mkdir: async (p, opts) => { forwardingCalls += 1; return mkdirSync(p, opts) },
  })
  check('③′ 正控：mkdir 正常时同一份内容照常写成功（written=true / writeError=null）',
    r2.written === true && r2.writeError === null && r2.healed.includes('webserver'),
    JSON.stringify({ written: r2.written, writeError: r2.writeError, healed: r2.healed }))
  check('③′ 正控：前一次失败、这一次成功 —— 失败没有留下坏影响（目录/文件仍可用）',
    forwardingCalls >= 1 && !readFileSync(patchPath, 'utf8').includes('disabled: true'),
    JSON.stringify(readFileSync(patchPath, 'utf8')))

  // 既有注入缝行为不变：调用方自己给 writeText 时，我们**不**再插手父目录（counter 保持 0）
  writeFileSync(patchPath, '- id: webserver\n  disabled: true\n', 'utf8')
  let touched = 0
  const wrote = []
  const r3 = await healPatchSafety(patchPath, {
    mkdir: async () => { touched += 1 },
    writeText: async (p, data) => { wrote.push(data); writeFileSync(p, data, 'utf8') },
  })
  check('③″ 既有注入缝零回归：给了 writeText 就不插手（mkdir 计数 0），注入的 writer 拿到同一份内容',
    touched === 0 && wrote.length === 1 && wrote[0] === readFileSync(patchPath, 'utf8')
    && r3.written === true && r3.writeError === null,
    JSON.stringify({ touched, wroteCount: wrote.length, written: r3.written, writeError: r3.writeError }))
}

// ══ ④ 读：文件不存在但父目录在 ⇒ 空补丁 + parentMissing=false（**行为与改动前一致**）══
{
  const profile = join(SANDBOX, 'read-parent-ok')
  mkdirSync(profile, { recursive: true })
  const patchPath = join(profile, PATCH)
  let state = null
  let error = null
  try { state = await readPatchState(patchPath) } catch (e) { error = e }
  check('④ 文件不存在但父目录在 ⇒ 不抛错', error === null, String(error?.message ?? ''))
  check('④ 仍返回"空补丁"（三份清单全空、text 为空串 —— 既有语义不变）',
    state?.text === ''
    && Array.isArray(state?.disables) && state.disables.length === 0
    && Array.isArray(state?.forced) && state.forced.length === 0
    && Array.isArray(state?.inserts) && state.inserts.length === 0,
    JSON.stringify(state))
  check('④ parentMissing === false（父目录在 ⇒ 这是"文件还没建"，不是路径错）', state?.parentMissing === false, String(state?.parentMissing))
  check('④ 正常环境下没有 missingReason 字段', state !== null && !('missingReason' in state), JSON.stringify(Object.keys(state ?? {})))
}

// ══ ⑤ 读：父目录也不存在 ⇒ 空补丁 + parentMissing=true（**不抛错**）═══════════════
{
  const patchPath = join(SANDBOX, 'read-parent-gone', 'deep', 'nested', PATCH)   // 整条路径都不存在
  let state = null
  let error = null
  try { state = await readPatchState(patchPath) } catch (e) { error = e }
  check('⑤ 父目录也不存在时**不抛错**（既有调用方行为一个字都不改）', error === null, String(error?.message ?? ''))
  check('⑤ 仍是空补丁（三份清单全空、text 空串）',
    state?.text === '' && state?.disables.length === 0 && state?.forced.length === 0 && state?.inserts.length === 0,
    JSON.stringify(state))
  check('⑤ parentMissing === true（让上层看得见"这是路径推导错了，不是文件真的空"）', state?.parentMissing === true, String(state?.parentMissing))
  check('⑤ missingReason === \'parent-missing\'', state?.missingReason === 'parent-missing', String(state?.missingReason))
  // 负控：判据保守 —— stat 报 EACCES（"读不到但不一定没有"）时**不许**谎报父目录缺失
  const state2 = await readPatchState(patchPath, {
    stat: async () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e },
  })
  check('⑤ 负控：stat 报 EACCES（不确定）时 parentMissing=false —— 不谎报路径错',
    state2.parentMissing === false && !('missingReason' in state2), JSON.stringify({ parentMissing: state2.parentMissing }))
}

// ══ ⑥ 读：正常文件 ⇒ 内容不变，多出来的字段**只有** parentMissing ═════════════════
{
  const profile = join(SANDBOX, 'read-normal')
  mkdirSync(profile, { recursive: true })
  const patchPath = join(profile, PATCH)
  const fixture = [
    '# 用户补丁',
    '- insert:',
    '    - id: row-installed',
    "      name: '@scope/plugin'",
    '- id: row-off',
    '  disabled: true',
    '- id: row-on',
    '  disabled: false',
    '',
  ].join('\n')
  writeFileSync(patchPath, fixture, 'utf8')
  const state = await readPatchState(patchPath)
  // 既有字段清单（改动前的契约）：6 个既有调用方 destructure 的正是这些 ——
  //   routes/state.js#disables · routes/plugins.js#disables · routes/revoke.js#forced ·
  //   domain/install-job.js#inserts/text · domain/revoke.js#text ·
  //   domain/compat-pending-records.js#liveRowIdsFromPatch(disables/forced/inserts)
  const LEGACY_FIELDS = ['disables', 'forced', 'inserts', 'text']
  const extra = Object.keys(state).filter((k) => !LEGACY_FIELDS.includes(k))
  check('⑥ 既有 4 个字段一个不少', LEGACY_FIELDS.every((k) => k in state), JSON.stringify(Object.keys(state)))
  check('⑥ 多出来的字段**只有一个**（parentMissing）', extra.length === 1 && extra[0] === 'parentMissing', JSON.stringify(extra))
  check('⑥ text 逐字节等于文件内容（读取语义没变）', state.text === fixture)
  check('⑥ 解析结果未变：inserts/disabled/forced 三份清单与旧语义一致',
    JSON.stringify(state.inserts) === JSON.stringify(['row-installed'])
    && JSON.stringify(state.disables) === JSON.stringify(['row-off'])
    && JSON.stringify(state.forced) === JSON.stringify(['row-on']),
    JSON.stringify({ inserts: state.inserts, disables: state.disables, forced: state.forced }))
  check('⑥ 正常文件 ⇒ parentMissing=false 且无 missingReason',
    state.parentMissing === false && !('missingReason' in state))
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
