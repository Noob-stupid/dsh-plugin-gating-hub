// issue #27 的回归钉子：兜底补丁路径不许写死 profile 名。
//
// 现场：`defaultPatchPath()` 硬编码 `profiles/web`。桌面端机器上 `cordis.yml` 里没有
// `cordis:include` 条目时兜底必然生效 ⇒ 所有补丁写入落到早已废弃的 `web` profile，
// 正在用的 `desktop` 静默收不到（开关插件、改禁用都没反应，且不报错）。
//
// 这份测试用隔离 DSH_HOME 逐条钉住候选顺序，并保留「include 条目能推导时优先」的正控。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) {
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

const withHome = async (setup, fn) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-paths-'))
  const saved = { home: process.env.DSH_HOME, dir: process.env.DSH_PROFILE_DIR, name: process.env.DSH_PROFILE }
  process.env.DSH_HOME = home
  delete process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE
  try {
    setup?.(home)
    // paths.js 在模块顶层不缓存 dshHome，但 defaultPatchPath 每次调用都读 env，直接动态导入一次即可
    const mod = await import(`../lib/server/infra/paths.js?case=${Math.random()}`)
    return await fn(mod, home)
  } finally {
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home
    if (saved.dir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = saved.dir
    if (saved.name === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = saved.name
    rmSync(home, { recursive: true, force: true })
  }
}

const makeProfile = (home, name) => {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n', 'utf8')
  return dir
}

// ① DSH_PROFILE_DIR 优先（桌面端/CLI 显式设置，最可信）
await withHome((home) => { makeProfile(home, 'web'); makeProfile(home, 'desktop') }, (mod, home) => {
  process.env.DSH_PROFILE_DIR = join(home, 'profiles', 'desktop')
  check('① DSH_PROFILE_DIR 设置时以它为准', () => {
    assert.equal(mod.defaultPatchPath(), join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
  })
})

// ② 只给 DSH_PROFILE 时按名字拼
await withHome((home) => { makeProfile(home, 'web'); makeProfile(home, 'desktop') }, (mod, home) => {
  process.env.DSH_PROFILE = 'web'
  check('② 只给 DSH_PROFILE 时用它拼路径', () => {
    assert.equal(mod.defaultPatchPath(), join(home, 'profiles', 'web', 'cordis.patch.yml'))
  })
})

// ③ 两个 env 都没有、desktop 存在 ⇒ 必须命中 desktop（issue 的核心）
await withHome((home) => { makeProfile(home, 'web'); makeProfile(home, 'desktop') }, (mod, home) => {
  check('③ 无 env 时优先命中真实存在的 desktop（别再落到 web）', () => {
    const got = mod.defaultPatchPath()
    assert.equal(got, join(home, 'profiles', 'desktop', 'cordis.patch.yml'), `实际 ${got}`)
    assert.ok(!got.includes(`${join('profiles', 'web')}`), '又落到 web 了')
  })
})

// ④ desktop 不存在、只有别的 profile ⇒ 用那个真实存在的
await withHome((home) => { makeProfile(home, 'alpha') }, (mod, home) => {
  check('④ desktop 缺失时退到真实存在的其它 profile', () => {
    assert.equal(mod.defaultPatchPath(), join(home, 'profiles', 'alpha', 'cordis.patch.yml'))
  })
})

// ⑤ 一个都没有 ⇒ 返回首个候选（desktop），不抛异常
await withHome(() => {}, (mod, home) => {
  check('⑤ 没有任何 profile 时返回 desktop 候选且不抛', () => {
    assert.equal(mod.defaultPatchPath(), join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
  })
})

// ⑥ 正控：loader 里能找到 cordis:include 时，仍然按条目推导（兜底不得抢戏）
await withHome((home) => { makeProfile(home, 'web'); makeProfile(home, 'desktop') }, (mod, home) => {
  const real = join(home, 'profiles', 'desktop', 'cordis.yml')
  writeFileSync(real, '[]\n', 'utf8')
  const ctx = {
    loader: {
      entries: () => [
        { options: { name: 'cordis:include', config: { path: new URL(`file:///${real.replace(/\\/gu, '/')}`).href } } },
      ],
    },
  }
  check('⑥ 正控：include 条目能推导时优先用条目路径', () => {
    assert.equal(mod.findPatchPath(ctx), join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
  })
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
