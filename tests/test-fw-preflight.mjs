// 0.5.50 加法：框架闭包预检与治包（真机背景见 lib/server/domain/fw-preflight.js 头注释，
// 事故 = 2026-10-14 四个框架包被掏空 ⇒ dsh 起不来 ⇒ 控制台插件从未加载）。
//
// 本套钉死（**全离线**：不联网、不起进程、只用内存 IO 替身 + 一个小型真磁盘沙箱）：
//   ① 闭包探测：坏包**只报一条**（枢纽包坏了会波及整条下游，逐条打印会淹没真正的原因）
//   ② 闭包探测：可选 peer 缺失**不算坏**（不冤枉合法的 optional 依赖）
//   ③ 闭包探测：健康的树是 no-op（一个字节都不写）
//   ④ lock 索引：lockfileVersion 3 的 `packages` 形态能建索引，坏 JSON / 不存在一律空 Map（不抛）
//   ⑤ 版本挑选：同包多版本取**最高**那条
//   ⑥ 计划：lock 里没有 ⇒ `no-lock-entry`（**不猜版本**）；无 integrity ⇒ `no-integrity`
//   ⑦ 目标判定：resolve → top-level → pnpm-store 的优先级
//   ⑧ integrity → cacache 路径：sha512 布局正确；非法输入返回 null（**不猜路径**）
//   ⑨ 解包：真磁盘沙箱里解开一个自造 tgz，文件落地、`package/` 前缀被剥掉、穿越条目被拒
//   ⑩ 修复：目标已有内容 ⇒ 改名成 `.preflight-bak-*` 再装（**绝不直接删**）；空壳直接替换
//   ⑪ 端到端：造一棵"被掏空的框架树" ⇒ `runFwPreflight({repair:true})` 从缓存装回 ⇒ 复验通过
//   ⑪d **junction 形态**：内容写进实体、链接原样保留（不许把 pnpm 链接结构改成真实目录）
//   ⑫ **绝不 spawn / kill**：源码里不出现 child_process（这条是本模块的红线，见 restart.js 的教训）
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(ROOT, '.testdir', 'fw-preflight')
const { probeClosure } = await import('../lib/server/infra/fw-closure.js')
const { integrityToContentPath, extractTgz, candidateCacheRoots } = await import('../lib/server/infra/npm-cache.js')
const { buildLockIndex, planClosureRepair, runFwPreflight, locateLockfile, isPreflightBak } = await import('../lib/server/domain/fw-preflight.js')

let passed = 0
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

// ── 内存 IO 替身：造一棵"任意形状"的框架树（不必碰真磁盘）──────────────────────
/**
 * @param {object} tree  `{ '包名': { version, deps?, peerDeps?, optionalPeers? } }`；
 *                       值为 `null` = 该包**解析不了**（模拟被掏空 / 被删）
 */
function fakeTree({ tree, rootName = '@deepseek-ai/dsh', entry = '/fw/node_modules/@deepseek-ai/dsh/lib/bin.js' }) {
  const dirOf = (name) => `/fw/node_modules/${name}`
  return probeClosure({
    entry,
    rootName,
    deps: {
      createRequire: () => ({ resolve: () => { throw new Error('not used (resolveSpec 已注入)') } }),
      resolveSpec: (name) => (name in tree && tree[name] !== null ? dirOf(name) : null),
      exists: () => true,
      readJson: (p) => {
        // ★ 路径分隔符归一：`join()` 在 Windows 上产出反斜杠，判据不该依赖宿主平台
        const norm = String(p).replace(/\\/gu, '/')
        const m = /\/node_modules\/(.+)\/package\.json$/u.exec(norm)
        const name = m === null ? null : m[1]
        const node = name === null ? null : tree[name]
        if (node === null || node === undefined) throw new Error('ENOENT')
        return {
          name,
          version: node.version,
          dependencies: node.deps ?? {},
          peerDependencies: node.peerDeps ?? {},
          peerDependenciesMeta: node.optionalPeers ?? {},
        }
      },
    },
  })
}

