// 依赖锁体检 / 重建的**离线**单测（2026-09-27 加法）
//
// 被测对象：lib/server/domain/lockfile-health.js（L1 domain：纯函数 + 注入 IO 的编排）
//   · 纯函数：readManifestDeps / parseLockImporters / diffLockfile / freshReleases / probeVerdict /
//     specSatisfiedBy / repairArgsFor / summarizeCheck；
//   · 编排：runLockfileCheck（只读体检）/ runLockfileRepair（**用户显式触发**的 lock 重建）。
//
// 本文件全程离线（registry 探测用注入桩、pnpm 用注入桩），真实 registry + 真 pnpm 的端到端验证
// 在 tests/test-lockfile-repair.mjs（隔离 profile，真装真卸）。
//
// 安全边界（本用例钉死，越线即红）：
//   ① 体检**只读**：不写任何文件（用内存 fs 桩统计写入次数，必须为 0）；
//   ② 有 404 依赖时重建**必须停下**（action='blocked'，pnpm 一次都不能跑，文件一个都不能改）；
//   ③ 重建 argv 里**永远**没有 `--config.minimumReleaseAge=0` 这类绕过供应链闸的开关；
//   ④ supply-chain-age 失败只提示"可自行显式绕过（有安全代价）"。
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_REGISTRY, diffLockfile, exactVersionOf, freshReleases, parseLockImporters, probeVerdict,
  readManifestDeps, repairArgsFor, runLockfileCheck, runLockfileRepair, specSatisfiedBy, summarizeCheck,
} from '../lib/server/domain/lockfile-health.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── 夹具：一份「陈旧残缺」的 lock（照抄 live web profile 的形状）────────────────
// manifest 有 3 个依赖；lock importer 只有 2 项、其中一项 specifier 与版本都对不上、还缺 1 项。
const MANIFEST = JSON.stringify({
  name: 'dsh-profile-fix',
  private: true,
  dependencies: {
    '@noob-stupid/dsh-plugin-console': '0.5.14',
    'left-pad': '^1.3.0',
    'dsh-github-login': '0.1.0',
  },
}, null, 2)
const STALE_LOCK = [
  "lockfileVersion: '9.0'", '',
  'importers:', '',
  '  .:', '    dependencies:',
  "      '@noob-stupid/dsh-plugin-console':", '        specifier: 0.5.4', '        version: 0.5.4',
  '      left-pad:', '        specifier: ^1.3.0', '        version: 1.3.0',
  '', 'packages:', '',
  "  '@noob-stupid/dsh-plugin-console@0.5.4':", '    resolution: {integrity: sha512-x}', '',
].join('\n')

// ── ① 重建 argv（纯函数）：只重写 lock，且绝无绕过供应链闸的开关 ────────────────
{
  const args = repairArgsFor(DEFAULT_REGISTRY)
  check('★ repairArgsFor：pnpm install --lockfile-only --no-frozen-lockfile --registry <主源>（顺序固定）',
    JSON.stringify(args) === JSON.stringify(['install', '--lockfile-only', '--no-frozen-lockfile', '--registry', DEFAULT_REGISTRY]),
    args.join(' '))
  check('★ 重建 argv 不含任何绕过供应链闸的开关（minimumReleaseAge 一律不出现）',
    !args.join(' ').includes('minimumReleaseAge') && !args.join(' ').includes('minimum-release-age'), args.join(' '))
  check('★ --no-frozen-lockfile 必须在（我们的 pnpm env 带 CI=true，不加就只会得到 OUTDATED_LOCKFILE）',
    args.includes('--no-frozen-lockfile'))
  check('repairArgsFor：registry 为空时回落主源（不留 undefined 参数）',
    repairArgsFor('')[4] === DEFAULT_REGISTRY && repairArgsFor(null)[4] === DEFAULT_REGISTRY)
  check('★ 模块源码里没有把 minimumReleaseAge 绕过开关拼进 argv 的地方',
    !/repairArgsFor[\s\S]{0,200}minimumReleaseAge/u.test(readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'lockfile-health.js'), 'utf8')))
}

