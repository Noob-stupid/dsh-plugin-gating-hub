// 套装安装端到端测试：/install 普通路径 → 服务端检测 .gitmodules → 自动转套装安装
// 真实目标仓库 yjh051108/dsh-routing-suite（预设 → .agent-presets，injector → bundle 层）。
//
// ── 2026-09-22（issue #3 收尾）两处改造，原因写在最前面，别改回去 ─────────────────────
// ① **安装通道离线化**：本用例原来会真装到真实 profile。上游仓库 2026-09-04 后已无 .gitmodules，
//    于是走到"私有聚合根（@dsh-external/dsh-super-injector，private:true）→ 自动展开子包"这条路，
//    每个候选都要真网络走 pnpm/curl/GitHub release。issue #3 把 release 通道放开给子包候选之后，
//    这条用例会真的按包名反查到**别的仓库**（yjh051108/dsh-super-injector）、下载产物并写进 profile ——
//    既慢又不可重复（本机 github.com 直连 curl exit 35，换个网络结果就不同）。
//    现在通过 ports.installChannels 注入桩：用例只断言"服务端把哪些通道、按什么顺序、派给哪个候选"，
//    安装本身不落盘、不联网。release 反查与挑 asset 的正确性由 test-suite-detect.mjs 的 release 反查单测 +
//    只读真实验证覆盖（见 HANDOFF-issue3.md 第三节）。
// ② **必须应答 AI 兜底授权**：所有确定性通道失败后，服务端会停在 stage=ai-consent 等**最多 10 分钟**
//    （面板上点「取消」才结束；见 install-job.js 的 ai-consent 段）。脚本驱动的用例没人点按钮，
//    旧写法就是干等 8 分钟轮询后判 FAIL —— 这正是本次报的"卡死/永不结束"。
//    现在与真实前端同一行为（client.js：aiFallback=false 时自动拒绝）：
//    POST /ai-consent {approved:false} → 作业立刻以"用户取消本地 AI 兜底"结束。
//    用例耗时从「8 分钟以上」降到数十秒。
// ③ **假 ctx 换成严格替身**（2026-09-22 事故的真正根因防线）：旧写法把 ctx 写成手写普通对象，
//    读未声明的属性只会得到 undefined —— 于是 0.3.59 那个"属性式读取未声明的 ctx.installChannels"
//    在单测里全绿、在真实 cordis 上必抛（cannot get property ... without inject），每次安装都失败。
//    现在用 strict-ctx.mjs 复刻 cordis 语义（未 inject 的名字属性访问即抛 + 记账本），
//    并在末尾断言账本为空；把注入缝改回属性访问，本用例立刻红。
// ④ **作业跑在临时 home 的 profile 副本上**（2026-09-27 批次 D-③ 事故的防线）：
//    本用例的安装通道全部打桩（见 ①），但 D-③ 新增的**预设源码通道**是一条真实通道 —— 它会
//    git 取源码并把预设装配到 `<DSH_HOME>/.agent-presets`。首次实现时本用例正是对着真实 home 跑的，
//    结果**改动了用户线上正在用的三个预设**（多出 6 个 .bak-* 目录、文件被上游版本合并）。
//    仍然保留"必须有真实 profile 才跑"的语义（CI 无 profile → SKIP），但真正的落盘全在临时目录里：
//    线上目录一个字节都不会动。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { disposeDir } from '../lib/server/infra/fsx.js'
import { channelImpls } from '../lib/server/domain/install-job.js'
import { strictCtx, violationsOf } from './strict-ctx.mjs'

const require = createRequire(import.meta.url)

// 该测试真实安装到 profile；无 profile 的环境（CI）跳过而非红灯
const liveHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
if (!existsSync(join(liveHome, 'profiles', 'web'))) {
  console.log(`SKIP 需要真实 profile（${join(liveHome, 'profiles', 'web')}）——CI 环境跳过`)
  process.exit(0)
}
// 临时 home：只带 profile 的三个必要文件（package.json / cordis.patch.yml / cordis.yml），
// 不复制 node_modules（几十 MB，且各通道已打桩，用不到）。
const home = join(tmpdir(), `dsh-suite-install-${process.pid}`)
disposeDir(home)
mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
mkdirSync(join(home, 'plugin-console'), { recursive: true })
for (const f of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
  try { copyFileSync(join(liveHome, 'profiles', 'web', f), join(home, 'profiles', 'web', f)) } catch {}
}
process.env.DSH_HOME = home
console.log(`INFO 临时 home：${home}（真实 home=${liveHome} 全程只读）`)
const mod = await import(new URL('../lib/index.js', import.meta.url).href)

