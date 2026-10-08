// 「pnpm 执行方式按目标 profile 的声明版本选」——唯一判据承担者（infra/pnpm-runner-pick.js），进 CI Unit 硬门槛。
//
// 真机现场（2026-10-08，官方桌面端 desktop profile）：
//   · `resolvePnpmRunners()` 在普通 node 进程里第一命中 `node-corepack` → corepack 自己那版 pnpm（本机 11.21.0）；
//   · 该 profile 的 node_modules 却是**桌面端自带运行时**那份 pnpm 建的（`<resources>\runtime\pnpm`，本机 11.7.0），
//     `node_modules/.modules.yaml` 的 `packageManager` 如实记着 `pnpm@11.7.0`。
//   ⇒ 版本错配 → 新版 pnpm 判链接/peer 状态漂移 → 重新导入 `@deepseek-ai` 的包
//     → Windows rename 覆盖已存在目录 → `ERR_PNPM_EPERM` → 卡满 120s 超时被杀 + 留 `*_tmp_<pid>_<n>` 僵尸目录；
//     换匹配那份同一操作 0.8–1.4 秒成功。
//
// 本套钉死的语义（全离线，IO 全部注入，**不在任何 profile 里跑 pnpm**）：
//   正控：声明 11.7.0 ⇒ 选中桌面端那份（提到最前）· 负控：声明 11.21.0 ⇒ 选中 corepack 那份
//   无 `.modules.yaml` / 读不出 / 只有一个候选 ⇒ **逐项等于既有顺序**（不倒退）
//   版本读不出来的 runner（PATH 上的 shim/全局 pnpm）永不被提升 · 平局（都在首位）不搬家
//   接线：runPnpmWithFallback 的首选 === 选择器的首选（判据没有第二份）
//   真机只读判据：本机确有 desktop profile 时，选出来的那份必须真的与声明版本一致（无则**响亮 SKIP**）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePnpmRunners, runPnpmWithFallback, pnpmRunnersFor } from '../lib/server/infra/exec.js'
import { modulesYamlPnpmVersion, runnerPnpmVersion, selectPnpmRunners } from '../lib/server/infra/pnpm-runner-pick.js'

let pass = 0
let fail = 0
let skip = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
const skips = (name, why) => { skip += 1; console.log(`SKIP ${name} — ${why}`) }
const kinds = (runners) => runners.map((r) => r.kind).join(',')

// ── 夹具：一张"只读文件表" + 注入 readFile/exists（零真实 IO、零网络、零 pnpm 调用）─────────────
const profileDir = join('C:', 'Users', 'u', '.dsh', 'profiles', 'desktop')
const corepackHome = join('C:', 'Users', 'u', 'AppData', 'Local', 'node', 'corepack')
const resourcesPath = join('C:', 'Harness', 'resources')
const pnpmMjs = join(resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
const desktopPkgJson = join(resourcesPath, 'runtime', 'pnpm', 'package.json')
const corepackJs = join('C:', 'Program Files', 'nodejs', 'node_modules', 'corepack', 'dist', 'corepack.js')
const execPath = join('C:', 'Program Files', 'nodejs', 'node.exe')
const env = { PATH: join('C:', 'tools'), LOCALAPPDATA: join('C:', 'Users', 'u', 'AppData', 'Local') }
const home = join('C:', 'Users', 'u')

const modulesYaml = (pnpmVersion) => `{
  "hoistPattern": [
    "*"
  ],
  "layoutVersion": 5,
  "packageManager": "pnpm@${pnpmVersion}",
  "storeDir": "C:\\\\store\\\\v11"
}
`
const files = {
  [join(profileDir, 'node_modules', '.modules.yaml')]: modulesYaml('11.7.0'),
  [join(profileDir, 'package.json')]: JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {} }),
  [pnpmMjs]: '// 桌面端自带运行时的 pnpm 入口（夹具：内容无关，只要"存在"）\n',
  [desktopPkgJson]: JSON.stringify({ name: 'pnpm', version: '11.7.0' }),
  [join(corepackHome, 'lastKnownGood.json')]: JSON.stringify({ pnpm: '11.21.0+sha512.521705bce689924eac72f5a3587122f362689ef6571e55ba80076fd637c11132ecffada26fad4ea79c485bfddbfd3d5a2a5b05805a77e893de71ec8a6cca3bb1' }),
}
const readerOf = (map) => (path) => {
  if (Object.hasOwn(map, path)) return map[path]
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
}
const readFile = readerOf(files)
const exists = (path) => Object.hasOwn(files, path) || path === corepackJs
const resolveOpts = { platform: 'win32', execPath, comspec: 'cmd.exe', exists, env, resourcesPath, delimiter: ';' }
const pickOpts = (profile = profileDir, map = files) => ({
  profileDir: profile,
  readFile: readerOf(map),
  env,
  home,
  platform: 'win32',
})

