// 「下载即持久」回归测试（0.5.38 加法 + 改错）—— domain/persist.js 的唯一判据 + 安装收口接线。
//
// 用户诉求原话（2026-10-04）：「能不能插件下载下来就不用 lock、重启也不会消失」。
// 真机现场（desktop profile 的 dshmarket）：包下载了、node_modules 在、bundle 行挂着，
// 但 `dependencies` 里没有条目 ⇒ 之后任何一次 pnpm 操作都会把它当多余包清掉，
// 而面板当时报的是「已安装并启用」——**装了没钉住被报成了成功**。
//
// 本套钉死（全部离线：私有 DSH_HOME + 注入写入器，一个网络请求都不发）：
//   ① 判据三处：清单 spec / pnpm-lock.yaml 条目 / 挂载行 —— 逐处正控与负控；
//   ② 收口动作 ensurePersisted：缺什么补什么、补完**读回磁盘**再判，且幂等（齐备时零写盘）；
//   ③ **负控**：故意让 lock 写入失败 ⇒ 必须 persisted=false + missing 含 lock + 一键钉住动作，
//      绝不报成功；来源是 link: 时**不得**用 registry 404 判问题（既有规矩）；
//   ④ runInstallJob 全链路：正控（三处齐备 → persisted=true、零写盘）与负控（lock 失败 → 如实报）；
//   ⑤ 结构化动作 persist-plugin：白名单内、拒绝命令字符串、缺 packageName 400、结果如实；
//   ⑥ 面板接线（静态）：`persisted === false` 时**不走**"已安装并启用"那句，改走「⚠ 已装上但未持久化」。
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'persist-pipeline-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })

const PROFILE = join(HOME, 'profiles', 'web')
const PATCH = join(PROFILE, 'cordis.patch.yml')
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({ registries: [{ id: 'noop', name: '无源', url: 'http://127.0.0.1:1', primary: true }], gitSources: [], archiveSources: [], indexSources: [] }, null, 2), 'utf8')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const {
  PERSIST_PARTS, diskFormOf, dependencyPart, lockPart, mountPart, persistNote, persistReport,
  suggestedPersistAction, ensurePersisted,
} = await import('../lib/server/domain/persist.js')
const { runInstallJob } = await import('../lib/server/domain/install-job.js')
const { removeDirVerifiedWithRetry } = await import('../lib/server/infra/fsx.js')
const { installJobView, detectBundleOnly } = await import('../lib/server/domain/install.js')
const { runSuggestedAction, ACTION_KINDS, parseActionRequest } = await import('../lib/server/domain/plugin-actions.js')

// ── 夹具 ─────────────────────────────────────────────────────────────────────
const writeManifest = (manifest) => writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
const readManifest = () => JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
const writePatch = (text) => writeFileSync(PATCH, text, 'utf8')
const readPatch = () => readFileSync(PATCH, 'utf8')
/** 铺一个包目录（真实目录）。bundlePatch=true 时同时声明 dsh.bundle.patch + 写它自己的补丁文件。 */
const writePkg = (name, version, { bundlePatch = false, dir = null } = {}) => {
  const target = dir ?? join(PROFILE, 'node_modules', ...name.split('/'))
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({
    name, version, main: 'index.js',
    ...(bundlePatch ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
  }, null, 2), 'utf8')
  writeFileSync(join(target, 'index.js'), 'export default {}\n', 'utf8')
  if (bundlePatch) writeFileSync(join(target, 'cordis.patch.yml'), `# fixture bundle patch\n- insert:\n    - id: ${name.replace(/^@/u, '').replace(/\//gu, '-')}\n      name: '${name}'\n`, 'utf8')
  return target
}
/** 把 node_modules/<包名> 换成指向 plugin-src 的**链接**（Windows 用 junction，免提权；POSIX 上 type 被忽略）。 */
const linkPkg = (name) => {
  const src = writePkg(name, '9.9.9', { dir: join(HOME, 'plugin-src', ...name.split('/')) })
  const dest = join(PROFILE, 'node_modules', ...name.split('/'))
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(src, dest, 'junction')
  return { src, dest }
}
/** 写一条 pnpm 风格的 importer 条目（模拟 pnpm 的产出；只覆盖判据要读的那两行）。
 * 键的引号形态必须**照 pnpm 的真实行为**：含 `/`、`@` 的包名加引号（`'@scope/name':`），
 * 未加 scope 的裸名不加引号（`dshmarket:`）—— 0.5.38 的 reader 改错正是为后者。 */
