// 0.5.30 改错（**真机事故 2026-09-29 01:05:44**）：`healPatchSafety()` 误判「模块缺失」→ 自动禁用。
//
// 现场：`~/.dsh/profiles/web/cordis.patch.yml` 尾部被追加了 4 个 `disabled: true` 块
//   （preset-router-spec / workflow-worker-thread / preset-router-standard / preset-router-react），
//   把用户的 preset-router-* 三条全停掉。
// 真因：该自愈只用**单基准** `resolvePackageJson(name, profileDir)`。而框架 0.2.0-rc.1 起
//   `@deepseek-ai/*` 的实体全在 `.pnpm` **内部**那层，profile 顶层只剩旧版残影 →
//   框架**真存在**的内置包 `@deepseek-ai/dsh-agent-preset` / `@deepseek-ai/dsh-workflow-ptc`
//   被判成「缺失」→ 写 `disabled: true`。
//
// 本套四段（全离线：私有临时 DSH_HOME + 自己造的桩包树，不碰真实 profile、不用网络）：
//   ① 多基准解析器：框架内置包在**第二个**基准（`.pnpm` 内部那层）也能被解析到
//   ② 单基准失败**不再**导致禁用：profile 顶层解析不到、框架树能解析 → 零写盘、零禁用
//   ③ 无缺失时**零写盘**（比对文件 SHA256）
//   ④ 真缺失时**仍如实禁用**（判据不能因为修了误判就把真缺陷放过去）
// 附加：框架自带包永不自动禁用 / 解析不确定只报告 / 写盘失败如实回报 / 真机框架树断言（不可用则响亮 SKIP）

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { makePackageResolver, listAvailablePackages } = await import(new URL('../lib/server/infra/package-resolve.js', import.meta.url).href)
const { frameworkBases, isFrameworkModuleName, basePackageName } = await import(new URL('../lib/server/infra/framework-root.js', import.meta.url).href)
const { healPatchSafety, readPatchState } = await import(new URL('../lib/server/domain/patch.js', import.meta.url).href)

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ── 私有沙箱（系统临时目录；绝不用真实 DSH_HOME）────────────────────────────────
const SANDBOX = join(tmpdir(), `dsh-heal-test-${process.pid}-${Date.now()}`)
const PROFILE = join(SANDBOX, 'profiles', 'web')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const FW_TREE = join(SANDBOX, 'fw')
const FW_OUTER = join(FW_TREE, 'node_modules')                    // 含 .pnpm 的外层 node_modules
const FW_INNER = join(FW_OUTER, '.pnpm', '@deepseek-ai+dsh@0.2.0-rc.1', 'node_modules') // 框架内置包真正的家
mkdirSync(PROFILE, { recursive: true })
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

/** 造一个桩包（`<baseDir>/node_modules/<name>/package.json`）。 */
function stubPackage(baseDir, name, version = '0.0.0-test') {
  const dir = join(baseDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), 'export default {}\n')
}

/** 同上，但 baseDir **本身就是 node_modules**（拼 `<nodeModulesDir>/<name>`，不再追加 node_modules）。 */
function stubInside(nodeModulesDir, name, version = '0.0.0-test') {
  const dir = join(nodeModulesDir, ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), 'export default {}\n')
}

