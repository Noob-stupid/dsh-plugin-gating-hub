import { strict as assert } from 'node:assert'
import { createCompositeTool, parametersOf, resolveValue, syncCompositeTools, validateArgs } from '../lib/server/agent/composite.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

const definition = {
  name: 'plugin_console_issue_to_doc',
  description: 'Read an issue and write a document',
  inputs: {
    issue: { type: 'integer', description: 'Issue number', required: true },
    outputPath: { type: 'string', description: 'Output path', required: true },
  },
  steps: [
    { tool: 'read_issue', args: { number: '${issue}' } },
    { tool: 'write_doc', args: { path: '${outputPath}', issue: '${issue}' } },
  ],
  requiresConfirmation: true,
}

function makeRuntime({ failWrite = false, batchApi = false } = {}) {
  const calls = []
  const definitions = new Map([
    ['read_issue', { name: 'read_issue' }],
    ['write_doc', { name: 'write_doc' }],
  ])
  const runtime = {
    calls,
    tools: {
      get: (name) => definitions.get(name),
      schemas: () => [...definitions.values()].map(({ name }) => ({ name })),
      executionMode: () => ({ kind: 'parallel' }),
      ...(batchApi ? { selectExecutor: () => ({}) } : {}),
      register(tool) {
        definitions.set(tool.name, tool)
        return () => definitions.delete(tool.name)
      },
      async execute(input) {
        const call = batchApi ? input.calls[0] : input
        const normalized = batchApi ? { ...input, callId: call.id, name: call.name, arguments: JSON.parse(call.arguments) } : input
        calls.push(normalized)
        const target = definitions.get(normalized.name)
        let result
        if (target !== undefined && typeof target.execute === 'function') {
          result = await target.execute(normalized.arguments, {
            ...normalized,
            token: Symbol('nested'),
            rootCallId: normalized.rootCallId ?? normalized.callId,
          })
        } else if (normalized.name === 'write_doc' && failWrite) {
          result = { isError: true, error: { message: 'write failed' }, content: [{ type: 'text', text: 'write failed' }] }
        } else {
          result = { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] }
        }
        return batchApi ? { results: [{ result }] } : result
      },
    },
    ctx: { on: () => () => {} },
    config: { composites: [] },
    compositeDisposers: [],
    compositePolicyDispose: null,
    compositeDefinitions: new Map(),
    compositeConflicts: [],
    compositeStacks: new Map(),
  }
  return runtime
}

const exec = () => ({
  callId: 'root-call',
  rootCallId: 'root-call',
  token: Symbol('parent'),
  agent: { id: 'agent-1' },
  signal: new AbortController().signal,
})

check('① composite parameters use standard JSON Schema required array', () => {
  const parameters = parametersOf(definition)
  assert.deepEqual(parameters.required, ['issue', 'outputPath'])
  assert.equal(parameters.additionalProperties, false)
})

check('② composite validates required input types', () => {
  validateArgs({ issue: 7, outputPath: 'D:/doc.md' }, definition)
  assert.throws(() => validateArgs({ issue: '7', outputPath: 'D:/doc.md' }, definition), /must be integer/u)
  assert.throws(() => validateArgs({ issue: 7, outputPath: 'D:/doc.md', extra: true }, definition), /does not accept input/u)
})

check('③ placeholders resolve recursively without evaluating code', () => {
  const value = resolveValue({ path: '${outputPath}', nested: ['${issue}'] }, { issue: 7, outputPath: 'D:/doc.md' }, definition)
  assert.deepEqual(value, { path: 'D:/doc.md', nested: [7] })
  assert.throws(() => resolveValue('${missing}', {}, definition), /missing input/u)
})

await checkAsync('④ sequential composite maps inputs and preserves parent token', async () => {
  const runtime = makeRuntime()
  const tool = createCompositeTool(runtime, definition)
  const execution = exec()
  const result = await tool.execute({ issue: 7, outputPath: 'D:/doc.md' }, execution)
  assert.equal(result.ok, true)
  assert.equal(result.completedSteps, 2)
  assert.deepEqual(runtime.calls[0].arguments, { number: 7 })
  assert.deepEqual(runtime.calls[1].arguments, { path: 'D:/doc.md', issue: 7 })
  assert.equal(runtime.calls[0].parent, execution.token)
})

