// 客户端作用域回归钉子（0.5.59 加法）。
//
// 真机事故（2026-10-17）：我在**主面板**（PluginConsoleTab）里写了一句
//   fill(t("healthSummary"), [["n", String(state.data.health.issues)]])
// 而 `fill` 是 **PluginSafetyTab 的局部函数** ⇒ 渲染第一帧抛 `ReferenceError: fill is not defined`
// ⇒ 整块「插件管理」面板**空白**。服务端 `/state` 一切正常（200 / 233 条目），
//   所以从数据侧完全看不出问题 —— 这类 bug 只能靠"作用域"这条钉子钉住。
//
// 本套钉的就是这一件事：**主面板不许用只属于某个子组件的局部辅助函数**。
//   · `fill` 只允许出现在 PluginSafetyTab 的代码区间内；
//   · `fill` 必须且只能定义一次；
//   · 顺带钉住 PluginConsoleTab / PluginSafetyTab 两个组件都还在（防止有人整段误删）。
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
const lines = SRC.split('\n')

const lineOf = (re) => {
  const i = lines.findIndex((l) => re.test(l))
  return i < 0 ? -1 : i + 1
}

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

const mainStart = lineOf(/^\s*function PluginConsoleTab\(/)
const safetyStart = lineOf(/^\s*function PluginSafetyTab\(/)
const applyStart = lineOf(/^\s*function apply\(ctx\)/)

check('两个组件与 apply 都还在（防整段误删）', () => {
  assert.ok(mainStart > 0, 'PluginConsoleTab 未找到')
  assert.ok(safetyStart > 0, 'PluginSafetyTab 未找到')
  assert.ok(applyStart > safetyStart, `apply 应在两个组件之后，实际 L${applyStart}`)
  assert.ok(safetyStart > mainStart, 'PluginSafetyTab 应在 PluginConsoleTab 之后')
})

check('★ fill 只定义一次', () => {
  const defs = lines.map((l, i) => ({ l, n: i + 1 })).filter((x) => /const fill = \(|function fill\(/.test(x.l))
  assert.equal(defs.length, 1, `期望 1 处定义，实际 ${defs.length}：${defs.map((d) => 'L' + d.n).join(', ')}`)
})

check('★★ 主面板（PluginConsoleTab）区间内**不许**出现 fill( —— 本次真机事故的根因', () => {
  const bad = []
  for (let n = mainStart; n < safetyStart; n += 1) {
    const line = lines[n - 1]
    if (/^\s*\/\//.test(line)) continue // 注释里提到不算
    if (/\bfill\(/.test(line)) bad.push(`L${n}: ${line.trim().slice(0, 90)}`)
  }
  assert.equal(bad.length, 0, `主面板里出现了只属于 safety tab 的 fill()：\n       ${bad.join('\n       ')}`)
})

check('fill 的定义确实落在 PluginSafetyTab 区间内（与上一条互补）', () => {
  const defLine = lineOf(/const fill = \(/)
  assert.ok(defLine > safetyStart && defLine < applyStart, `fill 定义在 L${defLine}，不在 safety tab 区间 (${safetyStart}..${applyStart})`)
})

check('主面板里出现的重渲染触发函数（refresh）确有定义（同类越界的最小钉子）', () => {
  const useInMain = []
  for (let n = mainStart; n < safetyStart; n += 1) {
    const line = lines[n - 1]
    if (/^\s*\/\//.test(line)) continue
    if (/\brefresh\(\)/.test(line)) useInMain.push(n)
  }
  if (useInMain.length > 0) {
    const def = lineOf(/const refresh = react\.useCallback/)
    assert.ok(def > 0 && def < safetyStart, `主面板用了 refresh() 但定义不在主面板内（定义 L${def}）`)
  }
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