// ── ② 清单解析（纯函数，容错）─────────────────────────────────────────────────
{
  const m = readManifestDeps(MANIFEST)
  check('readManifestDeps：读出 dependencies 里的 3 项（带 spec 与 section）',
    m.ok === true && m.deps.length === 3 && m.deps[0].section === 'dependencies' && m.deps[0].spec === '0.5.14', JSON.stringify(m.deps.map((d) => d.name)))
  const both = readManifestDeps(JSON.stringify({ dependencies: { a: '1.0.0' }, devDependencies: { b: '^2.0.0' }, optionalDependencies: { c: '~3.0.0' }, peerDependencies: { d: '4.0.0' } }))
  check('readManifestDeps：dependencies / devDependencies / optionalDependencies 都算，peerDependencies 不算',
    both.deps.map((d) => d.name).sort().join(',') === 'a,b,c', JSON.stringify(both.deps.map((d) => d.name)))
  check('readManifestDeps：坏 JSON 不抛，如实报 ok=false + 原因',
    readManifestDeps('{ oops').ok === false && typeof readManifestDeps('{ oops').error === 'string' && readManifestDeps('{ oops').deps.length === 0)
  check('readManifestDeps：非对象的 spec 项被跳过（不塞 undefined 进清单）',
    readManifestDeps(JSON.stringify({ dependencies: { a: '1.0.0', b: null, c: 3 } })).deps.length === 1)
}

// ── ③ lock importer 解析（纯函数）─────────────────────────────────────────────
{
  const parsed = parseLockImporters(STALE_LOCK)
  check('★ parseLockImporters：读到 importers 段里的包名 + specifier + version（不误读 packages 段）',
    parsed.present === true && parsed.parsed === true && parsed.importers.length === 2
    && parsed.importers[0].name === '@noob-stupid/dsh-plugin-console' && parsed.importers[0].specifier === '0.5.4' && parsed.importers[0].version === '0.5.4'
    && parsed.importers[1].name === 'left-pad' && parsed.importers[1].version === '1.3.0',
    JSON.stringify(parsed.importers))
  check('parseLockImporters：YAML 引号形态（单/双引号）都认',
    parseLockImporters("importers:\n\n  .:\n    dependencies:\n      \"a-b\":\n        specifier: 1.0.0\n        version: 1.0.0\n").importers[0]?.name === 'a-b')
  check('parseLockImporters：没有 importers 段时 parsed=false（调用方据此不谎报"lock 没问题"）',
    parseLockImporters("lockfileVersion: '9.0'\npackages: {}\n").parsed === false)
}