// ══ ① 坏包只报一条 ═══════════════════════════════════════════════════════════
await check('① 枢纽包坏掉：46 个下游引用只产出 1 条记录（不淹没原因）', () => {
  // dsh-tools 被掏空；a/b/c 都依赖它
  const tree = {
    '@deepseek-ai/dsh': { version: '1.0.0', deps: { '@deepseek-ai/a': '*', '@deepseek-ai/b': '*' } },
    '@deepseek-ai/a': { version: '1.0.0', deps: { '@deepseek-ai/dsh-tools': '*' } },
    '@deepseek-ai/b': { version: '1.0.0', deps: { '@deepseek-ai/dsh-tools': '*' } },
    '@deepseek-ai/c': { version: '1.0.0', deps: { '@deepseek-ai/dsh-tools': '*' } },
    '@deepseek-ai/dsh-tools': null,
  }
  const r = fakeTree({ tree })
  assert.equal(r.ok, false)
  assert.equal(r.broken.length, 1, `应只报 1 条，实得 ${r.broken.length}：${JSON.stringify(r.broken)}`)
  assert.equal(r.broken[0].name, '@deepseek-ai/dsh-tools')
  assert.equal(r.broken[0].reason, 'unresolvable')
})

// ══ ② 可选 peer 不算坏 ════════════════════════════════════════════════════════
await check('② 可选 peer 缺失不算坏（不冤枉 optional 依赖）', () => {
  const tree = {
    '@deepseek-ai/dsh': { version: '1.0.0', deps: { '@deepseek-ai/a': '*' } },
    '@deepseek-ai/a': {
      version: '1.0.0',
      peerDeps: { '@deepseek-ai/cordis-plugin-include': '*', '@deepseek-ai/cordis-plugin-loader': '*' },
      optionalPeers: { '@deepseek-ai/cordis-plugin-include': { optional: true }, '@deepseek-ai/cordis-plugin-loader': { optional: true } },
    },
  }
  const r = fakeTree({ tree })
  assert.equal(r.ok, true, `两个可选 peer 都缺，不该判坏：${JSON.stringify(r.broken)}`)
  assert.equal(r.broken.length, 0)
})

await check('②b 必填 peer 缺失**要**判坏（负控：别把判据放松成一律放行）', () => {
  const tree = {
    '@deepseek-ai/dsh': { version: '1.0.0', deps: { '@deepseek-ai/a': '*' } },
    '@deepseek-ai/a': { version: '1.0.0', peerDeps: { '@deepseek-ai/must-have': '*' } },
  }
  const r = fakeTree({ tree })
  assert.equal(r.ok, false)
  assert.equal(r.broken[0].name, '@deepseek-ai/must-have')
})

// ══ ③ 健康树是 no-op ═════════════════════════════════════════════════════════
await check('③ 健康的树：ok=true 且 walked 覆盖全部包', () => {
  const tree = {
    '@deepseek-ai/dsh': { version: '1.0.0', deps: { '@deepseek-ai/a': '*', '@deepseek-ai/b': '*' } },
    '@deepseek-ai/a': { version: '1.0.0', deps: { '@deepseek-ai/c': '*' } },
    '@deepseek-ai/b': { version: '1.0.0' },
    '@deepseek-ai/c': { version: '1.0.0' },
  }
  const r = fakeTree({ tree })
  assert.equal(r.ok, true)
  assert.deepEqual(r.walked.sort(), ['@deepseek-ai/a', '@deepseek-ai/b', '@deepseek-ai/c', '@deepseek-ai/dsh'])
})

await check('③b 入口自己解析不了 ⇒ 报根因（不是一串下游客）', () => {
  const r = fakeTree({ tree: {} })
  assert.equal(r.ok, false)
  assert.equal(r.broken.length, 1)
  assert.equal(r.broken[0].name, '@deepseek-ai/dsh')
})

