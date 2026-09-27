// 批次 D-②/D-③（2026-09-27）：稀疏/定向取源码 + 预设型子包按 preset 装配。
//
// 真机事故：yjh051108/dsh-routing-suite 三件套只装到两件 —— 第三件 `preset/`（= dsh-router-standard，
// 思维模式路由预设）npm 双 404、release 无资产，**只存在于仓库源码里**。缺的能力有两块：
//   ① 从仓库里"只取那一个目录"（`--filter=blob:none --sparse` + `git sparse-checkout set <subdir>`）；
//   ② 识别"预设型子包"并装配到 `~/.dsh/.agent-presets/<name>`（**已存在同名预设不静默覆盖**）。
// 本用例全离线（真 git + 本机裸仓库；一个网络请求都不发）：
//   ① 纯函数：预设包名形状判据、isPresetDir、findPresetDirs（且与 suite.js 的 re-export 是同一个函数）
//   ② assemblePreset：新装配 / 已存在同名（备份 + 合并 + 逐条报告）/ 内容一致
//   ③ fetchPresetSource（真 git + file:// 裸仓库）：骨架稀疏 → ls-tree 本地定位 → sparse-checkout set
//      → 只 preset/ 落地、graded/ 与 injector/ **缺席**（证明"没有克隆整个仓库"）
//   ④ 稀疏不被支持 → 降级普通 clone（两种触发路径都覆盖）
//   ⑤ tryPresetSourceChannel：名字不像预设（零副作用）/ 源码通道被禁（note 带尺寸）/ 全流程装配成功
//   ⑥ git 规格装成"别的包名"必须被识破（旧代码会把候选名当成功 → 补丁行指向不存在的模块）
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  findPresetDirs, isPresetDir, looksLikePresetPackageName, readPresetManifest, assemblePreset,
  locateSubpackageViaGit, fetchPresetSource, tryPresetSourceChannel,
} from '../lib/server/domain/preset-source.js'
import { findPresetDirs as suiteFindPresetDirs } from '../lib/server/domain/suite.js'
import { gitCloneRepo, sparseUnsupportedReason, runGitArgs } from '../lib/server/domain/repoland.js'
import { tryGitChannel, installedPackageName } from '../lib/server/domain/git-channel.js'
import { disposeDir } from '../lib/server/infra/fsx.js'
import { gitBin } from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = join(tmpdir(), `dsh-preset-source-${process.pid}`)
mkdirSync(HOME, { recursive: true })
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

// ── ① 纯函数与目录判据 ────────────────────────────────────────────────────────────────
{
  check('① 预设型包名：dsh-router-standard → 是', looksLikePresetPackageName('dsh-router-standard') === true)
  check('① 预设型包名：dsh_router_standard → 是（下划线形态）', looksLikePresetPackageName('dsh_router_standard') === true)
  check('① 预设型包名：@scope/dsh-preset-x → 是', looksLikePresetPackageName('@scope/dsh-preset-x') === true)
  check('① 预设型包名：router → 是（单词本身就是）', looksLikePresetPackageName('router') === true)
  check('① 反例：@dsh-external/dsh-super-injector → 不是（真机另外两件）', looksLikePresetPackageName('@dsh-external/dsh-super-injector') === false)
  check('① 反例：@dsh-external/dsh-graded-mode → 不是', looksLikePresetPackageName('@dsh-external/dsh-graded-mode') === false)
  check('① 反例：@linxin666/dsh-web-all → 不是', looksLikePresetPackageName('@linxin666/dsh-web-all') === false)
  check('① 反例：空串 / null → 不是', looksLikePresetPackageName('') === false && looksLikePresetPackageName(null) === false)
  check('① 反例：dsh-routers（后缀不是分隔符）→ 不是（不做子串匹配）', looksLikePresetPackageName('dsh-routers') === false)

  const root = join(HOME, 'marker-fixture')
  mkdirSync(join(root, 'router-standard'), { recursive: true })
  mkdirSync(join(root, 'plain'), { recursive: true })
  writeFileSync(join(root, 'router-standard', 'agent.cordis.yml'), 'plugins: []\n', 'utf8')
  writeFileSync(join(root, 'router-standard', 'preset.yml'), 'name: Router Standard\n', 'utf8')
  writeFileSync(join(root, 'plain', 'package.json'), '{}\n', 'utf8')
  check('① isPresetDir：含 agent.cordis.yml → 真', isPresetDir(join(root, 'router-standard')) === true)
  check('① isPresetDir：普通目录 → 假', isPresetDir(join(root, 'plain')) === false)
  check('① findPresetDirs 找到 1 个（且不需要 preset.yml 的 isPresetDir 判据更宽）',
    findPresetDirs(root, 2).length === 1, JSON.stringify(findPresetDirs(root, 2)))
  check('★① suite.js 的 findPresetDirs 与 preset-source.js 是**同一个函数**（套装路径与候选路径共用一份判据）',
    suiteFindPresetDirs === findPresetDirs)
  check('① readPresetManifest 读到 name', readPresetManifest(join(root, 'router-standard'))?.name === 'Router Standard')
  check('① readPresetManifest 读不到 → null（不抛）', readPresetManifest(join(root, 'plain')) === null)
}

