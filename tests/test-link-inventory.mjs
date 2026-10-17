// link 清单与体检的**离线**判据测试（0.5.54 加法）。
//
// 真机背景（用户 2026-10-15）：「这主要是对标他们本地开发插件 link 挂载钉住」——
//   而面板上 link 钉住的插件与普通插件长得一模一样：看不出指向哪、目标还在不在、
//   依赖/peer 齐不齐、垫片还在不在。本模块把这些**只读地**聚合成清单。
//
// 本套钉死的判据（每条都要能失败）：
//   ① 只收**路径型来源**（link: / file:）—— registry 版本号依赖绝不混进来
//   ② 目标存在时读出它的版本；目标不存在时 targetExists=false 且版本为 null（不猜）
//   ③ 缺依赖 / 缺 peer 如实分列（两条不同的出路：pnpm 与垫片）
//   ④ 垫片账（我们造过哪些）能读出来 —— 它是"卸载时只清我们造的"那份记录
//   ⑤ 持久化三处判据（清单 + lock + 挂载行）由 persistReport 提供，这里只透传不重算
//   ⑥ `isLinkTargetOfProfile` = repo-open 的白名单判据：
//      只认清单里写着的目标（正控），任意路径一律 false（负控 —— 浏览器改不了清单）
//
// 全离线：私有夹具（tests/.testdir/，已 gitignore），不联网、不 spawn、不动真实 profile。
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '.testdir', 'link-inventory')
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, 'home')
const PROFILE = join(ROOT, 'profile')
const writeJson = (file, v) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`, 'utf8') }
const touch = (file, body = 'export const ok = true\n') => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body, 'utf8') }

// 目标目录：一个"自足"的、一个"缺依赖"的、一个"目标不存在"的
// ★ 陷阱（本目录特有，值得记住）：`tests/.testdir/node_modules` 里留着**历史夹具残留**
//   （`@deepseek-ai/dsh-llm` / `dsh-mcp-client` / `dsh-schedule` …，被 gitignore 但真实存在）。
//   任何放在 `.testdir` 下的夹具，向上解析都会撞见它 ⇒ 若夹具用**真实包名**声明 peer，
//   会意外"解析成功"、给出**假绿**。所以缺 peer 的用例必须用**保证不存在**的名字。
const GOOD = join(ROOT, 'dev', 'good-plugin')
writeJson(join(GOOD, 'package.json'), { name: 'good-plugin', version: '1.2.3', dependencies: {}, peerDependencies: {} })
touch(join(GOOD, 'index.js'))

const LONELY = join(ROOT, 'dev', 'lonely-plugin')
writeJson(join(LONELY, 'package.json'), {
  name: 'lonely-plugin', version: '0.1.0',
  dependencies: { 'left-pad': '^1.3.0' },                 // 目标目录里没有 ⇒ missingDeps
  peerDependencies: { '@deepseek-ai/definitely-not-installed-peer-xyz': '^0.2.0' }, // 解析不到 ⇒ missingPeers
})
touch(join(LONELY, 'index.js'))

// profile 清单：2 个 link + 1 个 file + 1 个 registry（后者必须被排除）
writeJson(join(PROFILE, 'package.json'), {
  name: 'profile-fixture', private: true,
  dependencies: {
    'good-plugin': `link:${GOOD.replace(/\\/gu, '/')}`,
    'lonely-plugin': `link:${LONELY.replace(/\\/gu, '/')}`,
    'gone-plugin': 'link:' + join(ROOT, 'dev', 'does-not-exist').replace(/\\/gu, '/'),
    'file-plugin': `file:${GOOD.replace(/\\/gu, '/')}`,
    'registry-plugin': '^1.0.0',
  },
})
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '- id: demo\n  disabled: true\n', 'utf8')

// 垫片记录（模拟我们给 lonely-plugin 造过 2 个）
writeJson(join(HOME, 'plugin-console', 'link-self-sufficiency', 'lonely-plugin.json'), {
  packageName: 'lonely-plugin',
  updatedAt: '2026-10-15T00:00:00.000Z',
  shims: [
    { link: join(LONELY, 'node_modules', '@deepseek-ai', 'dsh-llm'), target: join(HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm') },
    { link: join(LONELY, 'node_modules', '@deepseek-ai', 'cordis'), target: join(HOME, 'profiles', 'node_modules', '@deepseek-ai', 'cordis') },
  ],
})

const { buildLinkInventory, isLinkTargetOfProfile, pathDepsOf } = await import('../lib/server/domain/link-inventory.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

const inv = buildLinkInventory({ profileDir: PROFILE, patchPath: join(PROFILE, 'cordis.patch.yml'), home: HOME })
const byName = Object.fromEntries(inv.items.map((x) => [x.packageName, x]))

// ── ① 只收路径型来源 ───────────────────────────────────────────────────────
check('① 只收 link:/file: 依赖，registry 版本号依赖被排除', () => {
  assert.equal(byName['registry-plugin'], undefined, 'registry 依赖不该出现')
  assert.ok(byName['good-plugin'] && byName['lonely-plugin'] && byName['gone-plugin'] && byName['file-plugin'])
  assert.equal(inv.count, 4, `期望 4 个路径型依赖，实际 ${inv.count}`)
  assert.equal(pathDepsOf(PROFILE).length, 4)
})

// ── ② 目标与版本 ───────────────────────────────────────────────────────────
check('② 目标存在 ⇒ 读出它的真实版本', () => {
  assert.equal(byName['good-plugin'].targetExists, true)
  assert.equal(byName['good-plugin'].version, '1.2.3')
})
check('② 目标不存在 ⇒ targetExists=false 且版本为 null（绝不猜）', () => {
  assert.equal(byName['gone-plugin'].targetExists, false)
  assert.equal(byName['gone-plugin'].version, null)
})

// ── ③ 缺依赖 / 缺 peer 分列 ────────────────────────────────────────────────
check('③ 缺依赖与缺 peer 分开列（两条不同的出路：pnpm 补依赖、垫片补 peer）', () => {
  const x = byName['lonely-plugin']
  assert.ok(x.missingDeps.includes('left-pad'), `missingDeps=${JSON.stringify(x.missingDeps)}`)
  assert.ok(x.missingPeers.includes('@deepseek-ai/definitely-not-installed-peer-xyz'), `missingPeers=${JSON.stringify(x.missingPeers)}`)
  assert.equal(x.ready, false)
})
check('③ 自足的插件 ready=true（正控：别把好的也说成坏的）', () => {
  assert.equal(byName['good-plugin'].ready, true, `ready=${byName['good-plugin'].ready} missingDeps=${JSON.stringify(byName['good-plugin'].missingDeps)}`)
})

// ── ④ 垫片账 ───────────────────────────────────────────────────────────────
check('④ 垫片记录能读出来（数量 + 明细）', () => {
  const x = byName['lonely-plugin']
  assert.ok(x.shims, '应有垫片记录')
  assert.equal(x.shims.count, 2)
  assert.equal(x.shims.items.length, 2)
})
check('④ 没有记录的插件 ⇒ shims 为 null（不是伪造的空对象）', () => {
  assert.equal(byName['good-plugin'].shims, null)
})

// ── ⑤ 持久化三处判据由 persistReport 提供（这里只透传）──────────────────────
check('⑤ 持久化字段存在且有 missing 数组（判据不在本模块重算）', () => {
  const x = byName['good-plugin']
  assert.ok(x.persisted && Array.isArray(x.persisted.missing), JSON.stringify(x.persisted))
  assert.equal(typeof x.persisted.ok, 'boolean')
})

// ── ⑥ repo-open 的白名单判据 ───────────────────────────────────────────────
check('⑥ 正控：清单里写着的 link 目标 ⇒ 允许（白名单命中）', () => {
  assert.equal(isLinkTargetOfProfile(PROFILE, GOOD), true)
  assert.equal(isLinkTargetOfProfile(PROFILE, GOOD.replace(/\\/gu, '/')), true, '正斜杠形态也应命中')
})
check('⑥ ★ 负控：清单外的任意路径 ⇒ 一律不允许（浏览器改不了清单，因此不构成越权）', () => {
  assert.equal(isLinkTargetOfProfile(PROFILE, 'C:/Windows/System32'), false)
  assert.equal(isLinkTargetOfProfile(PROFILE, join(ROOT, 'dev')), false, '父目录不算目标本身')
  assert.equal(isLinkTargetOfProfile(PROFILE, ''), false)
  assert.equal(isLinkTargetOfProfile(PROFILE, null), false)
})

// ── ⑦ 空清单是正常空态 ─────────────────────────────────────────────────────
check('⑦ 没有 link 依赖 ⇒ 空清单（count=0，不抛）', () => {
  const empty = join(ROOT, 'empty-profile')
  writeJson(join(empty, 'package.json'), { name: 'p', private: true, dependencies: { x: '^1.0.0' } })
  const r = buildLinkInventory({ profileDir: empty, home: HOME })
  assert.deepEqual({ count: r.count, items: r.items.length }, { count: 0, items: 0 })
})

rmSync(ROOT, { recursive: true, force: true })
console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