// ══ ④ lock 索引 ══════════════════════════════════════════════════════════════
await check('④ lock 索引：lockfileVersion 3 的 packages 形态', () => {
  const p = join(SANDBOX, 'lock-v3.json')
  mkdirSync(SANDBOX, { recursive: true })
  writeFileSync(p, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'root' },
      'node_modules/@deepseek-ai/dsh-tools': { version: '0.2.0-rc.2', integrity: 'sha512-AAA', resolved: 'https://x/y.tgz' },
      'node_modules/a/node_modules/@scope/inner': { version: '9.9.9', integrity: 'sha512-BBB' },
      'node_modules/plain': { version: '1.0.0' },
    },
  }))
  const idx = buildLockIndex(p)
  assert.ok(idx.has('@deepseek-ai/dsh-tools@0.2.0-rc.2'))
  assert.ok(idx.has('@scope/inner@9.9.9'), '嵌套路径要取最后一段包名')
  assert.ok(idx.has('plain@1.0.0'))
  assert.equal(idx.get('@deepseek-ai/dsh-tools@0.2.0-rc.2').integrity, 'sha512-AAA')
})

await check('④b lock 不存在 / 坏 JSON ⇒ 空 Map（绝不抛）', () => {
  assert.equal(buildLockIndex(join(SANDBOX, 'nope.json')).size, 0)
  const bad = join(SANDBOX, 'lock-bad.json')
  writeFileSync(bad, '{ this is not json')
  assert.equal(buildLockIndex(bad).size, 0)
})

await check('④c lock 在老格式（dependencies 树）下也能建索引', () => {
  const p = join(SANDBOX, 'lock-old.json')
  writeFileSync(p, JSON.stringify({
    lockfileVersion: 1,
    dependencies: { '@deepseek-ai/dsh-llm': { version: '0.2.0-rc.2', integrity: 'sha512-CCC' } },
  }))
  const idx = buildLockIndex(p)
  assert.ok(idx.has('@deepseek-ai/dsh-llm@0.2.0-rc.2'))
})

// ══ ⑤⑥⑦ 计划 ════════════════════════════════════════════════════════════════
await check('⑤ 同包多版本 ⇒ 取版本最高那条', () => {
  const idx = new Map([
    ['@deepseek-ai/x@0.1.0', { name: '@deepseek-ai/x', version: '0.1.0', integrity: 'sha512-OLD' }],
    ['@deepseek-ai/x@0.2.0', { name: '@deepseek-ai/x', version: '0.2.0', integrity: 'sha512-NEW' }],
    ['@deepseek-ai/x@0.1.9', { name: '@deepseek-ai/x', version: '0.1.9', integrity: 'sha512-MID' }],
  ])
  const plan = planClosureRepair({ broken: [{ name: '@deepseek-ai/x' }], lockIndex: idx, nodeModulesDir: '/fw/node_modules' })
  assert.equal(plan.items[0].version, '0.2.0')
  assert.equal(plan.items[0].integrity, 'sha512-NEW')
})

await check('⑥ lock 里没有 ⇒ no-lock-entry（不猜版本）；无 integrity ⇒ no-integrity', () => {
  const plan = planClosureRepair({
    broken: [{ name: '@deepseek-ai/gone' }, { name: '@deepseek-ai/no-sum' }],
    lockIndex: new Map([['@deepseek-ai/no-sum@1.0.0', { name: '@deepseek-ai/no-sum', version: '1.0.0', integrity: null }]]),
    nodeModulesDir: '/fw/node_modules',
  })
  assert.equal(plan.items.length, 0)
  const reasons = Object.fromEntries(plan.skippable.map((s) => [s.name, s.reason]))
  assert.equal(reasons['@deepseek-ai/gone'], 'no-lock-entry')
  assert.equal(reasons['@deepseek-ai/no-sum'], 'no-integrity')
})

await check('⑦ 目标判定：resolve 优先于 top-level 优先于 pnpm-store', () => {
  const idx = new Map([['@deepseek-ai/x@1.0.0', { name: '@deepseek-ai/x', version: '1.0.0', integrity: 'sha512-A' }]])
  const broken = [{ name: '@deepseek-ai/x' }]
  const base = { lockIndex: idx, nodeModulesDir: '/fw/node_modules', storeDir: '/fw/node_modules/.pnpm/node_modules' }
  // 用 join() 而非硬编码 '/' —— 判据本身依赖宿主分隔符，断言要跟着走
  const nm = join('/fw/node_modules', '@deepseek-ai', 'x')
  const st = join('/fw/node_modules/.pnpm/node_modules', '@deepseek-ai', 'x')

  const r1 = planClosureRepair({ ...base, broken, resolveDir: () => '/resolved/x' })
  assert.equal(r1.items[0].target, '/resolved/x')
  assert.equal(r1.items[0].via, 'resolve')

  const r2 = planClosureRepair({ ...base, broken, resolveDir: () => null })
  assert.equal(r2.items[0].target, nm)
  assert.equal(r2.items[0].via, 'top-level')

  const r3 = planClosureRepair({ ...base, broken, resolveDir: () => null, nodeModulesDir: null })
  assert.equal(r3.items[0].target, st)
  assert.equal(r3.items[0].via, 'pnpm-store')
})

