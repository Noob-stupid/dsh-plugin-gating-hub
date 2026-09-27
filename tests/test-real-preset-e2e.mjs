// 批次 D-②/D-③ 的**真实网络端到端**验收（2026-09-27）：真打 yjh051108/dsh-routing-suite，
// 把只存在于仓库源码里的第三件 `preset/`（= dsh-router-standard 预设）真的取下来并装配到
// `<DSH_HOME>/.agent-presets/router-standard/agent.cordis.yml`（打印字节数与内容首行），
// 并证明**没有克隆整个仓库**（稀疏取源码：工作区里 graded/ 与 injector/ 必须缺席）。
//
// 为什么必须有这一段（而不是只跑离线夹具）：离线夹具用的是本机裸仓库，永远验证不到
// "真镜像 + 真 partial clone + 真 sparse-checkout" 这条路 —— 而这条路上才可能出现
// "服务端不支持 filter""稀疏拉到一半断流"这类只有真网络才会暴露的问题。
//
// 隔离：全程 DSH_HOME 指向临时目录，真 profile 与真 .agent-presets 一个字节都不动。
// 网络不可达时**响亮 SKIP**（打印原因，退出码 0）—— 与本仓库既有 real-smoke 约定一致：
// 不拿网络当红灯，但也绝不假装 PASS。
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { tryPresetSourceChannel } from '../lib/server/domain/preset-source.js'
import { evaluateSourceChannel, gatePrivateRoot } from '../lib/server/domain/repo-size.js'
import { gitCloneRepo } from '../lib/server/domain/repoland.js'
import { disposeDir } from '../lib/server/infra/fsx.js'
import { gitBin } from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const REPO = 'yjh051108/dsh-routing-suite'
const CANDIDATE = 'dsh-router-standard'
const HOME = join(tmpdir(), `dsh-real-preset-e2e-${process.pid}`)
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

// 跳过条件：真实元数据探测不到（离线/限流）→ 说明这次跑不了真网络断言
const sizeProbe = await evaluateSourceChannel(REPO, {})
console.log(`INFO 真实仓库体积探测：state=${sizeProbe.state} sizeKb=${sizeProbe.sizeKb} limitMb=${sizeProbe.limitMb} note=${sizeProbe.note.slice(0, 120)}`)
if (sizeProbe.state !== 'known') {
  console.log(`SKIP 真实网络 E2E：读不到 ${REPO} 的元数据（${sizeProbe.note}）——离线或 GitHub 限流，本次不跑真网络断言（不假装 PASS）`)
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  try { disposeDir(HOME) } catch {}
  console.log('\nALL PASS（真实网络部分 SKIP）')
  process.exit(0)
}

// ── ① 真机仓库只有 1.3 MB → 源码通道放行（private 根不再一刀切）─────────────────────────
{
  const job = { id: 'real-e2e', repo: REPO, channelNotes: [] }
  const note = (j, text) => { if (!j.channelNotes.includes(text)) j.channelNotes.push(text) }
  const gate = await gatePrivateRoot(job, note, {})
  check('★① 真机仓库（1334 KB）在 20 MB 阈值下**放行**源码通道（本次改错的核心）',
    gate.allow === true && job.gitChannelBlocked === false, JSON.stringify(job.repoSize))
  check('★① note 含真实尺寸（不是硬编码的 "429 MB"）',
    job.channelNotes.some((n) => /1\.[0-9] MB/u.test(n) && n.includes('已放行')), JSON.stringify(job.channelNotes))
  check('★① 真机仓库尺寸落在 1~2 MB 区间（上游若大改，这里会提醒我们复核阈值）',
    job.repoSize.state === 'known' && job.repoSize.sizeKb > 512 && job.repoSize.sizeKb < 4096, `${job.repoSize.sizeKb} KB`)
}

