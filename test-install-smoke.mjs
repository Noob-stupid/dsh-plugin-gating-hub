// CI 真装真卸冒烟（临时 DSH_HOME，绝不碰真实用户目录）
//
// 为什么需要它（2026-09-20 复盘）：环境相关测试"没有 profile 就整体 SKIP"，导致
//   · 非 Windows 硬编码（`git.exe`、"<node bin>/node_modules/corepack/dist/corepack.js"）在 Linux CI 上一直活着，
//     直到真实用户在 Android/proot Ubuntu 上撞出来（spawn git.exe ENOENT / MODULE_NOT_FOUND）；
//   · 多通道兜底路径（pnpm → curl → Release → git）平时从不执行，漏 import 这类错误能一路走到线上。
// 这条测试**在 CI 的 Linux 宿主上**真的走一遍：git 可用性 → pnpm/corepack 定位 → 真装一个零依赖包 →
// 校验落盘 → 真卸载 → 校验移除 → 真克隆一个小仓库。只有 DSH_TEST_SKIP_NETWORK=1 时才跳过。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(tmpdir(), `dsh-install-smoke-${Date.now()}-${process.pid}`)
process.env.DSH_HOME = HOME
const profileDir = join(HOME, 'profiles', 'web')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

if (process.env.DSH_TEST_SKIP_NETWORK === '1') {
  console.log('SKIP 需要真实网络与 pnpm（DSH_TEST_SKIP_NETWORK=1）')
  process.exit(0)
}

// 兼容两种仓库结构：单体版函数都在 lib/index.js；分层版在 lib/server/**（按名字逐个找）
const entry = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const pick = async (name, specs) => {
  if (typeof entry[name] === 'function') return entry[name]
  for (const spec of specs) {
    try {
      const mod = await import(pathToFileURL(join(ROOT, spec)).href)
      if (typeof mod[name] === 'function') return mod[name]
    } catch {}
  }
  return null
}
const pnpmInstall = await pick('pnpmInstall', ['lib/server/domain/install.js'])
const pnpmRemove = await pick('pnpmRemove', ['lib/server/domain/install-job.js'])
const gitCloneRepo = await pick('gitCloneRepo', ['lib/server/domain/repoland.js'])
const gitBin = await pick('gitBin', ['lib/server/infra/exec.js'])
const resolvePnpmRunners = await pick('resolvePnpmRunners', ['lib/server/infra/exec.js'])
// 安装任务表：分层版在 lib/server/state.js（路由与测试共用同一模块实例），单体版在 lib/index.js
const installJobsOf = async () => {
  if (entry.installJobs instanceof Map) return entry.installJobs
  try {
    const m = await import(pathToFileURL(join(ROOT, 'lib', 'server', 'state.js')).href)
    return m.installJobs instanceof Map ? m.installJobs : null
  } catch {
    return null
  }
}

check('四个被测函数都能取到（导出面完整）',
  [pnpmInstall, pnpmRemove, gitCloneRepo, gitBin, resolvePnpmRunners].every((f) => typeof f === 'function'))