// ── ② assemblePreset：备份 + 合并（绝不静默覆盖）────────────────────────────────────────
{
  const presetsRoot = join(HOME, 'presets-a')
  const src = join(HOME, 'src-preset')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'agent.cordis.yml'), 'plugins:\n  - id: a\n', 'utf8')
  writeFileSync(join(src, 'preset.yml'), 'name: Router Standard\n', 'utf8')
  writeFileSync(join(src, 'router-core.mjs'), 'export const v = 2\n', 'utf8')

  const r1 = assemblePreset(src, 'router-standard', { presetsRoot })
  const dest = join(presetsRoot, 'router-standard')
  check('② 新装配：目录 + agent.cordis.yml 落盘', r1.ok === true && existsSync(join(dest, 'agent.cordis.yml')), JSON.stringify({ ok: r1.ok, dest: r1.dest }))
  check('② 新装配：字节与源一致（16538 B 那类断言的前提）',
    readFileSync(join(dest, 'router-core.mjs'), 'utf8') === 'export const v = 2\n' && r1.bytes === readFileSync(join(src, 'router-core.mjs')).length + readFileSync(join(src, 'preset.yml')).length + readFileSync(join(src, 'agent.cordis.yml')).length)
  check('② 新装配：没有备份（本来就没有同名预设）', r1.backup === null && r1.added.length === 3 && r1.overwritten.length === 0)
  check('② 新装配的 note 说清落盘路径与文件数', r1.note.includes(dest) && r1.note.includes('新增 3 个文件'), r1.note)

  // 同名预设已存在，且内容不同 → 必须备份 + 合并 + 报告
  writeFileSync(join(dest, 'router-core.mjs'), 'export const v = 1\n', 'utf8')       // 会被覆盖
  writeFileSync(join(dest, 'user-only.mjs'), 'export const keep = true\n', 'utf8')   // 用户独有，必须保留
  const r2 = assemblePreset(src, 'router-standard', { presetsRoot, now: () => 1234567890 })
  check('★② 已存在同名预设 → **先整目录备份**（backup 非空且目录真的存在）',
    typeof r2.backup === 'string' && existsSync(r2.backup), String(r2.backup))
  check('★② 备份里是**用户原来的**内容（v=1），不是被覆盖后的',
    readFileSync(join(r2.backup, 'router-core.mjs'), 'utf8') === 'export const v = 1\n')
  check('★② 备份里也留住了用户独有的文件（user-only.mjs）',
    existsSync(join(r2.backup, 'user-only.mjs')))
  check('★② 合并：同名不同内容 → 覆盖并**逐条报告**（overwritten 里点名 router-core.mjs）',
    r2.overwritten.includes('router-core.mjs') && r2.note.includes('router-core.mjs'), r2.note)
  check('★② 合并：内容一致的文件不重复报告为覆盖（identical 计数）',
    r2.identical.includes('preset.yml') && r2.identical.includes('agent.cordis.yml') && !r2.overwritten.includes('preset.yml'), `identical=${JSON.stringify(r2.identical)} overwritten=${JSON.stringify(r2.overwritten)}`)
  check('★② 用户独有文件在合并后仍然存在（不是 rm -rf 重建）', existsSync(join(dest, 'user-only.mjs')))
  check('★② 覆盖后的内容是**新的**（v=2）', readFileSync(join(dest, 'router-core.mjs'), 'utf8') === 'export const v = 2\n')
  check('★② note 里有备份路径与「已存在同名预设」的明说', r2.note.includes(r2.backup) && r2.note.includes('已存在同名预设'), r2.note)

  // 内容完全一致 → 无覆盖、无新增
  const r3 = assemblePreset(src, 'router-standard', { presetsRoot, now: () => 999 })
  check('② 内容一致 → overwritten 为空、added 为空、identical=3',
    r3.ok === true && r3.overwritten.length === 0 && r3.added.length === 0 && r3.identical.length === 3, JSON.stringify({ a: r3.added, o: r3.overwritten, i: r3.identical }))

  const bad = assemblePreset(src, '../escape', { presetsRoot })
  check('★② 目录名带路径分隔符 → 明确拒绝（不越出 .agent-presets）', bad.ok === false && String(bad.error).includes('不合法'), JSON.stringify(bad))
  const empty = assemblePreset(join(HOME, 'no-such-dir'), 'x', { presetsRoot })
  check('② 源目录不存在/为空 → 明确报错', empty.ok === false && String(empty.error).includes('没有任何文件'))
}