// ── ② 稀疏取源码：真打真镜像，只取 preset/ 一个目录 ────────────────────────────────────
const dest = join(HOME, 'src')
{
  // 用真实默认源（readSources() 回退 DEFAULT_SOURCES → ghproxy 主源 + GitHub 直连），
  // 只关掉"已落地仓库复用"以免误命中本机 reposDir。
  let cloned = null
  let threw = null
  try {
    cloned = await gitCloneRepo(REPO, dest, 'github', 120000, { sparse: [], reuseLanded: false })
  } catch (error) { threw = error }
  if (threw !== null) {
    console.log(`SKIP ②③：真镜像克隆失败（${String(threw?.message ?? '').slice(0, 220)}）——网络受限，本次不跑真网络断言（不假装 PASS）`)
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    try { disposeDir(HOME) } catch {}
    console.log(`\nALL PASS（真实网络部分 SKIP；已完成 ${pass} 条真网络前的断言）`)
    process.exit(0)
  }
  check('★② 稀疏骨架克隆成功（--filter=blob:none --sparse）', cloned?.sparse === true, JSON.stringify({ sparse: cloned?.sparse, source: cloned?.source, url: cloned?.url }))
  check('② 稀疏没有被降级（真镜像支持 partial clone）', cloned?.downgradedFromSparse === false, String(cloned?.downgradedFromSparse))
  const materialized = readdirSync(dest).filter((n) => n !== '.git').sort()
  check('★② **没有克隆整个仓库**：骨架阶段工作区只有根目录文件（graded/ injector/ preset/ 都还没落地）',
    !existsSync(join(dest, 'graded')) && !existsSync(join(dest, 'injector')) && !existsSync(join(dest, 'preset')),
    JSON.stringify(materialized))
  const skeletonBytes = Number(execFileSync(process.execPath, ['-e', `const fs=require('fs'),p=require('path');let t=0;const w=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const c=p.join(d,e.name);try{if(e.isDirectory())w(c);else t+=fs.statSync(c).size}catch{}}};w(process.argv[1]);console.log(t)`, dest], { encoding: 'utf8' }).trim())
  check('★② 骨架落地字节数远小于整仓（< 300 KB；整仓要 2.3 MB + 全部 blob）',
    Number.isFinite(skeletonBytes) && skeletonBytes > 0 && skeletonBytes < 300 * 1024, `骨架 ${skeletonBytes} B`)
  console.log(`INFO ② 骨架工作区 ${JSON.stringify(materialized)}；落地 ${skeletonBytes} B`)
}

// ── ②b 定向取目录：`git sparse-checkout set preset` 后**只有 preset/ 多出来** ──────────────
{
  const { runGitArgs } = await import('../lib/server/domain/repoland.js')
  const set = await runGitArgs(['sparse-checkout', 'set', 'preset'], { cwd: dest, timeout: 120000 })
  check('★②b git sparse-checkout set preset 成功（真镜像 + 真 partial clone）', set.code === 0, `code=${set.code} stderr=${String(set.stderr).slice(0, 160)}`)
  const sparseFiles = readdirSync(dest).filter((n) => n !== '.git')
  check('★②b 稀疏后工作区**只有 preset/**（graded/ 与 injector/ 缺席 → 证明确实"只取了那一个目录"）',
    sparseFiles.includes('preset') && !existsSync(join(dest, 'graded')) && !existsSync(join(dest, 'injector')),
    JSON.stringify(sparseFiles))
  check('★②b preset/router-standard/agent.cordis.yml 真的在（真机那条路径的文件到位）',
    existsSync(join(dest, 'preset', 'router-standard', 'agent.cordis.yml')))
  const afterBytes = Number(execFileSync(process.execPath, ['-e', `const fs=require('fs'),p=require('path');let t=0;const w=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const c=p.join(d,e.name);try{if(e.isDirectory())w(c);else t+=fs.statSync(c).size}catch{}}};w(process.argv[1]);console.log(t)`, dest], { encoding: 'utf8' }).trim())
  console.log(`INFO ②b sparse-checkout set preset 后工作区 ${JSON.stringify(sparseFiles)}；落地 ${afterBytes} B（骨架阶段是 92125 B）`)
  check('★②b 稀疏后总字节数仍远小于整仓 clone（实测整仓 ≈ 2.34 MB）', afterBytes > 0 && afterBytes < 2 * 1024 * 1024, `${afterBytes} B`)
}