// 桩树（**逐段等价真机形状**，2026-09-30 实测的真机路径）：
//   真机：<npx 缓存>\node_modules\.pnpm\@deepseek-ai+dsh@0.2.0-rc.1_<hash>\node_modules\@deepseek-ai\dsh\package.json
//   所以 fixture 必须有三层同名 node_modules 的嵌套关系：
//     <FW_TREE>\node_modules\.pnpm\@deepseek-ai+dsh@0.2.0-rc.1\node_modules\@deepseek-ai\dsh\
//          ↑ 外层（含 .pnpm）        ↑ 内层（框架内置包真正的家，= frameworkBases 首项）
//   · profile 顶层 node_modules：**没有**任何 @deepseek-ai 包 —— 这正是"单基准必然失败"的现场
//   · 第三方真缺失包：哪儿都没有
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
stubPackage(PROFILE, '@linxin666/dsh-client-ui-skin-center', '1.0.0')  // 只在 profile 能解析（第三方插件）
// `@deepseek-ai/dsh` 的实体放在**内层** node_modules 里（真机 `.pnpm/<pkg>/node_modules/` 那层）——
// 于是 `dirname×3(pkgPath)` 正好落回 FW_INNER 自己，与真机逐段一致
stubInside(FW_INNER, '@deepseek-ai/dsh', '0.2.0-rc.1')
// 另外两个框架内置包放**外层** node_modules（Node 解析器从内层向上找即命中，真机同形 ——
// 真机里 `@deepseek-ai/dsh-agent-preset` 在 `.pnpm/@deepseek-ai+dsh-agent-pres_b041b5b…/node_modules/`
// 由一个 *.pnpm 实体目录符号链接到外层 node_modules）
stubPackage(FW_TREE, '@deepseek-ai/dsh-agent-preset', '0.2.0-rc.1')
stubPackage(FW_TREE, '@deepseek-ai/dsh-workflow-ptc', '0.2.0-rc.1')

// ── ① 多基准解析器 ────────────────────────────────────────────────────────────
{
  const resolve = makePackageResolver([PROFILE, FW_INNER])
  const preset = resolve('@deepseek-ai/dsh-agent-preset')
  const ptc = resolve('@deepseek-ai/dsh-workflow-ptc')
  const third = resolve('@linxin666/dsh-client-ui-skin-center')
  const gone = resolve('@deepseek-ai/dsh-workflow-worker-thread')
  check('① 框架内置包可从第二个基准（.pnpm 内部那层）解析到', preset.ok === true && /dsh-agent-preset/u.test(preset.from), JSON.stringify(preset))
  check('① 框架内置包 dsh-workflow-ptc 同样解析到', ptc.ok === true && /workflow-ptc/u.test(ptc.from), JSON.stringify(ptc))
  check('① 第三方插件包可从第一个基准（profile）解析到', third.ok === true && /skin-center/u.test(third.from), JSON.stringify(third))
  check('① 真不存在的包如实报「都解析不到」', gone.ok === false && typeof gone.reason === 'string' && gone.reason.includes('所有基准'), JSON.stringify(gone))
  check('① 空基准列表 → 一律解析不到（不得假装命中）', makePackageResolver([])('@deepseek-ai/dsh').ok === false)
  check('① 非法基准被忽略且不抛（null/空串/对象）', (() => {
    try {
      const r = makePackageResolver([null, '', {}, PROFILE])
      return r('@linxin666/dsh-client-ui-skin-center').ok === true && r('@deepseek-ai/dsh').ok === false
    } catch { return false }
  })())
  const fwBases = frameworkBases(FW_INNER, PROFILE)
  check('① frameworkBases() 取到「@deepseek-ai/dsh 那层 node_modules」+ 含 .pnpm 的上层',
    fwBases.includes(FW_INNER) && fwBases.includes(FW_OUTER) && fwBases[0] === FW_INNER, JSON.stringify(fwBases))
  check('① frameworkBases() 首个基准真的是 node_modules 目录（不是 scope 目录 —— dirname×3 而非 ×2）',
    fwBases[0].endsWith('node_modules') && existsSync(join(fwBases[0], '@deepseek-ai', 'dsh', 'package.json')), fwBases[0])
  check('① 解析器两种基准写法都收：容器基准（profile）/ node_modules 基准（FW_INNER / FW_OUTER）',
    makePackageResolver([PROFILE])('@linxin666/dsh-client-ui-skin-center').ok === true
    && makePackageResolver([FW_INNER])('@deepseek-ai/dsh-agent-preset').ok === true
    && makePackageResolver([FW_OUTER])('@deepseek-ai/dsh-agent-preset').ok === true, '三种写法各试一次')
  check('① 回归：容器基准要拼 `<base>/node_modules`，node_modules 基准要拼 `<base>` 内部 —— 不会拼出 node_modules/node_modules',
    !existsSync(join(FW_OUTER, 'node_modules'))
    && makePackageResolver([FW_INNER])('@deepseek-ai/dsh').ok === true
    && makePackageResolver([FW_INNER])('@deepseek-ai/dsh-agent-preset').ok === true,
    '内层基准必须能解析到内层的 dsh 与外层的 dsh-agent-preset')
  check('① frameworkBases() 兜底不返回空数组（离线无框架树时用 profile/base 兜底）',
    frameworkBases(PROFILE, PROFILE).length > 0, JSON.stringify(frameworkBases(PROFILE, PROFILE)))
  check('① isFrameworkModuleName 只认框架命名空间（含子路径归一）',
    isFrameworkModuleName('@deepseek-ai/dsh-agent-preset') === true
    && isFrameworkModuleName('@deepseek-ai/dsh-agent-preset/sub') === true
    && isFrameworkModuleName('@linxin666/dsh-client-ui-skin-center') === false
    && basePackageName('@deepseek-ai/dsh-x/y/z') === '@deepseek-ai/dsh-x')
  check('① listAvailablePackages 合并多基准的 node_modules（框架包 + 第三方包都在候选里）',
    (() => { const list = listAvailablePackages([join(PROFILE, 'node_modules'), FW_OUTER, join(FW_TREE, 'node_modules')]); return list.includes('@deepseek-ai/dsh-workflow-ptc') && list.includes('@deepseek-ai/dsh-agent-preset') && list.includes('@linxin666/dsh-client-ui-skin-center') })(),
    JSON.stringify(listAvailablePackages([join(FW_TREE, 'node_modules')])))
  check('① listAvailablePackages 对不存在的目录不抛、返回空数组', JSON.stringify(listAvailablePackages([join(FW_TREE, 'nope')])) === '[]')
}