// ── 夹具：本机裸仓库（结构照抄真机 dsh-routing-suite：graded/ + injector/ + preset/）─────────
const GITROOT = join(HOME, 'gitroot')
const BARE = join(GITROOT, 'probe-org', 'routing-suite.git')
const WORK = join(HOME, 'work-routing-suite')
mkdirSync(join(WORK, 'graded'), { recursive: true })
mkdirSync(join(WORK, 'injector'), { recursive: true })
mkdirSync(join(WORK, 'preset', 'router-standard'), { recursive: true })
mkdirSync(join(WORK, 'preset', 'router-spec'), { recursive: true })
const PRESET_YML = 'name: Router Standard\ndescription: "Self-routed progressive tool disclosure"\norder: 1\n'
const AGENT_YML = '# agent.cordis.yml（夹具）\nplugins:\n  - id: router\n    name: "@probe/router-bootstrap"\n'
writeFileSync(join(WORK, 'package.json'), JSON.stringify({ name: '@dsh-external/dsh-super-injector', version: '0.3.3', private: true }, null, 2), 'utf8')
writeFileSync(join(WORK, 'README.md'), '# routing-suite fixture\n', 'utf8')
writeFileSync(join(WORK, 'graded', 'package.json'), JSON.stringify({ name: '@probe/stub-graded-mode', version: '0.0.1' }, null, 2), 'utf8')
writeFileSync(join(WORK, 'graded', 'index.js'), 'module.exports = "graded"\n', 'utf8')
writeFileSync(join(WORK, 'injector', 'package.json'), JSON.stringify({ name: '@probe/stub-super-injector', version: '0.3.3' }, null, 2), 'utf8')
writeFileSync(join(WORK, 'injector', 'index.js'), 'module.exports = "injector"\n', 'utf8')
writeFileSync(join(WORK, 'preset', 'package.json'), JSON.stringify({ name: 'dsh-router-standard', version: '0.3.0' }, null, 2), 'utf8')
writeFileSync(join(WORK, 'preset', 'preset.yml'), PRESET_YML, 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'agent.cordis.yml'), AGENT_YML, 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'preset.yml'), PRESET_YML, 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'router-core.mjs'), 'export const core = "standard"\n', 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'router-bootstrap.mjs'), 'export const boot = "standard"\n', 'utf8')
writeFileSync(join(WORK, 'preset', 'router-spec', 'agent.cordis.yml'), AGENT_YML.replace('Router Standard', 'Router Spec'), 'utf8')
writeFileSync(join(WORK, 'preset', 'router-spec', 'preset.yml'), 'name: Router Spec\n', 'utf8')
{
  const git = gitBin()
  const run = (cwd, args) => execFileSync(git, args, {
    cwd, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@local', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@local' },
  })
  run(WORK, ['init', '-q'])
  run(WORK, ['add', '-A'])
  run(WORK, ['commit', '-qm', 'fixture'])
  mkdirSync(join(GITROOT, 'probe-org'), { recursive: true })
  run(HOME, ['clone', '-q', '--bare', WORK, BARE])
  writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
    registries: [{ id: 'noop', name: '无源', url: 'http://127.0.0.1:1', primary: true }],
    gitSources: [{ id: 'local-bare', name: '本机裸仓库', urlTemplate: `${pathToFileURL(GITROOT).href}/{owner}/{repo}.git`, primary: true }],
    archiveSources: [{ id: 'dead', name: '死源', urlTemplate: 'http://127.0.0.1:1/{owner}/{repo}/archive/{branch}.tar.gz', primary: true }],
    indexSources: [],
  }, null, 2), 'utf8')
}
// 复用 gitCloneRepo 的裁剪参数：探活直接判活、不跑 archive（本机裸仓库用不上）
const cloneDeps = {
  probeDetail: async () => ({ alive: true, kind: 'local', status: null, note: '本地裸仓库' }),
  archive: null,
  reuseLanded: false,
}