const runners = resolvePnpmRunners(resolveOpts)
const [corepackRunner, desktopRunner] = [runners.find((r) => r.kind === 'node-corepack'), runners.find((r) => r.kind === 'desktop-pnpm-mjs')]

// ── ① 候选清单本身没被改动（既有顺序：node-corepack → 桌面端 → cmd-corepack）────────────────
check('① 夹具里既有候选顺序不变（node-corepack,desktop-pnpm-mjs,cmd-corepack）',
  kinds(runners) === 'node-corepack,desktop-pnpm-mjs,cmd-corepack', kinds(runners))

// ── ② 版本判据（唯一来源：.modules.yaml / corepack 规则 / pnpm.mjs 同级 package.json）────────
{
  check('② 目标版本 = .modules.yaml 的 packageManager', modulesYamlPnpmVersion(profileDir, (p) => files[p]) === '11.7.0', String(modulesYamlPnpmVersion(profileDir, (p) => files[p])))
  const probe = (runner) => runnerPnpmVersion(runner, pickOpts())
  check('② corepack 那份 = lastKnownGood.json（项目没声明 packageManager 时；+sha512 后缀被剥掉）',
    probe(corepackRunner) === '11.21.0', String(probe(corepackRunner)))
  check('② 桌面端那份 = <resources>\\runtime\\pnpm\\package.json 的 version',
    probe(desktopRunner) === '11.7.0', String(probe(desktopRunner)))
  const declared = { ...files, [join(profileDir, 'package.json')]: JSON.stringify({ name: 'x', packageManager: 'pnpm@11.21.0' }) }
  check('② corepack 规则：项目 packageManager 字段优先于 lastKnownGood（corepack 自己的解析顺序）',
    probe(corepackRunner) === '11.21.0' && runnerPnpmVersion(corepackRunner, pickOpts(profileDir, declared)) === '11.21.0', String(runnerPnpmVersion(corepackRunner, pickOpts(profileDir, declared))))
  // PATH 上的 pnpm.cmd / pnpm：版本不可静态判定 ⇒ null（绝不猜）
  const cmdPnpm = resolvePnpmRunners({ ...resolveOpts, exists: (p) => p === join('C:', 'tools', 'pnpm.cmd') })
  check('② 版本读不出来的 runner（cmd-pnpm）判据是 null，不猜版本',
    cmdPnpm[0]?.kind === 'cmd-pnpm' && runnerPnpmVersion(cmdPnpm[0], pickOpts()) === null, `${cmdPnpm[0]?.kind} :: ${String(runnerPnpmVersion(cmdPnpm[0], pickOpts()))}`)
}