const lockKeyOf = (name) => (/[/@]/u.test(name) ? `'${name}':` : `${name}:`)
const writeLockEntry = (name, spec) => {
  const version = spec.startsWith('link:') ? `link:${relative(PROFILE, spec.slice('link:'.length)).split('\\').join('/')}` : spec
  writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      ${lockKeyOf(name)}\n        specifier: ${spec}\n        version: ${version}\n`, 'utf8')
}
/** 模拟 pnpm 对 `link:` spec 的动作：把 node_modules/<包名> 换成指向目标目录的链接。 */
const emulatePnpmLink = (name, spec) => {
  const target = spec.slice('link:'.length)
  const dest = join(PROFILE, 'node_modules', ...name.split('/'))
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(target, dest, 'junction')
}
const reset = ({ bundles = ['@deepseek-ai/dsh-base'], patch = '# fixture profile patch\n' } = {}) => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles } } })
  writePatch(patch)
  rmSync(join(PROFILE, 'pnpm-lock.yaml'), { force: true })
}

console.log('\n=== ① 判据：三处逐项正控/负控（只读，不猜）===')
{
  const NAME = '@fake/plain-plugin'
  writePkg(NAME, '1.0.0')
  reset()
  const onlyDisk = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, entries: [] })
  check('① 只有磁盘上有包 ⇒ 三处全缺，missing 顺序恒为 dependency/lock/mount',
    onlyDisk.persisted === false && JSON.stringify(onlyDisk.missing) === JSON.stringify(PERSIST_PARTS), JSON.stringify(onlyDisk.missing))
  check('① 负控原因写清"pnpm 会把它当多余包清掉"（不说成功）',
    /多余包/u.test(String(onlyDisk.parts.dependency.reason)), String(onlyDisk.parts.dependency.reason))

  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [NAME]: '1.0.0' }, dsh: { profile: { bundles: [] } } })
  const depOk = dependencyPart({ profileDir: PROFILE, packageName: NAME })
  check('① 清单版本号与磁盘一致 ⇒ ① 就位（form=version）', depOk.ok === true && depOk.form === 'version', JSON.stringify(depOk))
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [NAME]: '2.0.0' }, dsh: { profile: { bundles: [] } } })
  check('① 负控：清单写 2.0.0 / 磁盘 1.0.0 ⇒ ① 不就位且原因写明两处对不上',
    dependencyPart({ profileDir: PROFILE, packageName: NAME }).ok === false
    && /磁盘上是 1\.0\.0/u.test(String(dependencyPart({ profileDir: PROFILE, packageName: NAME }).reason)),
    String(dependencyPart({ profileDir: PROFILE, packageName: NAME }).reason))

  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [NAME]: '1.0.0' }, dsh: { profile: { bundles: [] } } })
  check('① 负控：lock 里没有条目 ⇒ ② 不就位', lockPart({ profileDir: PROFILE, packageName: NAME, spec: '1.0.0' }).ok === false)
  writeLockEntry(NAME, '1.0.0')
  check('① 正控：lock 条目与清单逐字相等 ⇒ ② 就位', lockPart({ profileDir: PROFILE, packageName: NAME, spec: '1.0.0' }).ok === true)
  check('① 负控：清单是 link: 而 lock 是版本号 ⇒ ② 不就位（两处对不上）',
    lockPart({ profileDir: PROFILE, packageName: NAME, spec: `link:${join(HOME, 'plugin-src', 'x')}` }).ok === false)

  check('① 负控：补丁里没有行、bundles 里也没有 ⇒ ③ 不就位（重启后不会被挂载）',
    mountPart({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, bundles: [] }).ok === false
    && /不会被挂载/u.test(String(mountPart({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, bundles: [] }).reason)))
  writePatch('- insert:\n    - id: plain-plugin\n      name: \'@fake/plain-plugin\'\n')
  const mountRow = mountPart({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, bundles: [] })
  check('① 正控：补丁里有它的 insert 行 ⇒ ③ 就位（via=patch-row + 行 id）',
    mountRow.ok === true && mountRow.via === 'patch-row' && mountRow.rowId === 'plain-plugin', JSON.stringify(mountRow))
  check('① 负控：缺行时的一键钉住动作是白名单内的 persist-plugin（命令只供展示）',
    suggestedPersistAction({ packageName: NAME, profileDir: PROFILE, missing: ['mount'] }).kind === 'persist-plugin'
    && ACTION_KINDS.includes('persist-plugin'))
}

console.log('\n=== ② bundle 层：装了 bundle 的包靠它自己的补丁行挂载；声明缺失必须判红 ===')
{
  const BUNDLED = '@fake/bundle-plugin'
  const patch = '- insert:\n    - id: other-row\n      name: \'@fake/other\'\n'
  // 反例（真实缺陷形态）：在 bundles 里，却没有 dsh.bundle.patch ⇒ bundle 层不会装入任何行
  writePkg(BUNDLED, '1.0.0')
  reset({ bundles: ['@deepseek-ai/dsh-base', BUNDLED], patch })
  writeLockEntry(BUNDLED, '1.0.0')
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [BUNDLED]: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', BUNDLED] } } })
  const bad = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: BUNDLED, entries: [] })
  check('② 负控：在 bundles 里但没有 dsh.bundle.patch ⇒ ③ 不就位（缺的是挂载，不是清单/lock）',
    bad.persisted === false && JSON.stringify(bad.missing) === JSON.stringify(['mount'])
    && /dsh\.bundle\.patch/u.test(String(bad.parts.mount.reason)), JSON.stringify(bad.missing))
  check('② detectBundleOnly 与判据一致（同一份 dsh.bundle 语义）', (await detectBundleOnly(PROFILE, BUNDLED)) === false)
  // 正控：声明了 dsh.bundle.patch 且行指向它自己
  writePkg(BUNDLED, '1.0.0', { bundlePatch: true })
  check('② detectBundleOnly 认出声明', (await detectBundleOnly(PROFILE, BUNDLED)) === true)
  const good = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: BUNDLED, entries: [] })
  check('② 正控：bundle 声明齐备 ⇒ 三处齐备（via=bundle）',
    good.persisted === true && good.actual.mountVia === 'bundle', JSON.stringify(good.actual))
  // 运行时已有行提供它（聚合包里的行）→ 也算会挂载
  const served = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: '@fake/inner', entries: [{ rowId: 'web-ui-i18n', moduleName: '@fake/inner' }] })
  check('② 正控：运行时已有行提供它 ⇒ ③ 就位（via=live-entry，不再重复写行）',
    served.parts.mount.ok === true && served.parts.mount.via === 'live-entry', JSON.stringify(served.parts.mount))
}

console.log('\n=== ③ 收口 ensurePersisted：缺什么补什么 + 读回核实 + 幂等零写盘 ===')
{
  const NAME = '@fake/settle-me'
  writePkg(NAME, '3.1.4')
  reset()
  // 写入器注入：只替换"跑 pnpm"那一层（真判据/真文件读写都在），一个网络请求都不发
  const deps = {
    declare: async (profileDir, name, version, options) => {
      const { declareProfileDependency } = await import('../lib/server/domain/manifest.js')
      return declareProfileDependency(profileDir, name, version, { ...options, syncLock: false, probe: async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：HTTP 404 Not Found'] }) })
    },
    reconcile: async ({ profileDir, packages }) => {
      const spec = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies[packages[0].name]
      // 忠实模拟 `pnpm add link:<dir>` 的两件事：node_modules 换成链接 + lock 写 importer 条目
      if (String(spec).startsWith('link:')) emulatePnpmLink(packages[0].name, String(spec))
      writeLockEntry(packages[0].name, spec)
      return { lockUpdated: true, lockNote: null, depNote: null, suggestedActions: [] }
    },
  }
  const settled = await ensurePersisted({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, mode: 'insert', taken: new Set(), registries: ['http://127.0.0.1:1'], deps })
  const manifestSpec = readManifest().dependencies[NAME]
  check('③ 正控：一次调用后三处齐备（清单 link: + lock 条目 + insert 行）',
    settled.persisted === true && settled.missing.length === 0, JSON.stringify({ missing: settled.missing, spec: manifestSpec }))
  check('③ 写回形态按**磁盘真实形态**：真实目录 + registry 404 ⇒ link:（既有规矩，非 registry 来源不猜版本号）',
    String(manifestSpec).startsWith('link:') && existsSync(String(manifestSpec).slice('link:'.length)), String(manifestSpec))
  check('③ 挂载行真的写进 profile 补丁（entry id 由既有 deriveEntryId 产出）',
    /name: '@fake\/settle-me'/u.test(readPatch()) && typeof settled.rowId === 'string' && settled.rowId !== '', settled.rowId)
  const before = { manifest: readFileSync(join(PROFILE, 'package.json'), 'utf8'), lock: readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8'), patch: readPatch() }
  const again = await ensurePersisted({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, mode: 'insert', taken: new Set([settled.rowId]), registries: ['http://127.0.0.1:1'], deps })
  check('③ 幂等：三处齐备时再收口一次 ⇒ persisted=true 且三个文件逐字节不变（幂等零写盘）',
    again.persisted === true && readFileSync(join(PROFILE, 'package.json'), 'utf8') === before.manifest
    && readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8') === before.lock && readPatch() === before.patch)
}

console.log('\n=== ④ 负控（用户点名的那条）：让 lock 写入失败 ⇒ 必须报「未持久化」而不是成功 ===')
{
  const NAME = '@fake/lock-broken'
  writePkg(NAME, '1.0.0')
  reset()
  const deps = {
    declare: async (profileDir, name) => {
      const { setProfileDependency } = await import('../lib/server/domain/manifest.js')
      const wrote = await setProfileDependency(profileDir, name, '1.0.0')
      return { changed: wrote.changed, version: '1.0.0', spec: wrote.after, form: 'version', reason: null, lockSynced: false, lockNote: null, depNote: null, suggested: null }
    },
    reconcile: async () => { throw new Error('模拟 lock 写入失败（负控）') },
  }
  const settled = await ensurePersisted({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, mode: 'insert', taken: new Set(), registries: [], deps })
  check('④ 负控：persisted=false 且 missing 精确点名 lock（清单与挂载行已好）',
    settled.persisted === false && JSON.stringify(settled.missing) === JSON.stringify(['lock']), JSON.stringify(settled.missing))
  check('④ 负控：失败原因与"后果"都如实（未持久化 / 会被还原），绝不出现"已安装"一类结论',
    /未持久化/u.test(String(settled.note)) && /pnpm-lock\.yaml/u.test(String(settled.note)), String(settled.note))
  check('④ 负控：一键钉住动作随之下发（kind=persist-plugin，payload 只带包名/profile）',
    settled.suggested?.kind === 'persist-plugin' && settled.suggested?.payload?.packageName === NAME
    && settled.suggested?.payload?.action === 'persist-plugin', JSON.stringify(settled.suggested?.payload))
  check('④ 负控：lock 对账抛出的真因进了 notes（不静默吞掉）',
    settled.notes.some((n) => /模拟 lock 写入失败/u.test(String(n))), JSON.stringify(settled.notes))
}

console.log('\n=== ⑤ link: 来源的负控：只判"两处是否同形态"，绝不用 registry 404 判问题 ===')
{
  const NAME = '@fake/linked-plugin'
  const { src } = linkPkg(NAME)
  reset({ bundles: [] })
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [NAME]: `link:${src.split('\\').join('/')}` }, dsh: { profile: { bundles: [] } } })
  writePatch('- insert:\n    - id: linked-plugin\n      name: \'@fake/linked-plugin\'\n')
  const disk = diskFormOf(PROFILE, NAME)
  check('⑤ 磁盘真实形态被判成 link（junction → 链接目标）', disk.form === 'link' && disk.target !== null, JSON.stringify(disk))
  const noLock = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, entries: [] })
  check('⑤ 负控：link: 来源 + lock 无条目 ⇒ 未持久化（missing 只有 lock；**不含** registry 404 判据）',
    noLock.persisted === false && JSON.stringify(noLock.missing) === JSON.stringify(['lock'])
    && !/404/u.test(String(noLock.note)), String(noLock.note))
  const linkSpec = `link:${src.split('\\').join('/')}`
  check('⑤ 正控：lock 里也钉在 link: ⇒ 就位（link 条目没有 integrity 也照样算数）',
    (() => { writeLockEntry(NAME, linkSpec); return lockPart({ profileDir: PROFILE, packageName: NAME, spec: linkSpec }).ok === true })())
  const settled = await ensurePersisted({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, mode: 'insert', taken: new Set(['linked-plugin']), registries: [], deps: { reconcile: async () => ({ lockUpdated: true, lockNote: null, depNote: null, suggestedActions: [] }) } })
  check('⑤ 收口：link: 目标在用户自己的位置 ⇒ 清单原样写这条链接（**不**物化复制到 plugin-src）',
    settled.persisted === true && readManifest().dependencies[NAME] === linkSpec, String(readManifest().dependencies[NAME]))
}

console.log('\n=== ⑥ runInstallJob 全链路：正控（齐备→persisted、零写盘）/ 负控（lock 失败→如实报）===')
{
  const ports = (extra = {}) => ({
    baseUrl: pathToFileURL(join(PROFILE, 'cordis.yml')).href,
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(PROFILE, 'cordis.yml')).href } } }] },
    get: () => undefined,
    ...extra,
  })
  const NAME = '@fake/e2e-plugin'
  writePkg(NAME, '2.0.0')
  reset({ bundles: [], patch: '# fixture profile patch\n' })
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [NAME]: '2.0.0' }, dsh: { profile: { bundles: [] } } })
  writeLockEntry(NAME, '2.0.0')
  writePatch(`# fixture profile patch\n- insert:\n    - id: e2e-plugin\n      name: '${NAME}'\n`)
  const files = { manifest: readFileSync(join(PROFILE, 'package.json'), 'utf8'), lock: readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8'), patch: readPatch() }
  const okJob = { id: 'ok', repo: null, packageName: NAME, update: false, source: 'github', status: 'installing', channelNotes: [] }
  await runInstallJob(okJob, ports({ get: (key) => (key === 'installChannels' ? { raceInstallChannels: async () => null, pnpmInstall: async () => { throw new Error('不该被调用') }, curlManualInstall: async () => { throw new Error('不该被调用') }, githubReleaseInstall: async () => { throw new Error('不该被调用') }, backfillMissingDeps: async () => [] } : undefined) }))
  const view = installJobView(okJob)
  check('⑥ 正控：job.status=done 且 persisted=true（三处齐备，判据读的是磁盘）',
    okJob.status === 'done' && okJob.persisted === true && view.persisted === true, JSON.stringify({ status: okJob.status, persisted: okJob.persisted, missing: okJob.persist?.missing }))
  check('⑥ 正控：三处齐备时**零写盘**（清单/lock/补丁逐字节不变）',
    readFileSync(join(PROFILE, 'package.json'), 'utf8') === files.manifest
    && readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8') === files.lock && readPatch() === files.patch)
  check('⑥ installJobView 下发 persistent 字段（面板据此决定报不报成功）',
    'persisted' in view && 'persistNote' in view && 'persist' in view)

  // 负控：清单里没有条目（真机 dshmarket 的形态）+ lock 写入失败 ⇒ 必须如实报「未持久化」
  const BAD = '@fake/unpinned-plugin'
  writePkg(BAD, '0.5.0')
  reset({ bundles: [], patch: '# fixture profile patch\n' })
  const badJob = { id: 'bad', repo: null, packageName: BAD, update: false, source: 'github', status: 'installing', channelNotes: [] }
  const badDeps = {
    persistDeps: {
      declare: async (profileDir, name) => {
        const { setProfileDependency } = await import('../lib/server/domain/manifest.js')
        const wrote = await setProfileDependency(profileDir, name, '0.5.0')
        return { changed: wrote.changed, version: '0.5.0', spec: wrote.after, form: 'version', reason: null, lockSynced: false, lockNote: null, depNote: null, suggested: null }
      },
      reconcile: async () => { throw new Error('模拟 lock 写入失败（负控）') },
    },
  }
  await runInstallJob(badJob, ports({ get: (key) => (key === 'installChannels' ? { raceInstallChannels: async () => null, pnpmInstall: async () => { throw new Error('不该被调用') }, curlManualInstall: async () => { throw new Error('不该被调用') }, githubReleaseInstall: async () => { throw new Error('不该被调用') }, backfillMissingDeps: async () => [] } : undefined) }), badDeps)
  const badView = installJobView(badJob)
  check('⑥ 负控：job.persisted=false 且 missing 点名 lock（**不许**报成功）',
    badJob.persisted === false && JSON.stringify(badJob.persist?.missing) === JSON.stringify(['lock']), JSON.stringify({ persisted: badJob.persisted, missing: badJob.persist?.missing }))
  check('⑥ 负控：persistNote 是人话且含「未持久化」，一键钉住动作已下发（面板可一键补齐）',
    /未持久化/u.test(String(badJob.persistNote)) && badJob.suggestedAction?.kind === 'persist-plugin'
    && badView.persistNote === badJob.persistNote, String(badJob.persistNote))
  check('⑥ 负控：清单/挂载行的真实结果照样如实下发（不因为 lock 失败就整条吞掉）',
    badView.persist?.actual?.spec === '0.5.0' && badView.persist?.actual?.mountVia === 'patch-row', JSON.stringify(badView.persist?.actual))
}

console.log('\n=== ⑦ 结构化动作 persist-plugin：白名单 + 拒绝命令字符串 + 结果如实 ===')
{
  const NAME = '@fake/action-target'
  writePkg(NAME, '1.2.3')
  reset()
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [NAME]: '1.2.3' }, dsh: { profile: { bundles: [] } } })
  const missingName = parseActionRequest({ action: 'persist-plugin' })
  check('⑦ 缺 packageName ⇒ 400（形状校验在服务端）', missingName.ok === false && missingName.status === 400, String(missingName.error))
  const withCommand = parseActionRequest({ action: 'persist-plugin', packageName: NAME, command: 'rm -rf /' })
  check('⑦ 带命令字符串 ⇒ 400（本接口没有传命令的位置）', withCommand.ok === false && withCommand.status === 400, String(withCommand.error))
  const notInProfile = await runSuggestedAction({ body: { action: 'persist-plugin', packageName: '@fake/not-mine' }, profileDir: PROFILE, registries: [] })
  check('⑦ 包不属于本 profile ⇒ 400 且拒绝改动', notInProfile.ok === false && notInProfile.status === 400, String(notInProfile.error))
  const calls = []
  const done = await runSuggestedAction({
    body: { action: 'persist-plugin', packageName: NAME, profile: 'web' }, profileDir: PROFILE, registries: [],
    deps: {
      ensurePersisted: async (opts) => {
        calls.push(opts)
        return { persisted: false, missing: ['lock'], notes: ['lock 对账失败：模拟'], rowId: null, suggested: null, note: '未持久化（重启或任何一次 pnpm 操作后可能消失）—— ② pnpm-lock.yaml：没有条目', before: { actual: { spec: '1.2.3' } }, after: { actual: { spec: '1.2.3', lockEntry: null, mountVia: 'patch-row' }, parts: { dependency: { ok: true, form: 'version' }, lock: { ok: false }, mount: { ok: true } } } }
      },
    },
  })
  check('⑦ 执行体只认结构化参数（packageName 与服务端 profile 目录），且结果 ok=false + 未持久化',
    calls.length === 1 && calls[0].packageName === NAME && calls[0].profileDir === PROFILE && done.ok === false && done.missing?.[0] === 'lock', JSON.stringify({ ok: done.ok, missing: done.missing }))
  const done2 = await runSuggestedAction({
    body: { action: 'persist-plugin', packageName: NAME }, profileDir: PROFILE, registries: [],
    deps: { ensurePersisted: async () => ({ persisted: true, missing: [], notes: [], rowId: 'action-target', note: null, before: { actual: { spec: '1.2.3' } }, after: { actual: { spec: 'link:X', lockEntry: 'link:X', mountVia: 'patch-row' }, parts: { dependency: { ok: true, form: 'link' }, lock: { ok: true }, mount: { ok: true } } } }) },
  })
  check('⑦ 三处齐备时 ok=true 且 reason 把三处真实值都报出来（清单/lock/挂载）',
    done2.ok === true && /清单（link:X）/u.test(String(done2.reason)) && /挂载（patch-row）/u.test(String(done2.reason)), String(done2.reason))
}