// ── ③ fetchPresetSource：真 git 骨架稀疏克隆 + 本地定位 + 定向 sparse-checkout ─────────────
const SPARSE_DIR = join(HOME, 'sparse-1')
{
  const res = await fetchPresetSource({ repo: 'probe-org/routing-suite', candidateName: 'dsh-router-standard', dest: SPARSE_DIR, deps: { cloneOpts: cloneDeps } })
  check('③ 稀疏取源码成功（ok=true + sparse=true）', res.ok === true && res.sparse === true, JSON.stringify({ ok: res.ok, sparse: res.sparse, subdir: res.subdir, err: res.error }))
  check('★③ 本地 ls-tree 定位到候选对应的子包目录 preset/', res.subdir === 'preset', String(res.subdir))
  check('★③ notes 里写明用了稀疏（--filter=blob:none --sparse）与 sparse-checkout set',
    (res.notes ?? []).some((n) => n.includes('--filter=blob:none --sparse')) && (res.notes ?? []).some((n) => n.includes('sparse-checkout set preset')), JSON.stringify(res.notes))
  check('★③ 子包目录自己就是预设容器：findPresetDirs 找到 router-standard / router-spec 两个',
    findPresetDirs(join(SPARSE_DIR, 'preset'), 2).map((p) => p.split(/[\\/]/u).pop()).sort().join(',') === 'router-spec,router-standard',
    JSON.stringify(findPresetDirs(join(SPARSE_DIR, 'preset'), 2)))
  check('★③ 真机那条路径上的文件真的落地了（preset/router-standard/agent.cordis.yml）',
    existsSync(join(SPARSE_DIR, 'preset', 'router-standard', 'agent.cordis.yml'))
    && readFileSync(join(SPARSE_DIR, 'preset', 'router-standard', 'agent.cordis.yml'), 'utf8').replace(/\r\n/gu, '\n') === AGENT_YML)
  // 证明"没有克隆整个仓库"：graded/ 与 injector/ 在磁盘上必须缺席（稀疏只拉 preset/ 的 blob）
  const materialized = readdirSync(SPARSE_DIR).filter((n) => n !== '.git').sort()
  check('★③ **没有克隆整个仓库**：工作区只落地了 preset/ 与根目录文件，graded//injector/ 缺席',
    !existsSync(join(SPARSE_DIR, 'graded')) && !existsSync(join(SPARSE_DIR, 'injector'))
    && materialized.includes('preset') && materialized.includes('package.json'),
    `materialized=${JSON.stringify(materialized)}`)
  // 稀疏克隆的 .git 里"只有树对象"：整仓 clone 会把所有 blob 都拉下来
  const sparseGitBytes = Number(execFileSync(process.execPath, ['-e', `const fs=require('fs'),p=require('path');let t=0;const w=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const c=p.join(d,e.name);try{if(e.isDirectory())w(c);else t+=fs.statSync(c).size}catch{}}};w(process.argv[1]);console.log(t)`, join(SPARSE_DIR, '.git')], { encoding: 'utf8' }).trim())
  check('★③ 稀疏克隆的 .git 体积远小于整仓（< 400 KB；整仓 clone 会把每个 blob 都拉下来）',
    Number.isFinite(sparseGitBytes) && sparseGitBytes > 0 && sparseGitBytes < 400 * 1024, `.git=${sparseGitBytes} B`)
  console.log(`INFO ③ 稀疏骨架 + sparse-checkout set：工作区文件名 ${JSON.stringify(materialized)}；.git ${sparseGitBytes} B`)
}