// ── ③ 正控：声明 11.7.0 ⇒ 桌面端那份被提到最前（其余相对顺序不变）────────────────────────────
{
  const picked = selectPnpmRunners(runners, pickOpts())
  check('③ 正控：声明 11.7.0 ⇒ 选中桌面端那份（提到最前）',
    picked[0]?.kind === 'desktop-pnpm-mjs' && kinds(picked) === 'desktop-pnpm-mjs,node-corepack,cmd-corepack', kinds(picked))
  check('③ 正控：选中的那份真的与声明版本一致（不是搬了个不匹配的上来）',
    runnerPnpmVersion(picked[0], pickOpts()) === modulesYamlPnpmVersion(profileDir, (p) => files[p]), String(runnerPnpmVersion(picked[0], pickOpts())))
  check('③ 正控：既有的第一个候选仍在清单里、没有被删（只是顺序变了）',
    picked.includes(corepackRunner) && picked.length === runners.length, `${picked.length}/${runners.length}`)
  // 混进"版本读不出来"的候选：相对顺序照旧，且**永不**被提升
  const mixed = [...runners, { kind: 'cmd-pnpm', note: 'cmd /c pnpm', run: () => ({ bin: 'cmd.exe', argv: [] }) }]
  const pickedMixed = selectPnpmRunners(mixed, pickOpts())
  check('③ 混入 cmd-pnpm（版本不可判定）时：仍是桌面端那份最前，未知版本者排在后面且相对顺序不变',
    kinds(pickedMixed) === 'desktop-pnpm-mjs,node-corepack,cmd-corepack,cmd-pnpm', kinds(pickedMixed))
}

// ── ④ 负控：声明 11.21.0 ⇒ 选中 corepack 那份（桌面端**不许**被无条件提升）────────────────────
{
  const yaml = { ...files, [join(profileDir, 'node_modules', '.modules.yaml')]: modulesYaml('11.21.0') }
  const picked = selectPnpmRunners(runners, pickOpts(profileDir, yaml))
  check('④ 负控：声明 11.21.0 ⇒ corepack 那份就是首选（桌面端不被提升）',
    picked[0]?.kind === 'node-corepack' && kinds(picked) === kinds(runners), `${kinds(picked)} :: 首选版本=${String(runnerPnpmVersion(picked[0], pickOpts(profileDir, yaml)))}`)
  check('④ 负控：选中的那份真的与声明版本一致（驱动器是版本，不是"总选桌面端"）',
    runnerPnpmVersion(picked[0], pickOpts(profileDir, yaml)) === '11.21.0', String(runnerPnpmVersion(picked[0], pickOpts(profileDir, yaml))))
  // corepack 不在首位时也必须能被提升（证明提升逻辑对"非首个匹配者"同样生效）
  const unknown = { kind: 'path-pnpm', note: 'pnpm（PATH）', run: () => ({ bin: 'pnpm', argv: [] }) }
  const reordered = selectPnpmRunners([unknown, desktopRunner, corepackRunner], pickOpts(profileDir, yaml))
  check('④ 负控：匹配者不在首位 ⇒ 被提到最前，其余相对顺序不变（unknown,desktop 保持前后关系）',
    kinds(reordered) === 'node-corepack,path-pnpm,desktop-pnpm-mjs', kinds(reordered))
  // 平局语义：项目 packageManager 声明 11.7.0 ⇒ corepack 也会跑 11.7.0，此时**顺序不变**（先在者优先）
  const tied = { ...files, [join(profileDir, 'package.json')]: JSON.stringify({ name: 'x', packageManager: 'pnpm@11.7.0' }) }
  const pickedTie = selectPnpmRunners(runners, pickOpts(profileDir, tied))
  check('④ 平局（两个候选版本都与声明一致）⇒ 既有顺序优先，不作无谓搬家',
    kinds(pickedTie) === kinds(runners), kinds(pickedTie))
}

// ── ⑤ 不倒退：读不出声明版本 ⇒ 逐项等于既有顺序（同一个数组，零变化）─────────────────────────
{
  const noYaml = { ...files }
  delete noYaml[join(profileDir, 'node_modules', '.modules.yaml')]
  const picked = selectPnpmRunners(runners, pickOpts(profileDir, noYaml))
  check('⑤ 无 .modules.yaml ⇒ 退回既有顺序（同一个数组引用，逐项不变）',
    picked === runners && kinds(picked) === kinds(runners), kinds(picked))
  check('⑤ 无 .modules.yaml ⇒ modulesYamlPnpmVersion 判据是 null（读不出来就不猜）',
    modulesYamlPnpmVersion(profileDir, readerOf(noYaml)) === null)
  const junk = { ...files, [join(profileDir, 'node_modules', '.modules.yaml')]: '{ "packageManager": "npm@10.0.0" }\n' }
  check('⑤ 声明不是 pnpm（如 npm@…）/ 字段缺失 ⇒ 同样退回既有顺序',
    selectPnpmRunners(runners, pickOpts(profileDir, junk)) === runners
    && selectPnpmRunners(runners, pickOpts(profileDir, { ...files, [join(profileDir, 'node_modules', '.modules.yaml')]: '{}\n' })) === runners)
  check('⑤ 没给 profileDir / 只有 1 个候选 ⇒ 原样返回（不越界、不重排）',
    selectPnpmRunners(runners, { readFile, env, home, platform: 'win32' }) === runners
    && selectPnpmRunners([desktopRunner], pickOpts())[0] === desktopRunner)
  check('⑤ 坏输入（null / 非数组）⇒ 返回空清单，绝不抛',
    Array.isArray(selectPnpmRunners(null, pickOpts())) && selectPnpmRunners(null, pickOpts()).length === 0)
}

