// 0.5.48 · pnpm 执行方式：DSH 运行时装那份必须能被**普通 node 进程**发现并选中。
//
// 缺陷②现场：`resolvePnpmRunners()` 原来只有两条"找本机那份 pnpm"的线索 ——
//   ① Electron 的 `process.resourcesPath`（只有桌面端宿主有）
//   ② PATH 里的 `<…>\runtime\pnpm\bin` / `<…>\runtime\bin`（只有桌面端 host 塞过 PATH 才有）
// 而控制台的安装动作是在**普通 node 服务进程**里跑的 ⇒ 两条线索一条都没有 ⇒ 落到候选表最前面的
// `node-corepack` ⇒ 跑 corepack 自己解析出的那版 pnpm（本机实测 11.21.0），
// 而 profile 的 node_modules 是**声明的那版**建的（`.modules.yaml` 写着 pnpm@11.7.0）
// ⇒ 版本错配 ⇒ Windows 上 rename 覆盖已存在目录 ⇒ ERR_PNPM_EPERM（这条缺陷的真实后果）。
//
// 本机实据（两份都在，且都是 profile 声明的那版 11.7.0）：
//   · ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm
//   · <桌面端安装目录>/resources/runtime/pnpm
//
// 本套钉死的语义（**全离线**：无 spawn、无网络；`exists` 全注入）：
//   正控：声明 11.7.0 ⇒ 选中本机那份（提到最前）
//   负控：声明 11.21.0 ⇒ 选中 corepack 那份
//   回落：两份都找不到 / 读不出声明版本 ⇒ **既有顺序逐项不变**（不倒退、不新增拒绝分支）
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { resolvePnpmRunners, pnpmRunnersFor } from '../lib/server/infra/exec.js'
import { selectPnpmRunners, runnerPnpmVersion, modulesYamlPnpmVersion } from '../lib/server/infra/pnpm-runner-pick.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

// ── 夹具：一张"只读文件表"（零真实 IO）────────────────────────────────────────
const home = join('C:', 'Users', 'u')
const dshHome = join(home, '.dsh')
const runtimeMjs = join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const runtimePkg = join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'package.json')
const corepackHome = join(home, 'AppData', 'Local', 'node', 'corepack')
const corepackJs = join('C:', 'Program Files', 'nodejs', 'node_modules', 'corepack', 'dist', 'corepack.js')
const profileDir = join(dshHome, 'profiles', 'web')
const modulesYaml = (v) => `{\n  "packageManager": "pnpm@${v}"\n}\n`

/** 只读文件表读取器（缺文件抛 ENOENT —— 与真实 readFileSync 同形，判据不能靠"读不到返回 undefined"）。 */
const readerOf = (map) => (path) => {
  if (Object.hasOwn(map, path)) return map[path]
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
}

function fixture({ declarePnpm = '11.7.0', runtimeVersion = '11.7.0', corepackVersion = '11.21.0', hasRuntime = true } = {}) {
  const files = {
    [corepackJs]: '// corepack',
    [join(corepackHome, 'lastKnownGood.json')]: JSON.stringify({ pnpm: `${corepackVersion}+sha512.abc` }),
    [join(profileDir, 'package.json')]: JSON.stringify({ name: 'dsh-profile-web', private: true }),
  }
  if (declarePnpm !== null) files[join(profileDir, 'node_modules', '.modules.yaml')] = modulesYaml(declarePnpm)
  if (hasRuntime) {
    files[runtimeMjs] = '// runtime pnpm entry'
    files[runtimePkg] = JSON.stringify({ name: 'pnpm', version: runtimeVersion })
  }
  return files
}

/** 模拟**普通 node 进程**：没有 resourcesPath、PATH 里没有 runtime\bin。 */
const plainNodeOpts = (files) => ({
  platform: 'win32',
  execPath: join('C:', 'Program Files', 'nodejs', 'node.exe'),
  env: { PATH: join('C:', 'Windows'), LOCALAPPDATA: join(home, 'AppData', 'Local') },
  resourcesPath: undefined,
  delimiter: ';',
  nodeBin: 'node',
  home, // 注入 home ⇒ dshHome 落在夹具里（生产默认值仍是真实 homedir()）
  readFile: readerOf(files),
  exists: (p) => Object.hasOwn(files, p),
})

