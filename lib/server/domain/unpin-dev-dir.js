// L1 · domain —— 取消钉住：把 profile 清单里那条 `link:` / `file:` 依赖摘掉（0.5.87 加法）
//
// 为什么需要（用户 2026-10-18 的原话）：link 面板过去**只能看不能改** —— 看到"这一条钉着本地目录"
//   却没有任何办法退回去。钉住有入口（/pin-dev-dir），退出没有。
//
// 语义词边界（与 `routes/revoke-force.js` 同一套"窄动作"纪律，**照抄它的安全语义**）：
//   · 只对**清单里真写着 `link:`/`file:` 的那一条**生效 —— 不是这种来源就一律拒（不猜、不代劳）；
//   · 两段式：`planUnpinDevDir` 纯只读先给"将要发生什么"，`applyUnpinDevDir` 才会动手；
//   · 动手时**先备份清单**，pnpm 报成功但**读回**发现清单里还有它 ⇒ 回滚并如实报错（绝不谎报）；
//   · **只摘依赖**：不删开发目录、不删我们造过的 peer 垫片、不碰 dsh.profile.bundles 之外的东西。
//     它若还在 `dsh.profile.bundles` 里，撤销后框架会跳过那个 bundle —— 这是**必说的后果**，
//     由 plan.warnings 与 apply.note 明说，而不是替用户顺手改 bundles（那属于「卸载」的语义）。
//
// 为什么**不自己写清单**：`pnpm remove` 一个动作同时负责清单 / pnpm-lock.yaml / node_modules 三处；
//   我们若先删清单再调 pnpm，失败时就是"清单没了、锁没动、链接还在"的半截状态。
//   所以：备份 → 交给 pnpm → **读回三处**如实汇报。pnpm 是墙钟动作，执行器可注入（离线测试用）。
//
// 分层：L1 domain —— 收已解开的 profileDir；不认 ctx。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NPM_NAME_RE, canonicalSourceSpec, sourceSpecTarget } from './dep-source.js'
import { pnpmRemove } from './install-cleanup.js'
import { readBundlesSync } from './persist.js'
import { lockVersion } from './selfupdate.js'

/** 路径型来源（`link:` / `file:`）—— 只有这一族谈得上"钉住 / 取消钉住"。 */
const PATH_SPEC_RE = /^(?:link:|file:)/u

const readJsonSafe = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** `node_modules/<包名>` 的路径（不判断存在性）。 */
function nodeModulesPathOf(profileDir, packageName) {
  return join(profileDir, 'node_modules', ...String(packageName).split('/'))
}

/** 清单里该依赖当前的 spec（没有就 null）。 */
function manifestDepSpec(profileDir, packageName) {
  const deps = readJsonSafe(join(profileDir, 'package.json'))?.dependencies
  if (deps === null || typeof deps !== 'object') return null
  const spec = deps[packageName]
  return typeof spec === 'string' && spec !== '' ? spec : null
}

/**
 * 规划一次取消钉住（**纯只读**，不写盘、不 spawn）。
 *
 * @param {object} p
 * @param {string} p.profileDir profile 根目录
 * @param {string} p.packageName 要取消钉住的包名
 * @returns {{ ok: boolean, status: number, error: string|null, packageName: string, spec: string|null,
 *             target: string|null, targetExists: boolean, inBundles: boolean, bundles: string[],
 *             warnings: string[], steps: string[] }}
 */
function planUnpinDevDir({ profileDir, packageName } = {}) {
  const base = {
    ok: false, status: 400, error: null, packageName: typeof packageName === 'string' ? packageName : '',
    spec: null, target: null, targetExists: false, inBundles: false, bundles: [], warnings: [], steps: [],
  }
  if (typeof profileDir !== 'string' || profileDir === '') return { ...base, error: '拿不到 profile 目录，拒绝改动' }
  if (typeof packageName !== 'string' || !NPM_NAME_RE.test(packageName)) return { ...base, error: '包名无效' }
  const spec = manifestDepSpec(profileDir, packageName)
  if (spec === null) return { ...base, error: `${packageName} 不在 profile 清单的 dependencies 里 —— 没有可取消的钉住` }
  const canonical = canonicalSourceSpec(spec)
  if (typeof canonical !== 'string' || !PATH_SPEC_RE.test(canonical)) {
    return { ...base, spec, error: `${packageName} 的来源是 ${spec}，不是 link:/file: —— 它本来就没被钉到本地目录，无需取消钉住` }
  }
  const target = sourceSpecTarget(profileDir, canonical)
  const targetExists = target !== null && existsSync(target)
  let bundles = []
  try { bundles = readBundlesSync(profileDir) } catch { bundles = [] }
  const inBundles = bundles.includes(packageName)
  const warnings = inBundles
    ? [`它仍在 dsh.profile.bundles 里：取消钉住后这个 bundle 会解析不到（重启后被框架跳过、插件不可用）。要连 bundle 一起去掉请用「卸载」；只想换回发行版请重新安装它。`]
    : []
  if (target !== null && !targetExists) {
    warnings.push(`目标目录已经不在了（${target}）—— 这一条是"指向不存在目录的陈旧链接"，取消它只是清理，不会有任何功能损失。`)
  }
  const steps = [
    `备份 profile 清单（package.json.bak-unpin-<时间戳>）`,
    `执行 pnpm remove ${packageName}（同时清掉 pnpm-lock.yaml 条目与 node_modules 里的链接）`,
    target === null ? '读回核对：清单 / lock / node_modules 三处都不再有它' : `读回核对：清单 / lock / node_modules 三处都不再有它（目标目录 ${target} 不会被删）`,
  ]
  return { ...base, ok: true, status: 200, spec, target, targetExists, inBundles, bundles, warnings, steps }
}