// ══ ⑧ integrity → cacache 路径 ═══════════════════════════════════════════════
await check('⑧ integrity → content-v2 路径：sha512 布局正确', () => {
  // 造一个已知的 sha512：hex 前 4 位决定两级目录
  const hex = 'ab'.repeat(64) // 128 个 hex 字符
  const b64 = Buffer.from(hex, 'hex').toString('base64')
  const p = integrityToContentPath('/cache/_cacache', `sha512-${b64}`)
  assert.equal(p, join('/cache/_cacache', 'content-v2', 'sha512', 'ab', 'ab', 'ab'.repeat(62)))
})

await check('⑧b 非法 integrity ⇒ null（不猜路径）', () => {
  for (const bad of [null, undefined, '', 'sha1-abc', 'sha512-!!!', 'sha512-' + Buffer.from('short').toString('base64'), 123]) {
    assert.equal(integrityToContentPath('/c', bad), null, `应对 ${String(bad)} 返回 null`)
  }
})

await check('⑧c 缓存根探测：只认真有 content-v2 的目录', () => {
  // 语义：env 给的是 npm 的 **cache 根**（`npm config get cache`），其下才是 `_cacache`。
  // 目录名带 `_cacache` 时按原样用；不带时自动拼一层。
  const fakeBase = join(SANDBOX, 'fakebase')
  const realBase = join(SANDBOX, 'realbase')
  mkdirSync(fakeBase, { recursive: true })
  mkdirSync(join(realBase, '_cacache', 'content-v2'), { recursive: true })
  const roots = candidateCacheRoots({ env: { npm_config_cache: realBase, NPM_CONFIG_CACHE: fakeBase }, home: '/nope' })
  assert.ok(roots.includes(join(realBase, '_cacache')), `真的缓存根要在列表里，实得 ${JSON.stringify(roots)}`)
  assert.ok(!roots.some((p) => p.includes('fakebase')), '只有目录名、没有 content-v2 的不算')
})

await check('⑧d 缓存根探测：直接给 `_cacache` 本身也认', () => {
  const direct = join(SANDBOX, 'directbase', '_cacache')
  mkdirSync(join(direct, 'content-v2'), { recursive: true })
  const roots = candidateCacheRoots({ env: { npm_config_cache: direct }, home: '/nope' })
  assert.ok(roots.includes(direct), `显式给 _cacache 时应原样命中，实得 ${JSON.stringify(roots)}`)
})

