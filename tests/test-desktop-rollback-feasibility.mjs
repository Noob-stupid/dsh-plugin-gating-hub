// 0.5.84（用户第 8 项）：框架回滚在桌面端**能不能支持** —— 只读结论的可核查部分
//
// 交付物是 `docs/framework-rollback-desktop.md`（结论 + 前置条件 + 风险），本套钉的是：
//   ① 那份结论**依赖的代码事实**没有被悄悄改掉（否则文档会变成过期承诺）；
//   ② 结论**没有**伴随任何破坏性实现（回滚在桌面端仍然是拒绝，且没有任何代码往 asar 里写）；
//   ③ 文档三件套齐全（能否支持 / 前置条件 / 风险），且不写本机绝对路径。
//
// 这一套是"调研结论的守卫"，不是功能测试：它保证下一个人改动这些前提时会被提醒去同步文档。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const DOC = join(REPO, 'docs', 'framework-rollback-desktop.md')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

console.log('=== ① 文档本身：结论三件套齐全，且不写本机路径 ===')
const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : ''
{
  check('① 调研文档存在（docs/framework-rollback-desktop.md）', doc !== '', DOC)
  check('① 有明确的"能/不能支持"结论（不是含糊其辞）', /一句话结论/u.test(doc) && /不支持/u.test(doc), '')
  check('① 写清了前置条件（缺一不可）', /前置条件/u.test(doc) && /官方提供/u.test(doc))
  check('① 写清了风险（含"应用打不开"与签名/更新）', /风险/u.test(doc) && /打不开|无法启动/u.test(doc) && /签名/u.test(doc))
  check('① 给了只读复现方式', /复现方式/u.test(doc) && /asar/u.test(doc))
  // 仓库惯例：不把本机绝对路径/用户名写进源码与文档（test-peer-veto ④ 同一口径）
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const user = home === '' ? '' : home.split(/[\\/]/u).pop()
  const banned = [
    user.length < 2 ? null : new RegExp(user.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    home === '' ? null : new RegExp(home.replace(/[\\/]/gu, '[\\\\/]'), 'u'),
    new RegExp(REPO.replace(/[\\/]/gu, '[\\\\/]'), 'u'),
  ].filter((re) => re !== null)
  const hits = banned.filter((re) => re.test(doc)).length
  check('① 文档里 0 处本机绝对路径/用户名（用占位符书写）', hits === 0, `命中 ${hits} 条`)
}

console.log('\n=== ② 结论依赖的代码事实（改了就说明文档要同步）===')
{
  const rollbackRoute = readFileSync(join(REPO, 'lib', 'server', 'routes', 'framework.js'), 'utf8')
  const body = (() => {
    const from = rollbackRoute.indexOf('async function routeFrameworkRollback(')
    if (from === -1) return ''
    const end = rollbackRoute.indexOf('\n}', from)
    return end === -1 ? rollbackRoute.slice(from) : rollbackRoute.slice(from, end + 2)
  })()
  check('② ★ 桌面端回滚仍然是**明确拒绝**（refuseWhenShellHosted 在生成脚本之前）',
    body.indexOf('refuseWhenShellHosted(res)') > 0
    && body.indexOf('refuseWhenShellHosted(res)') < body.indexOf('fw-rollback-'),
    '拒绝点必须在任何脚本/写盘之前')

  // 回滚脚本恢复的目标来自 framework-rollback.json 的 fwRoot（而不是 asar）
  check('② 回滚恢复的目标是记录里的 fwRoot（不是桌面端 asar）',
    /fwRoot: rec\.fwRoot/u.test(body) && /checkpointDir/u.test(body), '')

  // 我们"以为的框架"来自 frameworkBases()：指向包管理器安装树，不是桌面端资源目录
  const { frameworkBases } = await import('../lib/server/infra/framework-root.js')
  const seed = join(ROOT, '.testdir', 'fw-rollback-feasibility', 'profiles', 'desktop')
  const bases = frameworkBases(seed, seed)
  check('② ★ frameworkBases 给的是包管理器安装树（npx/node_modules 一类），**不是** app.asar',
    Array.isArray(bases) && bases.every((b) => !/app\.asar/iu.test(b)), JSON.stringify(bases).slice(0, 120))

  // 全仓没有任何代码往 app.asar 里写（结论的前提：我们不碰那个归档）
  const serverFiles = []
  const { readdirSync } = await import('node:fs')
  const walkServer = (rel) => {
    for (const e of readdirSync(join(REPO, rel), { withFileTypes: true })) {
      const next = `${rel}/${e.name}`
      if (e.isDirectory()) walkServer(next)
      else if (e.name.endsWith('.js')) serverFiles.push(next)
    }
  }
  walkServer('lib/server')
  const writers = serverFiles.filter((rel) => {
    const src = readFileSync(join(REPO, rel), 'utf8')
    // 只要出现"写 app.asar / resources 下写盘"就算违规（读它都不允许：普通 fs 读不进）
    return /writeFile(Sync)?\([^)]*app\.asar/u.test(src) || /(?:rmSync|writeFileSync)\([^)]*resources[\\/]/u.test(src)
  })
  check('② ★ 全仓 lib/server/** 里 0 处往 app.asar / resources 写盘（调研结论的前提：不碰归档）',
    writers.length === 0, writers.join(', ') || `扫了 ${serverFiles.length} 个文件`)
}

console.log('\n=== ③ 结论落点：面板能如实说"不可用"，不假装可以回滚 ===')
{
  const stateSrc = readFileSync(join(REPO, 'lib', 'server', 'routes', 'state.js'), 'utf8')
  check('③ /state 下发 host.hosted（面板据此把回滚标成不可用，而不是给一个点了必 409 的按钮）',
    /host = \{ hosted: shape\.hosted === true/u.test(stateSrc) && /notice: shape\.hosted === true/u.test(stateSrc))
  const clientSrc = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  check('③ 客户端按同一份事实显示"不可用 + 原因"', /status\?\.host\?\.hosted === true/u.test(clientSrc) && /safetyRollbackNone/u.test(clientSrc))
  check('③ 复盘记录仍指向 npx 树这件事被写进了文档（版本漂移风险有据可查）',
    /0\.2\.1-rc\.2/u.test(doc) && /0\.2\.0-rc\.2/u.test(doc), '')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