// ── ⑥ 接线：runPnpmWithFallback 的首选 === 选择器的首选（判据没有第二份实现）─────────────────
// 全部离线：runner 清单由夹具注入（runnerOpts 是既有 exists/env/resourcesPath 注入口的直通），
// 所以"声明 11.7.0 必须首选桌面端那份"这条强判据在 CI（Linux、无桌面端运行时）上也照样钉得住。
{
  const attempts = []
  const seen = []
  const enoent = async (bin, argv, opts) => {
    attempts.push(bin)
    seen.push(argv)
    throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' })
  }
  const seam = { ...resolveOpts, readFile, home }
  const caught = await runPnpmWithFallback(['add', 'left-pad'], { profileDir, runnerOpts: seam, execOpts: { cwd: profileDir }, exec: enoent })
    .then(() => null, (e) => e)
  const expected = pnpmRunnersFor(profileDir, seam)
  check('⑥ 接线：候选清单与"选择器 + 既有候选解析"逐项一致（首选=' + String(expected[0]?.kind) + '）',
    attempts.join('|') === expected.map((r) => r.run(['add', 'left-pad']).bin).join('|'), `${attempts.length} 次尝试`)
  check('⑥ 接线（正控，跨平台离线可跑）：profile 声明 11.7.0 ⇒ 第一次尝试就是桌面端运行时（node --expose-internals <pnpm.mjs>）',
    expected[0]?.kind === 'desktop-pnpm-mjs' && attempts[0] === execPath
    && seen[0]?.[0] === '--expose-internals' && String(seen[0]?.[1]).endsWith(join('runtime', 'pnpm', 'bin', 'pnpm.mjs')), `${String(expected[0]?.kind)} :: ${String(seen[0]?.[1])}`)
  check('⑥ 接线：候选全不可用时仍如实抛错并列出已尝试清单（既有兜底语义未变）',
    /已尝试：/u.test(caught?.message ?? '') && /ENOENT/u.test(caught?.message ?? ''), String(caught?.message ?? '').slice(0, 90))
  // 负控：同一套夹具、把声明换成 11.21.0 ⇒ 第一次尝试必须是 corepack 那份（不许无条件选桌面端）
  const yaml21 = { ...files, [join(profileDir, 'node_modules', '.modules.yaml')]: modulesYaml('11.21.0') }
  const attempts21 = []
  const enoent21 = async (bin) => { attempts21.push(bin); throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }) }
  await runPnpmWithFallback(['--version'], {
    profileDir, runnerOpts: { ...resolveOpts, readFile: readerOf(yaml21), home }, execOpts: { cwd: profileDir }, exec: enoent21,
  }).then(() => null, (e) => e)
  const expected21 = pnpmRunnersFor(profileDir, { ...resolveOpts, readFile: readerOf(yaml21), home })
  check('⑥ 接线（负控）：声明 11.21.0 ⇒ 第一次尝试是 corepack 那份（选择判据随版本走，不硬编码桌面端）',
    expected21[0]?.kind === 'node-corepack' && attempts21[0] === execPath && attempts21.join('|') === expected21.map((r) => r.run(['--version']).bin).join('|'),
    `${String(expected21[0]?.kind)} :: 尝试 ${attempts21.length} 次`)
  // 不传 profileDir ⇒ 与旧的 resolvePnpmRunners() 逐项相同（不倒退）
  const attemptsBare = []
  const enoentBare = async (bin) => { attemptsBare.push(bin); throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }) }
  await runPnpmWithFallback(['--version'], { exec: enoentBare }).then(() => null, (e) => e)
  const bareExpected = resolvePnpmRunners()
  check('⑥ 接线（不倒退）：不传 profileDir ⇒ 依次尝试的就是 resolvePnpmRunners() 的既有清单',
    attemptsBare.join('|') === bareExpected.map((r) => r.run(['--version']).bin).join('|'), `${attemptsBare.length} 次`)
}

