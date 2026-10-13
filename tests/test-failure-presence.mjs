// 「报失败之前先核实**其实已经装上了**」—— 2026-10-13 用户被误导过（第三次实测报告）。
//
// 现场：面板「最近安装失败」把某个插件报成失败并给出「重试」，而那个插件**当时其实已经装好**：
//   · profile `package.json` 的 `dependencies` 里有它；
//   · `dsh.profile.bundles` 里有它；
//   · `node_modules/<包名>` 下有实体。
// 旧实现只看作业状态，于是"没装上"的错觉被反复强化，用户还会照着「重试」把好端端的安装再动一次。
//
// 本套断言（**全离线**：私有 DSH_HOME + 夹具文件；零网络、零子进程、零 GUI）：
//   ① 三处核实（dependencies / dsh.profile.bundles / node_modules）**任一命中即算已安装**，
//      且能读出已装版本号；三处都没有 ⇒ 如实说"没装"
//   ② 作业 → 名字的解析顺序：packageName → candidateName → subplugin.packageName（子目录插件那条路）
//   ③ **真路由**（POST /install-status）下发前就带上核实结果：失败作业带 installedEvidence
//   ④ 客户端接线（静态）：已装 ⇒ 「已安装 vX（无需重装）」是主行，历史失败折叠为次要信息（默认收起）
//   ⑤ 双语 i18n（en ⊆ zh，不硬编码中文）
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'failure-presence-home')
rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'