// ══ ⑨ 解包（真磁盘沙箱 + 自造 tgz）═══════════════════════════════════════════
/** 造一个最小 ustar tgz（够覆盖 npm tarball 的形态：`package/` 前缀 + 目录 + 文件）。 */
function makeTgz(entries) {
  const blocks = []
  for (const e of entries) {
    const name = e.name
    const body = e.type === '5' ? Buffer.alloc(0) : Buffer.from(e.content ?? '', 'utf8')
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'utf8')
    header.write('0000000\0', 108, 8, 'utf8')
    header.write('0000000\0', 116, 8, 'utf8')
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write(e.type ?? '0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('00', 263, 2, 'utf8')
    let sum = 0
    for (const b of header) sum += b
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8')
    blocks.push(header)
    if (body.length > 0) {
      blocks.push(body)
      const pad = (512 - (body.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

await check('⑨ 解包：package/ 前缀剥掉、目录与文件都落地', () => {
  const dest = join(SANDBOX, 'extract-ok')
  rmSync(dest, { recursive: true, force: true })
  const tgz = makeTgz([
    { name: 'package/', type: '5' },
    { name: 'package/package.json', content: '{"name":"@deepseek-ai/dsh-tools","version":"0.2.0-rc.2"}' },
    { name: 'package/lib/', type: '5' },
    { name: 'package/lib/index.js', content: 'export const x = 1\n' },
  ])
  const stat = extractTgz(tgz, dest)
  assert.equal(stat.files, 2, `应解出 2 个文件，实得 ${stat.files}`)
  assert.ok(existsSync(join(dest, 'package.json')), 'package.json 要在 dest 根（前缀已剥）')
  assert.ok(existsSync(join(dest, 'lib', 'index.js')))
  assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version, '0.2.0-rc.2')
})

await check('⑨b 解包：拒绝目录穿越条目（坏缓存不许写到树外）', () => {
  const dest = join(SANDBOX, 'extract-escape')
  const outside = join(SANDBOX, 'ESCAPED.txt')
  rmSync(dest, { recursive: true, force: true })
  rmSync(outside, { force: true })
  const tgz = makeTgz([
    { name: 'package/ok.txt', content: 'fine' },
    { name: 'package/../../../ESCAPED.txt', content: 'should not land' },
  ])
  const stat = extractTgz(tgz, dest)
  assert.ok(existsSync(join(dest, 'ok.txt')), '正常条目仍要解出来')
  assert.ok(!existsSync(outside), '穿越条目必须被拒（ESCAPED.txt 不许落地）')
  assert.ok(stat.skipped >= 1, '被拒的条目要计入 skipped')
})

// ══ ⑩⑪ 端到端：造一棵被掏空的框架树 ⇒ 修复 ⇒ 复验 ═══════════════════════════
await check('⑩⑪ 端到端：掏空的包从本地缓存装回，且旧内容改成 .preflight-bak 备份', async () => {
  const fwRoot = join(SANDBOX, 'fw', 'node_modules')
  const cacheRoot = join(SANDBOX, 'cache', '_cacache')
  rmSync(join(SANDBOX, 'fw'), { recursive: true, force: true })
  rmSync(join(SANDBOX, 'cache'), { recursive: true, force: true })

  // 造两个包：`dsh`（好的，作为入口）与 `@deepseek-ai/dsh-tools`（**被掏空**）
  const dshDir = join(fwRoot, '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', main: 'lib/bin.js', dependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' } }))
  writeFileSync(join(dshDir, 'lib', 'bin.js'), '// entry\n')

  const toolsDir = join(fwRoot, '@deepseek-ai', 'dsh-tools')
  mkdirSync(toolsDir, { recursive: true })
  // 掏空形态之一：目录在、里面**还留着一个残留文件**（不是全空 ⇒ 走"改名备份"那条路）
  writeFileSync(join(toolsDir, 'LEFTOVER.txt'), 'stale residue')

  // 造该包的 tarball，并按 integrity 放进自造缓存的正确路径
  const tgz = makeTgz([
    { name: 'package/package.json', content: JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.0-rc.2', main: 'lib/index.js' }) },
    { name: 'package/lib/index.js', content: 'export const ok = true\n' },
  ])
  const { createHash } = await import('node:crypto')
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const contentPath = integrityToContentPath(cacheRoot, integrity)
  mkdirSync(dirname(contentPath), { recursive: true })
  writeFileSync(contentPath, tgz)

  // lock 住在 fwRoot 的**父目录**（真机形态）
  writeFileSync(join(dirname(fwRoot), 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/@deepseek-ai/dsh-tools': { version: '0.2.0-rc.2', integrity } },
  }))

  // 修前：探测应报 dsh-tools 坏
  const beforePlan = runFwPreflight({ fwRoot, repair: false, cacheRoots: [cacheRoot] })
  assert.equal(beforePlan.ok, false, '掏空后应判定不完整')
  assert.equal(beforePlan.before.broken.length, 1)
  assert.equal(beforePlan.before.broken[0].name, '@deepseek-ai/dsh-tools')
  assert.equal(beforePlan.lockKind, 'npm', `lock 应定位到父目录那份，实得 ${beforePlan.lockPath}`)

  // 修：真装回
  const after = runFwPreflight({ fwRoot, repair: true, cacheRoots: [cacheRoot] })
  assert.equal(after.repaired.length, 1, `应修 1 个，实得 ${JSON.stringify(after)}`)
  assert.equal(after.repaired[0].name, '@deepseek-ai/dsh-tools')
  assert.equal(after.okAfter, true, '复验必须通过')
  assert.ok(existsSync(join(toolsDir, 'package.json')), 'package.json 要装回来')
  assert.equal(JSON.parse(readFileSync(join(toolsDir, 'package.json'), 'utf8')).version, '0.2.0-rc.2')

  // 旧内容必须留成备份（**绝不直接删**）
  const siblings = readdirSync(join(fwRoot, '@deepseek-ai'))
  const baks = siblings.filter((n) => isPreflightBak(n))
  assert.equal(baks.length, 1, `应留下 1 个 .preflight-bak 备份，实得 ${JSON.stringify(siblings)}`)
  assert.ok(existsSync(join(fwRoot, '@deepseek-ai', baks[0], 'LEFTOVER.txt')), '备份里要保住原来的残留文件')
})

await check('⑪b 幂等：健康的树再修一次 = 一个字节都不写', () => {
  const fwRoot = join(SANDBOX, 'fw2', 'node_modules')
  rmSync(join(SANDBOX, 'fw2'), { recursive: true, force: true })
  const dshDir = join(fwRoot, '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', dependencies: {} }))
  writeFileSync(join(dshDir, 'lib', 'bin.js'), '// entry\n')
  const stamp = () => {
    const out = []
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); out.push(p); if (e.isDirectory()) walk(p) } }
    walk(fwRoot)
    return out.sort()
  }
  const before = stamp()
  const r = runFwPreflight({ fwRoot, repair: true, cacheRoots: [] })
  assert.equal(r.ok, true)
  assert.equal(r.okAfter, true)
  assert.equal(r.repaired.length, 0, '不该修任何东西')
  assert.deepEqual(stamp(), before, '健康树上不许有任何写盘')
})

