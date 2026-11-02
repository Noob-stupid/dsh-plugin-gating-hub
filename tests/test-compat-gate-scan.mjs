// 门控的「按需检查」（0.5.100 加法）：`POST /compat-gate {action:'scan-current'}`
//
// 用户 2026-11-02 原话：「我们一般情况下都不预检吧」——compat-pending 只在升级前预扫与启动失败
// 隔离时写入，平时门控一条记录都没有，而"0 条"会被误读成"全部兼容"。这个动作让用户随时查一次。
//
// 本套钉死五件事（全离线：隔离 DSH_HOME + 私有 profile 夹具 + 桩框架包，零外网）：
//   ① 真的跑判定并返回统计（检查了几行 / 通过 / 不适配 / 无法判定），跳过项带原因；
//   ② **只把判为不适配（fail）的行写进记录**，记录带 `source: 'manual-scan'`（pass/unknown 只进统计）；
//   ③ ★ **绝不禁用任何行**：扫描前后补丁文件逐字节不变、`patch.disables` 不变；
//   ④ 写盘纪律：坏文件 ⇒ 409 拒绝覆盖且一个字节不改；没有变化 ⇒ 零写盘（幂等）；
//   ⑤ 零行可查 ⇒ 如实说明"没有可检查的行"，不写任何记录。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const statOf = (file) => ({ size: statSync(file).size, mtimeMs: statSync(file).mtimeMs })

/**
 * 起一个独立的宿主（隔离 DSH_HOME + profile 夹具）。
 * @param {string} tag                                                    HOME 目录名（每个场景独立）
 * @param {'full'|'empty'} variant                                        夹具形态
 */