// ── ④ 三方对账（纯函数）：缺项 / specifier 漂移 / 版本不满足 / 磁盘漂移 ────────────
{
  const diff = diffLockfile({ manifestText: MANIFEST, lockText: STALE_LOCK, installed: { 'left-pad': '1.3.0', 'dsh-github-login': '0.1.0' } })
  check('★ diffLockfile：点名"清单里有、lock 里没有"的依赖',
    JSON.stringify(diff.missing) === JSON.stringify(['dsh-github-login']), JSON.stringify(diff.missing))
  check('★ diffLockfile：specifier 漂移（lock 记 0.5.4 / 清单写 0.5.14）被识别',
    diff.specifierMismatch.length === 1 && diff.specifierMismatch[0].name === '@noob-stupid/dsh-plugin-console' && diff.specifierMismatch[0].lockSpecifier === '0.5.4',
    JSON.stringify(diff.specifierMismatch))
  check('★ diffLockfile：upToDate=false 且 deps 逐项带 state（面板可逐条显示）',
    diff.upToDate === false && diff.deps.find((d) => d.name === 'left-pad')?.state === 'ok'
    && diff.deps.find((d) => d.name === 'dsh-github-login')?.state === 'missing', JSON.stringify(diff.deps))
  const versionOnly = diffLockfile({
    manifestText: JSON.stringify({ dependencies: { x: '0.5.14' } }),
    lockText: "importers:\n\n  .:\n    dependencies:\n      x:\n        specifier: 0.5.14\n        version: 0.5.4\n\npackages:\n",
  })
  check('★ diffLockfile：specifier 相同但**钉住的版本不满足清单**也算陈旧（version-mismatch）',
    versionOnly.versionMismatch.length === 1 && versionOnly.upToDate === false, JSON.stringify(versionOnly.versionMismatch))
  const drift = diffLockfile({ manifestText: MANIFEST, lockText: STALE_LOCK, installed: { 'left-pad': '1.2.0' } })
  check('diffLockfile：磁盘上装的版本 != lock 钉住的版本 → drift（"装了但没写进 lock"）',
    drift.drift.length === 1 && drift.drift[0].name === 'left-pad' && drift.drift[0].installed === '1.2.0', JSON.stringify(drift.drift))
  check('diffLockfile：清单/lock 都健康时 upToDate=true（不误报）',
    diffLockfile({
      manifestText: JSON.stringify({ dependencies: { x: '^1.0.0' } }),
      lockText: "importers:\n\n  .:\n    dependencies:\n      x:\n        specifier: ^1.0.0\n        version: 1.2.3\n\npackages:\n",
    }).upToDate === true)
  check('specSatisfiedBy：非 registry 来源（link:/file:/git+）交给 specifier 判定，不误报版本不满足',
    specSatisfiedBy('link:D:/x', '1.0.0') && specSatisfiedBy('git+https://x/y.git', null) && specSatisfiedBy('^1.0.0', '1.2.0') && !specSatisfiedBy('^1.0.0', '2.0.0'))
  check('exactVersionOf：只有精确版本才取出来（范围/来源规格返回 null）',
    exactVersionOf('0.1.0') === '0.1.0' && exactVersionOf('^0.1.0') === null && exactVersionOf('link:D:/x') === null)
}

// ── ⑤ 供应链年龄（纯函数）：只看 dist-tags.latest 的发布时间 ────────────────────
{
  const now = Date.parse('2026-09-27T12:00:00Z')
  const meta = { 'dist-tags': { latest: '9.9.9' }, time: { '9.9.9': '2026-09-27T06:00:00Z', '9.9.8': '2026-01-01T00:00:00Z' } }
  const fresh = freshReleases('pkg-a', meta, { now })
  check('★ freshReleases：latest 发布不足 24h → 报出来（带版本与小时数）',
    fresh.length === 1 && fresh[0].version === '9.9.9' && fresh[0].ageHours === 6, JSON.stringify(fresh))
  check('freshReleases：超过 24h 不报（不拿"老版本"吓人）', freshReleases('pkg-a', meta, { now: Date.parse('2026-09-30T12:00:00Z') }).length === 0)
  check('freshReleases：镜像没给 time 字段 → 返回空（口径：不判定，不猜）',
    freshReleases('pkg-a', { 'dist-tags': { latest: '9.9.9' } }, { now }).length === 0
    && freshReleases('pkg-a', null, { now }).length === 0)
}

// ── ⑥ registry 探测结论 → 分类（纯函数）────────────────────────────────────────
{
  check('★ probeVerdict：tried 文本里有 HTTP 404 → fetch-404（要点名）',
    probeVerdict({ resolvable: false, tried: ['https://registry.npmmirror.com：请求失败 (HTTP 404)', 'https://registry.npmjs.org：请求失败 (HTTP 404)'] }) === 'fetch-404')
  check('probeVerdict：连接类失败 → network-timeout（与 404 分开，避免误导排查方向）',
    probeVerdict({ resolvable: false, tried: ['https://registry.npmmirror.com：请求失败 (HTTP 0)'] }) === 'network-timeout')
}

