// 取消钉住（unpin-dev-dir）离线判据（0.5.87 加法）
//
// 用户 2026-10-18 要求：link 面板里"已钉住 → [取消钉住]"（移除 link: 覆盖，参考 routes/revoke-force.js
//   的做法与安全语义）。语义照抄 revoke-force 的**窄动作**纪律：
//     只对**清单里真写着 link:/file: 的那一条**生效；不是这种来源一律拒（不猜、不代劳）；
//     两段式（先只读计划，confirm 后才动手）；备份 → 动手 → **读回三处**；失败即回滚、绝不谎报。
//
// 本套钉死（每条都能失败）：
//   ①② 规划：只认路径型依赖；registry 依赖 / 不存在的依赖 / 非法包名一律拒（带人话原因）
//   ③  规划**只读**：一个字节都不写
//   ④  在 dsh.profile.bundles 里 ⇒ 必须在 warnings 里明说后果（不替用户改 bundles）
//   ⑤  目标目录已不在 ⇒ 照实提示"陈旧链接，取消它没有功能损失"
//   ⑥  ★ 执行：pnpm 报成功但读回清单里还有它 ⇒ 必须失败 + 回滚（绝不谎报）
//   ⑦  ★ pnpm 抛错 ⇒ 清单逐字节回滚，backup 留下
//   ⑧  正控：三处（清单 / lock / node_modules）读回全清 + note 明说"开发目录与代码未被删除"
//
// 全离线：私有夹具（tests/.testdir，已 gitignore）+ 注入的假 pnpm remove。一次真实 pnpm 都不跑。
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '.testdir', 'unpin-dev-dir')
rmSync(ROOT, { recursive: true, force: true })
const PROFILE = join(ROOT, 'profile')
const DEV = join(ROOT, 'dev', 'linked-plugin')
const DEV2 = join(ROOT, 'dev', 'file-plugin')
const GONE = join(ROOT, 'dev', 'gone-plugin')

