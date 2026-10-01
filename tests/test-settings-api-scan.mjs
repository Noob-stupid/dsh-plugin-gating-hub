// 0.5.33 改错：已删除 dsh-settings API 的扫描判据（真机误报 → 好插件被误判不兼容 → 误禁）
//
// 现症（诊断已到行号，证据充分）：`dshmarket` 被判 `check:'fail'`，于是框架升级预扫会把它
// **自动禁用**。逐条核对它的命中：
//   · dshmarket/lib/settings.js:45 / :53 / :73 —— 三处全在**注释**里；
//   · dshmarket/lib/routes.js:3136 `settingsNamespace: settingsNamespaceState(),` ——
//     一个 **HTTP 载荷对象的属性名**（值是该包自己的局部函数）；
//   · 该包对 `@deepseek-ai/dsh-settings` 的 **import 零命中**（它早已内联那两个 helper）。
// 旧判据（标识符边界 + 排除局部定义）挡不住这两类：注释里的名字与对象键上的名字都不是"引用"，
// 却都在代码行上、也不是本地定义。
//
// 本套钉死四条 —— ③ 是「**不许放松**」的反向断言（门禁不许被这次修复修软）：
//   ① 纯注释命中 → 不报
//   ② 对象属性名 → 不报
//   ③ 真实 `import { settingsNamespace } from '@deepseek-ai/dsh-settings'` → **仍报**
//   ④ `dshmarket` 当前**已装源码**复现 → 0 命中（本机没有该包时**响亮 SKIP**，不假装 PASS）
// 另加一组边界（注释掉的真 import 不算、别的包的同名导入不算、字符串里的不算、
// 前缀巧合不算、局部同名定义不算；require 解构 / 命名空间成员访问 / 别名导入都算）。
//
// 全离线：只读本机已装源码（路径由 dshHome() 派生，**无任何本机绝对路径/用户名**）。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// 路径基线走仓库既有 infra（DSH_HOME 或 homedir()/.dsh）——测试里同样不写死本机路径
import { dshHome } from '../lib/server/infra/paths.js'
import { scanSettingsApiUsage, settingsApiReferences, referencesRemovedSymbol, maskLiterals } from '../lib/server/domain/settings-api-scan.js'

let failed = 0
let skipped = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const skip = (label, why) => { skipped += 1; console.log(`SKIP ${label} — ${why}`) }
const hits = (src) => settingsApiReferences(src)

console.log('=== ① 纯注释命中 → 不报（dshmarket/lib/settings.js 形态）===')
{
  const src = [
    "// NOTE: settingsNamespace was removed from @deepseek-ai/dsh-settings in 0.1.2-rc.1",
    '/**',
    ' * installSettingsSection 同理：0.1.2 起官方删除，改用 ctx.get("settings")。',
    ' */',
    'export const ok = true',
  ].join('\n')
  check('① 注释里的 settingsNamespace / installSettingsSection 都不算引用', hits(src).length === 0, JSON.stringify(hits(src)))
  check('① 掩码保留换行（行号不漂移）', maskLiterals(src, true).split('\n').length === src.split('\n').length)
}

console.log('\n=== ② 对象属性名 → 不报（dshmarket/lib/routes.js:3136 形态）===')
{
  const src = [
    'function settingsNamespaceState() { return { tenant: "x" } }',
    'export function buildPayload() {',
    '  return {',
    '    kind: "fetch",',
    '    settingsNamespace: settingsNamespaceState(),',
    '  }',
    '}',
  ].join('\n')
  check('② 对象键 settingsNamespace（值是自己的局部函数）不算引用', hits(src).length === 0, JSON.stringify(hits(src)))
  check('② 局部同名定义也不算引用（旧判据的既有语义不许丢）',
    hits('const settingsNamespace = (x) => x\nexport default settingsNamespace\n').length === 0)
  check('② 前缀巧合（settingsNamespaceRequestSchema）依旧不算',
    hits('const settingsNamespaceRequestSchema = { ns: 1 }\nexport const p = settingsNamespaceRequestSchema\n').length === 0)
}