// ── ⑦ 只读体检（注入 IO）：只读、点名、可修不可修分清楚 ─────────────────────────
/** 内存 fs 桩：统计写入（本模块不该有任何写入）、按绝对路径喂内容。 */
function memFs(files) {
  const writes = []
  const readFile = (p) => {
    if (Object.prototype.hasOwnProperty.call(files, p)) return files[p]
    throw new Error(`ENOENT: ${p}`)
  }
  const exists = (p) => Object.prototype.hasOwnProperty.call(files, p)
  const write = (p, text) => { writes.push(p); files[p] = text }
  return { files, writes, readFile, exists, write }
}
const probeStub = (map) => async (name) => map[name] ?? { resolvable: true, hasVersion: true, latest: '1.0.0', registry: DEFAULT_REGISTRY, tried: [], meta: { 'dist-tags': { latest: '1.0.0' } } }

{
  const dir = 'X:/profile'
  const fs = memFs({
    [join(dir, 'package.json')]: MANIFEST,
    [join(dir, 'pnpm-lock.yaml')]: STALE_LOCK,
    [join(dir, 'node_modules', 'left-pad', 'package.json')]: JSON.stringify({ name: 'left-pad', version: '1.3.0' }),
  })
  const view = await runLockfileCheck({
    profileDir: dir, registries: [DEFAULT_REGISTRY], readFile: fs.readFile, exists: fs.exists,
    probe: probeStub({ 'dsh-github-login': { resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['https://registry.npmmirror.com：请求失败 (HTTP 404)'] } }),
    now: Date.parse('2026-09-27T12:00:00Z'),
  })
  check('★ 体检：404 依赖被点名（packages404 + fetch-404 问题项）',
    view.ok === false && JSON.stringify(view.packages404) === JSON.stringify(['dsh-github-login'])
    && view.problems.some((p) => p.kind === 'fetch-404' && p.packages.includes('dsh-github-login')),
    JSON.stringify(view.problems.map((p) => p.kind)))
  check('★ 体检：陈旧 lock 也被报出来（缺项 + specifier 漂移）',
    view.problems.some((p) => p.kind === 'lockfile-outdated')
    && JSON.stringify(view.outdated.missing) === JSON.stringify(['dsh-github-login'])
    && view.outdated.specifierMismatch.length === 1,
    JSON.stringify(view.outdated))
  check('★ 体检：有 404 时**不许**说"可以重建"（applicable=false + blockedBy=fetch-404）',
    view.repair.applicable === false && JSON.stringify(view.repair.blockedBy) === JSON.stringify(['fetch-404']), JSON.stringify(view.repair))
  check('★ 体检是只读的：一次写入都没有', fs.writes.length === 0, fs.writes.join(','))
  check('体检结论带一句话短句（面板用）', typeof view.hint === 'string' && view.hint.includes('dsh-github-login'), view.hint)
  check('summarizeCheck：健康时给"无需处理"短句', summarizeCheck({ ok: true }) === '依赖锁与清单一致，无需处理。')

  // 探测不可达：与 404 分开报，且同样不许重建
  const unreachable = await runLockfileCheck({
    profileDir: dir, registries: [DEFAULT_REGISTRY], readFile: fs.readFile, exists: fs.exists,
    probe: probeStub({ 'dsh-github-login': { resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['https://registry.npmmirror.com：请求失败 (HTTP 0)'] } }),
    now: Date.parse('2026-09-27T12:00:00Z'),
  })
  check('★ 体检：registry 不可达 → 报 network-timeout（不是 fetch-404），同样 blockedBy 拦住重建',
    unreachable.problems.some((p) => p.kind === 'network-timeout') && unreachable.problems.every((p) => p.kind !== 'fetch-404')
    && unreachable.repair.applicable === false, JSON.stringify(unreachable.problems.map((p) => p.kind)))
  check('★ 体检：探测不可达时也不写文件', fs.writes.length === 0, fs.writes.join(','))

  // 供应链年龄：命中 latest 发布不足 24h → 只提示，不拦重建（重建本身照跑，闸由 pnpm 决定）
  const fresh = await runLockfileCheck({
    profileDir: dir, registries: [DEFAULT_REGISTRY], readFile: fs.readFile, exists: fs.exists,
    probe: probeStub({
      'dsh-github-login': { resolvable: true, hasVersion: true, latest: '0.1.1', registry: DEFAULT_REGISTRY, tried: [], meta: { 'dist-tags': { latest: '0.1.1' }, time: { '0.1.1': '2026-09-27T09:00:00Z' } } },
    }),
    now: Date.parse('2026-09-27T12:00:00Z'),
  })
  check('★ 体检：新发版本（<24h）报 supply-chain-age，且 hint 只给"可自行显式绕过（有安全代价）"',
    fresh.problems.some((p) => p.kind === 'supply-chain-age')
    && fresh.problems.find((p) => p.kind === 'supply-chain-age').hint.includes('--config.minimumReleaseAge=0')
    && /绝不替你绕过/u.test(fresh.problems.find((p) => p.kind === 'supply-chain-age').hint),
    JSON.stringify(fresh.supplyChainAge))
  check('★ 供应链年龄只是提示，**不**拦重建（applicable 由 lock 问题决定，绕不绕由用户决定）',
    fresh.repair.applicable === true && fresh.repair.blockedBy.length === 0, JSON.stringify(fresh.repair))
  check('体检全程没有写入（三轮调用合计 0 次）', fs.writes.length === 0, fs.writes.join(','))
}

