// L0 · infra（边界由 tests/test-architecture-guard.mjs 断言）
//
// 「选哪个 pnpm 执行方式」的**唯一判据承担者**（2026-10-08 加法，只此一处，调用点不许各写一份）。
//
// 现场（官方桌面端 desktop profile，上一批实测结论）：
//   · 控制台 `resolvePnpmRunners()` 在普通 node 进程里第一命中 `node-corepack` → corepack 自己那版 pnpm
//     （本机实测 11.21.0：corepack 的 lastKnownGood.json，见下）；
//   · 而该 profile 的 node_modules 是**桌面端自带运行时**那份 pnpm 建出来的
//     （`<resources>\runtime\pnpm`，本机实测 11.7.0），`.modules.yaml` 的 packageManager 如实记着 `pnpm@11.7.0`。
//   ⇒ 版本错配：新版 pnpm 判定链接/peer 状态漂移 ⇒ 重新导入 `@deepseek-ai` 的 schedule 包
//     ⇒ Windows 上 rename 覆盖已存在目录 → `ERR_PNPM_EPERM` ⇒ 卡满 120s 被超时杀掉，
//     还留下 `<包名>_tmp_<pid>_<n>` 僵尸目录；换**匹配那份**（桌面端 11.7.0）同一操作 0.8–1.4 秒成功。
//
// 本模块只做一件事：把"版本与目标 profile 声明一致"的 runner **提到最前**，其余顺序逐项不变。
//   · 匹配不到 / 版本读不出来 / 没给 profileDir ⇒ **原样返回既有顺序**（行为不倒退）；
//   · **不新增**"拒绝执行"分支：真正跑不起来照旧由 `runPnpmWithFallback` 如实抛出，
//     既有超时/回滚语义一个字不动。
// 版本判据全部是**只读静态读取**（不 spawn pnpm，不碰 profile 里的任何文件）：
//   · 目标版本 = `<profileDir>/node_modules/.modules.yaml` 的 `"packageManager": "pnpm@x.y.z"`；
//   · `node-corepack` / `cmd-corepack` = corepack 自己的解析规则：项目 package.json 的 `packageManager`
//     字段优先，否则 corepack home 的 `lastKnownGood.json`（照抄 corepack 0.34.5
//     `dist/lib/corepack.cjs#getCorepackHomeFolder / getDefaultVersion`）；
//   · `desktop-pnpm-mjs` / `path-pnpm-mjs` = `<…>/pnpm/bin/pnpm.mjs` 同级那份 pnpm 的 package.json version；
//   · `cmd-pnpm` / `path-pnpm`（PATH 上的 shim/全局安装）版本不可静态判定 ⇒ null ⇒ 不参与匹配（绝不猜）。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PNPM_SPEC_RE = /^pnpm@(.+)$/u