// ── ④ 稀疏不被支持 → 降级普通 clone（两条触发路径）────────────────────────────────────────
{
  check('④ sparseUnsupportedReason 认得三类"不支持"',
    sparseUnsupportedReason("error: unknown option `filter'") !== null
    && sparseUnsupportedReason("git: 'sparse-checkout' is not a git command. See 'git --help'.") !== null
    && sparseUnsupportedReason('fatal: could not read from remote') === null,
    JSON.stringify([sparseUnsupportedReason("error: unknown option `filter'"), sparseUnsupportedReason("git: 'sparse-checkout' is not a git command.")]))

  // ④-a：--filter/--sparse 不被认识 → gitCloneRepo 第二轮改用普通 clone（并在错误清单里留痕）
  const fakeSpawn = (bin, args, opts) => {
    if (args.includes('--filter=blob:none') || args.includes('--sparse')) {
      const child = new EventEmitter()
      child.pid = 424242
      child.exitCode = null
      child.stderr = new EventEmitter()
      child.stdout = new EventEmitter()
      setTimeout(() => {
        child.stderr.emit('data', "error: unknown option `filter'\n")
        child.exitCode = 129
        child.emit('close', 129)
      }, 5)
      return child
    }
    // 普通 clone 走真 git（本机裸仓库）
    return spawn(bin, args, opts)
  }
  let threw = null
  let cloned = null
  try {
    cloned = await gitCloneRepo('probe-org/routing-suite', join(HOME, 'downgrade-clone'), 'github', 60000, { ...cloneDeps, spawnFn: fakeSpawn, sparse: [] })
  } catch (error) { threw = error }
  check('★④ 稀疏不被支持 → **降级到普通 clone**（克隆最终成功）', threw === null && cloned !== null, threw === null ? JSON.stringify({ sparse: cloned?.sparse, downgraded: cloned?.downgradedFromSparse, source: cloned?.source }) : String(threw?.message).slice(0, 200))
  check('★④ 降级被如实标记（downgradedFromSparse=true + 结果里没谎称 sparse）',
    cloned?.downgradedFromSparse === true && cloned?.sparse === false, JSON.stringify({ sparse: cloned?.sparse, dg: cloned?.downgradedFromSparse }))
  check('★④ 降级后的仓库内容完整（graded/ 也在，因为这次是真整仓 clone）',
    existsSync(join(HOME, 'downgrade-clone', 'graded', 'package.json')) && existsSync(join(HOME, 'downgrade-clone', 'preset', 'router-standard', 'agent.cordis.yml')))

  // ④-b：sparse-checkout 子命令不可用 → fetchPresetSource 自己降级普通 clone 并仍然定位成功
  const fakeRunGit = async (argv, opts) => {
    if (argv[0] === 'sparse-checkout') {
      return { code: 1, stdout: '', stderr: "git: 'sparse-checkout' is not a git command. See 'git --help'.\n", timedOut: false, pid: 1, exited: true }
    }
    return runGitArgs(argv, opts)
  }
  const res = await fetchPresetSource({
    repo: 'probe-org/routing-suite', candidateName: 'dsh-router-standard', dest: join(HOME, 'sparse-2'),
    deps: { cloneOpts: cloneDeps, runGit: fakeRunGit },
  })
  check('★④ sparse-checkout 不可用 → 降级普通 clone 后仍定位成功（不把候选判死）',
    res.ok === true && res.subdir === 'preset' && res.downgraded === true, JSON.stringify({ ok: res.ok, subdir: res.subdir, dg: res.downgraded, err: res.error }))
  check('★④ 降级原因写在 notes 里（面板能看到"为什么走了整仓 clone"）',
    (res.notes ?? []).some((n) => n.includes('sparse-checkout 不可用') && n.includes('降级到普通 clone')), JSON.stringify(res.notes))
}

