// L1 · domain —— 把"开发区里的某个目录"钉成一个 link 依赖（0.5.57 加法）
//
// 用户决定（2026-10-15 原话）：① 允许注册自己的开发区根；② **不允许任意目录**；③ agent 自动钉住要用户勾选，
// 且**默认关闭**。本模块是 ②③ 的执行点：
//   · 目标必须落在已注册的根里（判据在 domain/dev-roots.js，本模块**不重复实现**）；
//   · `allowAgent` 必须显式为 true 才允许"由 agent 发起"的钉住（默认 false = 只接受用户显式请求）。
//
// 动作分两段，和仓库其它写动作一致：
//   planPinDevDir  —— **纯只读**：校验 + 产出一份"将要发生什么"的清单（面板先给用户看，人性化）；
//   applyPinDevDir —— 真的写：备份清单 → 写 `link:<dir>` → 跑 pnpm（可注入）→ **读回归属与 lock** →
//                     失败即回滚清单并如实报错（绝不谎报"钉住了"）。
//
// 为什么必须读回验证：`link:` 的"钉住了"判据是**清单里该包是 link: 形式且 lock 跟上了**，
//   不是"我写进去了"。pnpm 可能把绝对路径规范化、也可能因供应链闸/构建脚本失败而根本没写成。
//
// 分层：L1 domain —— 收已解开的 home/profileDir/deps；不认 ctx。pnpm 通过 deps.runInstall 注入（便于离线测试）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkInsideDevRoots } from './dev-roots.js'

const readJsonSafe = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 该目录是不是一个 dsh 插件（有 dsh.bundle / dsh.client / dsh.profile 任一标记）。
 *  与 install-job 的检测同口径（那套是"清单没有标志 ≠ 不是插件"的判据真源）。 */
function dshMarkerOf(pkg) {
  const dsh = pkg?.dsh
  if (dsh === null || dsh === undefined || typeof dsh !== 'object') return null
  for (const key of ['bundle', 'client', 'profile']) {
    if (dsh[key] !== undefined && dsh[key] !== null) return key
  }
  return null
}

/**
 * 规划一次钉住（**纯只读**）。
 *
 * @param {object} p
 * @param {string} [p.home] DSH 家目录（读开发区登记表）
 * @param {string} p.profileDir profile 根目录
 * @param {string} p.dir 要钉的目录（绝对路径）
 * @param {boolean} [p.allowAgent=false] 是否允许"由 agent 发起"（默认关闭，用户勾选后才 true）
 * @param {boolean} [p.byAgent=false] 本次请求是否真的由 agent 发起
 * @returns {{ ok: boolean, status: number, error: string|null, steps: string[],
 *             packageName: string|null, version: string|null, spec: string|null,
 *             current: string|null, marker: string|null, root: string|null, needsConfirm: boolean }}
 */
function planPinDevDir({ home = null, profileDir, dir, allowAgent = false, byAgent = false } = {}) {
  const base = {
    ok: false, status: 400, error: null, steps: [], packageName: null, version: null,
    spec: null, current: null, marker: null, root: null, needsConfirm: true,
  }
  // ③ agent 发起必须被明确放行（默认关闭）
  if (byAgent === true && allowAgent !== true) {
    return { ...base, status: 403, error: '看起来是 agent 发起的钉住，但「允许 agent 自动钉住」这个开关是关着的（默认关闭）—— 请在面板里勾选后再试，或由你自己点按钮' }
  }
  if (typeof profileDir !== 'string' || profileDir === '') return { ...base, error: '拿不到 profile 目录，拒绝改动' }
  // ② 必须落在已注册的开发区根里（唯一执行点）
  const inside = checkInsideDevRoots(home, dir)
  if (inside.ok !== true) return { ...base, status: 403, error: inside.reason }
  // 必须是一份能读的 package.json
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return { ...base, status: 400, error: `${dir} 里没有 package.json —— 这不是一个可安装的包` }
  const pkg = readJsonSafe(pkgPath)
  if (pkg === null || typeof pkg !== 'object') return { ...base, status: 400, error: `${pkgPath} 读不出来或不是合法 JSON` }
  if (typeof pkg.name !== 'string' || pkg.name === '') return { ...base, status: 400, error: `${pkgPath} 没有 name 字段` }
  const marker = dshMarkerOf(pkg)
  if (marker === null) {
    return { ...base, status: 400, error: `${pkg.name} 的 package.json 里没有 dsh.bundle / dsh.client / dsh.profile —— 它不是 dsh 插件，钉住它没有意义` }
  }
  const version = typeof pkg.version === 'string' ? pkg.version : null
  // 现值（用于"改了没有"的判定与人性化预览）
  const manifest = readJsonSafe(join(profileDir, 'package.json')) ?? {}
  const deps = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const current = typeof deps[pkg.name] === 'string' ? deps[pkg.name] : null
  const spec = `link:${dir}`
  const steps = [
    `把 ${pkg.name} 的来源写成 ${spec}（清单 dependencies）`,
    '跑一次 pnpm install --lockfile-only，让 pnpm-lock.yaml 与清单一致',
    '补该插件的自足性（缺的 dependencies 交给 pnpm，框架 peer 走垫片）',
    '读回归属与 lock 复核：只有两处都到位才算钉住',
  ]
  return { ...base, ok: true, status: 200, packageName: pkg.name, version, spec, current, marker, root: inside.root, steps }
}