// ── ② 单基准失败不再导致禁用（本事故的**直接回归**）──────────────────────────────
{
  // 现场等价：profile 顶层解析不到框架包（单基准必然失败），框架树在 .pnpm 内部那层能解析
  const text = [
    '# preset rows（用户的东西）',
    '- insert:',
    '    - id: preset-router-spec',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '    - id: preset-router-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '    - id: workflow-worker-thread',
    "      name: '@deepseek-ai/dsh-workflow-ptc'",
    '',
  ].join('\n')
  writeFileSync(PATCH, text)
  const before = sha(PATCH)
  const r = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER] })
  const after = sha(PATCH)
  check('② profile 顶层解析不到框架包时不再自动禁用（autoDisabled 为空）', Array.isArray(r.autoDisabled) && r.autoDisabled.length === 0, JSON.stringify(r.autoDisabled))
  check('② 零写盘：文件 SHA256 与修复前一致', before === after, `${before} vs ${after}`)
  check('② healedAt=0 / written=false（无修改就必须如实说无修改）', r.healedAt === 0 && r.written === false, JSON.stringify({ healedAt: r.healedAt, written: r.written }))
  check('② 文件里一个 disabled: true 都没多出来', !readFileSync(PATCH, 'utf8').includes('disabled: true'), readFileSync(PATCH, 'utf8').slice(-80))
  check('② 用 **默认推导** 的基准（不注入 bases）同样零写盘 —— profile 的 node_modules 空、框架树在 .pnpm 内层',
    await (async () => {
      const b2 = sha(PATCH)
      const r2 = await healPatchSafety(PATCH, { baseDir: FW_INNER })
      return r2.autoDisabled.length === 0 && b2 === sha(PATCH) && r2.written === false
    })(), 'healPatchSafety(PATCH, { baseDir: FW_INNER })')
}