await checkAsync('⑤ composite supports the 0.2.2 batch executor API', async () => {
  const runtime = makeRuntime({ batchApi: true })
  const tool = createCompositeTool(runtime, definition)
  const result = await tool.execute({ issue: 7, outputPath: 'D:/doc.md' }, exec())
  assert.equal(result.ok, true)
  assert.deepEqual(runtime.calls[0].arguments, { number: 7 })
})

await checkAsync('⑥ recursive composite calls are rejected before execution', async () => {
  const runtime = makeRuntime()
  const recursive = { ...definition, name: 'plugin_console_recursive', steps: [{ tool: 'plugin_console_recursive', args: { issue: '${issue}', outputPath: '${outputPath}' } }] }
  const tool = createCompositeTool(runtime, recursive)
  runtime.tools.register(tool)
  await assert.rejects(() => tool.execute({ issue: 7, outputPath: 'D:/doc.md' }, exec()), /recursive composite/u)
})

await checkAsync('⑥ failed step stops the composite and returns partial results', async () => {
  const runtime = makeRuntime({ failWrite: true })
  const tool = createCompositeTool(runtime, definition)
  const result = await tool.execute({ issue: 7, outputPath: 'D:/doc.md' }, exec())
  assert.equal(result.ok, false)
  assert.equal(result.completedSteps, 2)
  assert.equal(result.results[1].isError, true)
})

await checkAsync('⑥ parallel group only uses concurrency-safe tools', async () => {
  const runtime = makeRuntime()
  const parallelDefinition = {
    ...definition,
    steps: [
      { tool: 'read_issue', args: { number: '${issue}' }, parallel: true },
      { tool: 'write_doc', args: { path: '${outputPath}' }, parallel: true },
    ],
  }
  const tool = createCompositeTool(runtime, parallelDefinition)
  const result = await tool.execute({ issue: 7, outputPath: 'D:/doc.md' }, exec())
  assert.equal(result.ok, true)
  assert.equal(runtime.calls.length, 2)
})

await checkAsync('⑦ parallel sibling calls to the same composite are not recursion', async () => {
  const runtime = makeRuntime()
  const child = createCompositeTool(runtime, {
    name: 'plugin_console_parallel_child',
    description: 'Child',
    inputs: {},
    steps: [{ tool: 'read_issue', args: {} }],
    requiresConfirmation: false,
  })
  runtime.tools.register(child)
  const parent = createCompositeTool(runtime, {
    name: 'plugin_console_parallel_parent',
    description: 'Parent',
    inputs: {},
    steps: [
      { tool: 'plugin_console_parallel_child', args: {}, parallel: true },
      { tool: 'plugin_console_parallel_child', args: {}, parallel: true },
    ],
    requiresConfirmation: false,
  })
  runtime.tools.register(parent)
  const result = await parent.execute({}, exec())
  assert.equal(result.ok, true)
  assert.equal(result.completedSteps, 2)
})

await checkAsync('⑧ composite registration detects conflicts and installs approval policy', async () => {
  const runtime = makeRuntime()
  runtime.config.composites = [definition]
  const handlers = new Map()
  runtime.ctx.on = (name, fn) => {
    handlers.set(name, fn)
    return () => handlers.delete(name)
  }
  syncCompositeTools(runtime)
  assert.equal(runtime.compositeDefinitions.size, 1)
  assert.equal(runtime.compositeConflicts.length, 0)
  const policy = handlers.get('tools/pre-execute')
  const decision = await policy({ name: definition.name }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask')
  const allowed = await policy({ name: 'read_issue' }, async () => ({ kind: 'allow' }))
  assert.equal(allowed.kind, 'allow')
  runtime.config.composites = [{ ...definition, name: 'read_issue' }]
  syncCompositeTools(runtime)
  assert.deepEqual(runtime.compositeConflicts, ['read_issue'])
})

console.log(`\n${passed} passed`)
process.exit(process.exitCode ?? 0)