// 离线通道桩（见文件头 ①）：每个桩都记录"自己被谁调用"，并立刻以确定性错误失败。
const channelCalls = []
const offline = (label) => { throw new Error(`离线夹具：${label} 不联网（本用例只验证通道派发与作业终止）`) }
const installChannels = {
  raceInstallChannels: async (dir, name) => { channelCalls.push(`race:${name}`); return null },
  pnpmInstall: async (dir, spec) => {
    const s = String(spec)
    channelCalls.push(`${s.startsWith('git+') || s.startsWith('github:') ? 'git' : 'pnpm'}:${s}`)
    offline('pnpm/git')
  },
  curlManualInstall: async (dir, name) => { channelCalls.push(`curl:${name}`); offline('curl') },
  githubReleaseInstall: async (dir, repo, name, options) => {
    channelCalls.push(`release:${repo ?? 'null'}:${name}:${options?.baseUrl ?? 'null'}`)
    offline('GitHub release')
  },
  backfillMissingDeps: async () => [],
}

// ── 假 ctx 换**严格替身**（文件头 ③，2026-09-22 事故的根因防线）───────────────────────
// 旧写法是手写普通对象：读任何属性都返回 undefined，于是 0.3.59 那个「属性式读取未声明的
// ctx.installChannels」在单测里全绿、到真实 cordis 上必炸。严格替身复刻 cordis 的语义：
//   · inject 声明过的（webServer / loader）→ 属性访问合法；
//   · 只是 provide 进来的 installChannels    → **只能 ctx.get 读**，属性访问抛 "without inject" 并记账；
//   · baseUrl / effect 等 ctx 自身成员       → 属性访问合法。
// 账本（violationsOf）在文件末尾断言：整条安装路径不许出现属性式访问未声明的名字。
const ctx = strictCtx({
  inject: mod.inject,
  services: {
    webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
    loader: { entries: () => [] },
    installChannels,
  },
  own: { baseUrl: pathToFileURL(join(home, 'profiles', 'web', 'cordis.yml')).href },
})
// 自检：替身必须"有牙齿"——拿一颗一次性的替身演示属性式读取会抛（并留下账本），
// 否则下面那条"账本为空"就只是装饰。绝不能在主 ctx 上做这个演示（会给账本记一笔假账）。
const probeCtx = strictCtx({ inject: mod.inject, services: { installChannels } })
let probeError = null
try { void probeCtx.installChannels } catch (error) { probeError = error }
check('严格替身自检：属性式读取未声明的 installChannels 必抛（与 cordis 一致）',
  probeError !== null && /cannot get property "installChannels" without inject/u.test(probeError.message)
  && violationsOf(probeCtx).length === 1,
  probeError === null ? '（没有抛错 —— 替身坏了）' : probeError.message)
check('严格替身自检：被 provide 的服务仍然可以经 ctx.get 读到（可选读取的正规入口）',
  ctx.get('installChannels') === installChannels && ctx.get('never-provided') === undefined)
// 注入缝本身：channelImpls 必须经 ctx.get 取到桩。若有人把主路径改回 ports?.installChannels，
// 严格替身会抛 → 被 channelImpls 的 try/catch 吞掉 → 回落到**真实通道** → 这里必红（这条断言不联网、不落盘）。
const seam = channelImpls(ctx)
check('★ 注入缝经 ctx.get(\'installChannels\') 取到桩函数（改回属性访问则此断言必红）',
  seam.raceInstallChannels === installChannels.raceInstallChannels
  && seam.pnpmInstall === installChannels.pnpmInstall
  && seam.curlManualInstall === installChannels.curlManualInstall
  && seam.githubReleaseInstall === installChannels.githubReleaseInstall
  && seam.backfillMissingDeps === installChannels.backfillMissingDeps,
  `race=${seam.raceInstallChannels === installChannels.raceInstallChannels}`)