// ── ③ 无缺失时零写盘（幂等；GET /state 每 ≤2min 调一次）─────────────────────────
{
  const text = [
    '# 全部可解析 + 一条已被用户手动禁用的行',
    '- insert:',
    '    - id: preset-router-spec',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '    - id: preset-router-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '    - id: web-ui-skin-center',
    "      name: '@linxin666/dsh-client-ui-skin-center'",
    '- id: web-ui-pet',
    '  disabled: true',
    '',
  ].join('\n')
  writeFileSync(PATCH, text)
  const before = sha(PATCH)
  const r1 = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER] })
  const mid = sha(PATCH)
  const r2 = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER] })
  const after = sha(PATCH)
  check('③ 无缺失 → 零写盘（第一次调用后 SHA256 不变）', before === mid, `${before} vs ${mid}`)
  check('③ 幂等：连续两次调用都零写盘、都 healedAt=0', before === after && r1.healedAt === 0 && r2.healedAt === 0, JSON.stringify({ a: r1.healedAt, b: r2.healedAt }))
  check('③ 已有 disabled 的行不被重复处理、也不被"复活"', r1.autoDisabled.length === 0 && r1.healed.length === 0 && readFileSync(PATCH, 'utf8').includes('- id: web-ui-pet\n  disabled: true'))
  check('③ 解析器抛异常时不写盘、只如实报告', await (async () => {
    const b = sha(PATCH)
    const r = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER], resolve: () => { throw new Error('boom') } })
    return b === sha(PATCH) && r.autoDisabled.length === 0 && r.uncertain.some((u) => /boom/u.test(String(u.reason)))
  })())
  check('③ 一个基准都没有 → 判"无法判定"、只报告不写盘', await (async () => {
    const b = sha(PATCH)
    const r = await healPatchSafety(PATCH, { bases: [], resolve: null })
    return b === sha(PATCH) && r.autoDisabled.length === 0 && r.uncertain.length > 0
  })(), JSON.stringify((await healPatchSafety(PATCH, { bases: [], resolve: null })).uncertain))
}

// ── ④ 真缺失时仍如实禁用（判据不能被修松）──────────────────────────────────────
{
  const text = [
    '# 一条真缺失的第三方行（哪儿都没有）',
    '- insert:',
    '    - id: ghost-plugin',
    "      name: '@ghost-scope/dsh-does-not-exist'",
    '    - id: preset-router-spec',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '',
  ].join('\n')
  writeFileSync(PATCH, text)
  const r = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER] })
  const after = readFileSync(PATCH, 'utf8')
  check('④ 真缺失的行仍被如实禁用', r.autoDisabled.includes('ghost-plugin'), JSON.stringify(r.autoDisabled))
  check('④ 禁用块真的写进文件且格式与既有 disableBlock 一致', after.includes('- id: ghost-plugin\n  disabled: true'), JSON.stringify(after.slice(-120)))
  check('④ 可解析的框架行**没有**被连坐禁用', !after.includes('- id: preset-router-spec\n  disabled: true'), after)
  check('④ written=true / writeError=null / healedAt>0（写盘成功要如实说成功）', r.written === true && r.writeError === null && r.healedAt > 0, JSON.stringify({ written: r.written, writeError: r.writeError, healedAt: r.healedAt }))
  check('④ 二次调用幂等（该行已 disabled → 零写盘）', await (async () => {
    const b = sha(PATCH)
    const r2 = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER] })
    return b === sha(PATCH) && r2.autoDisabled.length === 0 && r2.written === false
  })())
}

// ── ⑤ 框架自带包永不自动禁用（本事故的**根因防线**）────────────────────────────
{
  // 哪怕框架树暂时不完整（升级中途）→ @deepseek-ai/* 也只报告、绝不写 disabled: true
  const text = [
    '- insert:',
    '    - id: preset-router-react',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    "    - id: workflow-worker-thread",
    "      name: '@deepseek-ai/dsh-workflow-war-never-existed'",
    '',
  ].join('\n')
  writeFileSync(PATCH, text)
  const before = sha(PATCH)
  const r = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER] })
  check('⑤ 框架命名空间的缺失包只报告不写盘（永不自动禁用）', r.autoDisabled.length === 0 && before === sha(PATCH), JSON.stringify(r))
  check('⑤ skipped 里点名了框架自带包与原因', r.skipped.filter((s) => s.reason === 'framework-owned').length === 2, JSON.stringify(r.skipped))
  check('⑤ 该保护不误伤第三方包：同一文件里真缺失的第三方行照样被禁用', await (async () => {
    writeFileSync(PATCH, '- insert:\n    - id: ghost2\n      name: \'@ghost-scope/nope\'\n    - id: wf\n      name: \'@deepseek-ai/dsh-nope\'\n')
    const rr = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER] })
    return rr.autoDisabled.includes('ghost2') && !rr.autoDisabled.includes('wf')
  })())
}

