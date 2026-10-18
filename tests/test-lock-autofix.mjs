// 0.5.84 加法：清单 ↔ lock 口径不一致的**后台自动对账**（domain/lock-autofix.js）
//
// 用户要求的三条硬约束，逐条钉死：
//   ① **绝不阻塞**：派发立即返回（同步调用不 await pnpm），pnpm 在后台 promise 里跑；
//   ② **冷却窗**：两次尝试之间 ≥ 10 分钟，期间任何触发都跳过；
//   ③ **失败就停**：失败后不再自动重试 —— 除非"不一致的样子"变了（signature 变化）；原因如实留下。
// 另加两条判据边界（用户点名的既有事实）：
//   · 不一致里出现**来源型依赖**（link:/file:/git/URL）⇒ 不自动修（整份 --lockfile-only 会改写解析记录）；
//   · 测试进程里不自动跑 pnpm（与 infra/egress.js#isTestProcess 同一判据），此处用注入了 repair 替身
//     的那条路覆盖全流程，并单独断言"没注入时会被拦下"。
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'lock-autofix-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(PROFILE, { recursive: true })

const {
  COOLDOWN_MS, STATE_FILE_NAME, __resetLockAutofix, lockAutofixStatus, planLockAutofix, scheduleLockAutofix,
} = await import('../lib/server/domain/lock-autofix.js')
const { isTestProcess } = await import('../lib/server/infra/egress.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

const writeManifest = (deps) => writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: deps }, null, 2)}\n`, 'utf8')
const writeLock = (deps) => {
  const rows = Object.entries(deps).map(([name, spec]) => `${/[/@]/u.test(name) ? `'${name}':` : `${name}:`}\n        specifier: ${spec}\n        version: ${spec}`).join('\n      ')
  writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      ${rows}\n`, 'utf8')
}
const cleanState = () => {
  __resetLockAutofix()
  for (const f of [join(PROFILE, 'package.json'), join(PROFILE, 'pnpm-lock.yaml'), join(HOME, 'plugin-console', STATE_FILE_NAME)]) rmSync(f, { force: true })
}

console.log('=== ① 判据：只有「口径不一致 + 清单是明确来源」才动手 ===')
{
  cleanState()
  // lock 缺一条（清单有、lock 没有）
  writeManifest({ '@fake/one': '1.0.0' })
  writeLock({ '@fake/one': '1.0.0' })
  const okPlan = planLockAutofix({ profileDir: PROFILE })
  check('① 一致时 applicable=false 且 reason=null（安静，不打扰）', okPlan.applicable === false && okPlan.reason === null, JSON.stringify(okPlan.reason))

  writeManifest({ '@fake/one': '1.0.0', '@fake/two': '2.0.0' }) // lock 里没有 @fake/two
  const gapPlan = planLockAutofix({ profileDir: PROFILE })
  check('① 清单多一条、lock 没有 ⇒ applicable=true（这才是自动修的场景）',
    gapPlan.applicable === true && JSON.stringify(gapPlan.outdated.missing) === JSON.stringify(['@fake/two']), JSON.stringify(gapPlan.outdated))
  check('① 判据是纯函数：只读、不写盘（跑完 lock 与清单逐字节不变）',
    readFileSync(join(PROFILE, 'package.json'), 'utf8').includes('@fake/two') && !existsSync(join(HOME, 'plugin-console', STATE_FILE_NAME)))

  // 来源型依赖出现在不一致里 ⇒ 不自动修（这是 lock-importer 的地盘）
  writeManifest({ '@fake/one': '1.0.0', '@fake/linked': 'link:D:/dev/linked' })
  const srcPlan = planLockAutofix({ profileDir: PROFILE })
  check('① 来源型依赖不一致 ⇒ 拒绝自动对账（交给「一键钉住」）',
    srcPlan.applicable === false && srcPlan.sourceSpecNames.includes('@fake/linked') && /一键钉住/u.test(String(srcPlan.reason)),
    String(srcPlan.reason).slice(0, 80))

  // 清单根本读不出来 ⇒ 绝不碰
  writeFileSync(join(PROFILE, 'package.json'), '{ not json', 'utf8')
  const broken = planLockAutofix({ profileDir: PROFILE })
  check('① 清单不是合法 JSON ⇒ 不动手且说明原因（不猜着改）', broken.applicable === false && /不是合法 JSON/u.test(String(broken.reason)), String(broken.reason).slice(0, 60))
}