console.log('\n=== ③ 真实 import/require 绑定 → 仍报（门禁不许被修软）===')
{
  const esm = "import { settingsNamespace } from '@deepseek-ai/dsh-settings'\nexport const api = settingsNamespace\n"
  check('③ ESM 具名导入 settingsNamespace → 命中', hits(esm).includes('settingsNamespace'), JSON.stringify(hits(esm)))
  check('③ referencesRemovedSymbol(esm, "settingsNamespace") === true（对外契约不变）', referencesRemovedSymbol(esm, 'settingsNamespace') === true)

  const cjs = "const { installSettingsSection } = require('@deepseek-ai/dsh-settings')\nmodule.exports = installSettingsSection\n"
  check('③ CJS 解构 require installSettingsSection → 命中', hits(cjs).includes('installSettingsSection'), JSON.stringify(hits(cjs)))

  const ns = "import * as s from '@deepseek-ai/dsh-settings'\nexport const a = s.settingsNamespace\n"
  check('③ 命名空间成员访问 s.settingsNamespace → 命中', hits(ns).includes('settingsNamespace'), JSON.stringify(hits(ns)))

  const alias = "import { settingsNamespace as sn } from '@deepseek-ai/dsh-settings'\nexport const a = sn\n"
  check('③ 别名导入（settingsNamespace as sn）→ 仍按导入名命中', hits(alias).includes('settingsNamespace'), JSON.stringify(hits(alias)))

  const dyn = "const { installSettingsSection } = await import('@deepseek-ai/dsh-settings')\nexport default installSettingsSection\n"
  check('③ 动态 import() 解构 → 命中', hits(dyn).includes('installSettingsSection'), JSON.stringify(hits(dyn)))

  const multi = "import { a } from './a.js'\nimport { installSettingsSection } from '@deepseek-ai/dsh-settings'\n"
  check('③ 上一条 import 的绑定子句不许被并进来（installSettingsSection 命中、a 不算）',
    hits(multi).includes('installSettingsSection'))

  // 反向：真 import 被注释掉 / 写在字符串里 → 不算（这正是本次修复的核心）
  check('③ 被注释掉的真 import 不算引用',
    hits("// import { settingsNamespace } from '@deepseek-ai/dsh-settings'\n").length === 0)
  check('③ 字符串里出现的 import 文本不算引用',
    hits('export const doc = "import { settingsNamespace } from \'@deepseek-ai/dsh-settings\'"\n').length === 0)
  check('③ 别的包的同名导入不算引用',
    hits("import { settingsNamespace } from './local.js'\nexport default settingsNamespace\n").length === 0)
}

console.log('\n=== ③′ 真机上的真载体（@morlay/session-rdb）→ 仍报（不许放松的实时证据）===')
{
  // 本机翻出来的真实样本：`@morlay/session-rdb/lib/index.mjs:3`
  //   import { settingsNamespace } from "@deepseek-ai/dsh-settings";
  // 并在 1751 行真的调用它 —— 这正是适配门要拦的那一类。它必须继续被判命中，
  // 否则这次修复就成了"把误报和真报一起关掉"。
  const profilesDir = join(dshHome(), 'profiles')
  const found = []
  if (existsSync(profilesDir)) {
    for (const name of readdirSync(profilesDir)) {
      const dir = join(profilesDir, name, 'node_modules', '@morlay', 'session-rdb')
      if (existsSync(join(dir, 'package.json'))) found.push(dir)
    }
  }
  if (found.length === 0) {
    skip('③′ @morlay/session-rdb 真载体复现', `本机没有已安装的 @morlay/session-rdb（DSH_HOME=${dshHome()}）`)
  } else {
    for (const dir of found) {
      const hits2 = scanSettingsApiUsage(dir)
      check(`③′ ${dir.replace(dshHome(), '$DSH_HOME')} → 命中 settingsNamespace（真载体不许被修软）`,
        hits2.includes('settingsNamespace'), JSON.stringify(hits2))
    }
  }
}

console.log('\n=== ④ dshmarket 当前已装源码复现 → 0 命中 ===')
{
  const profilesDir = join(dshHome(), 'profiles')
  const candidates = []
  if (existsSync(profilesDir)) {
    for (const name of readdirSync(profilesDir)) {
      candidates.push(join(profilesDir, name, 'node_modules', 'dshmarket'))
      candidates.push(join(profilesDir, name, 'node_modules', 'dshmarket', 'package.json').replace(/[\\/]package\.json$/u, ''))
    }
  }
  candidates.push(join(dshHome(), 'node_modules', 'dshmarket'))
  const real = candidates.find((p) => existsSync(join(p, 'package.json')))
  if (real === undefined) {
    skip('④ dshmarket 已装源码复现', `本机没有已安装的 dshmarket（DSH_HOME=${dshHome()}）—— 没有夹具就不假装 PASS`)
  } else {
    const version = (() => { try { return JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')).version ?? '?' } catch { return '?' } })()
    const found = scanSettingsApiUsage(real)
    check(`④ dshmarket@${version}（${real.replace(dshHome(), '$DSH_HOME')}）扫描 0 命中`, found.length === 0, JSON.stringify(found))
    // 佐证这个复现**真的**压在误报形态上：数一数原始文本里还有多少处裸名字
    let raw = 0
    let files = 0
    const walk = (dir, depth) => {
      if (depth > 3 || files > 120) return
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
          walk(full, depth + 1)
          continue
        }
        if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/u.test(entry.name)) continue
        files += 1
        try { raw += (readFileSync(full, 'utf8').match(/settingsNamespace|installSettingsSection/gu) ?? []).length } catch {}
      }
    }
    walk(real, 0)
    if (raw === 0) {
      skip('④ 误报形态复现佐证', '已装源码里已经没有裸名字（上游改过）—— 该夹具不再压在误报路径上，如实说明')
    } else {
      check(`④ 夹具仍压在误报形态上（原始文本 ${raw} 处裸名字，扫描 0 命中）`, raw > 0)
    }
  }
}

console.log(failed === 0 ? `\nALL PASS${skipped > 0 ? `（${skipped} 条 SKIP，原因见上）` : ''}` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