async function bootHost(tag, variant = 'full') {
  const HOME = join(ROOT, '.testdir', `gate-scan-${tag}`)
  process.env.DSH_HOME = HOME
  process.env.DSH_TEST_SKIP_NETWORK = '1'
  rmSync(HOME, { recursive: true, force: true })
  const profileDir = join(HOME, 'profiles', 'web')
  const cpDir = join(HOME, 'plugin-console')
  mkdirSync(cpDir, { recursive: true })
  const write = (rel, obj) => {
    const file = join(profileDir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8')
    return file
  }
  // 桩框架包：`currentFrameworkVersion()` 从 `ctx.baseUrl` 解析 `@deepseek-ai/dsh/package.json`
  write('node_modules/@deepseek-ai/dsh/package.json', { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' })
  write('node_modules/@deepseek-ai/dsh/index.js', 'export default {}\n')
  // 三行判定结论各一种：fail（声明不满足）/ pass（声明满足）/ unknown（无声明）
  write('node_modules/@fake/incompat/package.json', { name: '@fake/incompat', version: '1.0.0', main: 'index.js', dsh: { engines: { framework: '>=9.0.0' } } })
  write('node_modules/@fake/incompat/index.js', 'export default {}\n')
  write('node_modules/@fake/compat/package.json', { name: '@fake/compat', version: '2.0.0', main: 'index.js', dsh: { engines: { framework: '>=0.1.0' } } })
  write('node_modules/@fake/compat/index.js', 'export default {}\n')
  write('node_modules/@fake/unknown/package.json', { name: '@fake/unknown', version: '3.0.0', main: 'index.js' })
  write('node_modules/@fake/unknown/index.js', 'export default {}\n')
  write('package.json', { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: [] } } })
  const patchText = [
    '# gate-scan fixture',
    '- id: disabled-row',
    '  disabled: true',
    '- insert:',
    '    - id: incompat',
    "      name: '@fake/incompat'",
    '    - id: compat',
    "      name: '@fake/compat'",
    '    - id: unknown',
    "      name: '@fake/unknown'",
    '',
  ].join('\n')
  const patchFile = write('cordis.patch.yml', patchText)
  const rows = variant === 'empty'
    ? [{ id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } }]
    : [
        { id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } },
        { id: 'include:incompat', options: { name: '@fake/incompat' }, disabled: false, fiber: { state: 2 } },
        { id: 'include:compat', options: { name: '@fake/compat' }, disabled: false, fiber: { state: 2 } },
        { id: 'include:unknown', options: { name: '@fake/unknown' }, disabled: false, fiber: { state: 2 } },
        { id: 'include:missing-pkg', options: { name: '@fake/not-installed' }, disabled: false, fiber: { state: 2 } },
      ]
  const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
  const ctx = {
    baseUrl: cordisUrl,
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } }, ...rows] },
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
  return { HOME, profileDir, cpDir, patchFile, pendingFile: join(cpDir, 'compat-pending.json'), call, cleanup: () => rmSync(HOME, { recursive: true, force: true }) }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// ═══ ① 真机形态：三行三种结论 ⇒ 统计正确 + 只记录 fail + 绝不禁用 ═══════════════════
{
  const h = await bootHost('full')
  const before = { patch: sha256(h.patchFile), patchStat: statOf(h.patchFile) }
  const st0 = await h.call('GET', '/plugin-console/state')
  check('夹具就绪：/state 里 5 行、补丁 disables 只有 fixture 那条',
    st0.status === 200 && st0.json?.entries?.length === 5 && JSON.stringify(st0.json?.patch?.disables) === JSON.stringify(['disabled-row']),
    `entries=${st0.json?.entries?.length} disables=${JSON.stringify(st0.json?.patch?.disables)}`)

  const r = await h.call('POST', '/plugin-console/compat-gate', { action: 'scan-current' })
  check('★ POST /compat-gate {action:scan-current} → 200 且 ok', r.status === 200 && r.json?.ok === true, `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 200)}`)
  check('★ 统计：检查 3 行 / 通过 1 / 不适配 1 / 无法判定 1',
    r.json?.checked === 3 && r.json?.pass === 1 && r.json?.fail === 1 && r.json?.unknown === 1,
    `checked=${r.json?.checked} pass=${r.json?.pass} fail=${r.json?.fail} unknown=${r.json?.unknown}`)
  check('跳过项带原因：已装的 missing 包 + 控制台自己',
    Array.isArray(r.json?.skipped)
    && r.json.skipped.some((s) => s.reason === 'package-unreadable' && s.rowId === 'missing-pkg')
    && r.json.skipped.some((s) => s.reason === 'console-self'),
    JSON.stringify(r.json?.skipped))
  check('★ 只记录不适配的那一行（recorded=1，pass/unknown 不进记录）',
    r.json?.recorded === 1 && JSON.stringify(r.json?.added) === JSON.stringify(['incompat']),
    `recorded=${r.json?.recorded} added=${JSON.stringify(r.json?.added)}`)
  check('写盘核实通过（verified:true，不是"写完就报成功"）', r.json?.verified === true, `verified=${r.json?.verified}`)

  const saved = readJson(h.pendingFile)
  const rec = (saved.pending ?? []).find((p) => p.rowId === 'incompat') ?? null
  check('★ 记录带来源 `manual-scan`（面板/日志能区分是谁裁决的）', rec?.source === 'manual-scan', String(rec?.source))
  check('记录内容：status=pending / check=fail / 值得看的 checkNote',
    rec?.status === 'pending' && rec?.check === 'fail' && typeof rec?.checkNote === 'string' && rec.checkNote.includes('>=9.0.0'),
    JSON.stringify(rec)?.slice(0, 220))
  check('记录带判据戳（这次用的就是当前判据，不会被当成过期结论重算）',
    rec?.scanVerdict?.decision === 'fail' && typeof rec?.scanVerdict?.version === 'string', JSON.stringify(rec?.scanVerdict))
  check('★ lastScan 摘要落盘（面板据此说"上次查了几个/结果如何"）',
    saved?.lastScan?.checked === 3 && saved?.lastScan?.fail === 1 && saved?.lastScan?.source === 'manual-scan',
    JSON.stringify(saved?.lastScan))
  check('通过/无法判定的行**没有**被写成记录',
    (saved.pending ?? []).length === 1 && !(saved.pending ?? []).some((p) => p.rowId === 'compat' || p.rowId === 'unknown'),
    JSON.stringify((saved.pending ?? []).map((p) => p.rowId)))

  check('★★ 绝不禁用：补丁文件逐字节不变（含 mtime）',
    sha256(h.patchFile) === before.patch && statOf(h.patchFile).mtimeMs === before.patchStat.mtimeMs,
    `patch=${sha256(h.patchFile).slice(0, 8)}`)
  const st1 = await h.call('GET', '/plugin-console/state')
  check('★★ 绝不禁用：/state 的 patch.disables 一条没变',
    JSON.stringify(st1.json?.patch?.disables) === JSON.stringify(['disabled-row']),
    JSON.stringify(st1.json?.patch?.disables))
  check('★★ 绝不禁用：补丁里没有为该行新写 disabled 块',
    !/^- id: incompat\s*$/mu.test(readFileSync(h.patchFile, 'utf8')))
  check('面板拿到 lastScan（/state 的 compatPending.lastScan，只增字段）',
    st1.json?.compatPending?.lastScan?.checked === 3, JSON.stringify(st1.json?.compatPending?.lastScan))
  check('既有字段没被改坏：/state 仍带 actionableCount / staleCount（扫描记录里那行是真待适配=1）',
    st1.json?.compatPending?.actionableCount === 1 && st1.json?.compatPending?.staleCount === 0,
    `actionable=${st1.json?.compatPending?.actionableCount} stale=${st1.json?.compatPending?.staleCount}`)

  // ② 幂等：再查一次，记录没变 ⇒ 零写盘
  const shaBefore = sha256(h.pendingFile)
  const again = await h.call('POST', '/plugin-console/compat-gate', { action: 'scan-current' })
  check('★ 幂等：第二次扫描 changed:false 且零写盘',
    again.status === 200 && again.json?.changed === false && sha256(h.pendingFile) === shaBefore,
    `changed=${again.json?.changed} sha=${sha256(h.pendingFile).slice(0, 8)}`)
  h.cleanup()
}