// ── ⑤ tryPresetSourceChannel：识别 + 门禁 + 全流程装配 ─────────────────────────────────────
{
  // ⑤-a 名字不像预设 → 零副作用（不建临时目录、不联网）
  const j1 = { id: 'p1', repo: 'probe-org/routing-suite', channelNotes: [] }
  const skip = await tryPresetSourceChannel({ job: j1, name: '@probe/stub-graded-mode', deps: { sizeDeps: { probe: async () => { throw new Error('不该探测') } } } })
  check('⑤ 名字不像预设型 → handled=false 且零副作用（连体积都不探）',
    skip.handled === false && skip.installed === false && j1.channelNotes.length === 0 && j1.presetTried === undefined, JSON.stringify(skip))

  // ⑤-b 源码通道被禁（巨仓）→ 带具体原因与出路
  const j2 = { id: 'p2', repo: 'probe-org/routing-suite', channelNotes: [] }
  const note2 = (j, text) => { if (!j.channelNotes.includes(text)) j.channelNotes.push(text) }
  const blocked = await tryPresetSourceChannel({ job: j2, name: 'dsh-router-standard', deps: { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 429 * 1024 }) } } })
  check('★⑤ 源码通道被禁（429 MB）→ handled=true / installed=false，error 里带尺寸与出路',
    blocked.handled === true && blocked.installed === false && /429\.0 MB/u.test(String(blocked.error?.message)) && /仓库落地/u.test(String(blocked.error?.message)),
    String(blocked.error?.message))
  void note2

  // ⑤-c 全流程：真 git + 本机裸仓库 → 预设真的落盘
  const presetsRoot = join(HOME, 'presets-live')
  const j3 = { id: 'p3', repo: 'probe-org/routing-suite', channelNotes: [] }
  const note3 = (j, text) => { if (!j.channelNotes.includes(text)) j.channelNotes.push(text) }
  const okRun = await tryPresetSourceChannel({
    job: j3, name: 'dsh-router-standard', deps: {
      sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 1334 }) },
      fetchDeps: { cloneOpts: cloneDeps },
      presetsRoot,
      now: () => 555,
    },
  })
  const dest = join(presetsRoot, 'router-standard')
  check('★⑤ 全流程：installed=true，预设真的落到 <presetsRoot>/router-standard/agent.cordis.yml',
    okRun.installed === true && existsSync(join(dest, 'agent.cordis.yml')), JSON.stringify({ installed: okRun.installed, err: okRun.error }))
  check('★⑤ 落盘的 agent.cordis.yml 与源逐字节一致（贴得出字节数）',
    readFileSync(join(dest, 'agent.cordis.yml'), 'utf8').replace(/\r\n/gu, '\n') === AGENT_YML
    && readFileSync(join(dest, 'agent.cordis.yml')).length === Buffer.byteLength(AGENT_YML, 'utf8') + (process.platform === 'win32' ? AGENT_YML.split('\n').length - 1 : 0),
    `bytes=${readFileSync(join(dest, 'agent.cordis.yml')).length}（源 LF 版 ${Buffer.byteLength(AGENT_YML, 'utf8')} B；git checkout 在 Windows 上按 autocrlf 落 CRLF）`)
  check('★⑤ 第二个预设 router-spec 也装配了（同一子包目录里的多个预设一起装）',
    existsSync(join(presetsRoot, 'router-spec', 'agent.cordis.yml')))
  check('★⑤ 面板短句：note 里含「新建会话时选择」与落盘根目录',
    okRun.note.includes('新建会话时选择') && okRun.note.includes(presetsRoot), okRun.note)
  check('★⑤ note 里说明用了稀疏取源码（用户能核实"只取了那一个子包目录"）',
    okRun.note.includes('稀疏取源码'), okRun.note)
  check('★⑤ job 上留下结构化结果（name/dest/ok/bytes/backup/subdir/sparse）',
    Array.isArray(j3.presetInstalled) && j3.presetInstalled.length === 2 && j3.presetInstalled.every((p) => p.ok === true && p.marker === 'agent.cordis.yml' && p.subdir === 'preset' && p.sparse === true && p.bytes > 0),
    JSON.stringify(j3.presetInstalled))
  check('★⑤ job.channelNotes 记下"稀疏取源码 / sparse-checkout set"（面板可见，不沉默）',
    j3.channelNotes.some((n) => n.includes('--filter=blob:none --sparse')) && j3.channelNotes.some((n) => n.includes('sparse-checkout set preset')),
    JSON.stringify(j3.channelNotes))
  check('★⑤ 临时目录已清理（不留 dsh-preset-* 垃圾）',
    !readdirSync(tmpdir()).some((n) => n.startsWith(`dsh-preset-p3-`)), 'tmp clean')
  // 再走一次：同名预设已存在 → 备份 + 合并，绝不静默覆盖
  const j4 = { id: 'p4', repo: 'probe-org/routing-suite', channelNotes: [] }
  const again = await tryPresetSourceChannel({
    job: j4, name: 'dsh-router-standard', deps: { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 1334 }) }, fetchDeps: { cloneOpts: cloneDeps }, presetsRoot, now: () => 777 },
  })
  check('★⑤ 重复装配：已存在同名预设 → 有备份、note 明说（不静默覆盖）',
    again.installed === true && typeof j4.presetInstalled?.[0]?.backup === 'string' && /已存在同名预设/u.test(again.note),
    String(again.note).slice(0, 240))
  check('★⑤ 重复装配的备份目录真的存在', existsSync(j4.presetInstalled[0].backup))

  // ⑤-d 子包不是预设型（没有 agent.cordis.yml）→ 明确原因，不假装成功
  const j5 = { id: 'p5', repo: 'probe-org/routing-suite', channelNotes: [] }
  const notPreset = await tryPresetSourceChannel({
    job: j5, name: 'dsh-router-preset-injector-x', deps: { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 1334 }) }, fetchDeps: { cloneOpts: cloneDeps }, presetsRoot, now: () => 1 },
  })
  check('★⑤ 预设型命名但仓库里没有这个子包 → 明确报"没有名为…的子包"（不假装成功）',
    notPreset.handled === true && notPreset.installed === false && /没有名为/u.test(String(notPreset.error?.message)), String(notPreset.error?.message))
}