console.log('\n=== ⑧ 面板接线（静态）：persisted === false 时不许走"已安装并启用" ===')
{
  const src = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  check('⑧ 客户端有 installedNotPersisted 文案（中英各一条）', (src.match(/installedNotPersisted:/gu) ?? []).length === 2)
  check('⑧ 客户端有 persist 诊断行与 actionPersistLabel（中英各一条）',
    (src.match(/diagNotPersisted:/gu) ?? []).length === 2 && (src.match(/actionPersistLabel:/gu) ?? []).length === 2)
  const persistedBranch = src.indexOf('} else if (data.persisted === false) {\n\t\t\t\t\t\t\t\t\t\t// 0.5.38 加法')
  const successMessage = src.lastIndexOf('setMessage(t("installed") + "：" + data.packageName + "（"')
  check('⑧ done 分支里先判 persisted===false 再走"已安装并启用"',
    persistedBranch > 0 && successMessage > 0 && persistedBranch < successMessage, `persist@${persistedBranch} success@${successMessage}`)
  check('⑧ 未持久化时不自动 reload（给用户点「一键钉住」的机会）',
    /data\.persisted === false\)\s*\{\s*\n\s*\/\/ 未持久化：不自动刷新/u.test(src))
  check('⑧ 服务端 view 下发 persistNote/persist（判据与文案都由服务端给，客户端不自己算）',
    /persisted: job\.persisted \?\? null, persistNote: job\.persistNote \?\? null, persist: job\.persist \?\? null/u.test(readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'install.js'), 'utf8')))
}