// ═══ ③ 坏文件：拒绝覆盖，一个字节不改（扫描统计照样如实回）════════════════════════════
{
  const h = await bootHost('corrupt')
  const broken = '{ 这不是 JSON '
  writeFileSync(h.pendingFile, broken, 'utf8')
  const before = { sha: sha256(h.pendingFile), stat: statOf(h.pendingFile), patch: sha256(h.patchFile) }
  const r = await h.call('POST', '/plugin-console/compat-gate', { action: 'scan-current' })
  check('★ 坏记录文件 ⇒ 409 + 明确原因（绝不覆盖用户文件）',
    r.status === 409 && r.json?.ok === false && String(r.json?.error ?? '').includes('没有写盘'),
    `status=${r.status} error=${String(r.json?.error).slice(0, 120)}`)
  check('★ 坏文件一个字节都没被改写', sha256(h.pendingFile) === before.sha && statOf(h.pendingFile).mtimeMs === before.stat.mtimeMs)
  check('扫描统计仍然如实回报（用户至少知道"现在查出来是什么"）',
    r.json?.details?.checked === 3 && r.json?.details?.fail === 1, JSON.stringify(r.json?.details)?.slice(0, 160))
  check('坏文件场景下补丁也没被动过', sha256(h.patchFile) === before.patch)
  h.cleanup()
}

// ═══ ④ 零行可查：如实说明 + 不写任何记录 ═════════════════════════════════════════
{
  const h = await bootHost('empty', 'empty')
  const r = await h.call('POST', '/plugin-console/compat-gate', { action: 'scan-current' })
  check('★ 零行可查 ⇒ 200 + checked:0 + 说明"没有可检查的行"',
    r.status === 200 && r.json?.checked === 0 && String(r.json?.note ?? '').includes('没有可检查的行'),
    `checked=${r.json?.checked} note=${r.json?.note}`)
  check('★ 零行可查时**不写**记录文件', r.json?.changed === false && !(() => { try { statSync(h.pendingFile); return true } catch { return false } })(),
    `changed=${r.json?.changed}`)
  h.cleanup()
}

// ═══ ⑤ 既有契约零变化：不带 action 的 /compat-gate 仍是总开关 ══════════════════════
{
  const h = await bootHost('contract')
  const r = await h.call('POST', '/plugin-console/compat-gate', {})
  check('POST /compat-gate {} 仍是 {ok, compatGate}（响应逐字段不变）',
    r.status === 200 && JSON.stringify(Object.keys(r.json ?? {}).sort()) === JSON.stringify(['compatGate', 'ok']),
    `status=${r.status} keys=${Object.keys(r.json ?? {}).join(',')}`)
  const unknown = await h.call('POST', '/plugin-console/compat-gate', { action: 'nope' })
  check('未知 action 仍 400（不落到总开关分支）', unknown.status === 400 && unknown.json?.ok === false, `status=${unknown.status}`)
  h.cleanup()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
