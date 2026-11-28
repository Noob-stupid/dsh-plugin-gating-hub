import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsh-tool-governance-'))
process.env.DSH_HOME = home

const {
  TOOL_GOVERN_ACTIVATE,
  TOOL_GOVERN_SEARCH,
  getToolGovernanceSchemaReport,
  getToolGovernanceState,
  previewToolGovernanceSchemas,
  startToolGovernance,
  stopToolGovernance,
  updateToolGovernanceConfig,
} = await import('../lib/server/agent/runtime.js')
const { createTelemetry } = await import('../lib/server/agent/telemetry.js')
const { writeToolGovernanceConfig } = await import('../lib/server/domain/tool-governance-store.js')

let failed = 0
function check(label, condition, extra) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` — ${extra}`}`)
  if (!condition) failed += 1
}

const configCtx = { get: () => undefined, on: () => () => {} }

function createHarness({ conflict = false, delayServices = false, size = 30 } = {}) {
  const globals = new Map()
  const scoped = new Map()
  const listeners = new Map()
  let servicesReady = !delayServices
  let failNextAgentSchemas = false
  let failNextRestriction = false
  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) ?? []) fn(...args)
  }
  const registry = {
    register(definition) {
      if (globals.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
      globals.set(definition.name, definition)
      return () => globals.delete(definition.name)
    },
    schemas(agent) {
      if (agent !== undefined && failNextAgentSchemas) {
        failNextAgentSchemas = false
        throw new Error('transient schema failure')
      }
      let defs = [...globals.values()]
      if (agent !== undefined) {
        const restrictions = scoped.get(agent.id)?.restrictions ?? []
        defs = defs.filter((definition) => restrictions.every((restriction) => restriction.allow.includes(definition.name)))
        defs = defs.concat([...(scoped.get(agent.id)?.own ?? [])])
      }
      return defs.map(({ name, description, parameters }) => ({ name, description, parameters }))
    },
    get(name, agent) {
      const found = (registry.schemas(agent)).find((schema) => schema.name === name)
      return found === undefined ? undefined : globals.get(name)
    },
    restrict() {
      throw new Error('restrict requires scoped context')
    },
  }
  const agent = { id: 'agent-1', ctx: {} }
  scoped.set(agent.id, { restrictions: [], own: [] })
  agent.ctx.tools = {
    restrict(filter) {
      if (failNextRestriction) {
        failNextRestriction = false
        throw new Error('transient restriction failure')
      }
      const ownNames = new Set((scoped.get(agent.id).own ?? []).map((item) => item.name))
      const unknown = filter.allow.filter((name) => ownNames.has(name))
      if (unknown.length > 0) {
        throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((name) => JSON.stringify(name)).join(', ')}; known global tools: `)
      }
      const restrictions = scoped.get(agent.id).restrictions
      const entry = { allow: filter.allow }
      restrictions.push(entry)
      emit('tools/change')
      return () => {
        const index = restrictions.indexOf(entry)
        if (index >= 0) restrictions.splice(index, 1)
      }
    },
  }
  const services = { tools: registry, agents: { roots: () => [agent] } }
  const ctx = {
    get(name) {
      return servicesReady ? services[name] : undefined
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {
        const next = (listeners.get(event) ?? []).filter((item) => item !== fn)
        listeners.set(event, next)
      }
    },
  }
  for (let i = 0; i < size; i += 1) {
    registry.register({
      name: `tool_${i}`,
      description: i === 7 ? 'Query a database and return rows' : `Generic tool number ${i}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => 'ok',
    })
  }
  if (conflict) {
    registry.register({
      name: TOOL_GOVERN_SEARCH,
      description: 'existing tool',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => 'existing',
    })
  }
  return {
    registry,
    agent,
    ctx,
    globals,
    scoped,
    emit,
    listeners,
    activateServices() {
      servicesReady = true
      emit('internal/service', 'tools')
      emit('internal/service', 'agents')
    },
    failNextAgentSchemas() { failNextAgentSchemas = true },
    failNextRestriction() { failNextRestriction = true },
  }
}

{
  const { registry, agent, ctx, globals, emit } = createHarness()
  const dispose = startToolGovernance(ctx)
  let state = getToolGovernanceState()
  check('runtime starts', state.status === 'running', state.status)
  check('governance tools registered', globals.has(TOOL_GOVERN_SEARCH) && globals.has(TOOL_GOVERN_ACTIVATE))
  check('catalog contains tools', state.catalogCount >= 30, String(state.catalogCount))
  const visible = registry.schemas(agent).map((schema) => schema.name)
  check('active set is bounded', visible.length <= 12, String(visible.length))
  check('governance tools stay visible', visible.includes(TOOL_GOVERN_SEARCH) && visible.includes(TOOL_GOVERN_ACTIVATE))

  const before = registry.schemas(agent).map((schema) => schema.name)
  check('database tool initially hidden', !before.includes('tool_7'))
  check('hidden tool cannot be resolved', registry.get('tool_7', agent) === undefined)
  const search = globals.get(TOOL_GOVERN_SEARCH)
  const found = await search.execute({ query: 'database', limit: 5 }, { agent, signal: new AbortController().signal })
  check('search finds hidden tool', found.items.some((item) => item.name === 'tool_7'), JSON.stringify(found.items.map((item) => item.name)))
  const activate = globals.get(TOOL_GOVERN_ACTIVATE)
  const activated = await activate.execute({ names: ['tool_7'] }, { agent, signal: new AbortController().signal })
  check('activate reports success', activated.activated.includes('tool_7') && activated.effectiveNextStep === true)
  const noop = await activate.execute({ names: ['missing_tool'] }, { agent, signal: new AbortController().signal })
  check('activation with no valid tool is not effective', noop.activated.length === 0 && noop.effectiveNextStep === false)
  const after = registry.schemas(agent).map((schema) => schema.name)
  check('activated tool becomes visible', after.includes('tool_7'))
  check('activated tool can be resolved', registry.get('tool_7', agent) !== undefined)
  registry.register({
    name: 'tool_new',
    description: 'Newly registered tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'new',
  })
  emit('tools/change')
  check('tools change refreshes catalog', getToolGovernanceState().catalogCount >= 33, String(getToolGovernanceState().catalogCount))
  dispose()
  check('stop restores full view', registry.schemas(agent).length === 31, String(registry.schemas(agent).length))
}

{
  const { registry, agent, ctx, globals } = createHarness({ conflict: true })
  const dispose = startToolGovernance(ctx)
  const state = getToolGovernanceState()
  check('name conflict is visible', state.status === 'conflict' && state.conflicts.includes(TOOL_GOVERN_SEARCH), JSON.stringify(state.conflicts))
  check('conflict does not replace existing tool', globals.get(TOOL_GOVERN_SEARCH).description === 'existing tool')
  check('conflict does not restrict tools', registry.schemas(agent).length === 31, String(registry.schemas(agent).length))
  dispose()
}

{
  const { ctx } = createHarness()
  updateToolGovernanceConfig(ctx, { enabled: false })
  const dispose = startToolGovernance(ctx)
  check('disabled config stays disabled', getToolGovernanceState().status === 'disabled')
  dispose()
  updateToolGovernanceConfig(ctx, { enabled: true, maxActiveTools: 8 })
  const dispose2 = startToolGovernance(ctx)
  check('config enables runtime', getToolGovernanceState().status === 'running' && getToolGovernanceState().config.maxActiveTools === 8)
  dispose2()
}

{
  const { registry, agent, ctx } = createHarness({ size: 5 })
  const dispose = startToolGovernance(ctx)
  const state = getToolGovernanceState()
  check('small catalog bypasses restriction (minCatalogTools)', state.agents.length === 1 && state.agents[0].bypassed === true, JSON.stringify(state.agents))
  check('small catalog keeps all host tools visible', registry.schemas(agent).length === 7, String(registry.schemas(agent).length))
  dispose()
}

{
  const { registry, agent, ctx } = createHarness()
  const dispose = startToolGovernance(ctx)
  updateToolGovernanceConfig(ctx, { enabled: false })
  updateToolGovernanceConfig(ctx, { enabled: true })
  check('re-enable creates a live runtime', getToolGovernanceState().status === 'running')
  dispose()
  check('original unload disposer stops re-enabled runtime', registry.schemas(agent).length === 30, String(registry.schemas(agent).length))
}

{
  const { ctx, activateServices } = createHarness({ delayServices: true })
  const dispose = startToolGovernance(ctx)
  check('missing services wait instead of failing', getToolGovernanceState().status === 'waiting')
  activateServices()
  check('service-ready event activates runtime', getToolGovernanceState().status === 'running')
  dispose()
}

{
  updateToolGovernanceConfig(configCtx, { enabled: true, maxActiveTools: 4, optimizeDescriptions: true })
  const { registry, agent, ctx, globals } = createHarness()
  const dispose = startToolGovernance(ctx)
  const activate = globals.get(TOOL_GOVERN_ACTIVATE)
  const result = await activate.execute({ names: ['tool_1', 'tool_2', 'tool_3', 'tool_4', 'tool_5'] }, { agent, signal: new AbortController().signal })
  check('active tool limit is a hard cap', registry.schemas(agent).length <= 4, String(registry.schemas(agent).length))
  check('excess activations are reported as deferred', result.deferred.length > 0, JSON.stringify(result))
  dispose()
}

{
  updateToolGovernanceConfig(configCtx, { enabled: true, maxActiveTools: 12, optimizeDescriptions: true })
  const { ctx, agent, listeners } = createHarness()
  const dispose = startToolGovernance(ctx)
  const listener = listeners.get('system-prompt/assemble')[0]
  const assembly = { tools: [{ name: 'demo', description: 'alpha   beta\n gamma' }] }
  const optimized = await listener(assembly, { scope: agent }, async () => assembly)
  check('description optimization accepts scope-only assembly context', optimized.tools[0].description === 'alpha beta gamma', optimized.tools[0].description)
  dispose()
}

{
  const { registry, ctx, agent, emit, listeners } = createHarness()
  registry.register({
    name: 'schema_bad',
    description: '   ',
    parameters: { type: 'object', additionalProperties: true, properties: { value: { type: 'string' } }, required: ['missing'] },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'bad',
  })
  const dispose = startToolGovernance(ctx)
  emit('tools/change')
  const report = getToolGovernanceSchemaReport()
  const bad = report.items.find((item) => item.name === 'schema_bad')
  const codes = (bad?.issues ?? []).map((issue) => issue.code)
  check('schema report detects concrete issues', ['empty-description', 'open-parameters', 'missing-parameter-description', 'required-not-declared'].every((code) => codes.includes(code)), codes.join(','))
  const preview = previewToolGovernanceSchemas({ tool_1: '  improved   description ', missing_tool: 'x' })
  check('schema preview reports diff and unknown names', preview.items[0]?.after === 'improved description' && preview.unknown.includes('missing_tool'))
  updateToolGovernanceConfig(configCtx, { descriptionOverrides: { tool_1: 'Custom approved description' } })
  const listener = listeners.get('system-prompt/assemble')[0]
  const assembly = { tools: [{ name: 'tool_1', description: 'original' }] }
  const optimized = await listener(assembly, { scope: agent }, async () => assembly)
  check('approved description override reaches model assembly', optimized.tools[0].description === 'Custom approved description', optimized.tools[0].description)
  const malformed = { sections: [] }
  const untouched = await listener(malformed, { scope: agent }, async () => malformed)
  check('prompt assembly listener tolerates missing tools array', untouched === malformed)
  dispose()
}

{
  const { ctx, scoped } = createHarness()
  for (let i = 0; i < 20; i += 1) scoped.get('agent-1').own.push({ name: `scoped_${i}`, description: 'Agent-owned tool', parameters: { type: 'object', properties: {} } })
  const dispose = startToolGovernance(ctx)
  const agentState = getToolGovernanceState().agents[0]
  check('scope-owned tools are reported as outside the hard cap', agentState.capEnforced === false && agentState.scopeOwnedCount === 20, JSON.stringify(agentState))
  dispose()
}

{
  const { ctx, agent, registry, emit, failNextAgentSchemas } = createHarness()
  const dispose = startToolGovernance(ctx)
  const before = registry.schemas(agent).length
  failNextAgentSchemas()
  emit('tools/change')
  check('transient catalog failure preserves working tool view', registry.schemas(agent).length === before && getToolGovernanceState().catalogCount >= 32)
  dispose()
}

{
  const { ctx, agent, globals, failNextRestriction } = createHarness()
  const dispose = startToolGovernance(ctx)
  failNextRestriction()
  let rejected = false
  try {
    await globals.get(TOOL_GOVERN_ACTIVATE).execute({ names: ['tool_1'] }, { agent, signal: new AbortController().signal })
  } catch { rejected = true }
  check('failed restriction does not report activation success', rejected)
  check('failed activation rolls back session activation', !getToolGovernanceState().agents[0].activatedTools.includes('tool_1'))
  dispose()
}

{
  const cyclic = [
    { name: 'plugin_console_cycle_a', description: 'A', inputs: {}, steps: [{ tool: 'plugin_console_cycle_b', args: {} }] },
    { name: 'plugin_console_cycle_b', description: 'B', inputs: {}, steps: [{ tool: 'plugin_console_cycle_a', args: {} }] },
  ]
  const written = writeToolGovernanceConfig({ composites: cyclic })
  check('cyclic composites are rejected with a warning', written.config.composites.length === 0 && written.warnings.length > 0, JSON.stringify(written.warnings))
  writeToolGovernanceConfig({ composites: [] })
}

{
  const { ctx } = createHarness()
  const dispose = startToolGovernance(ctx)
  updateToolGovernanceConfig(configCtx, {
    composites: [{ name: 'plugin_console_needs_tool_1', description: 'Needs tool 1', inputs: {}, steps: [{ tool: 'tool_1', args: {} }] }],
    pinnedTools: ['plugin_console_needs_tool_1'],
    hiddenTools: ['tool_1'],
  })
  const active = getToolGovernanceState().agents[0].activeTools
  check('composite with hidden dependency is not exposed', !active.includes('plugin_console_needs_tool_1'), active.join(','))
  updateToolGovernanceConfig(configCtx, { composites: [], pinnedTools: [], hiddenTools: [] })
  dispose()
}

{
  const written = writeToolGovernanceConfig({ maxActiveTools: 2, hiddenTools: ['bad name'] })
  check('invalid config values return warnings', written.warnings.length >= 2 && written.config.maxActiveTools === 4, JSON.stringify(written.warnings))
  updateToolGovernanceConfig(configCtx, { enabled: false, maxActiveTools: 2, hiddenTools: ['bad name'] })
  check('config warnings survive disabling', getToolGovernanceState().warnings.length >= 2)
  updateToolGovernanceConfig(configCtx, { enabled: true, maxActiveTools: 12, hiddenTools: [] })
}

{
  const { ctx } = createHarness()
  const dispose = startToolGovernance(ctx)
  updateToolGovernanceConfig(configCtx, {
    composites: [
      { name: 'plugin_console_transitive_a', description: 'A', inputs: {}, steps: [{ tool: 'plugin_console_transitive_b', args: {} }] },
      { name: 'plugin_console_transitive_b', description: 'B', inputs: {}, steps: [{ tool: 'tool_1', args: {} }] },
    ],
    pinnedTools: ['plugin_console_transitive_a'],
    hiddenTools: [],
  })
  const active = getToolGovernanceState().agents[0].activeTools
  check('transitive composite dependencies are reserved', ['plugin_console_transitive_a', 'plugin_console_transitive_b', 'tool_1'].every((name) => active.includes(name)), active.join(','))
  updateToolGovernanceConfig(configCtx, { composites: [], pinnedTools: [], hiddenTools: [] })
  dispose()
}

{
  const telemetry = createTelemetry()
  telemetry.record({ kind: 'execute', isError: true })
  telemetry.record({ kind: 'result', isError: true })
  check('failed calls are counted once', telemetry.summary().failedCalls === 1, String(telemetry.summary().failedCalls))
}

{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-telemetry-'))
  const file = join(dir, 'events.jsonl')
  const telemetry = createTelemetry({ file, maxFileBytes: 4096, maxFiles: 2 })
  telemetry.record({ kind: 'selection', tool: 'demo', arguments: 'secret-arg', content: 'secret-output' })
  const first = JSON.parse(readFileSync(file, 'utf8').split('\n')[0])
  check('telemetry persists without raw args or output', first.tool === 'demo' && !('arguments' in first) && !('content' in first))
  for (let i = 0; i < 80; i += 1) telemetry.record({ kind: 'result', tool: `tool_${i}`, isError: false })
  check('telemetry rotates JSONL files', existsSync(`${file}.1`))
  check('telemetry keeps bounded rotation history', existsSync(`${file}.2`))
  check('telemetry counts persisted events', telemetry.summary().persistedEvents === 81, String(telemetry.summary().persistedEvents))
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-telemetry-fail-'))
  const file = join(dir, 'events.jsonl')
  mkdirSync(`${file}.2`)
  writeFileSync(file, 'x'.repeat(5000))
  const telemetry = createTelemetry({ file, maxFileBytes: 4096, maxFiles: 2 })
  telemetry.record({ kind: 'result', tool: 'demo' })
  check('rotation failure stops append and records error', telemetry.summary().writeErrors === 1 && telemetry.summary().persistedEvents === 0)
  check('rotation failure does not grow oversized file', readFileSync(file, 'utf8').length === 5000)
  rmSync(dir, { recursive: true, force: true })
}

stopToolGovernance()
rmSync(home, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