await check('⑪c lock 是 pnpm 形态时如实记 kind（不静默当成没有）', () => {
  const fwRoot = join(SANDBOX, 'fw3', 'node_modules')
  rmSync(join(SANDBOX, 'fw3'), { recursive: true, force: true })
  mkdirSync(join(fwRoot, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(fwRoot, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', dependencies: {} }))
  writeFileSync(join(fwRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// e\n')
  writeFileSync(join(dirname(fwRoot), 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const located = locateLockfile(fwRoot)
  assert.equal(located.kind, 'pnpm')
  const r = runFwPreflight({ fwRoot, repair: false, cacheRoots: [] })
  assert.equal(r.lockKind, 'pnpm')
})

await check('⑪d junction 形态：内容写进**实体**，链接原样保留（不改写 pnpm 链接结构）', async () => {
  // 真机 2026-10-14 演练抓到的设计错误：`cordis` 的坏法是"顶层 junction 还在、它指向的
  // `.pnpm` 实体被掏空"。若把内容写进顶层那个 junction 名字，顶层会从"链接"退化成"真实目录"
  // ⇒ 同一份包在树里多出第二个实体 ⇒ 模块身份（instanceof / 单例注册表）不再共享。
  const fwRoot = join(SANDBOX, 'fw4', 'node_modules')
  const cacheRoot = join(SANDBOX, 'cache4')
  const storeDir = join(fwRoot, '.pnpm', '@deepseek-ai+dsh-tools@0.2.0-rc.2', 'node_modules', '@deepseek-ai', 'dsh-tools')
  const topLink = join(fwRoot, '@deepseek-ai', 'dsh-tools')
  rmSync(join(SANDBOX, 'fw4'), { recursive: true, force: true })
  rmSync(cacheRoot, { recursive: true, force: true })

  const dshDir = join(fwRoot, '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', dependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' } }))
  writeFileSync(join(dshDir, 'lib', 'bin.js'), '// entry\n')

  // 实体：**被掏空**（空目录）；顶层是指向它的 junction
  mkdirSync(storeDir, { recursive: true })
  mkdirSync(dirname(topLink), { recursive: true })
  try { rmSync(topLink, { recursive: true, force: true }) } catch {}
  symlinkSync(storeDir, topLink, 'junction')

  const tgz = makeTgz([
    { name: 'package/package.json', content: JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.0-rc.2', main: 'lib/index.js' }) },
    { name: 'package/lib/index.js', content: 'export const ok = true\n' },
  ])
  const { createHash } = await import('node:crypto')
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const contentPath = integrityToContentPath(cacheRoot, integrity)
  mkdirSync(dirname(contentPath), { recursive: true })
  writeFileSync(contentPath, tgz)
  writeFileSync(join(dirname(fwRoot), 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/@deepseek-ai/dsh-tools': { version: '0.2.0-rc.2', integrity } },
  }))

  const r = runFwPreflight({ fwRoot, repair: true, cacheRoots: [cacheRoot] })
  assert.equal(r.repaired.length, 1, `应修 1 个，实得 repaired=${JSON.stringify(r.repaired)} failed=${JSON.stringify(r.failed)}`)
  assert.equal(r.okAfter, true)

  // ① 顶层必须**仍然是链接**（本断言的核心）
  assert.ok(lstatSync(topLink).isSymbolicLink(), '顶层必须仍是链接 —— 不许退化成真实目录')
  // ② 内容要落在**实体**那一侧
  assert.ok(existsSync(join(storeDir, 'package.json')), '内容应写进 junction 指向的实体')
  // ③ 经链接读得到，且两侧是同一份（身份共享）
  assert.equal(JSON.parse(readFileSync(join(topLink, 'package.json'), 'utf8')).version, '0.2.0-rc.2')
  assert.equal(realpathSync(join(topLink, 'package.json')), realpathSync(join(storeDir, 'package.json')), '两侧必须是同一份文件')
})

await check('⑪e 取不到内容时如实记账：复验报"仍不完整"，绝不假装成功', () => {
  const fwRoot = join(SANDBOX, 'fw5', 'node_modules')
  rmSync(join(SANDBOX, 'fw5'), { recursive: true, force: true })
  const dshDir = join(fwRoot, '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', dependencies: { '@deepseek-ai/gone': '1.0.0' } }))
  writeFileSync(join(dshDir, 'lib', 'bin.js'), '// e\n')
  writeFileSync(join(dirname(fwRoot), 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/@deepseek-ai/gone': { version: '1.0.0', integrity: `sha512-${Buffer.from('ab'.repeat(64), 'hex').toString('base64')}` } },
  }))
  // 缓存根是空的 ⇒ 取不到 tarball
  const r = runFwPreflight({ fwRoot, repair: true, cacheRoots: [join(SANDBOX, 'empty-cache')] })
  assert.equal(r.repaired.length, 0)
  assert.equal(r.failed.length, 1, '取不到内容必须记进 failed')
  assert.equal(r.okAfter, false, '复验要如实报"仍不完整"')
})

// ══ ⑫ 红线：绝不 spawn / kill ════════════════════════════════════════════════
await check('⑫ 红线：源码里不出现 child_process / spawn / exec / kill（只做文件级修复）', () => {
  const files = [
    join(ROOT, '..', 'lib', 'server', 'infra', 'fw-closure.js'),
    join(ROOT, '..', 'lib', 'server', 'infra', 'npm-cache.js'),
    join(ROOT, '..', 'lib', 'server', 'infra', 'fw-root-detect.js'),
    join(ROOT, '..', 'lib', 'server', 'domain', 'fw-preflight.js'),
    join(ROOT, '..', 'scripts', 'fw-preflight.mjs'),
  ]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    // 剥掉注释再断言：注释里提到这些词（解释"为什么不 spawn"）是允许的
    const code = src.replace(/^\s*\/\/.*$/gmu, '').replace(/\/\*[\s\S]*?\*\//gu, '')
    for (const banned of ['child_process', 'spawnSync', 'execSync', 'execFile', 'taskkill', 'schtasks']) {
      assert.ok(!code.includes(banned), `${f.replace(ROOT, '')} 不该出现 ${banned}（2026-10-10 的教训：抢端口/杀宿主会弹「应用无法启动或已意外停止」）`)
    }
  }
})

console.log(passed === 0 ? '' : `\n${passed} PASSED`)
