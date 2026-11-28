// M3 retrieval-level golden tasks: deterministic, no model calls.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateGoldenTasks, latestEvaluation, runGoldenEvaluation } from '../lib/server/agent/evaluator.js'

const result = evaluateGoldenTasks()
assert.equal(result.tasks.length, 10)
assert.equal(result.summary.count, 10)
assert.ok(result.summary.recall >= 0.9, `recall=${result.summary.recall}`)
assert.ok(result.summary.avgActiveTools <= 12, `avgActive=${result.summary.avgActiveTools}`)
assert.ok(result.summary.schemaReductionPct >= 70, `reduction=${result.summary.schemaReductionPct}%`)

const home = mkdtempSync(join(tmpdir(), 'dsh-eval-'))
try {
  const record = runGoldenEvaluation({ home, now: 1700000000000 })
  assert.equal(record.summary.count, 10)
  assert.ok(existsSync(join(home, 'plugin-console', 'tool-governance-eval.json')))
  const latest = latestEvaluation({ home })
  assert.equal(latest.summary.count, 10)
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`PASS ① 10 golden tasks recall=${result.summary.recall} avgActive=${result.summary.avgActiveTools}`)
console.log(`PASS ② schema ${result.summary.baselineSchemaBytes}B -> ${result.summary.governedSchemaBytes}B (-${result.summary.schemaReductionPct}%)`)
console.log('PASS ③ evaluation persisted and readable')
console.log('\nALL PASS')
