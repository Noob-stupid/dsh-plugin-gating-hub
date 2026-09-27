// 清理残余（/clean-residuals）回归测试 —— 2026-09-24 用户实测「点清除后 9 项删不掉」推动。
//
// 那次事故暴露了两个问题，本测试把它们钉死：
//   ① **判据错**：原实现拿旧聚合包 `@linxin666/dsh-web-ui-all` 的 dependencies 当「声明基线」，
//      于是用户后来单独安装、**正在用**的插件（`dsh-i18n` 当时还是已挂载的行）都被算成「未声明旧子包」
//      准备删除 —— 真删成的后果是重启后这些行直接消失；
//   ② **删除与报错都不可靠**：`rmSync` 在本机某些路径会静默落空（不抛错、目录仍在），
//      旧实现只重试 2 次就报「当前环境可能禁止删除」，把用户引向并不存在的权限问题。
// 现在：只删能证明是垃圾的东西（`.old-*` / `_tmp_<pid>_<n>` / 无行引用的孤儿包 / 陈旧副本），
// 在用的行一律保留并回报；删除走「清只读 → rmSync → 轮询核实 → rmdir 兜底」，失败带真实原因。
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'clean-residuals-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })

const profileDir = join(HOME, 'profiles', 'web')
const nodeModules = join(profileDir, 'node_modules')
const scoped = join(nodeModules, '@linxin666')
const consoleDataDir = join(HOME, 'plugin-console')
mkdirSync(profileDir, { recursive: true })
mkdirSync(scoped, { recursive: true })
mkdirSync(consoleDataDir, { recursive: true })
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# clean-residuals test\n', 'utf8')