const writeJson = (file, v) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`, 'utf8') }
const linkSpec = (dir) => `link:${dir.replace(/\\/gu, '/')}`
writeJson(join(DEV, 'package.json'), { name: 'linked-plugin', version: '0.3.0', dsh: { bundle: {} } })
writeJson(join(DEV2, 'package.json'), { name: 'file-plugin', version: '0.3.0', dsh: { bundle: {} } })
mkdirSync(join(PROFILE, 'node_modules', 'linked-plugin'), { recursive: true })
writeJson(join(PROFILE, 'node_modules', 'linked-plugin', 'package.json'), { name: 'linked-plugin', version: '0.3.0' })
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# x\n', 'utf8')
const manifest = (deps, bundles = []) => writeJson(join(PROFILE, 'package.json'), { name: 'profile-fixture', private: true, dependencies: deps, dsh: { profile: { bundles } } })
const lockWith = (names) => writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  ...names.flatMap((n) => [`      ${n}:`, `        specifier: ${linkSpec(DEV)}`, `        version: link:../../dev/${n}`]),
  '',
].join('\n'), 'utf8')

manifest({ 'linked-plugin': linkSpec(DEV), 'file-plugin': `file:${DEV2.replace(/\\/gu, '/')}`, 'registry-plugin': '^1.0.0' }, ['linked-plugin'])
lockWith(['linked-plugin', 'file-plugin'])

const { planUnpinDevDir, applyUnpinDevDir } = await import('../lib/server/domain/unpin-dev-dir.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const manifestText = () => readFileSync(join(PROFILE, 'package.json'), 'utf8')

// ── ① 只认路径型依赖 ───────────────────────────────────────────────────────
check('① ★ registry 依赖 ⇒ 拒（"它本来就没被钉住"），不代劳', () => {
  const p = planUnpinDevDir({ profileDir: PROFILE, packageName: 'registry-plugin' })
  assert.equal(p.ok, false)
  assert.ok(String(p.error).includes('不是 link:/file:'), p.error)
})
check('① 清单里没有的依赖 ⇒ 拒（"没有可取消的钉住"）', () => {
  const p = planUnpinDevDir({ profileDir: PROFILE, packageName: 'no-such-package' })
  assert.equal(p.ok, false)
  assert.ok(String(p.error).includes('没有可取消的钉住'), p.error)
})
check('① 非法包名 / 拿不到 profile ⇒ 拒（不猜）', () => {
  assert.equal(planUnpinDevDir({ profileDir: PROFILE, packageName: 'bad name!' }).ok, false)
  assert.equal(planUnpinDevDir({ profileDir: PROFILE, packageName: '' }).ok, false)
  const noProfile = planUnpinDevDir({ profileDir: null, packageName: 'linked-plugin' })
  assert.equal(noProfile.ok, false)
  assert.ok(String(noProfile.error).includes('profile 目录'), noProfile.error)
})

// ── ② 规划内容 ────────────────────────────────────────────────────────────
check('② 规划给出 spec / 目标 / 步骤（面板直接渲染给人看）', () => {
  const p = planUnpinDevDir({ profileDir: PROFILE, packageName: 'linked-plugin' })
  assert.equal(p.ok, true, p.error ?? '')
  assert.ok(String(p.spec).startsWith('link:'), p.spec)
  assert.equal(p.targetExists, true)
  assert.ok(Array.isArray(p.steps) && p.steps.length >= 3, JSON.stringify(p.steps))
  assert.ok(p.steps.some((s) => s.includes('pnpm remove')), JSON.stringify(p.steps))
})
check('② file: 也算路径型（与 link: 同一族）', () => {
  const p = planUnpinDevDir({ profileDir: PROFILE, packageName: 'file-plugin' })
  assert.equal(p.ok, true, p.error ?? '')
  assert.ok(String(p.spec).startsWith('file:'), p.spec)
})
check('④ ★ 它在 dsh.profile.bundles 里 ⇒ warnings 明说后果（不替用户改 bundles）', () => {
  const p = planUnpinDevDir({ profileDir: PROFILE, packageName: 'linked-plugin' })
  assert.equal(p.inBundles, true)
  assert.equal(p.warnings.length, 1, JSON.stringify(p.warnings))
  assert.ok(p.warnings[0].includes('dsh.profile.bundles'), p.warnings[0])
  // 不在 bundles 里的那条不该背这条警告
  assert.equal(planUnpinDevDir({ profileDir: PROFILE, packageName: 'file-plugin' }).warnings.length, 0)
})
check('⑤ 目标目录已不在 ⇒ 提示"陈旧链接，取消它没有功能损失"', () => {
  manifest({ 'gone-plugin': linkSpec(GONE) }, [])
  const p = planUnpinDevDir({ profileDir: PROFILE, packageName: 'gone-plugin' })
  assert.equal(p.ok, true, p.error ?? '')
  assert.equal(p.targetExists, false)
  assert.ok(p.warnings.some((w) => w.includes('已经不在了')), JSON.stringify(p.warnings))
  manifest({ 'linked-plugin': linkSpec(DEV), 'file-plugin': `file:${DEV2.replace(/\\/gu, '/')}`, 'registry-plugin': '^1.0.0' }, ['linked-plugin'])
})

// ── ③ 规划只读 ────────────────────────────────────────────────────────────
check('③ ★ 规划是只读的：清单 / lock 逐字节不变、node_modules 不动', () => {
  const before = { manifest: manifestText(), lock: readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8') }
  planUnpinDevDir({ profileDir: PROFILE, packageName: 'linked-plugin' })
  assert.equal(manifestText(), before.manifest)
  assert.equal(readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8'), before.lock)
  assert.equal(existsSync(join(PROFILE, 'node_modules', 'linked-plugin')), true)
})

// ── ⑥ 读回不符 ⇒ 失败 + 回滚（绝不谎报）───────────────────────────────────
await checkAsync('⑥ ★ pnpm 报成功但读回清单里还有它 ⇒ 必须失败、清单逐字节回滚', async () => {
  const before = manifestText()
  const r = await applyUnpinDevDir({ profileDir: PROFILE, packageName: 'linked-plugin', runRemove: async () => {} })
  assert.equal(r.ok, false, '读回不符却报成功 = 谎报')
  assert.equal(r.changed, false)
  assert.ok(String(r.error).includes('读回发现清单里仍有'), r.error)
  assert.equal(manifestText(), before, '清单必须回到改动前')
})

// ── ⑦ pnpm 抛错 ⇒ 回滚 + backup ───────────────────────────────────────────
await checkAsync('⑦ ★ pnpm remove 失败 ⇒ 清单逐字节回滚，backup 留下、错误如实带出', async () => {
  const before = manifestText()
  const r = await applyUnpinDevDir({
    profileDir: PROFILE, packageName: 'linked-plugin',
    runRemove: async () => { throw new Error('ERR_PNPM_FROZEN_LOCKFILE 模拟失败') },
  })
  assert.equal(r.ok, false)
  assert.equal(r.changed, false)
  assert.ok(String(r.error).includes('模拟失败'), r.error)
  assert.ok(String(r.error).includes('已回滚'), r.error)
  assert.equal(manifestText(), before)
  assert.ok(typeof r.backup === 'string' && existsSync(r.backup), `backup 应落盘：${r.backup}`)
})

// ── ⑧ 正控：三处都清掉 ────────────────────────────────────────────────────
await checkAsync('⑧ ★ 正控：清单 / lock / node_modules 三处读回全清，且说明"目录没删"', async () => {
  const runRemove = async ({ profileDir, packageName }) => {
    // 模拟 pnpm remove 的真实副作用：改清单、清 lock 条目、删 node_modules 里的链接
    const m = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    delete m.dependencies[packageName]
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(m, null, 2)}\n`, 'utf8')
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      file-plugin:',
      '        specifier: file:x',
      '        version: file:../../dev/file-plugin',
      '',
    ].join('\n'), 'utf8')
    rmSync(join(profileDir, 'node_modules', packageName), { recursive: true, force: true })
  }
  const r = await applyUnpinDevDir({ profileDir: PROFILE, packageName: 'linked-plugin', runRemove })
  assert.equal(r.ok, true, r.error ?? '')
  assert.equal(r.changed, true)
  assert.deepEqual(r.removed, { manifest: true, lock: true, nodeModules: true }, JSON.stringify(r.removed))
  assert.ok(!JSON.parse(manifestText()).dependencies['linked-plugin'], '清单里应已无该依赖')
  assert.ok(String(r.note).includes('开发目录与代码未被删除'), r.note)
  assert.ok(String(r.note).includes('pnpm-lock.yaml 条目已清除'), r.note)
  assert.equal(existsSync(DEV), true, '开发目录绝不能被删')
  assert.ok(typeof r.backup === 'string' && existsSync(r.backup))
})
await checkAsync('⑧ 取消钉住后同一件事再做一次 ⇒ 拒（"没有可取消的钉住"，不重复动手）', async () => {
  const r = await applyUnpinDevDir({ profileDir: PROFILE, packageName: 'linked-plugin', runRemove: async () => {} })
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('没有可取消的钉住'), r.error)
})

rmSync(ROOT, { recursive: true, force: true })
console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
