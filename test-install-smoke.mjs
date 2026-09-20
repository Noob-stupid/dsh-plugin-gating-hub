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
  for (const registry of ['https://registry.npmjs.org', 'https://registry.npmmirror.com']) {
    try {
      await pnpmInstall(profileDir, PKG, registry, 180000)
      installed = true
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