// ── ① 候选发现：普通 node 进程也要能找到本机那份 ───────────────────────────────
{
  const files = fixture()
  const runners = resolvePnpmRunners(plainNodeOpts(files))
  const kinds = runners.map((r) => r.kind)
  check('★ 普通 node 进程（无 resourcesPath / PATH 无 runtime）也能发现本机那份 pnpm',
    kinds.includes('runtime-pnpm-mjs'), kinds.join(','))
  const rt = runners.find((r) => r.kind === 'runtime-pnpm-mjs')
  check('形态正确：用 node 跑 pnpm.mjs（不带 ELECTRON_RUN_AS_NODE —— 那不是 Electron 二进制）',
    rt !== undefined && rt.run([]).bin === 'node'
    && rt.run([]).argv[0] === runtimeMjs
    && rt.run([]).env === undefined,
    JSON.stringify(rt?.run([]) ?? null))
  check('找不到那份时不产生该候选（不凭想象造候选）',
    resolvePnpmRunners(plainNodeOpts(fixture({ hasRuntime: false }))).every((r) => r.kind !== 'runtime-pnpm-mjs'))
}

// ── ② 正控：声明 11.7.0 ⇒ 选中本机那份（版本判据的核心）─────────────────────────
{
  const files = fixture({ declarePnpm: '11.7.0', runtimeVersion: '11.7.0', corepackVersion: '11.21.0' })
  const opts = plainNodeOpts(files)
  const picked = pnpmRunnersFor(profileDir, opts)
  check('★ 正控：声明 11.7.0 ⇒ 首选 = 本机运行时装那份 11.7.0（而不是 corepack 的 11.21.0）',
    picked[0].kind === 'runtime-pnpm-mjs', `first=${picked[0].kind}`)
  check('★ 判据来源正确：选择器认识 runtime-pnpm-mjs 的版本',
    runnerPnpmVersion(picked[0], { readFile: (p) => { if (!Object.hasOwn(files, p)) throw new Error('ENOENT'); return files[p] } }) === '11.7.0')
}

// ── ③ 负控：声明 11.21.0 ⇒ 选中 corepack 那份 ─────────────────────────────────
{
  const files = fixture({ declarePnpm: '11.21.0', runtimeVersion: '11.7.0', corepackVersion: '11.21.0' })
  const picked = pnpmRunnersFor(profileDir, plainNodeOpts(files))
  check('★ 负控：声明 11.21.0 ⇒ 首选 = corepack 那份（本机那份 11.7.0 不该被选中）',
    picked[0].kind === 'node-corepack', `first=${picked[0].kind}`)
}

// ── ④ 回落：读不出声明版本 / 那份不存在 ⇒ 既有顺序逐项不变 ──────────────────────
{
  const noDeclare = fixture({ declarePnpm: null })
  const base = resolvePnpmRunners(plainNodeOpts(noDeclare))
  const picked = pnpmRunnersFor(profileDir, plainNodeOpts(noDeclare))
  check('★ 读不出声明版本 ⇒ 顺序与 resolvePnpmRunners() **逐项相同**（不倒退）',
    picked.map((r) => r.kind).join(',') === base.map((r) => r.kind).join(','),
    picked.map((r) => r.kind).join(','))

  const missing = fixture({ hasRuntime: false })
  const picked2 = pnpmRunnersFor(profileDir, plainNodeOpts(missing))
  check('那份不存在 ⇒ 照样回落（首选中 corepack），不抛错、不新增拒绝分支',
    picked2[0].kind === 'node-corepack')
  check('选择器对空/单元素输入安全返回',
    selectPnpmRunners([], { profileDir }) .length === 0
    && selectPnpmRunners([{ kind: 'x', note: 'x', run: () => ({ bin: 'n', argv: [] }) }], { profileDir }).length === 1)
}

// ── ⑤ 真机只读判据：本机确有那份时，选出来的必须真的是声明版本 ────────────────────
{
  // 这一条只读真实文件系统（不 spawn、不写、不联网）；本机没有那份就**响亮 SKIP**。
  const real = join(process.env.USERPROFILE ?? home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  const realRunners = resolvePnpmRunners()
  const found = realRunners.find((r) => r.kind === 'runtime-pnpm-mjs')
  if (found === undefined) {
    console.log(`SKIP 真机只读判据 — 本机没有 ${real}（这份由 DSH 运行时装提供）`)
  } else {
    check('★ 真机只读：本机确有运行时装 pnpm ⇒ 候选里出现它，且路径就是那份',
      found.run([]).argv[0].toLowerCase() === real.toLowerCase(), found.run([]).argv[0])
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(`${fail} FAILED`); process.exit(1) }