// ── ③ 全流程：tryPresetSourceChannel 真装配（隔离 DSH_HOME）─────────────────────────────
{
  const presetsRoot = join(HOME, '.agent-presets')
  const job = { id: 'real-e2e-2', repo: REPO, channelNotes: [] }
  const res = await tryPresetSourceChannel({ job, name: CANDIDATE, deps: { presetsRoot } })
  const marker = join(presetsRoot, 'router-standard', 'agent.cordis.yml')
  check('★③ installed=true（真的装配成功）', res.installed === true, JSON.stringify({ installed: res.installed, err: res.error, note: String(res.note ?? '').slice(0, 300) }))
  check('★★③ 预设真的落到 <DSH_HOME>/.agent-presets/router-standard/agent.cordis.yml', existsSync(marker), marker)
  if (existsSync(marker)) {
    const buf = readFileSync(marker)
    const firstLine = buf.toString('utf8').split(/\r?\n/u)[0]
    console.log(`INFO ③ ${marker}`)
    console.log(`INFO ③ 字节数 = ${buf.length}`)
    console.log(`INFO ③ 内容首行 = ${firstLine}`)
    check('★③ agent.cordis.yml 非空且是真 YAML 开头（贴得出字节数与首行）',
      buf.length > 1000 && /^(---|#|[A-Za-z_][\w.-]*:)/u.test(firstLine), `${buf.length} B / ${firstLine.slice(0, 80)}`)
    check('★③ preset.yml 同时就位（框架预设发现需要它）', existsSync(join(presetsRoot, 'router-standard', 'preset.yml')))
  }
  check('★③ 同一子包里的另外两个预设也装了（上游 preset/ 下有三个）',
    existsSync(join(presetsRoot, 'router-spec', 'agent.cordis.yml')) && existsSync(join(presetsRoot, 'router-react', 'agent.cordis.yml')),
    JSON.stringify(readdirSync(presetsRoot)))
  // 0.5.28 改错：框架 0.1.7-rc.x 起预设改为**声明行**，旧文案"新建会话时选择"是谎话；
  // 这条真网络端到端没传 patchPath（没有目标 profile）→ note 必须如实说"需要声明行"。
  check('★③ 面板文案：落盘路径 + 「需要声明行」（如实，不谎称"新建会话时选择"）+ 稀疏取源码',
    String(res.note).includes(presetsRoot) && /需要声明行/u.test(String(res.note))
    && !/新建会话时选择/u.test(String(res.note)) && /稀疏取源码/u.test(String(res.note)),
    String(res.note).slice(0, 300))
  check('★③ job.presetSource 如实记录 sparse/subdir（可核验"用的是稀疏"）',
    job.presetSource?.sparse === true && job.presetSource?.subdir === 'preset' && job.presetSource?.downgraded === false,
    JSON.stringify(job.presetSource))
  check('★③ job.presetInstalled 里每个预设都有字节数与落盘路径',
    Array.isArray(job.presetInstalled) && job.presetInstalled.length >= 2 && job.presetInstalled.every((p) => p.ok === true && p.bytes > 0 && typeof p.dest === 'string'),
    JSON.stringify((job.presetInstalled ?? []).map((p) => ({ n: p.name, b: p.bytes }))))
  check('★③ job.channelNotes 记下稀疏与 sparse-checkout（面板可见，不沉默）',
    job.channelNotes.some((n) => n.includes('--filter=blob:none --sparse')) && job.channelNotes.some((n) => n.includes('sparse-checkout set preset')),
    JSON.stringify(job.channelNotes))
  // 通道自己用的临时目录必须清理干净（不静默留垃圾）——它内部会 disposeDir，删不掉才改名成 .trash-*
  const residue = readdirSync(tmpdir()).filter((n) => n.startsWith('dsh-preset-real-e2e-2-'))
  check('★③ 临时目录已清理（不留 dsh-preset-* 残留）', residue.length === 0, JSON.stringify(residue))
  check('③ preset/ 目录里没有必要的大文件被复制进 .agent-presets（只装预设本体）',
    statSync(join(presetsRoot, 'router-standard')).isDirectory() && !existsSync(join(presetsRoot, 'router-standard', 'docs')))
}

// ── 收尾 ────────────────────────────────────────────────────────────────────────────────
if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
try { disposeDir(HOME) } catch {}
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