// ── ⑦ 真机只读判据：本机确有 desktop profile 时，选出来的那份必须真与它声明的版本一致 ─────────
// （**只读**：读 .modules.yaml + 各 runner 的 package.json；绝不在这里跑 pnpm，更不写 profile）
{
  const liveHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const liveProfile = join(liveHome, 'profiles', 'desktop')
  const declared = modulesYamlPnpmVersion(liveProfile)
  if (declared === null) {
    skips('⑦ 真机只读判据', `本机没有 ${liveProfile}\\node_modules\\.modules.yaml（CI 常态），不假装 PASS`)
  } else {
    const liveRunners = resolvePnpmRunners()
    const before = kinds(liveRunners)
    const picked = selectPnpmRunners(liveRunners, { profileDir: liveProfile })
    const probes = picked.map((r) => `${r.kind}=${String(runnerPnpmVersion(r, { profileDir: liveProfile }))}`).join(' ')
    console.log(`   真机（只读）：profile 声明 pnpm@${declared}｜既有顺序=${before}｜选后顺序=${kinds(picked)}｜各候选版本=${probes}`)
    check('⑦ 真机只读判据：候选一个都没丢（只是顺序可能变）',
      picked.length === liveRunners.length && liveRunners.every((r) => picked.includes(r)), `${picked.length}/${liveRunners.length}`)
    // 只读自证：跑完这一段后，profile 里的判据文件读回逐字节一致（本套全程没写过 profile）
    const again = modulesYamlPnpmVersion(liveProfile)
    check('⑦ 真机只读判据：判据文件读回逐字节一致（本套不写 profile）', again === declared, String(again))
    const first = pnpmRunnersFor(liveProfile)[0]?.kind
    check('⑦ 真机只读判据：exec.pnpmRunnersFor() 与选择器同结论（唯一判据承担者）',
      first === picked[0]?.kind, `pnpmRunnersFor=${String(first)} select=${String(picked[0]?.kind)}`)
    // 强判据只在"这个进程真能看到桌面端运行时"时成立：Electron 宿主有 process.resourcesPath，
    // 普通 node 进程看不到（这正是本机 CLI 场景）。看不到就**响亮 SKIP** —— 但那时必须证明"不倒退"。
    const desktopVisible = liveRunners.some((r) => r.kind === 'desktop-pnpm-mjs')
    if (desktopVisible) {
      check('⑦ 真机只读判据：选出的首选 runner 的版本 === profile 声明的版本（真的匹配，不是碰巧）',
        runnerPnpmVersion(picked[0], { profileDir: liveProfile }) === declared, `${picked[0]?.kind} :: ${String(runnerPnpmVersion(picked[0], { profileDir: liveProfile }))} vs ${declared}`)
    } else {
      skips('⑦ 真机强判据（选中的必须版本匹配）', '本进程看不到桌面端运行时候选（普通 node 无 process.resourcesPath，非 Electron 宿主）→ 由探针脚本显式给出 resourcesPath 验证')
      check('⑦ 真机只读判据（看不到桌面端运行时的场合）：顺序逐项不变 = 不倒退',
        kinds(picked) === before && picked === liveRunners, `${before} ⇒ ${kinds(picked)}`)
    }
  }
}

console.log(fail === 0 ? `\nALL PASS（${pass} 条，SKIP ${skip} 条）` : `\n${fail} FAILED（共 ${pass + fail} 条）`)
process.exit(fail === 0 ? 0 : 1)
