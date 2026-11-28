// 80-tool scale/relevance check for the policy layer (no host required, runs in CI).
import { strict as assert } from 'node:assert'
import { selectActiveTools } from '../lib/server/agent/policy.js'

function catalog() {
  const map = new Map()
  for (let i = 0; i < 80; i += 1) {
    map.set(`tool_${i}`, {
      name: `tool_${i}`,
      description: i === 7 ? 'Query a database and return rows' : `Generic tool number ${i}`,
      parameters: { type: 'object', properties: {} },
    })
  }
  for (const name of ['plugin_console_tool_search', 'plugin_console_tool_activate']) {
    map.set(name, { name, description: 'governance tool', parameters: { type: 'object', properties: {} } })
  }
  return map
}

const items = catalog()
const base = ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4']
const selected = selectActiveTools({
  available: items,
  governanceTools: ['plugin_console_tool_search', 'plugin_console_tool_activate'],
  baselineTools: base,
  maxActiveTools: 12,
  taskText: 'query the database',
})
assert.ok(selected.length <= 12, `visible=${selected.length}`)
assert.ok(selected.includes('tool_7'), `database tool missing: ${selected.join(',')}`)
assert.ok(selected.includes('plugin_console_tool_search'))
assert.ok(!selected.includes('tool_50'), `zero-score tool filled the cap: ${selected.join(',')}`)
assert.ok(selected.length <= base.length + 1 + 2, `unexpected fill: ${selected.join(',')}`)

const noTask = selectActiveTools({
  available: items,
  governanceTools: ['plugin_console_tool_search', 'plugin_console_tool_activate'],
  baselineTools: base,
  maxActiveTools: 12,
  taskText: '',
})
assert.deepEqual(noTask.sort(), ['plugin_console_tool_activate', 'plugin_console_tool_search', ...base].sort())

console.log('PASS ① 80 工具下 active ≤ 12')
console.log('PASS ② 任务相关工具（database）被选中')
console.log('PASS ③ 零分工具不再按字母序塞满上限')
console.log('PASS ④ 无任务文本时只保留 baseline + 治理工具')
console.log('\nALL PASS')