mkdirSync(profileDir, { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# smoke\n', 'utf8')
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')

try {
  // ① git 可执行名（`git.exe` 那类硬编码在这里就会炸）
  const { execFileSync } = await import('node:child_process')
  let gitVersion = ''
  try { gitVersion = execFileSync(gitBin(), ['--version'], { encoding: 'utf8', windowsHide: true }).trim() } catch (error) { gitVersion = `失败：${error.message.split('\n')[0]}` }
  check(`① git 可用（gitBin() = ${gitBin()} → ${process.platform}）`, /^git version/u.test(gitVersion), gitVersion)

  // ② pnpm/corepack 定位（corepack 路径写死 Windows 布局在这里就会炸）
  const runners = resolvePnpmRunners()
  check('② 找到至少一种 pnpm 执行方式', Array.isArray(runners) && runners.length > 0, runners.map((r) => r.note).join(' → '))
  check('② 首选执行方式在本平台可用（win32 不得选 bare `corepack`，反之亦然）',
    runners[0].kind !== (process.platform === 'win32' ? 'corepack' : 'cmd-corepack'))

  // ③ 真装一个零依赖小包（pnpm 通道 → 真实的 corepack/pnpm 解析）
  const PKG = 'left-pad'
  let installed = false
  let lastErr = ''
  let workedRegistry = 'https://registry.npmjs.org'
  for (const registry of ['https://registry.npmjs.org', 'https://registry.npmmirror.com']) {
    try {
      await pnpmInstall(profileDir, PKG, registry, 180000)
      installed = true
      workedRegistry = registry
      break
    } catch (error) { lastErr = `${registry} → ${error.message.split('\n')[0]}` }
  }
  check(`③ pnpm 通道真装上 ${PKG}`, installed, installed ? 'ok' : lastErr)
  const pkgJson = join(profileDir, 'node_modules', PKG, 'package.json')
  let name = ''
  try { name = JSON.parse(readFileSync(pkgJson, 'utf8')).name } catch {}
  check(`③ ${PKG} 落盘且名字正确`, name === PKG, `name=${name || '（读不到）'} path=${pkgJson}`)

  // ④ 真卸载（pnpm remove 走同一套跨平台定位）
  let removed = false
  let removeErr = ''
  try { await pnpmRemove(profileDir, PKG); removed = true } catch (error) { removeErr = error.message.split('\n')[0] }
  check('④ pnpm 卸载通道执行成功', removed, removed ? 'ok' : removeErr)
  check(`④ ${PKG} 目录已移除`, !existsSync(join(profileDir, 'node_modules', PKG)))

  // ⑥ jobId 撤销（真 pnpm，走真路由）：刚装错的插件在重启前也能从面板撤回
  //    2026-09-20 真装真卸演练实测缺口：bundle 型插件装完 /install 返回 entryId: null、
  //    /state 里新增 loader 条目 = 0（要重启才被加载），而旧 /uninstall 只按**运行中** loader
  //    条目查找 → 恒 404，用户只能手改 patch + package.json + 删 node_modules 才能撤回。
  //    这一节用真实 pnpm 走完整链路：POST /uninstall { jobId } → 删补丁行 + 退 bundles 清单 +
  //    pnpm remove 包目录 + 回读核实（rc.deps.pnpmRemove 不打桩，钉死"路由 → domain"的参数接线）。
  {
    const jobs = await installJobsOf()
    check('⑥ 取到安装任务表 installJobs（撤销分支的数据源）', jobs !== null)
    let reinstalled = false
    let retryErr = ''
    for (const registry of [workedRegistry]) {
      try { await pnpmInstall(profileDir, PKG, registry, 180000); reinstalled = true } catch (error) { retryErr = error.message.split('\n')[0] }
    }
    check(`⑥ 重新装上 ${PKG}（作为"已安装但未生效"的现场）`, reinstalled, reinstalled ? 'ok' : retryErr)
    if (jobs !== null && reinstalled) {
      // 现场与 runInstallJob 成功后一致：patch insert 行（appendInsert）+ bundles 清单（addBundleToManifest）
      const ROW = 'left-pad'
      const JOB = 'job-smoke-pending-1'
      writeFileSync(join(profileDir, 'cordis.patch.yml'),
        `${readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')}- insert:\n    - id: ${ROW}\n      name: '${PKG}'\n`, 'utf8')
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', PKG] } }
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      jobs.set(JOB, {
        id: JOB, repo: 'stevemao/left-pad', source: 'github', packageName: PKG, status: 'done',
        stage: 'configuring', error: null, startedAt: Date.now(), finishedAt: Date.now(), entryId: null,
        bundle: true, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
      })
      // 真路由：loader 条目里没有这个包（= 装了但还没生效），只有 jobId 能定位
      const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
      const ctx = {
        baseUrl: cordisUrl,
        loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } }] },
        webServer: { register: (r) => { globalThis.__smokeRoute = r; return () => {} } },
        effect: (fn) => { try { fn() } catch {}; return () => {} },
      }
      entry.apply(ctx)
      const route = globalThis.__smokeRoute
      const q = {
        method: 'POST', url: '/plugin-console/uninstall', socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:3080' }, signal: { aborted: false, addEventListener: () => {} },
        [Symbol.asyncIterator]() {
          const chunks = [Buffer.from(JSON.stringify({ jobId: JOB }))]
          let i = 0
          return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
        },
      }
      const res = { status: 0, body: null }
      res.writeHead = (s) => { res.status = s }
      res.end = (p) => { res.body = p }
      await route.handler(q, res)
      const body = res.body === null ? null : JSON.parse(res.body)
      check('⑥ /uninstall { jobId } → 200 且 removed=pending-install（撤销未生效的安装）',
        res.status === 200 && body?.ok === true && body?.removed === 'pending-install', `status=${res.status} body=${JSON.stringify(body)?.slice(0, 200)}`)
      check('⑥ 回读核实三项全 true（补丁行 / bundles 清单 / 包目录）',
        body?.verified?.patchClean === true && body?.verified?.bundlesClean === true && body?.verified?.packageGone === true && body?.warn === null,
        `verified=${JSON.stringify(body?.verified)} warn=${body?.warn} uninstallError=${body?.uninstallError}`)
      check('⑥ 补丁行消失 + bundles 少一项（只删包名，保留其余项）',
        !readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes(PKG)
        && JSON.stringify(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-base']),
        `patch=${JSON.stringify(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))}`)
      check('⑥ 真实 pnpm remove 生效：包目录已不在、package.json 依赖也没了',
        !existsSync(join(profileDir, 'node_modules', PKG))
        && JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies?.[PKG] === undefined)
      jobs.delete(JOB)
    }
  }

  // ⑤ 真克隆（gitBin + gitEnv + 新的"重试前清理目标目录"逻辑）
  const cloneDir = join(HOME, 'clone-target')
  let cloned = ''
  try {
    await gitCloneRepo('octocat/Hello-World', cloneDir, 'github', 90000)
    cloned = existsSync(join(cloneDir, '.git')) ? 'ok' : '目录里没有 .git'
  } catch (error) { cloned = `失败：${error.message.split('\n')[0]}` }
  check('⑤ 真克隆一个小仓库成功（git 通道可用）', cloned === 'ok', cloned)
} finally {
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
