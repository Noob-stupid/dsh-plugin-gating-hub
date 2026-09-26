// ② 删不掉时 rename 降级成 `.trash-<ts>` + 后台清理（2026-09-26 本次加法）
//
// 背景：`removeDirVerifiedWithRetry`（infra/fsx.js，3×250ms + `rmdir` 兜底）仍失败时，旧代码只能报错，
// 并把「可手动删除后重试：Remove-Item …」/「当前环境可能禁止删除，请手动删除」甩给用户。
// 现在新增 `disposeDir(dir)`：先删 → 仍失败就**同父目录 rename 成 `.trash-<时间戳>-<随机>`**
// （只改目录项、不动内容，所以"目录里有进程正在用的文件"这类占用通常挡不住它；做法借自
// 2BingLing/dsh-market 的 `isLockFailure` + `.bak-<ts>` renameSync），并把 `.trash-*` 交给后台清理。
//
// 本测试分两段：
//   Ⅰ. **注入桩**（离线、确定性）：删除永远失败 → 必须走 rename 且返回 trashed；rename 也失败 →
//      返回明确失败原因，且文案里**不出现「请手动删除」/「Remove-Item」**；后台清理能清掉旧 `.trash-*`、
//      有上限、任何异常都吞掉不抛。
//   Ⅱ. **真机**（真进程占用）：用真进程占住目录（Windows=目录内有正在运行的 exe；POSIX=目录是活进程的
//      cwd）→ 真删不掉 → disposeDir 走 rename 成功、不阻塞、`.trash-*` 真存在 → 占用进程退出后
//      后台清理真的把它删掉。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupTrashDirs, disposeDir, disposeNote, findTrashDirs, isLockFailure, startTrashCleanup, trashPathFor, trashScanRoots, removeDirVerifiedWithRetry, TRASH_RE } from '../lib/server/infra/fsx.js'
import { killProcessTree, processAlive } from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const IS_WIN = process.platform === 'win32'
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-trash-'))
const mkTree = (name, files = ['a.txt']) => {
  const dir = join(ROOT, name)
  mkdirSync(join(dir, 'sub'), { recursive: true })
  for (const f of files) writeFileSync(join(dir, f), 'x', 'utf8')
  writeFileSync(join(dir, 'sub', 'b.txt'), 'x', 'utf8')
  return dir
}
const alwaysFail = () => ({ ok: false, attempts: 2, rounds: 3, error: 'EBUSY: resource busy or locked, rmdir' })
let holder = null