// ── ⑧ 显式重建（注入 pnpm）：404 停下 / 健康则重写 lock / 供应链闸如实回报 ─────────
{
  const dir = 'X:/profile'
  const files = { [join(dir, 'package.json')]: MANIFEST, [join(dir, 'pnpm-lock.yaml')]: STALE_LOCK }
  const fs = memFs(files)
  const calls = []
  const NOT_FOUND_PROBE = probeStub({ 'dsh-github-login': { resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['https://registry.npmmirror.com：请求失败 (HTTP 404)'] } })

  // ① 有 404 依赖 → blocked：pnpm 一次都不能跑，文件一个都不能改
  const blocked = await runLockfileRepair({
    profileDir: dir, registries: [DEFAULT_REGISTRY],
    deps: { readFile: fs.readFile, exists: fs.exists, probe: NOT_FOUND_PROBE },
    runPnpm: async (args) => { calls.push(args) },
  })
  check('★ 有 404 依赖时重建 action=blocked（明确失败，不假装成功）',
    blocked.ok === false && blocked.action === 'blocked' && blocked.kind === 'fetch-404', `${blocked.action}/${blocked.kind}`)
  check('★ 阻塞时如实点名包名（不静默丢弃依赖）',
    JSON.stringify(blocked.packages) === JSON.stringify(['dsh-github-login']) && blocked.hint.includes('dsh-github-login'), JSON.stringify(blocked.packages))
  check('★ 阻塞时 pnpm 一次都没跑、lock 与清单一个字节都没改',
    calls.length === 0 && fs.writes.length === 0 && files[join(dir, 'pnpm-lock.yaml')] === STALE_LOCK && files[join(dir, 'package.json')] === MANIFEST,
    `pnpm=${calls.length} writes=${fs.writes.length}`)

  // ② 依赖都能解析 → 真跑 argv，并把 lock 换成"对得上"的内容（模拟 pnpm 的效果）
  const healthyProbe = probeStub({})
  const LOCK_PATH = join(dir, 'pnpm-lock.yaml')
  const REPAIRED_LOCK = [
    "lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:',
    "      '@noob-stupid/dsh-plugin-console':", '        specifier: 0.5.14', '        version: 0.5.14',
    '      left-pad:', '        specifier: ^1.3.0', '        version: 1.3.0',
    '      dsh-github-login:', '        specifier: 0.1.0', '        version: 0.1.0',
    '', 'packages:', '',
  ].join('\n')
  const calls2 = []
  const repaired = await runLockfileRepair({
    profileDir: dir, registries: [DEFAULT_REGISTRY],
    deps: { readFile: fs.readFile, exists: fs.exists, probe: healthyProbe },
    runPnpm: async (args, opts) => {
      calls2.push({ args, cwd: opts?.execOpts?.cwd })
      // 模拟 `pnpm install --lockfile-only` 的效果：lock 变成与清单一致（并写进内存 fs）
      fs.write(LOCK_PATH, REPAIRED_LOCK)
    },
  })
  check('★ 依赖都能解析时才会真跑 pnpm（cwd=profile，argv 由 repairArgsFor 唯一产出）',
    calls2.length === 1 && calls2[0].cwd === dir
    && JSON.stringify(calls2[0].args) === JSON.stringify(['install', '--lockfile-only', '--no-frozen-lockfile', '--registry', DEFAULT_REGISTRY]),
    JSON.stringify(calls2[0]))
  check('★ 真跑时 argv 里也没有任何绕过供应链闸的开关（安全边界的行为级断言）',
    !calls2[0].args.join(' ').includes('minimumReleaseAge'), calls2[0].args.join(' '))
  check('★ 重建后复检通过才报成功（action=repaired + ok=true，不谎报）',
    repaired.ok === true && repaired.action === 'repaired' && repaired.before.missing.length === 1 && repaired.after.missing.length === 0,
    `${repaired.action} missing ${repaired.before?.missing?.length}→${repaired.after?.missing?.length}`)
  check('重建只写了 pnpm-lock.yaml（package.json 未被动过）',
    fs.writes.length === 1 && fs.writes[0] === join(dir, 'pnpm-lock.yaml') && files[join(dir, 'package.json')] === MANIFEST,
    fs.writes.join(','))

  // ③ pnpm 抛"供应链年龄闸" → 如实回报，且 hint 只给显式绕过（先把 lock 还原成陈旧的）
  files[LOCK_PATH] = STALE_LOCK
  const ageFail = await runLockfileRepair({
    profileDir: dir, registries: [DEFAULT_REGISTRY],
    deps: { readFile: fs.readFile, exists: fs.exists, probe: healthyProbe },
    runPnpm: async () => { throw new Error('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION  The version 0.5.15 was published too recently') },
  })
  check('★ pnpm 报供应链闸时 action=failed + kind=supply-chain-age（不自动绕过）',
    ageFail.ok === false && ageFail.action === 'failed' && ageFail.kind === 'supply-chain-age', `${ageFail.action}/${ageFail.kind}`)
  check('★ 失败文案只给"可自行显式绕过（有安全代价）"并原样带 pnpm 输出尾巴',
    ageFail.hint.includes('--config.minimumReleaseAge=0') && String(ageFail.stderrTail).includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'),
    ageFail.hint.slice(0, 80))

  // ④ 没有任何 lock 问题 → noop（不白跑一次 pnpm）
  files[LOCK_PATH] = REPAIRED_LOCK
  const clean = await runLockfileRepair({
    profileDir: dir, registries: [DEFAULT_REGISTRY],
    deps: { readFile: fs.readFile, exists: fs.exists, probe: healthyProbe },
    runPnpm: async () => { throw new Error('不该跑 pnpm：lock 已经对得上') },
  })
  check('lock 没问题时 rebuild 直接 noop（不白跑 pnpm、不写文件）',
    clean.ok === true && clean.action === 'noop' && fs.writes.length === 1, clean.action)
}

// ── ⑨ 真文件系统上的只读性（不用内存桩：体检前后逐字节比对 profile 目录）──────────
{
  const dir = join(ROOT, '.testdir', 'lockfile-health-fixture')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), MANIFEST, 'utf8')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), STALE_LOCK, 'utf8')
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0' }), 'utf8')
  const beforeManifest = readFileSync(join(dir, 'package.json'), 'utf8')
  const beforeLock = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
  const view = await runLockfileCheck({ profileDir: dir, registries: [DEFAULT_REGISTRY], probe: probeStub({}) })
  check('★ 真 fs 上也只读：体检后清单与 lock 逐字节不变',
    existsSync(join(dir, 'package.json')) && readFileSync(join(dir, 'package.json'), 'utf8') === beforeManifest
    && readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8') === beforeLock,
    `ok=${view.ok} problems=${view.problems.map((p) => p.kind).join(',')}`)
  check('★ 真 fs 上体检能读出缺项（内存桩之外的第二次确认）',
    JSON.stringify(view.outdated.missing) === JSON.stringify(['dsh-github-login']), JSON.stringify(view.outdated.missing))
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