/** 只读读取（任何异常都当"读不出来"，绝不抛给调用方）。 */
function readText(readFile, path) {
  try {
    return String(readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** 目标 profile 声明/记录的 pnpm 版本（`node_modules/.modules.yaml` 的 packageManager）。
 *  这就是"该用哪版 pnpm"的唯一事实来源：它是 pnpm 自己写下的、建出这棵 node_modules 的那版。 */
function modulesYamlPnpmVersion(profileDir, readFile = readFileSync) {
  if (typeof profileDir !== 'string' || profileDir === '') return null
  const text = readText(readFile, join(profileDir, 'node_modules', '.modules.yaml'))
  return text === null ? null : text.match(/"packageManager"\s*:\s*"pnpm@([^"]+)"/u)?.[1] ?? null
}

/** 某个 package.json 的 `packageManager` 字段里的 pnpm 版本（corepack 的"项目声明优先"规则）。 */
function packageManagerPnpmVersion(dir, readFile = readFileSync) {
  if (typeof dir !== 'string' || dir === '') return null
  const text = readText(readFile, join(dir, 'package.json'))
  if (text === null) return null
  try {
    return String(JSON.parse(text).packageManager ?? '').match(PNPM_SPEC_RE)?.[1] ?? null
  } catch {
    return null
  }
}

/** corepack home 目录（逐字照抄 corepack 0.34.5 的 getCorepackHomeFolder）。 */
function corepackHomeDir({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const explicit = env?.COREPACK_HOME
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const cache = env?.XDG_CACHE_HOME ?? env?.LOCALAPPDATA ?? join(home, platform === 'win32' ? 'AppData/Local' : '.cache')
  return join(cache, 'node', 'corepack')
}

/** `node <corepack.js> pnpm` 会跑哪一版 pnpm：项目 packageManager 字段优先，
 *  否则 corepack 的 `lastKnownGood.json`（值形如 `11.21.0+sha512.…`，取 `+` 之前那截）。 */
function corepackPnpmVersion({ profileDir = null, readFile = readFileSync, env = process.env, home = homedir(), platform = process.platform } = {}) {
  const declared = packageManagerPnpmVersion(profileDir, readFile)
  if (declared !== null) return declared
  const text = readText(readFile, join(corepackHomeDir({ env, home, platform }), 'lastKnownGood.json'))
  if (text === null) return null
  try {
    const value = String(JSON.parse(text).pnpm ?? '')
    return value.split('+')[0] === '' ? null : value.split('+')[0]
  } catch {
    return null
  }
}

/** `<…>/pnpm/bin/pnpm.mjs` 那份 pnpm 自己的版本（读它上一层目录的 package.json）。 */
function mjsPnpmVersion(mjsPath, readFile = readFileSync) {
  if (typeof mjsPath !== 'string' || mjsPath === '') return null
  const text = readText(readFile, join(dirname(dirname(mjsPath)), 'package.json'))
  if (text === null) return null
  try {
    const version = String(JSON.parse(text).version ?? '')
    return version === '' ? null : version
  } catch {
    return null
  }
}

/** 某个 runner 会跑哪一版 pnpm（null = 读不出来 ⇒ 不参与匹配，绝不猜）。 */
function runnerPnpmVersion(runner, opts = {}) {
  const kind = String(runner?.kind ?? '')
  if (kind === 'node-corepack' || kind === 'cmd-corepack') return corepackPnpmVersion(opts)
  if (kind.endsWith('-pnpm-mjs')) {
    let mjs = null
    try {
      // run([]) 只是"生成命令行"的纯函数（不 spawn）；两种形态的 argv 里都带 <…>\pnpm\bin\pnpm.mjs
      mjs = runner.run([]).argv.find((a) => typeof a === 'string' && a.endsWith('pnpm.mjs')) ?? null
    } catch {
      mjs = null
    }
    return mjsPnpmVersion(mjs, opts.readFile)
  }
  return null
}

/** 「选哪个 runner」的唯一判据：与目标 profile 声明版本一致的 runner 提到最前，其余相对顺序不变。
 *  返回的可能是**同一个数组**（无可提升时零拷贝、零顺序变化）。
 *  `runners` 由 infra/exec.js#resolvePnpmRunners 产出；`profileDir` 就是这次 pnpm 操作的目标 profile。 */
function selectPnpmRunners(runners, { profileDir = null, readFile = readFileSync, env = process.env, home = homedir(), platform = process.platform } = {}) {
  const list = Array.isArray(runners) ? runners : []
  const target = modulesYamlPnpmVersion(profileDir, readFile)
  if (target === null || list.length < 2) return list
  const opts = { profileDir, readFile, env, home, platform }
  const hit = list.find((runner) => runnerPnpmVersion(runner, opts) === target)
  // 匹配不到、或本来就排在首位 ⇒ 与既有顺序逐项相同（不倒退、不新增拒绝分支）
  if (hit === undefined || list[0] === hit) return list
  return [hit, ...list.filter((r) => r !== hit)]
}

export {
  corepackHomeDir, corepackPnpmVersion, mjsPnpmVersion, modulesYamlPnpmVersion,
  packageManagerPnpmVersion, runnerPnpmVersion, selectPnpmRunners,
}