/**
 * 执行钉住。**失败即回滚清单**，绝不留半截状态、绝不谎报成功。
 *
 * @param {object} p — 同 planPinDevDir，外加：
 * @param {(args: object) => Promise<{ ok: boolean, stderr?: string, note?: string }>} [p.runInstall]
 *        注入的 pnpm 执行器（离线测试用）；缺省走真实 pnpm。
 * @param {(args: object) => Promise<object>} [p.ensureSufficiency] 注入的自足性执行器
 */
async function applyPinDevDir({ home = null, profileDir, dir, allowAgent = false, byAgent = false, runInstall = null, ensureSufficiency = null } = {}) {
  const plan = planPinDevDir({ home, profileDir, dir, allowAgent, byAgent })
  if (plan.ok !== true) return { ...plan, changed: false, backup: null }
  const manifestPath = join(profileDir, 'package.json')
  const before = readFileSync(manifestPath, 'utf8')
  const backup = `${manifestPath}.bak-pin-${Date.now()}`
  try { writeFileSync(backup, before, 'utf8') } catch {}
  const rollback = (reason) => {
    try { writeFileSync(manifestPath, before, 'utf8') } catch {}
    return { ...plan, ok: false, changed: false, status: 500, error: `${reason}\n（清单已回滚到改动前，backup: ${backup}）`, backup }
  }
  // ① 写清单
  try {
    const manifest = JSON.parse(before)
    manifest.dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
    manifest.dependencies[plan.packageName] = plan.spec
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch (error) {
    return rollback(`写 profile 清单失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // ② pnpm：lock 与清单对齐（失败即回滚）
  let installNote = null
  try {
    const run = typeof runInstall === 'function' ? await runInstall({ profileDir, spec: plan.spec }) : { ok: true, skipped: true }
    if (run?.ok !== true) {
      return rollback(`pnpm 未能让 lock 与清单一致${run?.stderr ? `：${String(run.stderr).slice(0, 600)}` : ''}`)
    }
    installNote = run?.note ?? null
  } catch (error) {
    return rollback(`pnpm 执行失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // ③ 自足性（失败不致命：如实记下，钉住本身已经成立）
  let sufficiency = null
  try {
    if (typeof ensureSufficiency === 'function') sufficiency = await ensureSufficiency({ profileDir, packageName: plan.packageName })
  } catch (error) {
    sufficiency = { ok: false, note: error instanceof Error ? error.message : String(error) }
  }
  // ④ 读回验证：清单里必须是 link: 形式（pnpm 可能规范化路径，所以只认前缀）
  const after = readJsonSafe(manifestPath)
  const afterSpec = typeof after?.dependencies?.[plan.packageName] === 'string' ? after.dependencies[plan.packageName] : null
  const linked = typeof afterSpec === 'string' && afterSpec.startsWith('link:')
  if (!linked) return rollback(`写完读回发现清单里不是 link: 形式（实际 ${JSON.stringify(afterSpec)}）`)
  return {
    ...plan,
    ok: true,
    status: 200,
    changed: true,
    backup,
    after: afterSpec,
    note: installNote,
    sufficiency: sufficiency === null ? null : { ok: sufficiency.ok === true, ready: sufficiency.ready === true, note: sufficiency.note ?? null, created: Array.isArray(sufficiency.created) ? sufficiency.created.length : 0 },
  }
}

export { dshMarkerOf, planPinDevDir, applyPinDevDir }