mod.apply(ctx)
const route = globalThis.__route

function fakeReq(method, pathname, body) {
  const req = {
    method, url: pathname, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3080' },
    signal: { aborted: false, addEventListener: () => {} },
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
  return req
}
function fakeRes() {
  const res = { status: 0, body: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (payload) => { res.body = payload }
  return res
}
async function call(method, path, body) {
  const res = fakeRes()
  await route.handler(fakeReq(method, path, body), res)
  return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
}

let failed = 0
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// 前置探测：外部套装仓库 yjh051108/dsh-routing-suite 是否仍具备套装特征（根 .gitmodules）。
// 上游可能重构/清空仓库（2026-09-04 后已无 .gitmodules 与根 package.json），
// 此时套装链路无从验证，退化为「不得误判为套装」断言，避免外部变化让测试永久红灯。
let isSuiteRepo = false
try {
  const probe = await fetch('https://raw.githubusercontent.com/yjh051108/dsh-routing-suite/main/.gitmodules')
  isSuiteRepo = probe.status === 200
} catch {}

// 1. 普通插件安装请求（无 packageName）→ 应自动识别套装并转套装安装
const r = await call('POST', '/plugin-console/install', { repo: 'yjh051108/dsh-routing-suite' })
check('install accepted', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json))
const jobId = r.json?.jobId
check('job created', typeof jobId === 'string')

// 2. 轮询直到结束。安装通道已离线化（见文件头 ①），正常情况下几秒内跑完候选；
//    停在 ai-consent 时按真实前端的行为自动拒绝（见文件头 ②），作业随即可终止。
let job = null
let consentAnswered = 0
const started = Date.now()
const deadline = started + 4 * 60 * 1000
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const s = await call('POST', '/plugin-console/install-status', { jobId })
  job = s.json
  if (job && job.status !== 'installing') break
  if (job?.stage === 'ai-consent') {
    const d = await call('POST', '/plugin-console/ai-consent', { jobId, approved: false })
    consentAnswered += 1
    check('ai-consent 可以被脚本应答（真实前端同款路径）', d.status === 200 && d.json?.ok === true, JSON.stringify(d.json))
  }
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
check('job finished', job !== null && job.status !== 'installing', JSON.stringify({ status: job?.status, stage: job?.stage, error: job?.error }))
console.log(`  轮询 ${elapsed}s 结束，status=${job?.status} stage=${job?.stage}${job?.error ? ` error=${job.error}` : ''}`)

if (!isSuiteRepo) {
  console.log('SKIP 套装断言：上游仓库已无 .gitmodules（2026-09-04 后变更），改用「不得误判为套装」断言')
  check('no false suite detection', job?.kind !== 'suite', `kind=${job?.kind}`)
  check('no suiteReport for non-suite repo', job?.suiteReport === null || job?.suiteReport === undefined, JSON.stringify(job?.suiteReport))
} else {
  check('kind switched to suite', job?.kind === 'suite', `kind=${job?.kind}`)
  check('suiteReport present', Array.isArray(job?.suiteReport), JSON.stringify(job?.suiteReport))
  if (Array.isArray(job?.suiteReport)) {
    for (const item of job.suiteReport) {
      console.log(`  [${item.ok ? 'OK' : 'FAIL'}] ${item.component} (${item.type}): ${item.note}`)
    }
    check('presets installed (3 presets)', job.suiteReport.filter((x) => x.type === 'preset' && x.ok).length >= 2, job.suiteReport.filter((x) => x.type === 'preset' && x.ok).map((x) => x.component).join(', '))
    // 安全护栏：injector 是 bundle 型子包 → 套装装配**跳过**它（绝不写 bundles），报告里如实标失败。
    // （2026-09-22 更正：旧注释写"Release tgz 无 lib/ 入口"——实测 v0.3.5 的 asset 有 lib/index.js，
    //  跳过它的原因是**类型**（bundle 需与框架严格兼容），不是入口缺失。）
    const inj = job.suiteReport.find((x) => x.component === 'injector')
    check('injector skipped by suite assembler (bundle type, not written to bundles)', inj !== undefined && inj.ok === false, JSON.stringify(inj))
  }
}

// 2b. 通道派发（issue #3 守卫收尾的端到端核对）。
// 这里的候选来自"私有聚合根自动展开子包"（subpackageMode=true），正是 issue #3 要求放开守卫的那类候选：
// 展开之后并行竞速 / curl / release 都必须照常尝试，只有 git 保持不试（同一 job.repo 不重复 clone）。
// 网络受限时可能一个子包都没读到 —— 那时跳过这组断言，避免把"读不到"误判成"守卫错了"。
const attempted = [...new Set(channelCalls.filter((c) => c.startsWith('race:')).map((c) => c.slice('race:'.length)))]
if (attempted.length === 0) {
  console.log('SKIP 通道派发断言：本次没能读到候选子包（网络受限/仓库变更），只验证作业已终止且未落盘')
} else {
  console.log(`  候选 ${attempted.length} 个：${attempted.join('、')}`)
  check('★ 每个候选都试过 并行竞速 + curl 手动通道（issue #3 去掉了 !expanded 连坐）',
    attempted.every((n) => channelCalls.includes(`curl:${n}`)),
    channelCalls.filter((c) => c.startsWith('curl:')).join(' → '))
  check('★ 每个候选都试过 GitHub release 通道（按包名反查，不再按 job.repo 判断该不该试）',
    attempted.every((n) => channelCalls.some((c) => c.startsWith('release:') && c.includes(`:${n}:`))),
    channelCalls.filter((c) => c.startsWith('release:')).join(' → '))
  check('★ release 通道按候选预算派发（≤3 个候选，不把 8 分钟作业预算吃光）',
    channelCalls.filter((c) => c.startsWith('release:')).length <= 3,
    `${channelCalls.filter((c) => c.startsWith('release:')).length} 次`)
  check('★ git 通道不尝试（subpackageMode 下候选不是被请求的包，clone 根仓库装不出子包）',
    !channelCalls.some((c) => c.startsWith('git:')),
    channelCalls.filter((c) => c.startsWith('git:')).join(' → ') || '（无）')
  check('★ 作业按序试完确定性通道：要么停在 AI 兜底授权并被告知（本机网络装不上），要么被**预设源码装配**收口（第三件真的装上了）',
    consentAnswered > 0 || (Array.isArray(job?.presetInstalled) && job.presetInstalled.some((p) => p.ok === true)),
    `应答 ${consentAnswered} 次 / presetInstalled=${JSON.stringify(job?.presetInstalled ?? null).slice(0, 200)}`)
}

// 3. 验证磁盘结果（套装成功安装时才断言预设落地）
if (isSuiteRepo) {
  check('preset router-standard exists', existsSync(`${home}/.agent-presets/router-standard/preset.yml`), `${home}/.agent-presets/router-standard`)
  check('preset router-spec exists', existsSync(`${home}/.agent-presets/router-spec/preset.yml`))
}

// 3b. 批次 D-③（2026-09-27）的**真机端到端断言**：真仓库 yjh051108/dsh-routing-suite 的第三件
//     `dsh-router-standard` 只存在于仓库源码里（npm 双 404、release 无资产）。旧版本它必然落到
//     ai-consent（"装不上"）；现在由预设源码通道（稀疏取源码 + 按 preset 装配）真的装上。
//     网络不可达时本段如实 SKIP —— 上面的通道派发断言与 ai-consent 断言已经把"按序试完"钉住了。
if (Array.isArray(job?.presetInstalled) && job.presetInstalled.some((p) => p.ok === true)) {
  const pdir = `${home}/.agent-presets/router-standard`
  const marker = `${pdir}/agent.cordis.yml`
  check('★ [真机] 预设型子包装成：<临时 home>/.agent-presets/router-standard/agent.cordis.yml 真的落盘',
    existsSync(marker), `${marker} bytes=${existsSync(marker) ? readFileSync(marker).length : 0}`)
  // 0.5.28 改错：框架 0.1.7-rc.x 起预设改为**声明行**。本套跑在临时 home 上、没有可写的目标 profile，
  // 所以 note 必须**如实**说"文件已就位，但当前框架版本需要声明行才能显示"（旧文案是谎话）。
  check('★ [真机] 面板文案含落盘路径，且**如实**说明"需要声明行"（不再谎称"新建会话时选择"）',
    String(job.presetNote).includes('.agent-presets') && /需要声明行/u.test(String(job.presetNote ?? ''))
    && !/新建会话时选择/u.test(String(job.presetNote ?? '')),
    String(job.presetNote ?? '').slice(0, 240))
  check('★ [真机] **绝不写补丁行 / 绝不声明依赖**（预设不是 npm 包；写了会让补丁行指向不存在的模块 → 启动崩溃）',
    !readFileSync(`${home}/profiles/web/cordis.patch.yml`, 'utf8').includes('dsh-router-standard')
    && !readFileSync(`${home}/profiles/web/package.json`, 'utf8').includes('dsh-router-standard'),
    'patch/manifest clean')
  check('★ [真机] 用了**稀疏取源码**（--filter=blob:none --sparse + sparse-checkout set），不是整仓 clone',
    job.presetSource?.sparse === true && job.presetInstalled?.some((p) => p.subdir === 'preset') === true,
    JSON.stringify(job.presetSource ?? null))
  check('★ [真机] job.packageName 就是真正装上的那一件（不是私有根的根包名）',
    job.packageName === 'dsh-router-standard', String(job.packageName))
  console.log(`INFO [真机] 预设落盘明细：${JSON.stringify(job.presetInstalled ?? null)}`)
} else {
  console.log('SKIP [真机] 预设端到端断言：本次预设源码通道没成功（网络受限/上游变更）—— 通道派发与 ai-consent 断言已覆盖')
}
// injector 没有落盘：本用例的安装通道已全部打桩（见文件头 ①），所以这里验证的是
// "失败的确定性通道不会写下任何东西"；至于 release 产物本身能不能装，由只读真实验证回答
// （实测：@dsh-external/dsh-super-injector 0.3.5 的 asset 能下、能过盒子验证）。
check('injector NOT in node_modules（离线夹具：release 通道已打桩，未落盘）', !existsSync(`${home}/profiles/web/node_modules/@dsh-external/dsh-super-injector`)
  && !existsSync(`${home}/profiles/node_modules/@dsh-external/dsh-super-injector`))
console.log('--- profile bundles 声明 ---')
let bundles = []
try {
  const pkg = JSON.parse(require('node:fs').readFileSync(`${home}/profiles/web/package.json`, 'utf8'))
  bundles = pkg.dsh?.profile?.bundles ?? []
  console.log('bundles:', JSON.stringify(bundles))
} catch (e) { console.log('profile package.json 读取失败：' + e.message) }
check('bundles does NOT contain injector', !bundles.includes('@dsh-external/dsh-super-injector'))

// ── 严格替身账本：整条安装路径不许出现「属性式访问未声明的 ctx 名字」────────────────────
// 0.3.59 的注入缝就是属性式访问了未声明的 ctx.installChannels：假 ctx 是普通对象 → 单测全绿；
// 真实 cordis 直接抛 → 每次安装必失败。这条断言让同类改法再也过不去（即使异常被 try/catch 吞掉，
// 账本仍然记得有人读过那个名字）。若它红了：对照 strict-ctx.mjs 的说明，把该处改成 ctx.get('名字')
// 或显式传参，**不要**把名字塞进 inject 来"修"（那是方案 B，只适用于真服务）。
const violations = violationsOf(ctx)
check('★ 严格替身：整条安装路径没有属性式访问未声明的 ctx 名字（0.3.59 事故的回归断言）',
  violations.length === 0,
  violations.length === 0 ? '账本为空' : `越界读取 ${violations.length} 次：${[...new Set(violations)].join('、')}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
// 收尾：临时 home 整份清掉（复用既有降级：删不掉就改名成 .trash-*），线上目录全程只读
try { disposeDir(home) } catch {}
process.exit(failed === 0 ? 0 : 1)
