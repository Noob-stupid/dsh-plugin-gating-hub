// Schema/context-cost benchmark for the governance policy (no model calls).
// This is a deterministic proxy for "how much tool schema is sent": 80 realistic
// tools vs the bounded active set. It does not claim model accuracy improvement.
import { strict as assert } from 'node:assert'
import { buildCatalog, schemaBytes } from '../lib/server/agent/catalog.js'
import { selectActiveTools } from '../lib/server/agent/policy.js'

const items = []
for (let i = 0; i < 80; i += 1) {
  const name = `svc_${i}_${i === 45 ? 'search_docs' : 'op'}`
  items.push({
    name,
    description: i === 45 ? 'Search project documentation and return matching pages' : `Service operation ${i} for workspace resource ${i}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Resource identifier' },
        query: { type: 'string', description: 'Optional query text' },
        limit: { type: 'integer', description: 'Maximum rows' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        include: { type: 'array', items: { type: 'string' }, description: 'Fields to include' },
        dryRun: { type: 'boolean', description: 'Preview only' },
      },
    },
  })
}
const catalog = buildCatalog(items)
const base = ['svc_0_op', 'svc_1_op', 'svc_2_op', 'svc_3_op', 'svc_4_op']
const beforeBytes = [...catalog.values()].reduce((sum, item) => sum + item.schemaBytes, 0)
const active = selectActiveTools({
  available: catalog,
  governanceTools: ['plugin_console_tool_search', 'plugin_console_tool_activate'],
  baselineTools: base,
  maxActiveTools: 12,
  taskText: 'search documentation',
})
const afterBytes = active.reduce((sum, name) => sum + (catalog.get(name)?.schemaBytes ?? 0), 0)
const reduction = beforeBytes === 0 ? 0 : Math.round((1 - afterBytes / beforeBytes) * 1000) / 10
assert.ok(active.length <= 12, `active=${active.length}`)
assert.ok(active.includes('svc_45_search_docs'), active.join(','))
assert.ok(afterBytes < beforeBytes, `${afterBytes} !< ${beforeBytes}`)
assert.ok(reduction >= 70, `reduction=${reduction}%`)
console.log(`80 tools: schema ${beforeBytes}B -> active ${active.length} tools ${afterBytes}B (-${reduction}%)`)
console.log(`active: ${active.join(', ')}`)
console.log('PASS ① active ≤ 12')
console.log('PASS ② task-relevant tool selected')
console.log('PASS ③ schema bytes reduced ≥ 70% (deterministic proxy; model A/B is M3)')
