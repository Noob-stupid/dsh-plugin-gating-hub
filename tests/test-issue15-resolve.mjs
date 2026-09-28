// 场景模拟（issue #15）：npm 全局安装 dsh 时 ctx.baseUrl 落在框架安装树，
// resolvePackageJson(moduleName, frameworkBase, profileDir) 必须回退解出第三方包。
// Step 1 重构后：该函数已搬进 lib/server/infra/paths.js —— 直接 import 真模块。
//
// ★ 2026-09-30 改错（本机常年那 1 红 = 本套）：这里过去把「框架基准」写成**一个写死的目录**
//   （`…/@deepseek-ai/dsh` —— 框架包自身，还带本机 npx 缓存哈希）。框架 0.2.0-rc.1 把
//   `@deepseek-ai/*` 实体搬进 `.pnpm` 内层后，该基准下一个官方包都解不出来，于是常年红：
//   `FAIL 官方: @deepseek-ai/dsh-settings: noFallback=null withFallback=null`。
//   反证（2026-09-30 实测）：把 lib/server/infra/paths.js 换回 clean HEAD(2ad76da) 逐条重跑，
//   四个 case 结果**逐字相同** —— 坏的是**测试自己猜的基准**（环境漂移），不是被测函数。
//   现在框架基准改由产品自己的判据推导：dshHome() → profileDir → frameworkBases() 多基准有序并集，
//   测试不再自带第二套「框架在哪」的知识，也不再写死本机路径。
//   断言一条都没放松：第三方仍必须「只有带 profile 回退才解得出来」（issue #15 的核心回归），
//   官方包必须在真框架树里解得出来；本机没有真框架树（隔离/CI）时**整段响亮 SKIP 并打印原因**，
//   绝不静默 PASS（为什么是整段而不是逐条，见 §② 的注释）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { resolvePackageJson, dshHome } = await import('../lib/server/infra/paths.js')
const { frameworkBases, isFrameworkModuleName } = await import('../lib/server/infra/framework-root.js')

/** 多基准有序并集解析：任一基准命中即算命中（判据与 lib/server/infra/package-resolve.js 同源）。 */
function resolveOverBases(name, fallbackBase, from) {
  for (const base of from) {
    const hit = resolvePackageJson(name, base, fallbackBase)
    if (hit !== null) return hit
  }
  return null
}

let fail = 0
let skip = 0

/** 收尾：有红就红（退出码非 0），有 SKIP 就在结论行点名，绝不把 SKIP 混成 PASS。 */
function report() {
  if (fail > 0) {
    console.log(`\n${fail} FAILED`)
    process.exit(1)
  }
  console.log(skip > 0 ? `\nALL PASS（${skip} 条 SKIP —— 见上方 SKIP 行）` : '\nALL PASS')
  process.exit(0)
}

// ── ① 判据回归（离线，任何环境都跑得到）：单基准失败 + 多基准并集命中 ─────────────
// 本次常年红的判据缺口就是「只认一个基准」；这条不依赖真机框架树，CI 也跑得到。
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-issue15-'))
  try {
    const name = '@issue15-fixture/probe'
    const emptyBase = path.join(sandbox, 'empty')
    const realBase = path.join(sandbox, 'with-pkg')
    const pkgDir = path.join(realBase, 'node_modules', '@issue15-fixture', 'probe')
    fs.mkdirSync(emptyBase, { recursive: true })
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`)
    const single = resolvePackageJson(name, emptyBase, null)
    const union = resolveOverBases(name, null, [emptyBase, realBase])
    const ok = single === null && union === path.join(pkgDir, 'package.json')
    console.log(`${ok ? 'PASS' : 'FAIL'} 判据回归（离线）: 单基准=${single ?? 'null'} 并集=${union ?? 'null'}`)
    if (!ok) fail += 1
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

// ── ② 真机四条（需要本机 profile；CI 无 profile → 响亮 SKIP）────────────────────
const profileDir = process.env.DSH_PROFILE_DIR ?? path.join(dshHome(), 'profiles', 'web')
// DSH_FRAMEWORK_BASE 仍可跨机显式指定；默认从本机数据根推导（与插件运行期同一条推导链）。
const frameworkSeed = process.env.DSH_FRAMEWORK_BASE?.trim() || profileDir
if (!fs.existsSync(profileDir)) {
  skip += 4
  console.log(`SKIP 真机四条: profileDir=${profileDir} 不存在 —— CI 无本机 profile，如实跳过，不假装 PASS`)
  report()
}

const bases = frameworkBases(frameworkSeed, profileDir)
console.log(`框架基准（frameworkBases 多基准有序并集，${bases.length} 项）: ${bases.join(' | ')}`)
// 真框架树够不到时**整段 SKIP**（既不是 PASS 也不是 FAIL），原因有二，都指向"判不了"：
//   · 官方包只存在于框架树里；
//   · frameworkBases() 的兜底会把 profileDir 本身当基准，于是 frameworkBase 与 profileDir 重合，
//     「第三方只能靠 profile 回退才解得出」这条判据退化成不可能成立 —— 硬跑只会得到假红。
const hasFrameworkTree = bases.some((base) => resolvePackageJson('@deepseek-ai/dsh', base, profileDir) !== null)
if (!hasFrameworkTree) {
  skip += 4
  console.log(`SKIP 真机四条: 本机解析不到真框架树（frameworkBase 只能是 ${bases.join(' | ')}）—— 无法判定，不假装 PASS`)
  report()
}

const cases = [
  ['第三方: dsh-better-sidebar', 'dsh-better-sidebar'],
  ['第三方: @noob-stupid/dsh-plugin-console', '@noob-stupid/dsh-plugin-console'],
  ['全家桶: @linxin666/dsh-web-all/plugin-manager', '@linxin666/dsh-web-all/plugin-manager'],
  ['官方: @deepseek-ai/dsh-settings', '@deepseek-ai/dsh-settings'],
]

for (const [label, name] of cases) {
  const official = isFrameworkModuleName(name)
  const noFallback = resolveOverBases(name, null, bases)
  const withFallback = resolveOverBases(name, profileDir, bases)
  // 判定（与修前同强度，未放松）：
  //   · 官方包：带不带回退都必须解得出来 —— 修好后它落在框架树的多基准并集里；
  //   · 第三方：**只有**带 profile 回退才解得出来（框架基准单跑必须是 null）—— issue #15 核心。
  const cond = official
    ? withFallback !== null && noFallback !== null
    : withFallback !== null && noFallback === null
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}: noFallback=${noFallback ?? 'null'} withFallback=${withFallback ?? 'null'}`)
  if (!cond) fail += 1
}

report()
