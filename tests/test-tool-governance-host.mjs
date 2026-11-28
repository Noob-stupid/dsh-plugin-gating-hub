import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const candidates = [
  process.env.DSH_HOST_PACKAGE_JSON,
  'D:/dsh/_npx-repair/official-asar/dsh/package.json',
  'D:/dsh/deepseek-harness/package.json',
].filter((value) => typeof value === 'string' && value !== '')
const hostPackage = candidates.find((file) => existsSync(file))
if (hostPackage === undefined) {
  console.log('SKIP real host tool-governance test — set DSH_HOST_PACKAGE_JSON to a DSH host package.json')
  process.exit(0)
}

const requireHost = createRequire(hostPackage)
const loadHost = async (name) => import(pathToFileURL(requireHost.resolve(name)).href)
const { Context } = await loadHost('@deepseek-ai/cordis')
const { default: SystemPrompt } = await loadHost('@deepseek-ai/dsh-system-prompt')
const { default: ToolRuntime } = await loadHost('@deepseek-ai/dsh-tools')
const { createScope } = await loadHost('@deepseek-ai/dsh-scope')

const home = mkdtempSync(join(tmpdir(), 'dsh-tool-governance-host-'))
process.env.DSH_HOME = home
const {
  TOOL_GOVERN_ACTIVATE,
  TOOL_GOVERN_SEARCH,
  getToolGovernanceState,
  startToolGovernance,
  stopToolGovernance,
  updateToolGovernanceConfig,
} = await import('../lib/server/agent/runtime.js')

const ctx = new Context()
let scope = null
let scope2 = null
let dispose = null
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (typeof ctx.tools.setExecutor === 'function') {
    const native = await loadHost('@deepseek-ai/dsh-tool-executor-native')
    native.apply.inject = native.inject
    await ctx.plugin(native.apply)
  }
  const executeCall = async (input) => {
    if (typeof ctx.tools.selectExecutor === 'function') {
      const batch = await ctx.tools.execute({
        calls: [{ id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
        agent: input.agent,
        signal: input.signal,
      })
      return batch.results[0].result
    }
    return ctx.tools.execute(input)
  }
  for (let i = 0; i < 80; i += 1) {
    ctx.tools.register({
      name: `host_smoke_${i}`,
      description: i === 7 ? 'Query a database and return rows' : `Generic host smoke tool ${i}`,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => 'ok',
    })
  }

  const agent = { id: 'host-smoke-agent' }
  scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  const wrapper = {
    get(name) {
      if (name === 'tools') return ctx.get('tools')
      if (name === 'agents') return { roots: () => [agent], list: () => [agent] }
      return undefined
    },
    on: (...args) => ctx.on(...args),
  }

  dispose = startToolGovernance(wrapper)
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))

  const state = getToolGovernanceState()
  assert.equal(state.status, 'running')
  assert.equal(state.agents.length, 1)
  assert.ok(state.catalogCount >= 82, `catalogCount=${state.catalogCount}`)

  const agent2 = { id: 'host-smoke-agent-2' }
  scope2 = createScope(ctx, agent2)
  agent2.ctx = scope2.ctx
  ctx.emit('agent/created', { agent: agent2 })
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(getToolGovernanceState().agents.length, 2)
  assert.ok(ctx.tools.schemas(agent2).length <= 12)

  const visible = ctx.tools.schemas(agent).map((schema) => schema.name)
  assert.ok(visible.includes(TOOL_GOVERN_SEARCH))
  assert.ok(visible.includes(TOOL_GOVERN_ACTIVATE))
  assert.ok(visible.length <= 12, `visible=${visible.length}`)

  const signal = new AbortController().signal
  const found = await executeCall({
    callId: 'host-search-1',
    name: TOOL_GOVERN_SEARCH,
    arguments: { query: 'database', limit: 5 },
    agent,
    signal,
  })
  assert.equal(found.isError, false)
  assert.ok(found.content.some((block) => block.text.includes('host_smoke_7')))

  const activated = await executeCall({
    callId: 'host-activate-1',
    name: TOOL_GOVERN_ACTIVATE,
    arguments: { names: ['host_smoke_7'] },
    agent,
    signal,
  })
  assert.equal(activated.isError, false)
  assert.ok(ctx.tools.schemas(agent).some((schema) => schema.name === 'host_smoke_7'))

  const denied = await executeCall({
    callId: 'host-denied-1',
    name: 'host_smoke_8',
    arguments: {},
    agent,
    signal,
  })
  assert.equal(denied.isError, true)

  updateToolGovernanceConfig(wrapper, {
    composites: [{
      name: 'plugin_console_host_smoke_combo',
      description: 'Run two host smoke tools',
      inputs: { value: { type: 'string', description: 'Smoke value', required: true } },
      steps: [
        { tool: 'host_smoke_7', args: { value: '${value}' } },
        { tool: 'host_smoke_8', args: { value: '${value}' } },
      ],
      requiresConfirmation: false,
    }],
  })
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(getToolGovernanceState().compositeCount, 1)
  const compositeSearch = await executeCall({
    callId: 'host-composite-search',
    name: TOOL_GOVERN_SEARCH,
    arguments: { query: 'host smoke combo', limit: 5 },
    agent,
    signal,
  })
  assert.equal(compositeSearch.isError, false)
  assert.ok(compositeSearch.content.some((block) => block.text.includes('plugin_console_host_smoke_combo')))
  const compositeActivation = await executeCall({
    callId: 'host-composite-activate',
    name: TOOL_GOVERN_ACTIVATE,
    arguments: { names: ['plugin_console_host_smoke_combo'] },
    agent,
    signal,
  })
  assert.equal(compositeActivation.isError, false)
  assert.ok(ctx.tools.schemas(agent).some((schema) => schema.name === 'plugin_console_host_smoke_combo'))
  const composite = await executeCall({
    callId: 'host-composite-1',
    name: 'plugin_console_host_smoke_combo',
    arguments: { value: 'ok' },
    agent,
    signal,
  })
  assert.equal(composite.isError, false)
  assert.ok(composite.content.some((block) => block.text.includes('Composite completed')))

  dispose()
  dispose = null
  assert.equal(ctx.tools.schemas(agent).length, 80)
  console.log('PASS real host 80-tool governance: catalog/restrict/search/activate/deny/composite/restore')
} finally {
  if (typeof dispose === 'function') dispose()
  if (scope !== null) await scope.dispose()
  if (scope2 !== null) await scope2.dispose()
  stopToolGovernance()
  rmSync(home, { recursive: true, force: true })
}