console.log('\n=== ② 绝不阻塞：派发立即返回，pnpm 在后台跑 ===')
{
  cleanState()
  writeManifest({ '@fake/one': '1.0.0', '@fake/two': '2.0.0' })
  writeLock({ '@fake/one': '1.0.0' })
  let repairCalls = 0
  let repairSawStop = false
  const deps = {
    repair: async () => {
      repairCalls += 1
      await tick(40) // 模拟 pnpm 的墙钟耗时
      return { ok: true, action: 'repaired', reason: '只重写了 pnpm-lock.yaml', command: 'install --lockfile-only --no-frozen-lockfile' }
    },
  }
  const t0 = Date.now()
  const kicked = scheduleLockAutofix({ profileDir: PROFILE, deps })
  const elapsed = Date.now() - t0
  repairSawStop = lockAutofixStatus({ profileDir: PROFILE }).inFlight === true
  check('② started=true（确实派发了）', kicked.started === true, JSON.stringify(kicked))
  check(`② 返回耗时 ≈ 0（实测 ${elapsed}ms，远小于 40ms 的模拟 pnpm）`, elapsed < 30, `elapsed=${elapsed}ms`)
  check('② 派发时状态是「在跑」而不是「已完成」（证明没 await）', repairSawStop === true)
  await tick(120)
  check('② 后台跑完后结论落位（action=repaired）',
    repairCalls === 1 && lockAutofixStatus({ profileDir: PROFILE }).lastResult?.action === 'repaired',
    JSON.stringify(lockAutofixStatus({ profileDir: PROFILE }).lastResult))
  check('② 结论人话可读（面板直接展示）', /已自动对账/u.test(String(lockAutofixStatus({ profileDir: PROFILE }).note)), String(lockAutofixStatus({ profileDir: PROFILE }).note))
}

console.log('\n=== ③ 冷却窗：10 分钟内不再跑第二次 ===')
{
  cleanState()
  writeManifest({ '@fake/one': '1.0.0', '@fake/two': '2.0.0' })
  writeLock({ '@fake/one': '1.0.0' })
  let calls = 0
  const deps = { repair: async () => { calls += 1; return { ok: true, action: 'repaired', reason: 'ok' } } }
  scheduleLockAutofix({ profileDir: PROFILE, deps })
  await tick(30)
  const again = scheduleLockAutofix({ profileDir: PROFILE, deps })
  check('③ 第二次被冷却窗挡下（started=false 且说明还要等多久）',
    again.started === false && /冷却中/u.test(String(again.reason)), String(again.reason))
  check('③ 真的只跑过一次（不是"挡下了但后台又跑"）', calls === 1, `calls=${calls}`)
  check('③ 冷却窗就是 10 分钟', COOLDOWN_MS === 10 * 60 * 1000, String(COOLDOWN_MS))
}

