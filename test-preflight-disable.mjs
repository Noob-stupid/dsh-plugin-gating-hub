// 框架升级「前置禁用」门禁测试（用户硬要求：更新框架后所有不适配的必须先禁用）。
// 背景：#18 事故暴露适配门只有「执行侧」（读清单→锁启用→更新后解锁），检测侧从未实现——
// compat-pending.json 一直是人工产物。本测试验证新增的检测侧：
//   1) 判定 fail 的启用行 → 就地写 disabled:true 块 + 记入 compat-pending
//   2) 兼容的行不动（避免过度禁用把功能砍掉）
//   3) 受保护/核心行不碰（禁它们本身会让服务起不来），并记入 skipped
//   4) 控制台自身永不禁用
//   5) 已禁用的行不重复处理；重复执行幂等（不产生重复禁用块）
// 另测启动失败日志分析器（真实事故日志文本）。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'preflight-home')
process.env.DSH_HOME = HOME // 必须在 import 前设置（模块顶层常量按 DSH_HOME 求值）

rmSync(HOME, { recursive: true, force: true })
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@fake', 'incompatible'), { recursive: true })
mkdirSync(join(profileDir, 'node_modules', '@fake', 'fine'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# user patch\n', 'utf8')

// 不适配包：源码引用 0.1.2 起已删除的 dsh-settings API（适配门的硬判据）
writeFileSync(join(profileDir, 'node_modules', '@fake', 'incompatible', 'package.json'), JSON.stringify({
  name: '@fake/incompatible', version: '1.0.0', main: 'index.js',
  dsh: { engines: { framework: '>=0.1.0-rc.6' } },
}, null, 2), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'incompatible', 'index.js'),
  'import { installSettingsSection } from "@deepseek-ai/dsh-client-ui-settings";\nexport const x = installSettingsSection;\n', 'utf8')

// 正常包：干净源码
writeFileSync(join(profileDir, 'node_modules', '@fake', 'fine', 'package.json'), JSON.stringify({
  name: '@fake/fine', version: '2.0.0', main: 'index.js', dsh: { engines: { framework: '>=0.1.0-rc.6' } },
}, null, 2), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'fine', 'index.js'), 'export const ok = true;\n', 'utf8')

const ctx = {
  baseUrl: 'file:///' + profileDir.replace(/\\/gu, '/'),
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true } },
      { id: 'include:include', options: { name: 'cordis:include' } },
      { id: 'include:bad-plugin', options: { name: '@fake/incompatible' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:good-plugin', options: { name: '@fake/fine' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:webserver', options: { name: '@deepseek-ai/dsh-host-webserver' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:already-off', options: { name: '@fake/fine' }, disabled: true, fiber: undefined },
    ],
  },
  webServer: { register: () => () => {} },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}

const { preflightDisableIncompatible } = await import('./lib/server/domain/framework.js')
  const { analyzeBootFailure } = await import('./lib/server/domain/quarantine.js')
const patchPath = join(profileDir, 'cordis.patch.yml')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const res = await preflightDisableIncompatible({ ports: ctx, profileDir, patchPath, targetVersion: '0.1.5-rc.1' })
const patch = readFileSync(patchPath, 'utf8')

check('不适配行被禁用', res.disabled.some((d) => d.rowId === 'bad-plugin'), JSON.stringify(res.disabled.map((d) => d.rowId)))
check('补丁里出现 bad-plugin 的禁用块', /- id: bad-plugin\r?\n {2}disabled: true/u.test(patch))
check('兼容行未被禁用', !/good-plugin/u.test(patch))
check('核心/受保护行未被禁用', !/webserver/u.test(patch) && res.skipped.some((s) => s.rowId === 'webserver'))
check('控制台自身未被禁用', !/plugin-console/u.test(patch))
check('已禁用行被跳过（不重复处理）', !res.disabled.some((d) => d.rowId === 'already-off'))

const pending = JSON.parse(readFileSync(join(HOME, 'plugin-console', 'compat-pending.json'), 'utf8'))
const rec = (pending.pending ?? []).find((p) => p.rowId === 'bad-plugin')
check('写入 compat-pending（status=pending / check=fail）', rec !== undefined && rec.status === 'pending' && rec.check === 'fail', JSON.stringify(rec)?.slice(0, 160))
check('记录标记来源为前置门禁', rec?.source === 'preflight-disabled-before-upgrade')
check('frameworkVersion 记为升级目标', pending.frameworkVersion === '0.1.5-rc.1', pending.frameworkVersion)

// 幂等：再跑一次不应产生第二个禁用块
await preflightDisableIncompatible({ ports: ctx, profileDir, patchPath, targetVersion: '0.1.5-rc.1' })
const patch2 = readFileSync(patchPath, 'utf8')
check('幂等（禁用块不重复）', (patch2.match(/- id: bad-plugin/gu) ?? []).length === 1, `出现 ${(patch2.match(/- id: bad-plugin/gu) ?? []).length} 次`)