const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(join(PROFILE, 'node_modules', 'ds-bot'), { recursive: true })
mkdirSync(join(PROFILE, 'node_modules', 'only-bundles'), { recursive: true })
mkdirSync(join(PROFILE, 'node_modules', 'only-nm'), { recursive: true })
mkdirSync(join(PROFILE, 'node_modules', 'wrong-name'), { recursive: true })
writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), '', 'utf8')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '[]\n', 'utf8')
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({
  name: 'web-profile',
  version: '0.0.0',
  dependencies: {
    'ds-bot': 'link:D:/dsh-link/ds-bot',
    'only-deps': '^1.2.3', // 只在清单里（盘上没有实体，见下）
    'only-bundles': '^2.0.0',
  },
  dsh: { profile: { bundles: ['ds-bot', 'only-bundles'] } },
}, null, 2), 'utf8')
// 版本号只从 node_modules 的实体上读（这是"已安装 vX"里的 X 的唯一来源）
writeFileSync(join(PROFILE, 'node_modules', 'ds-bot', 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.1.4' }), 'utf8')
writeFileSync(join(PROFILE, 'node_modules', 'only-bundles', 'package.json'), JSON.stringify({ name: 'only-bundles', version: '2.0.0' }), 'utf8')
writeFileSync(join(PROFILE, 'node_modules', 'only-nm', 'package.json'), JSON.stringify({ name: 'only-nm', version: '3.1.4' }), 'utf8')
// 目录名与清单里的名字对不上的那种（不认错包）
writeFileSync(join(PROFILE, 'node_modules', 'wrong-name', 'package.json'), JSON.stringify({ name: 'someone-else', version: '9.9.9' }), 'utf8')
// 另一个 profile 用来演"三处都没有"（绝不与主夹具混在一起）
const EMPTY_PROFILE = join(HOME, 'profiles', 'empty')
mkdirSync(EMPTY_PROFILE, { recursive: true })
writeFileSync(join(EMPTY_PROFILE, 'package.json'), JSON.stringify({ name: 'empty-profile', version: '0.0.0', dependencies: {} }, null, 2), 'utf8')

const { installedEvidence, failedJobEvidence } = await import('../lib/server/domain/install-verify.js')
const { installJobs, nextInstallJobSeq } = await import('../lib/server/state.js')
const { routeInstallStatus } = await import('../lib/server/routes/install.js')

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const makeRes = () => {
  const captured = { status: null, json: null, raw: null }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(payload) { captured.raw = payload; try { captured.json = JSON.parse(payload) } catch { captured.json = null } },
  }
}
const mkFailedJob = (id, extra = {}) => ({
  id, repo: 'Fei2411/DeepSeek-Bot', source: 'github', packageName: null, status: 'failed', stage: 'preparing',
  error: '仓库 Fei2411/DeepSeek-Bot 没有 package.json（也不是技能仓库），无法作为插件安装',
  startedAt: Date.now(), finishedAt: Date.now(), entryId: null, bundle: false, ai: false, aiNote: null,
  subpackages: null, lastError: null, update: false, kind: 'plugin',
  ...extra,
})

try {
  // ── ① 三处核实：任一命中即算已安装；命中处逐条列出；版本号从 node_modules 实体读 ────────────────
  {
    const all = installedEvidence(PROFILE, 'ds-bot')
    check('★① 三处都命中 ⇒ installed=true + 版本号 + 三处逐条列出（可核验）',
      all.installed === true && all.version === '0.1.4'
      && JSON.stringify(all.where) === JSON.stringify(['dependencies', 'bundles', 'node_modules'])
      && typeof all.note === 'string' && /已经装上了/u.test(all.note) && /无需重装/u.test(all.note),
      JSON.stringify(all))
    const onlyDeps = installedEvidence(PROFILE, 'only-deps')
    check('① 单命中 dependencies（盘上没有实体）⇒ installed=true 且 version=null（版本号只从实体读，不猜）',
      onlyDeps.installed === true && onlyDeps.version === null
      && JSON.stringify(onlyDeps.where) === JSON.stringify(['dependencies']),
      JSON.stringify(onlyDeps))
    const onlyBundles = installedEvidence(PROFILE, 'only-bundles')
    check('① 命中 bundles（+实体）⇒ installed=true，命中处逐条列出',
      onlyBundles.installed === true && JSON.stringify(onlyBundles.where) === JSON.stringify(['dependencies', 'bundles', 'node_modules']),
      JSON.stringify(onlyBundles))
    const onlyNm = installedEvidence(PROFILE, 'only-nm')
    check('★① 只在 node_modules 里（清单/bundles 都没有）⇒ 也算已安装（"装没装上"与"持久化完整"是两件事）',
      onlyNm.installed === true && onlyNm.version === '3.1.4' && JSON.stringify(onlyNm.where) === JSON.stringify(['node_modules']),
      JSON.stringify(onlyNm))
    const missing = installedEvidence(EMPTY_PROFILE, 'never-installed')
    check('① 三处都没有 ⇒ installed=false（**不下**"装上了"的结论）',
      missing.installed === false && missing.where.length === 0 && missing.version === null, JSON.stringify(missing))
    check('① 名字为空/非法输入 ⇒ 不抛、installed=false（本函数的契约是永不抛）',
      installedEvidence(PROFILE, '').installed === false && installedEvidence(null, null).installed === false
      && installedEvidence(PROFILE, 123).installed === false)
    const wrongName = installedEvidence(PROFILE, 'wrong-name')
    check('① 目录名与包内 name 对不上 ⇒ **不算命中**（不认错包：绝不拿别人的实体当"已安装"）',
      wrongName.installed === false, JSON.stringify(wrongName))
  }

  // ── ② 作业 → 名字的解析顺序（子目录插件那条路必须先看 subplugin.packageName）────────────────────
  {
    const direct = failedJobEvidence(PROFILE, mkFailedJob('j1', { packageName: 'only-nm' }))
    check('★② 有 packageName ⇒ 直接核实它', direct?.installed === true && direct.version === '3.1.4', JSON.stringify(direct))
    // 真机形状：安装失败在"根无清单"阶段，作业自己**没有** packageName，只有 subplugin.packageName
    const viaSub = failedJobEvidence(PROFILE, mkFailedJob('j2', {
      packageName: null,
      subplugin: { dir: 'ds-bot', packageName: 'ds-bot', markers: ['dsh.bundle.patch', 'dsh.client'], install: { action: 'install-subdir', dir: 'ds-bot', packageName: 'ds-bot' } },
    }))
    check('★② 作业没有 packageName 时走 subplugin.packageName（真机 Fei2411/DeepSeek-Bot 就是这条）',
      viaSub?.installed === true && viaSub.packageName === 'ds-bot' && viaSub.version === '0.1.4', JSON.stringify(viaSub))
    check('② 名字一个都取不到 ⇒ null（**不下**"没装上"的结论 —— 那正是要避免的误导）',
      failedJobEvidence(PROFILE, mkFailedJob('j3')) === null && failedJobEvidence(PROFILE, null) === null)
    check('② 名字取到了但三处都没有 ⇒ 返回 installed:false（面板照旧显示失败原因，不美化）',
      failedJobEvidence(PROFILE, mkFailedJob('j4', { packageName: 'never-installed' }))?.installed === false)
  }

  // ── ③ 真路由（POST /install-status）：下发**之前**就核实，已装 ⇒ 面板拿得到「已安装」─────────────
  {
    const jobAnyway = mkFailedJob(`job-${nextInstallJobSeq()}`, {
      packageName: null,
      subplugin: { dir: 'ds-bot', packageName: 'ds-bot', markers: ['dsh.bundle.patch'], install: { action: 'install-subdir', dir: 'ds-bot', packageName: 'ds-bot' } },
    })
    installJobs.set(jobAnyway.id, jobAnyway)
    const call = async (jobId) => {
      const res = makeRes()
      await routeInstallStatus({ method: 'POST', url: '/x' }, res, {
        ctx: { loader: { entries: () => [] } }, body: { jobId }, url: new URL('http://x/x'), pathname: '/x', method: 'POST', deps: {},
      })
      return res.captured
    }
    const ok = await call(jobAnyway.id)
    check('★③ 真路由：失败作业的响应里带 installedEvidence（installed=true + v0.1.4 + 命中三处）',
      ok.status === 200 && ok.json?.installedEvidence?.installed === true
      && ok.json.installedEvidence.version === '0.1.4'
      && ok.json.installedEvidence.where.includes('node_modules'),
      JSON.stringify(ok.json?.installedEvidence))
    check('★③ 原始失败原因仍然如实保留（核实只**补充**信息，绝不掩盖失败）',
      typeof ok.json.error === 'string' && /无法作为插件安装/u.test(ok.json.error), String(ok.json?.error).slice(0, 80))

    const jobMissing = mkFailedJob(`job-${nextInstallJobSeq()}`, { packageName: 'never-installed' })
    installJobs.set(jobMissing.id, jobMissing)
    const miss = await call(jobMissing.id)
    check('★③ 三处都没有 ⇒ installedEvidence.installed=false（不许无中生有地说"已安装"）',
      miss.json?.installedEvidence?.installed === false, JSON.stringify(miss.json?.installedEvidence))
    const missingJob = await call('job-does-not-exist')
    check('③ 未知作业仍是 404（既有契约不变）', missingJob.status === 404, `status=${missingJob.status}`)
  }

  // ── ④ 静态：状态路由（「最近安装失败」那张卡）在**下发之前**核实（去掉了就红）────────────────────
  {
    const stateSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'state.js'), 'utf8')
    check('★④ 「最近安装失败」列表逐条带上核实结果（recentFailures 现查三处；历史失败也能翻案）',
      /const recentFailures = \[\.\.\.installJobs\.values\(\)\]\.filter\(\(job\) => job\.status === 'failed'\)[\s\S]{0,400}?installedEvidence: failedJobEvidence\(profileDir, job\)/u.test(stateSrc),
      'routes/state.js 的 recentFailures')
    const installSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'install.js'), 'utf8')
    check('★④ /install-status 同样在下发前核实（失败作业现查三处）',
      /installedEvidence: job\.status === 'failed'[\s\S]{0,220}?failedJobEvidence\(dirname\(findPatchPath\(ctx\)\), job\)/u.test(installSrc))
    const viewSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'install.js'), 'utf8')
    check('④ 面板视图 installJobView 下发 installedEvidence 字段（老客户端忽略它，纯加法）',
      viewSrc.includes('installedEvidence: job.installedEvidence ?? null'))
  }

  // ── ⑤ 客户端接线（静态）：已装 ⇒ 主行「已安装 vX（无需重装）」，历史失败折叠为次要信息 ────────────
  {
    const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
    check('★⑤ 面板先看核实结果：installed === true 才把「已安装」当主行（不看作业状态）',
      /job\.installedEvidence !== null && job\.installedEvidence !== undefined && job\.installedEvidence\.installed === true/u.test(client))
    check('★⑤ 主行用的是 i18n 文案（已安装 vX —— 不硬编码中文、不把服务端中文塞进界面）',
      client.includes('t("alreadyInstalled").replace("{version}", String(evidence.version))')
      && client.includes('t("alreadyInstalledNoVersion")') && client.includes('t("installedBadge")'))
    check('★⑤ 命中处也如实显示（where → 双语标签：依赖清单 / bundles / node_modules）',
      client.includes('t("alreadyInstalledWhere").replace("{where}", whereText)')
      && client.includes('t("whereDependencies")') && client.includes('t("whereNodeModules")'))
    check('★⑤ 历史失败**折叠为次要信息**（默认收起 + 展开后才显示失败正文）',
      /const failureOpen = failureDetailOpen\[job\.jobId\] === true/u.test(client)
      && /evidence !== null && failureOpen/u.test(client)
      && /t\("failureSecondaryShow"\)/u.test(client) && /t\("failureSecondaryHide"\)/u.test(client)
      && /t\("failureSecondary"\)/u.test(client))
    check('★⑤ 已装 ⇒ 主行是「已安装 vX」，失败正文**只在展开时**出现（结构断言：把这行去掉就红）',
      client.includes('installedLine === null\n\t\t\t\t\t\t\t? el("p", { className: styles.message, "data-error": "true" }, job.error ?? "")\n\t\t\t\t\t\t\t: el("p", { className: styles.message, "data-warn": "true" }, installedLine),'))
    const zhKeys = ['alreadyInstalled', 'alreadyInstalledNoVersion', 'alreadyInstalledWhere', 'installedBadge',
      'whereDependencies', 'whereBundles', 'whereNodeModules', 'failureSecondary', 'failureSecondaryShow', 'failureSecondaryHide']
    check('⑤ 十个新键在两本词典里各恰好一条（总计 2：zh + en；0 重复由 test-i18n-keys 另钉）',
      zhKeys.every((k) => (client.match(new RegExp(`^\\t{3}${k}:`, 'gmu')) ?? []).length === 2), zhKeys.join(', '))
    check('⑤ 中文/英文都在（不许只写一边）：抽查两条值确实各自存在',
      client.includes('alreadyInstalled: "已安装 v{version}（无需重装）"')
      && client.includes('alreadyInstalled: "Already installed v{version} (no reinstall needed)"')
      && client.includes('failureSecondary: "历史失败') && client.includes('failureSecondary: "Earlier failure'))
  }
} finally {
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