console.log('\n=== ④ 失败就停：如实留原因，且不再自动重试 ===')
{
  cleanState()
  writeManifest({ '@fake/one': '1.0.0', '@fake/two': '2.0.0' })
  writeLock({ '@fake/one': '1.0.0' })
  let calls = 0
  const deps = { repair: async () => { calls += 1; return { ok: false, action: 'failed', kind: 'locked', reason: 'pnpm 重建 lock 失败', hint: '把手动起的进程关掉再试', stderrTail: 'ERR_PNPM_SOMETHING 尾巴' } } }
  scheduleLockAutofix({ profileDir: PROFILE, deps })
  await tick(40)
  const st = lockAutofixStatus({ profileDir: PROFILE })
  check('④ 失败被如实记录（action/kind/reason/pnpm 输出尾部都在）',
    st.lastResult?.action === 'failed' && st.lastResult.kind === 'locked' && /ERR_PNPM_SOMETHING/u.test(String(st.lastResult.stderrTail)),
    JSON.stringify(st.lastResult)?.slice(0, 120))
  check('④ 已置 stopped 且说明原因', st.stopped === true && /自动对账失败/u.test(String(st.stoppedReason)), String(st.stoppedReason).slice(0, 80))
  // 冷却窗过后（把时间往前拨）仍然不该重试：样子没变
  const later = scheduleLockAutofix({ profileDir: PROFILE, now: Date.now() + COOLDOWN_MS * 2, deps })
  await tick(20)
  check('④ 冷却窗过后也不重试（不一致的样子没变）', later.started === false && calls === 1, `started=${later.started} calls=${calls}`)
  check('④ 跳过原因说清是"失败后停手"', /已停止自动重试|清单\/lock 变化后会再试/u.test(String(later.reason)), String(later.reason))

  // 样子变了（用户又改了一条）⇒ 允许再试一次
  writeManifest({ '@fake/one': '1.0.0', '@fake/two': '2.0.0', '@fake/three': '3.0.0' })
  const afterChange = scheduleLockAutofix({ profileDir: PROFILE, now: Date.now() + COOLDOWN_MS * 3, deps })
  await tick(20)
  check('④ 不一致的样子变了 ⇒ 解除停手、允许再试（自愈，不会永久僵硬）',
    afterChange.started === true && calls === 2, `started=${afterChange.started} calls=${calls}`)
}

console.log('\n=== ⑤ 状态跨重启有记忆（落盘），且坏文件不会把功能带崩 ===')
{
  cleanState()
  writeManifest({ '@fake/one': '1.0.0', '@fake/two': '2.0.0' })
  writeLock({ '@fake/one': '1.0.0' })
  const deps = { repair: async () => ({ ok: true, action: 'repaired', reason: 'ok' }) }
  scheduleLockAutofix({ profileDir: PROFILE, deps, now: 1700000000000 })
  await tick(30)
  const file = join(HOME, 'plugin-console', STATE_FILE_NAME)
  check('⑤ 状态已落盘（重启后仍知道上次干了什么）', existsSync(file), file)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  check('⑤ 落盘内容含 lastAt / lastResult', typeof saved.lastAt === 'number' && saved.lastResult?.action === 'repaired', JSON.stringify(saved).slice(0, 100))
  __resetLockAutofix() // 模拟重启
  const afterRestart = lockAutofixStatus({ profileDir: PROFILE })
  check('⑤ 重启后仍读得到上次结论（不需要重复跑）', afterRestart.lastResult?.action === 'repaired' && afterRestart.lastAt === 1700000000000, JSON.stringify(afterRestart.lastAt))
  writeFileSync(file, '{ broken', 'utf8')
  __resetLockAutofix()
  let threw = false
  try { lockAutofixStatus({ profileDir: PROFILE }) } catch { threw = true }
  check('⑤ 状态文件坏掉 ⇒ 不抛（静默回到空状态，绝不因为一个缓存文件崩面板）', threw === false)
}

console.log('\n=== ⑥ 测试进程保护：没注入替身时一律不自动跑 pnpm ===')
{
  cleanState()
  writeManifest({ '@fake/one': '1.0.0', '@fake/two': '2.0.0' })
  writeLock({ '@fake/one': '1.0.0' })
  check('⑥ 本进程确实被判为测试进程（判据来自 infra/egress.js）', isTestProcess() === true)
  const r = scheduleLockAutofix({ profileDir: PROFILE }) // 不注入 repair ⇒ 真实现会被拦
  check('⑥ 未注入替身 ⇒ 不启动，并说明是测试进程保护', r.started === false && /测试进程/u.test(String(r.reason)), String(r.reason))
  check('⑥ 拦下时一个 pnpm 都没跑（状态里没有任何结果）', lockAutofixStatus({ profileDir: PROFILE }).lastResult === null)
}

cleanState()
rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