// ── ⑥ 定位器：包名不匹配 / ls-tree 失败 的如实回报 ─────────────────────────────────────────
{
  const loc = await locateSubpackageViaGit({ root: SPARSE_DIR, candidateName: 'no-such-package' })
  check('⑥ 定位不到 → subdir=null 且 error=null（"没找到"与"读不到"分开）', loc.subdir === null && loc.error === null, JSON.stringify(loc))
  const locFail = await locateSubpackageViaGit({ root: SPARSE_DIR, candidateName: 'x', runGit: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }) })
  check('⑥ ls-tree 失败 → error 里带 git 原话（不静默变成"没找到"）', locFail.subdir === null && /ls-tree 失败/u.test(String(locFail.error)), String(locFail.error))
  const locEmpty = await locateSubpackageViaGit({ root: SPARSE_DIR, candidateName: '  ' })
  check('⑥ 候选名为空 → 明确报错', locEmpty.subdir === null && String(locEmpty.error).includes('为空'))
}

// ── ⑦ git 规格装成"别的包名"必须被识破（旧代码会把候选名当成功）────────────────────────────
{
  const profile = join(HOME, 'gitname-profile')
  mkdirSync(join(profile, 'node_modules', 'dsh-router-standard'), { recursive: true })
  writeFileSync(join(profile, 'node_modules', 'dsh-router-standard', 'package.json'), JSON.stringify({ name: '@dsh-external/dsh-super-injector', version: '0.3.3' }), 'utf8')
  check('⑦ installedPackageName 读回的是**真实**包名（不是目录名）',
    installedPackageName(profile, 'dsh-router-standard') === '@dsh-external/dsh-super-injector')
  check('⑦ 读不到时返回 null（按"无法核实"处理，不误杀）', installedPackageName(profile, 'never-installed') === null)

  const job = { id: 'gn', repo: 'probe-org/routing-suite', channelNotes: [] }
  const ch = {
    pnpmInstall: async () => {},                     // "成功"，但装出来的是根包名
    raceInstallChannels: async () => null,
    curlManualInstall: async () => { throw new Error('no') },
    githubReleaseInstall: async () => { throw new Error('no') },
    backfillMissingDeps: async () => [],
  }
  const res = await tryGitChannel({ job, ch, name: 'dsh-router-standard', profileDir: profile, repoChannelAllowed: true, budget: {}, deadline: null })
  check('★⑦ git 装成别的包名 → **不算成功**（installedName 仍为 null）', res.installedName === null, JSON.stringify(res))
  check('★⑦ 报错说明"git 只能装根包"（具体原因，不是笼统失败）',
    /装成的是仓库根包/u.test(String(res.lastError?.message)) && /git 只能装根包/u.test(String(res.lastError?.message)), String(res.lastError?.message))
  check('★⑦ 该结论也写进 channelNotes（面板可见）',
    job.channelNotes.some((n) => n.includes('装成的是仓库根包')), JSON.stringify(job.channelNotes))

  // 正例：装的就是候选本身 → 照旧成功
  const profile2 = join(HOME, 'gitname-profile2')
  mkdirSync(join(profile2, 'node_modules', 'dsh-router-standard'), { recursive: true })
  writeFileSync(join(profile2, 'node_modules', 'dsh-router-standard', 'package.json'), JSON.stringify({ name: 'dsh-router-standard', version: '0.3.0' }), 'utf8')
  const job2 = { id: 'gn2', repo: 'probe-org/routing-suite', channelNotes: [] }
  const res2 = await tryGitChannel({ job: job2, ch, name: 'dsh-router-standard', profileDir: profile2, repoChannelAllowed: true, budget: {}, deadline: null })
  check('⑦ 正例：包名一致 → git 通道照旧成功（没有把既有能力改坏）', res2.installedName === 'dsh-router-standard', JSON.stringify(res2))
  check('⑦ 正例不留任何"无法核实/装成别的包"备注', (job2.channelNotes ?? []).length === 0, JSON.stringify(job2.channelNotes ?? []))
}

// ── 收尾 ────────────────────────────────────────────────────────────────────────────────
if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
try { disposeDir(HOME) } catch {}
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
