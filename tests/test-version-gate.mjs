// 版本变更自动拦截（0.5.111 加法）
//
// 钉住：
//   ① shouldRunVersionGate：同版本不跑、首次/版本变化要跑；
//   ② runVersionGate：默认开 → 真的禁用 fail 行 + 写 compat-pending + 记 gate.version；
//   ③ 同版本第二次不跑（幂等）；
//   ④ autoDisable=false → 只记版本、不写补丁；
//   ⑤ 面板读取的 compat-gate.version 能持久化。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'version-gate-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@fake', 'bad'), { recursive: true })
mkdirSync(join(profileDir, 'node_modules', '@fake', 'fine'), { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# user patch\n', 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'bad', 'package.json'), JSON.stringify({
  name: '@fake/bad', version: '1.0.0', main: 'index.js', dsh: { engines: { framework: '<0.1.0' } },
}), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'bad', 'index.js'), 'export const bad = true;\n', 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'fine', 'package.json'), JSON.stringify({
  name: '@fake/fine', version: '2.0.0', main: 'index.js', dsh: { engines: { framework: '>=0.1.0' } },
}), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'fine', 'index.js'), 'export const ok = true;\n', 'utf8')

const ctx = {
  baseUrl: `file:///${profileDir.replace(/\\/gu, '/')}`,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true } },
      { id: 'include:bad', options: { name: '@fake/bad' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:fine', options: { name: '@fake/fine' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } },
    ],
  },
  webServer: { register: () => () => {} },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const patchPath = join(profileDir, 'cordis.patch.yml')
const { readCompatGate, writeCompatGate } = await import('../lib/server/domain/compat.js')
const { runVersionGate, scheduleVersionGate, shouldRunVersionGate } = await import('../lib/server/domain/version-gate.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

check('① 首次见到版本 → 要跑', shouldRunVersionGate({ currentVersion: '0.1.5-rc.1', gate: { version: null } }).run === true)
check('① 同版本 → 不跑', shouldRunVersionGate({ currentVersion: '0.1.5-rc.1', gate: { version: '0.1.5-rc.1' } }).run === false)
check('① 版本变化 → 要跑', shouldRunVersionGate({ currentVersion: '0.1.6-rc.1', gate: { version: '0.1.5-rc.1' } }).run === true)
check('① 没有版本 → 不跑', shouldRunVersionGate({ currentVersion: null, gate: {} }).run === false)

writeCompatGate({ autoDisable: true, version: null })
const first = await runVersionGate({ ports: ctx, profileDir, patchPath, currentVersion: '0.1.5-rc.1' })
const patch = readFileSync(patchPath, 'utf8')
const pending = JSON.parse(readFileSync(join(HOME, 'plugin-console', 'compat-pending.json'), 'utf8'))
const rec = (pending.pending ?? []).find((x) => x.rowId === 'bad')
check('② 默认开：fail 行被禁用', first.ok === true && first.ran === true && first.disabled.some((d) => d.rowId === 'bad'), JSON.stringify(first.disabled))
check('② 补丁里出现 bad 的禁用块', /- id: bad\r?\n {2}disabled: true/u.test(patch), patch)
check('② 兼容行未被禁用', !/fine/u.test(patch))
check('② 写入 compat-pending（panel 待适配）', rec !== undefined && rec.status === 'pending' && rec.check === 'fail', JSON.stringify(rec))
{
  const { gatingSummary } = await import('../lib/server/domain/compat.js')
  const gateView = gatingSummary(ctx, pending, null, null)
  check('② 门控视图能读到这条待适配（拦截后不是“无记录”）', gateView.pending.some((p) => p.rowId === 'bad'), JSON.stringify(gateView.pending))
}
check('② 记录 gate.version', readCompatGate().version === '0.1.5-rc.1', JSON.stringify(readCompatGate()))
const second = await runVersionGate({ ports: ctx, profileDir, patchPath, currentVersion: '0.1.5-rc.1' })
check('③ 同版本第二次不跑', second.ran === false && second.reason === 'same-version', JSON.stringify(second))

writeCompatGate({ autoDisable: false, version: null })
const patchBefore = readFileSync(patchPath, 'utf8')
const off = await runVersionGate({ ports: ctx, profileDir, patchPath, currentVersion: '0.1.6-rc.1' })
check('④ autoDisable=false：只记版本、不写补丁', off.ran === false && off.reason === 'auto-disable-off' && readFileSync(patchPath, 'utf8') === patchBefore, JSON.stringify(off))
check('④ 版本仍被记住（不反复扫）', readCompatGate().version === '0.1.6-rc.1', JSON.stringify(readCompatGate()))
check('⑤ schedule 同版本不再调度', scheduleVersionGate({ ports: ctx, profileDir, patchPath, currentVersion: '0.1.6-rc.1' }).scheduled === false)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
