// 批次 C-⑩（2026-09-27 加法）：已落地仓库优先复用 —— 克隆前先看 <reposDir>/<owner>/<repo>。
//
// 动机：用户在「仓库落地」里已经把仓库拉到本地（默认 ~/.dsh/repos），安装/套装装配时再上网拉一遍
// 纯属浪费；本机直连不通时更是"白等一场空"。
// 命中判据（缺一不可）：目录在 listLandedRepos() 里 + 含 package.json（没有它的多半是半成品/技能仓库）。
// 全部离线：listLandedRepos / copyTree / listLanded 全注入。
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findLandedRepo, gitCloneRepo } from '../lib/server/domain/repoland.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const ROOT = join(tmpdir(), `dsh-landed-reuse-${process.pid}`)
disposeDir(ROOT)
const landedPath = join(ROOT, 'repos', 'probe-org', 'plugin')
mkdirSync(landedPath, { recursive: true })
writeFileSync(join(landedPath, 'package.json'), JSON.stringify({ name: '@probe/plugin' }), 'utf8')
writeFileSync(join(landedPath, '.gitmodules'), '[submodule "x"]\n', 'utf8')

const withPkg = [{ owner: 'probe-org', name: 'plugin', repo: 'probe-org/plugin', path: landedPath }]
const noPkg = [{ owner: 'probe-org', name: 'plugin', repo: 'probe-org/plugin', path: join(ROOT, 'repos', 'probe-org', 'empty') }]

// ── ① 命中判据（纯函数）────────────────────────────────────────────────────
{
  check('★ 落地且含 package.json → 命中', findLandedRepo('probe-org/plugin', { listLanded: () => withPkg }).hit === true)
  check('★ 落地但**没有** package.json → 不命中（多半是半成品/技能仓库，交给正常通道）',
    findLandedRepo('probe-org/plugin', { listLanded: () => noPkg }).hit === false)
  check('没有落地记录 → 不命中（行为与改动前一致）', findLandedRepo('probe-org/other', { listLanded: () => withPkg }).hit === false)
  check('大小写与 .git 后缀不影响匹配', findLandedRepo('Probe-Org/Plugin.git', { listLanded: () => withPkg }).hit === true)
  check('脏输入（空串 / 没有斜杠）安全返回不命中', findLandedRepo('', { listLanded: () => withPkg }).hit === false && findLandedRepo('nodash', { listLanded: () => withPkg }).hit === false)
  check('listLandedRepos 抛异常也安全（不影响正常克隆）',
    findLandedRepo('probe-org/plugin', { listLanded: () => { throw new Error('boom') } }).hit === false)
}

// ── ② 克隆前复用：命中后**一个网络请求都不发** ─────────────────────────────────
{
  const dest = join(ROOT, 'clone-1')
  const calls = []
  const res = await gitCloneRepo('probe-org/plugin', dest, 'github', 5000, {
    spawnFn: () => { calls.push('spawn'); return { pid: 1, stderr: { on() {} }, on() {} } },
    probe: async () => { calls.push('probe'); return true },
    findLanded: () => ({ hit: true, path: landedPath }),
    copyLanded: (from, to) => { calls.push(`copy:${from}`); mkdirSync(to, { recursive: true }); writeFileSync(join(to, 'package.json'), '{"name":"@probe/plugin"}', 'utf8') },
    readMemo: () => '', writeMemo: () => {},
  })
  check('★ 命中落地仓库 → 直接返回（source=landed、reused=true），不 spawn / 不探活 / 不下载',
    res.source === 'landed' && res.reused === true && calls.length === 1 && calls[0].startsWith('copy:'), JSON.stringify({ source: res.source, calls }))
  check('内容真的复制到 dest（上层照旧读 dest，无感）',
    existsSync(join(dest, 'package.json')), dest)
  check('返回里带上来源路径（面板/日志可追溯"用的是本地那份"）', typeof res.from === 'string' && res.from === landedPath, String(res.from))
  disposeDir(dest)
}

// ── ③ dest 与落地路径相同（套装直接原地用）时不复制，直接返回 ──────────────────────
{
  const res = await gitCloneRepo('probe-org/plugin', landedPath, 'github', 5000, {
    findLanded: () => ({ hit: true, path: landedPath }),
    copyLanded: () => { throw new Error('不该复制（同一路径）') },
    readMemo: () => '', writeMemo: () => {},
  })
  check('dest 就是落地目录本身 → 不复制、直接复用', res.dir === landedPath && res.reused === true, JSON.stringify({ dir: res.dir }))
}

// ── ④ 没命中时的行为与改动前一致（走正常通道）────────────────────────────────────
{
  const dest = join(ROOT, 'clone-2')
  const seen = []
  const res = await gitCloneRepo('probe-org/plugin', dest, 'github', 5000, {
    spawnFn: (bin, argv) => {
      const part = argv[argv.length - 1]
      seen.push(part)
      mkdirSync(part, { recursive: true })
      writeFileSync(join(part, 'package.json'), '{"name":"@probe/plugin"}', 'utf8')
      const handlers = {}
      setImmediate(() => handlers.close?.(0))
      return { pid: 31, stderr: { on() {} }, on(event, cb) { handlers[event] = cb } }
    },
    killTree: () => true,
    archive: null, // 专测 git 路径：不让 archive 通道接上真网络
    probe: async () => true,
    findLanded: () => ({ hit: false, path: null }),
    removeDir: (d) => { disposeDir(d); return { ok: true, attempts: 1, rounds: 1 } },
    renameDir: (a, b) => { disposeDir(b); renameSync(a, b) },
    readMemo: () => '', writeMemo: () => {},
  })
  check('未命中 → 照旧走 git 通道（成功路径行为不变）', res.source !== 'landed' && seen.length === 1, JSON.stringify({ source: res.source, spawn: seen.length }))
  disposeDir(ROOT)
}

assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
