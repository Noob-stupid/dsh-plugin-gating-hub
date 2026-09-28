// 本地补丁：从 @linxin666/dsh-web-all 的 lib/client.js 中移除「插件管理」tab 注册。
// 背景 2026-09-04：web-ui-plugin-manager 行被停用后，该 tab 的后端通道不可用，
// 而 web-all 客户端是无条件注册此 tab（无行态门控），点开会报「操作失败：load」。
// 等待上游 0.3.15 提供行态门控后删除本补丁（并恢复该行的启用位）。
// 用法：node hide-web-all-plugin-manager-tab.mjs [目标client.js路径]
//   （默认 <DSH_HOME 或 ~/.dsh>/profiles/web/node_modules/@linxin666/dsh-web-all/lib/client.js）
// 幂等：已打过补丁则直接退出；找不到注入块或边界不符则报错退出，绝不盲改。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 默认值由用户目录派生（DSH_HOME 优先，与 host 端 dshHome() 同一判据）——不写死任何机器路径。
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const target = process.argv[2]
  ?? join(dshHome, 'profiles', 'web', 'node_modules', '@linxin666', 'dsh-web-all', 'lib', 'client.js')
const START = 'ctx.slots.inject("settings.plugins.tab"'
const REGISTER_MARK = '}, PluginManagerTab);'
const END = '});' // 锚点：register 调用之后出现的第一个 `});` = inject 箭头调用自身的闭合
const COMMENT = `// [LOCAL PATCH 2026-09-04] family plugin-manager tab hidden locally.
// Reason: web-ui-plugin-manager row disabled -> its backend channels are gone, but web-all
// client registers this tab unconditionally (no row-state gate), clicking shows load error.
// Waiting for upstream row-state gating (0.3.15); remove this patch then.
// Original registration (disabled): ctx.slots.inject(name, () => register({...}, PluginManagerTab))
`

if (!existsSync(target)) { console.error('target not found:', target); process.exit(1) }
const text = readFileSync(target, 'utf8')
if (text.includes('[LOCAL PATCH 2026-09-04]')) { console.log('patch already applied; nothing to do'); process.exit(0) }
const start = text.indexOf(START)
if (start < 0) { console.error('inject call not found — bundle changed? aborting without touching the file'); process.exit(1) }
const endRel = text.indexOf(END, start)
if (endRel < 0) { console.error('inject close not found — aborting'); process.exit(1) }
const end = endRel + END.length
const block = text.slice(start, end)
if (!block.includes('PluginManagerTab') || block.includes('//#endregion')) {
  console.error('block mismatch — aborting; block head:', JSON.stringify(block.slice(0, 60)))
  process.exit(1)
}
// 真实结构：inject 的 `});` 之后是 `}`（apply$14 函数闭）再 //#endregion
const after = text.slice(end).replace(/^[\s]*/u, '')
if (!after.startsWith('}') || !after.slice(0, 60).includes('//#endregion')) {
  console.error('boundary mismatch — aborting; after-block head:', JSON.stringify(after.slice(0, 60)))
  process.exit(1)
}
const next = text.replace(block, COMMENT)
if (next === text) { console.error('replace no-op'); process.exit(1) }
writeFileSync(target, next, 'utf8')
console.log('patched ok: removed block =', Buffer.byteLength(block, 'utf8'), 'bytes; new size =', Buffer.byteLength(next, 'utf8'), 'bytes')
