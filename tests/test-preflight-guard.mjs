// 升级预扫「误伤」回归测试（v0.3.35）。
// 起因：用实时行快照对真机做只读演练时抓到——框架自带的 @deepseek-ai/dsh-api-settings-controller
// 里有个标识符 `settingsNamespaceRequestSchema`，被 `text.includes('settingsNamespace')`
// 子串匹配判成「引用 0.1.2 起已删除的 dsh-settings API」，于是升级预扫会把这个框架行自动禁用
// （等于砍掉设置功能）。本测试锁死两件事：
//   1) 只是「恰好含同名前缀」不算引用；真引用（import / 调用）依旧判 fail —— 门禁不能被修软。
//   2) 解析到 profile 之外的包 = 框架自带，永不自动禁用（正确处置是回滚框架）。
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = join(ROOT, '.testdir', 'preflight-guard-home')
process.env.DSH_HOME = HOME // 必须在 import 前设置
rmSync(HOME, { recursive: true, force: true })

const profileDir = join(HOME, 'profiles', 'web')
const fwDir = join(HOME, 'profiles', 'node_modules') // 框架层：profile 之外，但能被 profile 解析到
const patchPath = join(profileDir, 'cordis.patch.yml')
mkdirSync(profileDir, { recursive: true })
writeFileSync(patchPath, '# user patch\n', 'utf8')

const writePkg = (base, name, source) => {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), source, 'utf8')
}

// ① 与框架包同形的「子串巧合」：settingsNamespace 只是更长标识符的前缀
writePkg(join(profileDir, 'node_modules'), '@fake/substring-only',
  'const settingsNamespaceRequestSchema = { ns: "x" }\nexport const parsed = settingsNamespaceRequestSchema\n')
// ② 真引用：从已删除的 dsh-settings 导入该 API（必须继续判 fail）
writePkg(join(profileDir, 'node_modules'), '@fake/true-ref',
  "import { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport const api = settingsNamespace\n")
// ③ 框架自带包（解析到 profile 之外）：即使真引用也不自动禁用
writePkg(fwDir, '@fake/framework-pkg',
  "import { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport const api = settingsNamespace\n")

const ctx = {
  baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(profileDir, 'cordis.yml')).href } } },
      { id: 'include:substring-only', options: { name: '@fake/substring-only' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:true-ref', options: { name: '@fake/true-ref' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:framework-pkg', options: { name: '@fake/framework-pkg' }, disabled: false, fiber: { state: 2 } },
    ],
  },
  webServer: { register: () => () => {} },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}

const { preflightDisableIncompatible } = await import('../lib/index.js')
let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const res = await preflightDisableIncompatible({ ctx, profileDir, patchPath, targetVersion: '0.1.5-rc.2' })
const patch = readFileSync(patchPath, 'utf8')
const ids = res.disabled.map((d) => d.rowId)

check('子串巧合不再误判为不适配（框架控制器同形样本）', !ids.includes('substring-only'), `disabled=${JSON.stringify(ids)}`)
check('补丁里没有 substring-only 的禁用块', !/- id: substring-only/u.test(patch))
check('真引用依旧判 fail 并禁用（门禁没被修软）', ids.includes('true-ref'), `disabled=${JSON.stringify(ids)}`)
check('补丁里出现 true-ref 的禁用块', /- id: true-ref\r?\n {2}disabled: true/u.test(patch))
check('框架自带包不被自动禁用', !ids.includes('framework-pkg'))
check('框架自带包写入 skipped 并说明原因', res.skipped.some((s) => s.rowId === 'framework-pkg' && /框架自带包/u.test(s.reason ?? '')), JSON.stringify(res.skipped.map((s) => s.rowId)))
check('框架自带包不被写进补丁', !/- id: framework-pkg/u.test(patch))

const pending = JSON.parse(readFileSync(join(HOME, 'plugin-console', 'compat-pending.json'), 'utf8'))
const pend = (pending.pending ?? []).map((p) => p.rowId)
check('只有真不适配的行进清单', pend.includes('true-ref') && !pend.includes('substring-only') && !pend.includes('framework-pkg'), JSON.stringify(pend))
check('清单判定依据仍是源码扫描 fail', (pending.pending ?? []).find((p) => p.rowId === 'true-ref')?.check === 'fail')

// 幂等：再跑一次不应重复写块
await preflightDisableIncompatible({ ctx, profileDir, patchPath, targetVersion: '0.1.5-rc.2' })
const patch2 = readFileSync(patchPath, 'utf8')
check('幂等（true-ref 禁用块仍只有 1 个）', (patch2.match(/- id: true-ref/gu) ?? []).length === 1)

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