try {
  // ── Ⅰ-① 占用判据（照 dsh-market 的用例对齐）────────────────────────────────
  check('isLockFailure：占用/权限类失败全部命中（EPERM/EACCES/EBUSY/Access is denied/…）',
    isLockFailure('EPERM: operation not permitted, unlink') && isLockFailure('EBUSY: resource busy or locked')
    && isLockFailure('Access is denied') && isLockFailure('The process cannot access the file because it is being used by another process'),
    'EPERM/EBUSY/Access is denied/in use by another')
  check('isLockFailure：网络类/无关错误不误判（否则会把可重试失败当占用）',
    !isLockFailure('426 Insecure Underlying Transport') && !isLockFailure('ETIMEDOUT') && !isLockFailure(''))

  // ── Ⅰ-② 删除永远失败 → 必须走 rename 并如实返回 trashed ─────────────────────
  {
    const dir = mkTree('unit-trashed')
    const result = disposeDir(dir, { remover: alwaysFail, now: () => 1758888888888, random: () => 0.5 })
    check('★ 删除永远失败 → 走 rename 降级，返回 status=trashed / ok=true',
      result.status === 'trashed' && result.trashed === true && result.ok === true && result.removed === false,
      JSON.stringify(result))
    check('★ 降级目录与目标**同父目录**、名字符合 .trash-<时间戳>-<随机>（同卷 rename 才可能成功）',
      result.trashPath !== null && existsSync(result.trashPath) && !existsSync(dir)
      && TRASH_RE.test(result.trashPath.split(/[\\/]/u).pop()) && result.trashPath.startsWith(ROOT),
      `${result.trashPath} 存在=${existsSync(result.trashPath)} 原路径还在=${existsSync(dir)}`)
    check('降级后内容原封不动（rename 只改目录项，不动内容）',
      existsSync(join(result.trashPath, 'sub', 'b.txt')) && readdirSync(result.trashPath).includes('a.txt'))
    check('reason / lockFailure 如实带上（占用类判据命中）',
      typeof result.reason === 'string' && result.reason.includes('EBUSY') && result.lockFailure === true, String(result.reason))
    check('★ 前端短句：说清"正被占用 + 已改名降级为 .trash-* + 稍后自动清理"，不含「请手动删除」',
      /目录正被占用/u.test(disposeNote(result)) && /已改名降级为/u.test(disposeNote(result))
      && /\.trash-\*/u.test(disposeNote(result)) && /稍后自动清理/u.test(disposeNote(result))
      && !/请手动删除|Remove-Item|手动删除/u.test(disposeNote(result)), disposeNote(result))
  }

  // ── Ⅰ-③ rename 也失败 → 明确失败原因（仍不出现"请手动删除"）───────────────
  {
    const dir = mkTree('unit-failed')
    const result = disposeDir(dir, { remover: alwaysFail, rename: () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }) } })
    check('★ rename 也失败 → status=failed / ok=false，并给出**两条**真实原因',
      result.status === 'failed' && result.ok === false && result.trashed === false
      && String(result.reason).includes('改名降级也失败') && String(result.reason).includes('EPERM') && String(result.reason).includes('EBUSY'),
      String(result.reason))
    check('★ 失败文案也不含「请手动删除」/「Remove-Item」（改说"后台自动重试"）',
      /自动重试清理/u.test(disposeNote(result)) && !/请手动删除|Remove-Item|手动删除/u.test(disposeNote(result)), disposeNote(result))
    check('rename 失败时原目录原封不动（不假装成功）', existsSync(dir) && existsSync(join(dir, 'sub', 'b.txt')))
  }

  // ── Ⅰ-④ 正常删除 / 本来就不存在 / 名字撞车 → 语义不变 ──────────────────────
  {
    const dir = mkTree('unit-removed')
    const ok = disposeDir(dir, {})
    check('真能删掉时：status=removed（不产生 .trash-*，行为与旧路径一致）',
      ok.status === 'removed' && ok.ok === true && !existsSync(dir) && ok.trashPath === null, JSON.stringify(ok))
    const missing = disposeDir(join(ROOT, 'never-existed'))
    check('目标本来就不存在：status=removed / reason=already-gone（幂等，不调 remover）',
      missing.status === 'removed' && missing.reason === 'already-gone', JSON.stringify(missing))
    const empty = disposeDir('')
    check('空路径：status=failed 且原因明确（不抛错）', empty.status === 'failed' && /没有给出目录路径/u.test(empty.reason))
    const dir2 = mkTree('unit-collide')
    const caught = join(ROOT, '.trash-111-abcdefgh') // 预置一个同名候选（now/random 被钉死 → 第一次必撞）
    mkdirSync(caught, { recursive: true })
    const collide = disposeDir(dir2, { remover: alwaysFail, now: () => 111, random: () => 0.5 })
    check('候选名撞车时换名重试（三次机会），最终仍能降级成功',
      collide.status === 'trashed' && collide.trashPath !== caught && existsSync(collide.trashPath), `${collide.trashPath}（预置=${caught}）`)
    check('trashPathFor：与目标同父目录、名字带时间戳与随机后缀',
      trashPathFor(join(ROOT, 'x', 'pkg'), { now: () => 42, random: () => 0.5 }) === join(ROOT, 'x', '.trash-42-' + Math.floor(0.5 * 0xffffffff).toString(36)),
      trashPathFor(join(ROOT, 'x', 'pkg'), { now: () => 42, random: () => 0.5 }))
    check('TRASH_RE：只认自己的降级名（`.trash-<数字>-<字母数字>`），别人的目录不误伤',
      TRASH_RE.test('.trash-1758888888888-ab12cd') && TRASH_RE.test('.trash-1-z') && !TRASH_RE.test('.trash-') && !TRASH_RE.test('trash-1-a') && !TRASH_RE.test('.trash-1-a-b'))
  }

  // ── Ⅰ-⑤ 后台清理：能清、有上限、任何异常都吞掉 ──────────────────────────────
  {
    const scanRoot = mkdtempSync(join(tmpdir(), 'dsh-trash-scan-'))
    mkdirSync(join(scanRoot, 'ownerA'), { recursive: true })
    for (const name of ['.trash-100-aaa', '.trash-200-bbb']) mkdirSync(join(scanRoot, name), { recursive: true })
    mkdirSync(join(scanRoot, 'ownerA', '.trash-300-ccc'), { recursive: true })
    mkdirSync(join(scanRoot, 'ownerA', '.trash-400-ddd'), { recursive: true })
    mkdirSync(join(scanRoot, 'not-trash-500-eee'), { recursive: true })
    mkdirSync(join(scanRoot, 'ownerA', 'deep', '.trash-600-fff'), { recursive: true }) // 深度 3：超出扫描范围
    const found = findTrashDirs([scanRoot], { maxDepth: 2 })
    check('findTrashDirs：扫到 2 层内的 .trash-*（按名字升序=由旧到新），非降级目录与更深层不误扫',
      found.length === 4 && found.every((p) => TRASH_RE.test(p.split(/[\\/]/u).pop())),
      found.map((p) => p.replace(scanRoot, '')).join(' | '))
    check('findTrashDirs：根不存在/为空时返回 []，不抛',
      findTrashDirs([join(scanRoot, 'nope')]).length === 0 && findTrashDirs([]).length === 0 && findTrashDirs(['']).length === 0)

    const cleaned = await cleanupTrashDirs({ roots: [scanRoot], limit: 10, perItemMs: 2000 })
    const left = findTrashDirs([scanRoot])
    check('★ 后台清理：旧的 .trash-* 真的被删掉（顶层 + 一级子目录都覆盖）',
      cleaned.removed === 4 && cleaned.kept === 0 && left.length === 0,
      `removed=${cleaned.removed} kept=${cleaned.kept} 剩余=${left.length} 用时=${cleaned.ms}ms`)
    check('后台清理：返回结构化统计（scanned/removed/kept/skipped/ms/dirs），失败项带原因',
      cleaned.scanned === 4 && Array.isArray(cleaned.dirs) && cleaned.dirs.length === 4 && cleaned.dirs.every((d) => d.ok === true && typeof d.method === 'string'),
      JSON.stringify(cleaned.dirs.slice(0, 2)))

    // 上限：25 个 → 只处理 20 个（默认），其余如实 skipped
    const bigRoot = mkdtempSync(join(tmpdir(), 'dsh-trash-big-'))
    for (let i = 0; i < 25; i += 1) mkdirSync(join(bigRoot, `.trash-${1000 + i}-x${i}`), { recursive: true })
    const capped = await cleanupTrashDirs({ roots: [bigRoot] })
    check('★ 后台清理有上限：默认最多处理 20 个，其余如实 skipped/more（不会一把梭全删）',
      capped.scanned === 21 && capped.removed === 20 && capped.skipped === 1 && capped.more === true && findTrashDirs([bigRoot]).length === 5,
      `scanned=${capped.scanned} removed=${capped.removed} skipped=${capped.skipped} more=${capped.more} 盘上剩余=${findTrashDirs([bigRoot]).length}`)
    check('上限参数可覆盖（limit=25 → 全清）',
      (await cleanupTrashDirs({ roots: [bigRoot], limit: 25 })).removed === 5 && findTrashDirs([bigRoot]).length === 0)

    // 删不掉：如实 kept，不抛
    const stuckRoot = mkdtempSync(join(tmpdir(), 'dsh-trash-stuck-'))
    mkdirSync(join(stuckRoot, '.trash-777-stuck'), { recursive: true })
    const stuck = await cleanupTrashDirs({ roots: [stuckRoot], remover: async () => ({ ok: false, error: 'EBUSY：还在被占用' }) })
    check('后台清理：删不掉 → kept + 原因，不抛（留给下次）',
      stuck.kept === 1 && stuck.removed === 0 && /EBUSY/u.test(String(stuck.dirs[0]?.error)) && existsSync(join(stuckRoot, '.trash-777-stuck')),
      JSON.stringify(stuck.dirs))
    // 单条超时：到点就不管它，继续（不阻塞主流程）
    const slowRoot = mkdtempSync(join(tmpdir(), 'dsh-trash-slow-'))
    mkdirSync(join(slowRoot, '.trash-888-slow'), { recursive: true })
    const slowStart = Date.now()
    const slow = await cleanupTrashDirs({ roots: [slowRoot], perItemMs: 120, remover: () => new Promise(() => {}) })
    check('★ 后台清理单个不等待超过 perItemMs（到点就不管它、继续下一个，绝不阻塞）',
      slow.kept === 1 && Date.now() - slowStart < 2000 && /超过 120ms/u.test(String(slow.dirs[0]?.error)),
      `用时=${Date.now() - slowStart}ms error=${slow.dirs[0]?.error}`)
    // 异常/坏根：吞掉、只记日志、绝不抛
    const boom = await cleanupTrashDirs({ roots: [stuckRoot], remover: () => { throw new Error('remover 炸了') } })
    check('后台清理：remover 抛异常 → 记为 kept + 原因（吞掉不抛）', boom.kept === 1 && /remover 炸了/u.test(String(boom.dirs[0]?.error)))
    const badFind = await cleanupTrashDirs({ roots: [stuckRoot], find: () => { throw new Error('find 炸了') } })
    check('后台清理：扫描本身抛异常 → stats.error 记录、仍 resolve（绝不抛）', /find 炸了/u.test(String(badFind.error)) && badFind.scanned === 0)
    const logs = []
    const logged = await startTrashCleanup({ roots: [stuckRoot], remover: async () => ({ ok: false, error: '忙' }), log: (m) => logs.push(m) })
    check('★ startTrashCleanup（启动/安装前用的即发即忘入口）永不 reject，且按需记日志',
      logged !== null && typeof logged === 'object' && logs.length === 1 && /\[trash\] 扫描 1 个/u.test(logs[0]), logs[0])
    check('startTrashCleanup：连 find 抛错也不 reject（返回带 error 的统计）',
      typeof (await startTrashCleanup({ roots: [stuckRoot], find: () => { throw new Error('x') } }))?.error === 'string')
    check('trashScanRoots：默认含系统 tmpdir；传 profileDir 与 extra 时一并纳入（去重前如实罗列）',
      trashScanRoots({}).includes(tmpdir()) && trashScanRoots({ profileDir: 'D:/p', extra: ['D:/repos'] }).join('|').includes(join('D:/p', 'node_modules'))
      && trashScanRoots({ profileDir: 'D:/p', extra: ['D:/repos'] }).includes('D:/repos'),
      trashScanRoots({ profileDir: 'D:/p', extra: ['D:/repos'] }).join(' | '))
    for (const d of [scanRoot, bigRoot, stuckRoot, slowRoot]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  }

  // ── Ⅱ 真机：真进程占住目录 → 真删不掉 → rename 降级 → 占用解除后后台清理 ────
  {
    const dir = join(ROOT, 'real-locked')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'keep.txt'), 'x', 'utf8')
    // 占用形态（2026-09-26 本机实测，两种平台各选一种"删不掉但能改名"的）：
    //   Windows：目录内有**正在运行的 exe**（句柄带 FILE_SHARE_DELETE → 删不掉，但父目录改名成功）
    //   POSIX  ：目录是活进程的 **cwd**（rmdir EBUSY；POSIX 允许改 cwd 的名字）
    if (IS_WIN) {
      const exe = join(dir, 'node-copy.exe')
      copyFileSync(process.execPath, exe)
      holder = spawn(exe, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' })
    } else {
      holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: dir, stdio: 'ignore' })
    }
    for (let i = 0; i < 60 && !processAlive(holder.pid); i += 1) await sleep(50)
    await sleep(500)
    check('真机：占用进程已在跑（断言不靠 if 静默跳过）', processAlive(holder.pid) === true, `holder pid=${holder.pid} 形态=${IS_WIN ? '目录内运行中的 exe' : 'cwd 占用'}`)
    const direct = removeDirVerifiedWithRetry(dir, { attempts: 1, pollMs: 20 })
    check('★ 真机先验：占用中该目录**真的删不掉**（否则后面的降级断言没有牙齿）',
      direct.ok === false && existsSync(dir), JSON.stringify(direct))
    const started = Date.now()
    const result = disposeDir(dir, { removerOpts: { attempts: 1, pollMs: 20 } })
    const elapsed = Date.now() - started
    check('★ 真机：disposeDir 走了 rename 降级（status=trashed、原路径已让开、.trash-* 真存在）',
      result.status === 'trashed' && result.ok === true && !existsSync(dir) && existsSync(result.trashPath) && TRASH_RE.test(result.trashPath.split(/[\\/]/u).pop()),
      `status=${result.status} trash=${result.trashPath} 原路径还在=${existsSync(dir)}`)
    check('★ 真机：不阻塞（有界返回，实测耗时在秒级以内），且占用进程仍在跑（我们没杀它）',
      elapsed < 15000 && processAlive(holder.pid) === true, `disposeDir 耗时=${elapsed}ms，holder 仍在=${processAlive(holder.pid)}`)
    check('真机：降级是"改名"而不是"删除"（**真正删不掉的那个东西**跟着目录一起被搬走）',
      existsSync(result.trashPath) && (IS_WIN ? existsSync(join(result.trashPath, 'node-copy.exe')) : true),
      `降级目录内容=${readdirSync(result.trashPath).join(',') || '（空目录：内容已删掉，只剩删不掉的目录本身）'}`)
    check('真机：前台短句如实（正被占用 + 已改名降级 + 稍后自动清理，无「请手动删除」）',
      /目录正被占用/u.test(disposeNote(result)) && /稍后自动清理/u.test(disposeNote(result)) && !/请手动删除|手动删除/u.test(disposeNote(result)), disposeNote(result))
    // 占用还在 → 后台清理清了不（应当留着，留给下次）；占用解除 → 必须清掉
    const whileBusy = await cleanupTrashDirs({ roots: [ROOT], limit: 5, perItemMs: 3000 })
    check('真机：占用未解除时后台清理**不谎报成功**（kept，留着下次）',
      existsSync(result.trashPath) && whileBusy.kept >= 1, `removed=${whileBusy.removed} kept=${whileBusy.kept}`)
    killProcessTree(holder.pid)
    for (let i = 0; i < 100 && processAlive(holder.pid); i += 1) await sleep(50)
    check('真机：占用进程已按测试需要退出（后台清理前提）', processAlive(holder.pid) === false, `holder pid=${holder.pid}`)
    const after = await cleanupTrashDirs({ roots: [ROOT], limit: 5, perItemMs: 4000 })
    check('★ 真机：占用解除后**后台清理真的把它删掉**（.trash-* 消失）',
      !existsSync(result.trashPath) && after.removed >= 1 && findTrashDirs([ROOT]).length === 0,
      `removed=${after.removed} kept=${after.kept} 剩余=${findTrashDirs([ROOT]).length} 用时=${after.ms}ms`)
  }
} finally {
  try { if (holder !== null) killProcessTree(holder.pid) } catch {}
  await sleep(200)
  try {
    const left = findTrashDirs([ROOT], { maxDepth: 2 })
    if (left.length > 0) await cleanupTrashDirs({ roots: [ROOT], limit: 20, perItemMs: 4000 })
    const still = findTrashDirs([ROOT], { maxDepth: 2 })
    if (still.length > 0) console.log(`（提示）仍有 ${still.length} 个降级目录未清掉（占用未解除时属预期）：${still.join(' | ')}`)
    try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
    if (existsSync(ROOT)) {
      const r = disposeDir(ROOT, { removerOpts: { attempts: 1, pollMs: 100 } })
      if (r.ok !== true) console.log(`（提示）临时目录未能清理：${ROOT} — ${r.reason}`)
    }
  } catch (error) { console.log(`（提示）清理临时目录出错：${error instanceof Error ? error.message : String(error)}`) }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