// 日志分析器：用 2026-09-10 事故的真实日志文本
const realLog = `
2026-09-11 10:00:00 resume failed for session "session-d5d540e7": RemoteError: agent-presets: preset "router-spec" failed to mount: failed to apply loader entry persona (@deepseek-ai/dsh-persona): invalid config: - $.prefix missing required value (at prefix) (C:\\Users\\花火\\.dsh\\.agent-presets\\router-spec\\agent.cordis.yml) (gateway/internal)
2026-09-11 10:00:01 Error: plugin tree failed to load
2026-09-11 10:00:02 Cannot find module '@linxin666/dsh-web-all/plugin-manager'
2026-09-11 10:00:03 failed to apply loader entry web-ui-liangshen (@linxin666/dsh-web-all/liangshen)
`
const analyzed = analyzeBootFailure(realLog)
check('分析器提取出预设名', analyzed.presets.includes('router-spec'), JSON.stringify(analyzed.presets))
check('分析器提取出 loader 条目行 id', analyzed.modules.some((m) => m.rowId === 'persona' && m.moduleName === '@deepseek-ai/dsh-persona'), JSON.stringify(analyzed.modules))
check('分析器提取出缺失模块', analyzed.modules.some((m) => m.moduleName === '@linxin666/dsh-web-all/plugin-manager'))
check('分析器提取出第二个 loader 条目', analyzed.modules.some((m) => m.rowId === 'web-ui-liangshen'))
check('分析器保留命中行用于展示', analyzed.lines.length >= 3, `${analyzed.lines.length} 行`)
check('分析器对正常日志返回空', analyzeBootFailure('all good\nno errors here').presets.length === 0 && analyzeBootFailure('all good').modules.length === 0)

// ── 启动失败隔离决策器（planQuarantine）──────────────────────────────────────
const { planQuarantine } = await import('./lib/server/domain/quarantine.js')
const candidates = [
  { rowId: 'bad-plugin', moduleName: '@fake/incompatible', toggleable: true, enabled: true },
  { rowId: 'webserver', moduleName: '@deepseek-ai/dsh-host-webserver', toggleable: false, enabled: true },
  { rowId: 'plugin-console', moduleName: '@noob-stupid/dsh-plugin-console', toggleable: false, enabled: true },
]

// 场景 1：日志点到第三方插件行 → 禁用该行（不隔离预设、不进安全模式）
const plan1 = planQuarantine({
  logText: "failed to apply loader entry bad-plugin (@fake/incompatible): boom",
  candidates,
  presetRoot: join(HOME, '.agent-presets'),
  exists: () => false,
})
check('决策器：定位到第三方行', plan1.rows.length === 1 && plan1.rows[0] === 'bad-plugin', JSON.stringify(plan1.rows))
check('决策器：有明确肇事者时不进安全模式', plan1.safeMode === false)

// 场景 2：日志点到预设 → 隔离预设文件（真实事故形态）
mkdirSync(join(HOME, '.agent-presets', 'router-spec'), { recursive: true })
const presetFile = join(HOME, '.agent-presets', 'router-spec', 'agent.cordis.yml')
writeFileSync(presetFile, '- id: persona\n', 'utf8')
const plan2 = planQuarantine({
  logText: 'preset "router-spec" failed to mount: invalid config (C:\\x\\.agent-presets\\router-spec\\agent.cordis.yml)',
  candidates,
  presetRoot: join(HOME, '.agent-presets'),
})
check('决策器：识别出要隔离的预设', plan2.presets.length === 1 && plan2.presets[0].name === 'router-spec', JSON.stringify(plan2.presets))
check('决策器：预设文件存在标记正确', plan2.presets[0].exists === true)
check('决策器：仅预设问题时也不进安全模式', plan2.safeMode === false)

// 场景 3：命中的是核心行 → 不动它（正确动作是回滚框架）
const plan3 = planQuarantine({
  logText: "failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): cannot start",
  candidates,
  presetRoot: join(HOME, '.agent-presets'),
  exists: () => false,
})
check('决策器：核心行只记录不隔离', plan3.rows.length === 0 && plan3.coreHits.some((c) => c.rowId === 'webserver'), JSON.stringify(plan3.coreHits))

// 场景 4：日志里没有可用线索 → 建议安全模式（先让服务起来）
const plan4 = planQuarantine({ logText: 'something exploded with no module name', candidates, presetRoot: join(HOME, '.agent-presets'), exists: () => false })
check('决策器：无线索时建议安全模式', plan4.safeMode === true)

// 场景 5：日志提到未安装/未知模块 → 记入 unknown，不误禁
const plan5 = planQuarantine({ logText: "Cannot find module 'some-unknown-pkg'", candidates, presetRoot: join(HOME, '.agent-presets'), exists: () => false })
check('决策器：未知模块进 unknown 不误禁', plan5.unknown.includes('some-unknown-pkg') && plan5.rows.length === 0, JSON.stringify(plan5.unknown))

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