console.log('\n=== ⑨ lock 读取（唯一真源 lockVersion）：三种键形态都要认（0.5.38 改错）===')
{
  // 真机缺陷（desktop profile 的 dshmarket）：lock 的 importers 里条目就在那里（35-37 行），
  // 但旧 reader 只认 `'name':`（带引号）与 packages 段的 `name@ver:` —— **未加 scope 的裸键 `name:`
  // 读不出来**，于是 dshmarket 被判成"没写进 lock"（面板永远报未持久化、pin 永远 partial）。
  const { lockVersion } = await import('../lib/server/domain/selfupdate.js')
  const NAME = 'unscoped-link-dep'
  reset({ bundles: [] })
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [NAME]: 'link:C:/nowhere/x' }, dsh: { profile: { bundles: [] } } })
  writeLockEntry(NAME, 'link:C:/nowhere/x')
  check('⑨ 未加 scope 的裸键（`name:`）+ link: 条目 ⇒ 读得出来（真机 dshmarket 的形态）',
    String(lockVersion(PROFILE, NAME)).startsWith('link:'), JSON.stringify(lockVersion(PROFILE, NAME)))
  const SCOPED = '@fake/scoped-dep'
  writeLockEntry(SCOPED, '1.2.3')
  check('⑨ 带 scope 的引号键（`\'@scope/name\':`）照旧读得出来（回归：一个字没改）',
    lockVersion(PROFILE, SCOPED) === '1.2.3', JSON.stringify(lockVersion(PROFILE, SCOPED)))
  writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\npackages:\n\n  plain-dep@2.0.1:\n    resolution: {integrity: sha512-xx}\n", 'utf8')
  check('⑨ packages 段的 `name@ver:` 照旧读得出来（回归）', lockVersion(PROFILE, 'plain-dep') === '2.0.1', JSON.stringify(lockVersion(PROFILE, 'plain-dep')))
  check('⑨ 不命中时仍返回 null（不许谎报"lock 里有"）', lockVersion(PROFILE, 'not-there') === null)
  const { reconcileLockfile } = await import('../lib/server/domain/selfupdate.js')
  // 真机几何形态：profile 在 <DSH_HOME>/profiles/<名>，plugin-src 在 <DSH_HOME>/plugin-src ⇒
  // lock 里的 version 就是 `link:../../plugin-src/<包名>`（desktop profile 的 dshmarket 现场）。
  // 0.5.39 起判据还要求这条 link 条目**指向同一个目标**（目标不同 = 真漂移），所以夹具的相对路径
  // 必须真的指回 plugin-src（旧夹具借用了真机的相对串、却把 plugin-src 放在别处 —— 那种"对齐"是假的）。
  const desktopShaped = join(ROOT, '.testdir', 'persist-lock-shape', 'profiles', 'desktop')
  const shapeRoot = join(ROOT, '.testdir', 'persist-lock-shape')
  // 上一轮残留（Windows 上 rmSync 遇 junction 会**静默落空** —— 仓库里为此有专门的删除助手）先清掉，
  // 否则第二次运行会在 symlinkSync 处 EEXIST（本测试自己踩过）。
  removeDirVerifiedWithRetry(shapeRoot, { attempts: 3, pollMs: 250 })
  mkdirSync(join(desktopShaped, 'node_modules'), { recursive: true })
  const src = writePkg('dshmarket-like', '1.0.0', { dir: join(shapeRoot, 'plugin-src', 'dshmarket-like') })
  writeFileSync(join(desktopShaped, 'package.json'), `${JSON.stringify({ name: 'p', private: true, dependencies: { 'dshmarket-like': `link:${src.split('\\').join('/')}` } }, null, 2)}\n`, 'utf8')
  symlinkSync(src, join(desktopShaped, 'node_modules', 'dshmarket-like'), 'junction')
  const relLock = relative(desktopShaped, src).split('\\').join('/')
  check('⑨ 夹具几何 = 真机形态（版本号写相对路径 link:../../plugin-src/<包名>）', relLock === '../../plugin-src/dshmarket-like', relLock)
  writeFileSync(join(desktopShaped, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dshmarket-like:\n        specifier: link:${src.split('\\').join('/')}\n        version: link:${relLock}\n`, 'utf8')
  const aligned = await reconcileLockfile({ profileDir: desktopShaped, packages: [{ name: 'dshmarket-like' }], registries: [], pnpmAdd: async () => { throw new Error('不该被调用：本来就是对账齐备的状态') } })
  check('⑨ 真机形态端到端：裸键 link: 依赖被判**已对齐**（lockUpdated=true、一次 pnpm 都不跑）',
    aligned.lockUpdated === true && aligned.lockNote === null, JSON.stringify({ lockUpdated: aligned.lockUpdated, lockNote: aligned.lockNote }))
  // 0.5.39 附加（Fix 2 的"目标不同 = 真漂移"）：把 lock 的 version 指到别处 ⇒ 必须判出来并只补那条条目
  writeFileSync(join(desktopShaped, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dshmarket-like:\n        specifier: link:${src.split('\\').join('/')}\n        version: link:../../plugin-src/other-place\n`, 'utf8')
  const repaired = await reconcileLockfile({
    profileDir: desktopShaped, packages: [{ name: 'dshmarket-like' }], registries: [],
    pnpmAdd: async () => { throw new Error('不该被调用：link: 来源只写 lock importer 条目，不用 pnpm add') },
    deps: { verifyLock: async () => ({ verified: true, via: 'stub', reason: null }) },
  })
  check('⑨ 目标不同 ⇒ 判为真漂移，且只把那条 link 条目改成规范形（不碰清单、不跑 pnpm add）',
    repaired.lockUpdated === true && repaired.method === 'lock-importer'
    && readFileSync(join(desktopShaped, 'pnpm-lock.yaml'), 'utf8').includes(`        version: link:${relLock}`)
    && JSON.parse(readFileSync(join(desktopShaped, 'package.json'), 'utf8')).dependencies['dshmarket-like'] === `link:${src.split('\\').join('/')}`,
    JSON.stringify({ lockUpdated: repaired.lockUpdated, method: repaired.method }))
  removeDirVerifiedWithRetry(shapeRoot, { attempts: 3, pollMs: 250 })
}