// ── ⑥ 写盘失败如实回报（不静默）───────────────────────────────────────────────
{
  writeFileSync(PATCH, '- insert:\n    - id: ghost3\n      name: \'@ghost-scope/nope\'\n')
  const before = sha(PATCH)
  const r = await healPatchSafety(PATCH, {
    bases: [PROFILE, FW_INNER],
    writeText: async () => { throw new Error('EACCES: 模拟写盘失败') },
  })
  check('⑥ 写盘失败 → written=false / writeError 带真因', r.written === false && /EACCES/u.test(String(r.writeError)), JSON.stringify({ written: r.written, writeError: r.writeError }))
  check('⑥ 写盘失败时 healedAt=0（不能谎报已修复）', r.healedAt === 0, String(r.healedAt))
  check('⑥ 写盘失败时文件确实没变', before === sha(PATCH), `${before} vs ${sha(PATCH)}`)
  check('⑥ 写盘失败但已判定出待禁用的行（报告不丢信息）', r.autoDisabled.includes('ghost3'), JSON.stringify(r.autoDisabled))
}

// ── ⑦ 核心行误禁用仍会被恢复（既有语义不回归）─────────────────────────────────
{
  writeFileSync(PATCH, '# t\n- id: webserver\n  disabled: true\n')
  const r = await healPatchSafety(PATCH, { bases: [PROFILE, FW_INNER] })
  check('⑦ 核心行 webserver 误禁用被自动恢复且写盘', r.healed.includes('webserver') && r.written === true, JSON.stringify(r.healed))
  check('⑦ 恢复后文件里不再有该禁用块', !readFileSync(PATCH, 'utf8').includes('disabled: true'), JSON.stringify(readFileSync(PATCH, 'utf8')))
}

// ── ⑧ 真机框架树断言（本机有真实框架就真跑，没有则响亮 SKIP）──────────────────
{
  // 真机事实（2026-09-30 实测，写进注释供 CI 对照）：框架实体在
  //   <npx 缓存>\node_modules\.pnpm\@deepseek-ai+dsh@0.2.0-rc.1_<hash>\node_modules\@deepseek-ai\dsh
  // 所以"框架基准"是 `<…>/node_modules`（含 @deepseek-ai），而**不是**它的父目录。
  const realProfile = process.env.DSH_TEST_REAL_PROFILE ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', 'web')
  const real = existsSync(join(realProfile, 'cordis.patch.yml'))
  const bases = real ? frameworkBases(join(realProfile, 'node_modules'), realProfile) : []
  const realResolve = bases.length > 0 ? makePackageResolver(bases) : null
  const preset = real && realResolve !== null ? realResolve('@deepseek-ai/dsh-agent-preset') : null
  const ptc = real && realResolve !== null ? realResolve('@deepseek-ai/dsh-workflow-ptc') : null
  if (!real) {
    console.log(`SKIP ⑧ 真机框架树断言 — ${realProfile} 下没有 cordis.patch.yml（CI 无真实 profile，如实跳过，不假装 PASS）`)
  } else {
    check('⑧ 真机：框架基准首项是 node_modules 目录', String(bases[0] ?? '').endsWith('node_modules'), JSON.stringify(bases))
    check('⑧ 真机：框架内置包 @deepseek-ai/dsh-agent-preset 在多基准下可解析（修复前单基准必然失败）',
      preset?.ok === true, JSON.stringify(preset))
    check('⑧ 真机：框架内置包 @deepseek-ai/dsh-workflow-ptc 在多基准下可解析',
      ptc?.ok === true, JSON.stringify(ptc))
    check('⑧ 真机：已移除的旧包 dsh-workflow-worker-thread 仍如实报"解析不到"（多基准没把判据放水）',
      realResolve('@deepseek-ai/dsh-workflow-worker-thread').ok === false, JSON.stringify(realResolve('@deepseek-ai/dsh-workflow-worker-thread')))
  }
  // 无条件断言（不依赖真机）：单基准失败 + 多基准命中 —— 这正是本事故的判据缺口
  check('⑧ 事故判据回归：只在 .pnpm 内层的包，单基准失败而多基准命中', (() => {
    const single = makePackageResolver([PROFILE])('@deepseek-ai/dsh-agent-preset').ok
    const multi = makePackageResolver([PROFILE, FW_INNER])('@deepseek-ai/dsh-agent-preset').ok
    return single === false && multi === true
  })())
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