/** 把清单写回改动前（回滚用；失败只返回 false，绝不抛）。 */
function restoreManifest(manifestPath, text) {
  try { writeFileSync(manifestPath, text, 'utf8'); return true } catch { return false }
}

/**
 * 执行取消钉住。**失败即回滚清单**，并如实汇报三处（清单 / lock / node_modules）的真实状态。
 *
 * @param {object} p
 * @param {string} p.profileDir profile 根目录
 * @param {string} p.packageName 要取消钉住的包名
 * @param {(args: { profileDir: string, packageName: string }) => Promise<void>} [p.runRemove]
 *        注入的移除执行器（离线测试用）；缺省走真实 pnpm remove。
 */
async function applyUnpinDevDir({ profileDir, packageName, runRemove = null } = {}) {
  const plan = planUnpinDevDir({ profileDir, packageName })
  if (plan.ok !== true) return { ...plan, changed: false, backup: null, removed: null }
  const manifestPath = join(profileDir, 'package.json')
  const before = readFileSync(manifestPath, 'utf8')
  const backup = `${manifestPath}.bak-unpin-${Date.now()}`
  try { writeFileSync(backup, before, 'utf8') } catch {}
  const failed = (reason, restored) => ({
    ...plan, ok: false, status: 500, changed: false, backup, removed: null,
    error: `${reason}\n（清单${restored ? '已回滚到改动前' : '**回滚失败**，请手动检查'}，backup: ${backup}）`,
  })
  // ① 备份 → ② 交给 pnpm（清单 / lock / node_modules 由同一个动作负责）
  try {
    if (typeof runRemove === 'function') await runRemove({ profileDir, packageName })
    else await pnpmRemove(profileDir, packageName)
  } catch (error) {
    const restored = restoreManifest(manifestPath, before)
    return failed(`pnpm remove 失败：${error instanceof Error ? error.message : String(error)}`, restored)
  }
  // ③ 读回三处（不读回就报成功 = 谎报）
  const afterSpec = manifestDepSpec(profileDir, plan.packageName)
  const manifestCleared = afterSpec === null
  const nodeModulesCleared = !existsSync(nodeModulesPathOf(profileDir, plan.packageName))
  let lockCleared = false
  try { lockCleared = lockVersion(profileDir, plan.packageName) === null } catch { lockCleared = false }
  if (!manifestCleared) {
    const restored = restoreManifest(manifestPath, before)
    return failed(`pnpm 报告成功，但读回发现清单里仍有 ${plan.packageName}（实际 ${JSON.stringify(afterSpec)}）`, restored)
  }
  const note = [
    `已从 profile 清单移除 ${plan.packageName}（原来源 ${plan.spec}）`,
    `pnpm-lock.yaml 条目${lockCleared ? '已清除' : '仍在（lock 没跟上这一步，下一次 pnpm 操作会重算）'}`,
    `node_modules 里的链接${nodeModulesCleared ? '已清除' : '仍在（pnpm 没清掉它，重启后它可能仍被解析到）'}`,
    '开发目录与代码未被删除',
    ...plan.warnings,
  ].join('；')
  return {
    ...plan,
    ok: true,
    status: 200,
    changed: true,
    backup,
    removed: { manifest: manifestCleared, lock: lockCleared, nodeModules: nodeModulesCleared },
    note,
  }
}

export { PATH_SPEC_RE, manifestDepSpec, nodeModulesPathOf, planUnpinDevDir, applyUnpinDevDir }