console.log('\n=== ⑩ 真机发现的两处共享判据缺陷（0.5.38 改错）：补丁行引号 + lock 的 peer 后缀 ===')
{
  const { parseInsertNames } = await import('../lib/server/domain/patch.js')
  const { readBundlePatchRefNames } = await import('../lib/server/domain/bundle-refs.js')
  // ① 真机 dsh-whale-widget 的 bundle 补丁写的是**不带引号**的 `name: dsh-whale-widget`（合法 YAML），
  //    旧 parseInsertNames 只认带引号的 ⇒ 那一行"在文件里、程序却说没有"（自愈/装后校验/撤销全瞎）。
  const unquoted = '- insert:\n    - id: whale\n      name: dsh-whale-widget\n'
  const quoted = "- insert:\n    - id: whale\n      name: 'dsh-whale-widget'\n"
  const withComment = '- insert:\n    - id: whale\n      name: dsh-whale-widget # 挂件\n'
  check('⑩ 不带引号的 name 也要解析出来（真机 dsh-whale-widget 的形态）',
    parseInsertNames(unquoted).get('whale') === 'dsh-whale-widget', JSON.stringify([...parseInsertNames(unquoted)]))
  check('⑩ 带引号（单/双）照旧解析（回归）',
    parseInsertNames(quoted).get('whale') === 'dsh-whale-widget' && parseInsertNames('- insert:\n    - id: x\n      name: "@a/b"\n').get('x') === '@a/b')
  check('⑩ 行内注释被剥掉（不留进模块名）', parseInsertNames(withComment).get('whale') === 'dsh-whale-widget', JSON.stringify([...parseInsertNames(withComment)]))
  check('⑩ 没有 name 的块仍不产出（判据只多不少，不乱认）', parseInsertNames('- insert:\n    - id: x\n').size === 0)
  // ② bundle patch 引用清单同理：不带引号也必须读出来（否则"注册前校验引用可解析"这道防崩闸门形同不存在）
  const BUNDLED = '@fake/bundle-unquoted'
  writePkg(BUNDLED, '1.0.0')
  const dir = join(PROFILE, 'node_modules', ...BUNDLED.split('/'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: BUNDLED, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2), 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: fake-bundle-unquoted\n      name: @fake/definitely-missing\n', 'utf8')
  check('⑩ readBundlePatchRefNames 认得未加引号的引用（注册前防崩校验因此真的生效）',
    readBundlePatchRefNames(PROFILE, BUNDLED).includes('@fake/definitely-missing'), JSON.stringify(readBundlePatchRefNames(PROFILE, BUNDLED)))
  writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: fake-bundle-unquoted\n      name: '@fake/definitely-missing'\n", 'utf8')
  check('⑩ 带引号照旧（回归）', readBundlePatchRefNames(PROFILE, BUNDLED).includes('@fake/definitely-missing'))
  // ③ lock 里带 peer 后缀的版本号（真机 @deepseek-ai/dsh-experimental-schedule-bundle）不是"两处对不上"
  const PEER = '@fake/peer-suffixed'
  writePkg(PEER, '2.0.0-rc.2')
  reset({ bundles: [] })
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: { [PEER]: '2.0.0-rc.2' }, dsh: { profile: { bundles: [] } } })
  writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '${PEER}':\n        specifier: 2.0.0-rc.2\n        version: 2.0.0-rc.2(@fake/peer@1.0.0)\n`, 'utf8')
  const peerPart = lockPart({ profileDir: PROFILE, packageName: PEER, spec: '2.0.0-rc.2' })
  check('⑩ lock 的 `2.0.0-rc.2(@peer@1.0.0)` 与清单 `2.0.0-rc.2` 判为同版（peer 后缀不是另一个版本）',
    peerPart.ok === true, JSON.stringify(peerPart))
  check('⑩ 真不同版仍然判红（判据没被修松）',
    lockPart({ profileDir: PROFILE, packageName: PEER, spec: '2.0.0-rc.3' }).ok === false)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