const writePkg = (name, version = '1.0.0') => {
  const dir = join(scoped, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@linxin666/${name}`, version }), 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export const ok = true\n', 'utf8')
  return dir
}

// ① 在用行指向的包 —— 必须保留（这是原实现会误删的那种）
const inUseDir = writePkg('dsh-i18n')
// ② 没有任何行引用的孤儿包 —— 应当删除
const orphanDir = writePkg('dsh-orphan-legacy')
// ③ pnpm 中断残留（_tmp_<pid>_<n>）—— 无条件删除
const tmpDir = writePkg('dsh-something_tmp_25060_12')
// ④ .old-* 备份目录 —— 无条件删除
const oldDir = writePkg('dsh-web-all.old-1789099537829')

// ⑤ 陈旧副本：quarantine 快照保留最近 2 个（按名字排序）
for (const stamp of ['100', '200', '300', '400', '500']) {
  writeFileSync(join(consoleDataDir, `fw-quarantine.json.applied-${stamp}`), '{}', 'utf8')
}
// ⑥ 过期日志/计数（>7 天）删、新的留
const oldLog = join(consoleDataDir, 'upgrade-watch-20260911-110507.log')
writeFileSync(oldLog, 'old\n', 'utf8')
const oldAge = new Date(Date.now() - 10 * 86400000)
utimesSync(oldLog, oldAge, oldAge)
const freshCount = join(consoleDataDir, 'restart-guard-99999.count')
writeFileSync(freshCount, '1\n', 'utf8')

const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      { id: 'include:web-ui-i18n', options: { name: '@linxin666/dsh-i18n' }, disabled: false, fiber: { state: 2 } },
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const mod = await import('../lib/index.js')
mod.apply(ctx)
const route = globalThis.__route

const fakeReq = (method, pathname, body) => ({
  method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
  signal: { aborted: false, addEventListener: () => {} },
  [Symbol.asyncIterator]() {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    let i = 0
    return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
  },
})
const fakeRes = () => { const r = { status: 0, body: null }; r.writeHead = (s) => { r.status = s }; r.end = (p) => { r.body = p }; return r }
const call = async (method, path, body) => { const r = fakeRes(); await route.handler(fakeReq(method, path, body), r); return { status: r.status, json: r.body === null ? null : JSON.parse(r.body) } }

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const res = await call('POST', '/plugin-console/clean-residuals', {})
const json = res.json ?? {}
const removedNames = (json.removed ?? []).map((r) => r.name)
const keptNames = json.kept ?? []

check('清理接口返回 200 且不带假错误', res.status === 200 && json.ok === true, `status=${res.status} error=${json.error ?? '-'}`)
check('在用行指向的包**被保留**（原实现会误删的那种）', existsSync(inUseDir) && keptNames.includes('@linxin666/dsh-i18n'), `kept=${JSON.stringify(keptNames)}`)
check('孤儿包（无任何行引用）被删除', !existsSync(orphanDir) && removedNames.includes('@linxin666/dsh-orphan-legacy'))
check('pnpm `_tmp_<pid>_<n>` 中断残留被删除', !existsSync(tmpDir) && removedNames.includes('dsh-something_tmp_25060_12'))
check('`.old-*` 备份目录被删除', !existsSync(oldDir) && removedNames.includes('dsh-web-all.old-1789099537829'))
const snapshotsLeft = readdirSync(consoleDataDir).filter((n) => /^fw-quarantine\.json\.applied-/u.test(n)).sort()
check('quarantine 陈旧快照只保留最近 2 个', snapshotsLeft.length === 2 && snapshotsLeft.join(',') === 'fw-quarantine.json.applied-400,fw-quarantine.json.applied-500', snapshotsLeft.join(','))
check('>7 天的 upgrade-watch 日志被清掉', !existsSync(oldLog))
check('刚生成的 restart-guard 计数**不被清**（未过期）', existsSync(freshCount))
check('删除结果带真实方法（不再只说"环境禁止删除"）', (json.removed ?? []).every((r) => typeof r.method === 'string' && r.method !== ''), JSON.stringify((json.removed ?? []).slice(0, 3)))
check('全部失败项的 error 字段为结构化文本', (json.failed ?? []).every((f) => typeof f.error === 'string' || f.error === null), JSON.stringify(json.failed ?? []))

// 幂等：再清一次不应报错、也没有可删项
const again = await call('POST', '/plugin-console/clean-residuals', {})
check('幂等：二次清理无残余且仍成功', again.json?.ok === true && (again.json?.removed ?? []).length === 0, JSON.stringify(again.json?.removed ?? []))
check('二次清理仍然保留在用插件', existsSync(inUseDir) && (again.json?.kept ?? []).includes('@linxin666/dsh-i18n'))

// 删除器单测：正常树删除成功并回报方法
const { removeDirVerifiedAsync } = await import('../lib/server/infra/fsx.js')
const plainDir = join(HOME, 'plain-tree')
mkdirSync(join(plainDir, 'sub'), { recursive: true })
writeFileSync(join(plainDir, 'sub', 'a.txt'), 'x', 'utf8')
const plainResult = await removeDirVerifiedAsync(plainDir)
check('removeDirVerifiedAsync：普通树删除成功并回报方法', plainResult.ok === true && !existsSync(plainDir) && typeof plainResult.method === 'string', JSON.stringify(plainResult))
// 只读父目录（POSIX 生效）：删除应失败并带**真实原因**，不能假装成功
if (process.platform === 'win32') {
  console.log('SKIP 只读目录删除失败路径（Windows 上只读位不阻止删除）')
} else {
  const { chmodSync } = await import('node:fs')
  const readOnlyParent = join(HOME, 'ro-parent')
  mkdirSync(join(readOnlyParent, 'child'), { recursive: true })
  writeFileSync(join(readOnlyParent, 'child', 'a.txt'), 'x', 'utf8')
  chmodSync(readOnlyParent, 0o500)
  const roResult = await removeDirVerifiedAsync(join(readOnlyParent, 'child'), { attempts: 1, pollMs: 100 })
  check('只读父目录删不掉时：ok=false 且带真实原因（不谎报成功）', roResult.ok === false && typeof roResult.error === 'string' && roResult.error.length > 0, JSON.stringify(roResult))
  chmodSync(readOnlyParent, 0o700)
}

// ── 0.5.26 改错（F7，预存在缺陷）：shell 兜底对**文件**必须用 `del /f /q`，不能对文件用 `rmdir` ──────
// 真机场景：`clean-residuals` 清的陈旧 `fw-quarantine.json.applied-*` 是**文件**；`rmSync` 一次瞬时失败
// 之后走进 shell 兜底，旧代码一律 `rmdir /s /q <path>` —— rmdir 只能删目录，对文件返回
// `exit=267 The directory name is invalid`，于是"其实删得掉的文件"被报成**用户可见的「有 1 项没能删除」**。
{
  const { shellDeleteCommand, removeViaShell, removeViaShellSync } = await import('../lib/server/infra/fsx.js')

  // 判据（唯一真源）：文件 → del；目录 → rmdir；已经不在了 → 视为已达成（不是失败）
  const fileTarget = join(HOME, 'residual-file.json.applied-123')
  writeFileSync(fileTarget, '{}', 'utf8')
  const dirTarget = join(HOME, 'residual-dir')
  mkdirSync(join(dirTarget, 'inner'), { recursive: true })
  const filePlan = shellDeleteCommand(fileTarget)
  const dirPlan = shellDeleteCommand(dirTarget)
  const gonePlan = shellDeleteCommand(join(HOME, 'never-existed'))
  check('★F7 判据：**文件** → `del /f /q`（不再对文件用 rmdir）',
    filePlan.kind === 'file' && filePlan.argv[0] === 'del' && filePlan.argv.includes('/f') && filePlan.argv.includes('/q') && filePlan.argv[filePlan.argv.length - 1] === fileTarget,
    JSON.stringify(filePlan))
  check('★F7 判据：**目录** → 仍用 `rmdir /s /q`（既有能力没被改坏）',
    dirPlan.kind === 'dir' && dirPlan.argv[0] === 'rmdir' && dirPlan.argv.includes('/s') && dirPlan.argv.includes('/q') && dirPlan.method === 'rmdir',
    JSON.stringify(dirPlan))
  check('★F7 判据：目标已不存在 → kind=gone（视为已达成，不报失败）',
    gonePlan.kind === 'gone' && gonePlan.argv === null, JSON.stringify(gonePlan))

  // 真删（本机真 cmd.exe）：文件与目录都必须真的消失，且回报**用的哪条命令**
  if (process.platform === 'win32') {
    const fileGone = await removeViaShell(fileTarget)
    check('★F7 真删文件：ok=true 且 method=del、文件真的消失（旧代码这里是 exit=267 + 假失败）',
      fileGone.ok === true && fileGone.method === 'del' && !existsSync(fileTarget), JSON.stringify(fileGone))
    const dirGone = await removeViaShell(dirTarget)
    check('★F7 真删目录：ok=true 且 method=rmdir、目录真的消失（回归）',
      dirGone.ok === true && dirGone.method === 'rmdir' && !existsSync(dirTarget), JSON.stringify(dirGone))
    const file2 = join(HOME, 'residual-file-2.json.applied-456')
    writeFileSync(file2, '{}', 'utf8')
    const syncGone = removeViaShellSync(file2)
    check('★F7 同步兜底同样按类型选命令（文件 → del）', syncGone.ok === true && syncGone.method === 'del' && !existsSync(file2), JSON.stringify(syncGone))
    const already = await removeViaShell(join(HOME, 'never-existed'))
    check('★F7 目标已不在 → ok=true / method=already-gone（**不是**失败）', already.ok === true && already.method === 'already-gone', JSON.stringify(already))
  } else {
    console.log('SKIP F7 的真删断言（非 win32；判据断言已在上方覆盖）')
  }

  // 端到端：陈旧快照（文件）被清掉且 clean-residuals 不报失败 —— 走的就是上面这条兜底路径
  const snapFile = join(consoleDataDir, 'fw-quarantine.json.applied-100')
  writeFileSync(snapFile, '{}', 'utf8')
  writeFileSync(join(consoleDataDir, 'fw-quarantine.json.applied-200'), '{}', 'utf8')
  const third = await call('POST', '/plugin-console/clean-residuals', {})
  check('★F7 端到端：陈旧快照（文件）真被清掉、failed 为空',
    (third.json?.failed ?? []).length === 0 && !existsSync(snapFile), `failed=${JSON.stringify(third.json?.failed ?? [])} removed=${JSON.stringify((third.json?.removed ?? []).map((r) => r.name))}`)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
