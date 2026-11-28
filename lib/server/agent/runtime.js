import { appendToolGovernanceAudit, eventsFile, readToolGovernanceConfig, writeToolGovernanceConfig } from '../domain/tool-governance-store.js'
import { buildCatalog, buildSchemaReport, detectConflicts, optimizeDescription, searchCatalog, schemaBytes } from './catalog.js'
import { syncCompositeTools } from './composite.js'
import { extractMessageText, selectActiveTools } from './policy.js'
import { createTelemetry } from './telemetry.js'

export const TOOL_GOVERN_SEARCH = 'plugin_console_tool_search'
export const TOOL_GOVERN_ACTIVATE = 'plugin_console_tool_activate'
const GOVERNANCE_TOOLS = [TOOL_GOVERN_SEARCH, TOOL_GOVERN_ACTIVATE]

let activeRuntime = null
let lastConfigWarnings = []

function text(value) {
  return [{ type: 'text', text: String(value) }]
}

function listAgents(agents) {
  const out = []
  const seen = new Set()
  for (const fn of [() => agents?.roots?.(), () => agents?.list?.()]) {
    try {
      const list = fn()
      if (!Array.isArray(list)) continue
      for (const agent of list) {
        if (agent === null || agent === undefined || seen.has(agent.id)) continue
        seen.add(agent.id)
        out.push(agent)
      }
    } catch {}
  }
  return out
}

function agentIdOf(agent) {
  return typeof agent?.id === 'string' ? agent.id : null
}

function createSearchTool(runtime) {
  return {
    name: TOOL_GOVERN_SEARCH,
    description: 'Search the complete tool catalog when the current task needs a tool that is not currently exposed. Returns compact summaries; activate a result with plugin_console_tool_activate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords describing the needed capability.' },
        limit: { type: 'integer', description: 'Maximum results, 1-20. Default 10.' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                sourceKind: { type: 'string' },
                riskHints: { type: 'array', items: { type: 'string' } },
                schemaBytes: { type: 'integer' },
              },
              required: ['name', 'description', 'sourceKind', 'riskHints', 'schemaBytes'],
            },
          },
        },
        required: ['query', 'total', 'truncated', 'items'],
      },
      render: (_args, value) => {
        const lines = value.items.map((item) => `${item.name} — ${item.description} [${item.sourceKind}, ${item.schemaBytes}B]`)
        return text(`Tool search: ${value.query}\n${lines.join('\n') || '(no matches)'}${value.truncated ? '\n(results truncated)' : ''}`)
      },
    },
    presentCall: (args) => ({ card: 'generic', title: 'Tool search', kind: 'search', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Tool search', content: result.content }),
    async execute(args, exec) {
      exec.signal?.throwIfAborted?.()
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('plugin_console_tool_search requires a non-empty query')
      const state = runtime.agentStates.get(agentIdOf(exec.agent))
      if (state === undefined) throw new Error('tool governance is not active for this agent')
      const found = searchCatalog(state.available, query, args?.limit)
      return { query, ...found }
    },
  }
}

function createActivateTool(runtime) {
  return {
    name: TOOL_GOVERN_ACTIVATE,
    description: 'Activate one or more tools found with plugin_console_tool_search. Activated tools become visible to the model on the next step.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact tool names to activate.',
        },
      },
      required: ['names'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          activated: { type: 'array', items: { type: 'string' } },
          unavailable: { type: 'array', items: { type: 'string' } },
          hidden: { type: 'array', items: { type: 'string' } },
          deferred: { type: 'array', items: { type: 'string' } },
          effectiveNextStep: { type: 'boolean' },
        },
        required: ['activated', 'unavailable', 'hidden', 'deferred', 'effectiveNextStep'],
      },
      render: (_args, value) => text([
        `Activated: ${value.activated.join(', ') || '(none)'}`,
        value.unavailable.length > 0 ? `Unavailable: ${value.unavailable.join(', ')}` : '',
        value.hidden.length > 0 ? `Hidden by policy: ${value.hidden.join(', ')}` : '',
        value.deferred.length > 0 ? `Deferred by active-tool limit: ${value.deferred.join(', ')}` : '',
        'Changes take effect on the next step.',
      ].filter(Boolean).join('\n')),
    },
    presentCall: (args) => ({ card: 'generic', title: 'Activate tools', kind: 'other', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Activate tools', content: result.content }),
    async execute(args, exec) {
      exec.signal?.throwIfAborted?.()
      const names = Array.isArray(args?.names) ? args.names.filter((name) => typeof name === 'string').slice(0, 20) : []
      if (names.length === 0) throw new Error('plugin_console_tool_activate requires at least one tool name')
      const state = runtime.agentStates.get(agentIdOf(exec.agent))
      if (state === undefined) throw new Error('tool governance is not active for this agent')
      const activated = []
      const unavailable = []
      const hidden = []
      const hiddenSet = new Set(runtime.config.hiddenTools)
      const previousActivated = [...state.activated]
      for (const name of names) {
        if (!state.available.has(name)) unavailable.push(name)
        else if (hiddenSet.has(name) && !GOVERNANCE_TOOLS.includes(name)) hidden.push(name)
        else {
          activated.push(name)
          if (!state.activated.includes(name)) state.activated.push(name)
        }
      }
      if (!applyRestriction(state)) {
        state.activated = previousActivated
        throw new Error('unable to update the active tool set')
      }
      const active = new Set(state.activeNames)
      const deferred = activated.filter((name) => !active.has(name))
      const effectiveNextStep = activated.length > 0 && deferred.length === 0 && unavailable.length === 0 && hidden.length === 0
      return { activated: activated.filter((name) => active.has(name)), unavailable, hidden, deferred, effectiveNextStep }
    },
  }
}

function restrictVisibleTools(state, allow) {
  let next = [...allow]
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return { dispose: state.scopedTools.restrict({ allow: next }), allow: next }
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!message.includes('names unknown global tool')) throw error
      const unknownPart = message.split('; known global tools:')[0]
      const unknown = new Set([...unknownPart.matchAll(/"([^"]+)"/gu)].map((match) => match[1]))
      if (unknown.size === 0) throw error
      const filtered = next.filter((name) => !unknown.has(name))
      if (filtered.length === next.length) throw error
      next = filtered
    }
  }
  throw new Error('unable to apply tool restriction after removing scope-owned tools')
}

function applyRestriction(state) {
  const runtime = state.runtime
  if (runtime.status !== 'running' || state.scopedTools === null) return false
  // 工具很少时按行业惯例不做动态收窄（10+ 才值得 search/activation 的额外往返）。
  if (state.available.size < runtime.config.minCatalogTools) {
    const previous = state.restrictionDispose
    state.restrictionDispose = null
    if (typeof previous === 'function') previous()
    state.bypassed = true
    state.activeNames = [...state.available.keys()]
    state.visibleNames = runtime.tools.schemas(state.agent).map((schema) => schema.name)
    state.capEnforced = true
    runtime.telemetry.record({ kind: 'exposure', agentId: agentIdOf(state.agent), activeCount: state.visibleNames.length, schemaBytes: runtime.tools.schemas(state.agent).reduce((sum, schema) => sum + schemaBytes(schema.parameters), 0) })
    return true
  }
  state.bypassed = false
  const selected = selectActiveTools({
    available: state.available,
    governanceTools: GOVERNANCE_TOOLS,
    baselineTools: runtime.config.baselineTools,
    protectedTools: runtime.config.protectedTools,
    pinnedTools: runtime.config.pinnedTools,
    hiddenTools: runtime.config.hiddenTools,
    recentTools: state.recent,
    activatedTools: state.activated,
    composites: runtime.config.composites,
    maxActiveTools: runtime.config.maxActiveTools,
    taskText: state.taskText,
  })
  let restricted = null
  runtime.applying = true
  try {
    restricted = restrictVisibleTools(state, selected)
    const previous = state.restrictionDispose
    state.restrictionDispose = restricted.dispose
    if (typeof previous === 'function') previous()
  } catch (error) {
    runtime.lastError = String(error?.message ?? error)
    return false
  } finally {
    runtime.applying = false
  }
  const allow = restricted.allow
  state.activeNames = selected
  state.restrictionAllow = allow
  const visibleSchemas = runtime.tools.schemas(state.agent)
  state.visibleNames = visibleSchemas.map((schema) => schema.name)
  state.scopeOwnedCount = state.visibleNames.filter((name) => !allow.includes(name) && name !== 'run_code').length
  const protectedNames = new Set(runtime.config.protectedTools ?? [])
  state.capEnforced = visibleSchemas.filter((schema) => schema.name !== 'run_code' && !protectedNames.has(schema.name)).length <= runtime.config.maxActiveTools
  if (!state.capEnforced) {
    runtime.lastError = `Active tool cap cannot be enforced for agent ${agentIdOf(state.agent)}: ${state.scopeOwnedCount} scope-owned tool(s) remain visible.`
  }
  runtime.telemetry.record({
    kind: 'exposure',
    agentId: agentIdOf(state.agent),
    activeCount: visibleSchemas.length,
    schemaBytes: visibleSchemas.reduce((sum, schema) => sum + schemaBytes(schema.parameters), 0),
  })
  return true
}

function refreshAgent(state) {
  const runtime = state.runtime
  const previousAvailable = state.available
  const previous = state.restrictionDispose
  state.restrictionDispose = null
  if (typeof previous === 'function') previous()
  try {
    state.available = buildCatalog(runtime.tools.schemas(state.agent))
  } catch (error) {
    runtime.lastError = String(error?.message ?? error)
    state.available = previousAvailable
    applyRestriction(state)
    return
  }
  applyRestriction(state)
}

function attachAgent(runtime, agent) {
  if (runtime.agentStates.has(agent.id)) return
  const state = {
    runtime,
    agent,
    available: new Map(),
    scopedTools: null,
    restrictionDispose: null,
    restrictionAllow: null,
    activeNames: [],
    visibleNames: [],
    bypassed: false,
    capEnforced: true,
    scopeOwnedCount: 0,
    recent: [],
    activated: [],
    taskText: '',
  }
  runtime.agentStates.set(agent.id, state)
  if (typeof agent?.ctx?.inject === 'function') {
    agent.ctx.inject(['tools'], (toolsCtx) => {
      if (runtime.agentStates.get(agent.id) !== state) return
      state.scopedTools = toolsCtx.tools
      refreshAgent(state)
    })
  } else {
    state.scopedTools = agent?.ctx?.tools ?? runtime.tools
  }
  refreshAgent(state)
}

function detachAgent(runtime, agent) {
  const state = runtime.agentStates.get(agent.id)
  if (state === undefined) return
  if (typeof state.restrictionDispose === 'function') state.restrictionDispose()
  runtime.agentStates.delete(agent.id)
}

function refreshAll(runtime) {
  if (runtime.refreshing || runtime.applying) return
  runtime.refreshing = true
  try {
    runtime.catalog = buildCatalog(runtime.tools.schemas())
    runtime.conflictCandidates = detectConflicts(runtime.catalog)
    for (const state of runtime.agentStates.values()) refreshAgent(state)
  } finally {
    runtime.refreshing = false
  }
}

function stopToolGovernance() {
  const runtime = activeRuntime
  if (runtime === null) return
  activeRuntime = null
  for (const dispose of runtime.disposers ?? []) {
    try { dispose() } catch {}
  }
  for (const state of runtime.agentStates?.values() ?? []) {
    try { state.restrictionDispose?.() } catch {}
  }
  for (const dispose of runtime.compositeDisposers ?? []) {
    try { dispose() } catch {}
  }
  try { runtime.compositePolicyDispose?.() } catch {}
  for (const dispose of runtime.toolDisposers ?? []) {
    try { dispose() } catch {}
  }
}

function startToolGovernance(ctx) {
  stopToolGovernance()
  const stored = readToolGovernanceConfig()
  const runtime = {
    ctx,
    config: stored.config,
    status: stored.config.enabled ? 'starting' : 'disabled',
    error: stored.error,
    conflicts: [],
    conflictCandidates: [],
    catalog: new Map(),
    agentStates: new Map(),
    disposers: [],
    toolDisposers: [],
    compositeDisposers: [],
    compositePolicyDispose: null,
    compositeDefinitions: new Map(),
    compositeConflicts: [],
    compositeStacks: new Map(),
    configWarnings: lastConfigWarnings,
    telemetry: createTelemetry({ file: eventsFile() }),
    applying: false,
    refreshing: false,
    lastError: null,
  }
  activeRuntime = runtime
  const dispose = () => { if (activeRuntime?.ctx === ctx) stopToolGovernance() }
  if (!runtime.config.enabled) return dispose

  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (tools === undefined || agents === undefined || typeof tools.register !== 'function' || typeof tools.restrict !== 'function' || typeof tools.schemas !== 'function') {
    runtime.status = typeof ctx.on === 'function' ? 'waiting' : 'unsupported'
    runtime.error = 'Waiting for the host tools/agents services.'
    if (typeof ctx.on === 'function') {
      const off = ctx.on('internal/service', function (name) {
        if ((name === 'tools' || name === 'agents') && activeRuntime === runtime) {
          stopToolGovernance()
          startToolGovernance(ctx)
        }
      }, { global: true })
      if (typeof off === 'function') runtime.disposers.push(off)
    }
    return dispose
  }
  runtime.tools = tools
  runtime.agents = agents

  const existing = new Set()
  try {
    for (const schema of tools.schemas()) existing.add(schema.name)
  } catch (error) {
    runtime.status = 'error'
    runtime.error = String(error?.message ?? error)
    return dispose
  }
  runtime.conflicts = GOVERNANCE_TOOLS.filter((name) => existing.has(name) || tools.get(name) !== undefined)
  if (runtime.conflicts.length > 0) {
    runtime.status = 'conflict'
    runtime.error = `Tool name conflict: ${runtime.conflicts.join(', ')}`
    return dispose
  }

  try {
    runtime.toolDisposers.push(tools.register(createSearchTool(runtime)))
    runtime.toolDisposers.push(tools.register(createActivateTool(runtime)))
  } catch (error) {
    stopToolGovernance()
    runtime.status = 'error'
    runtime.error = String(error?.message ?? error)
    activeRuntime = runtime
    return dispose
  }

  const listen = (event, handler) => {
    const off = ctx.on(event, handler)
    if (typeof off === 'function') runtime.disposers.push(off)
  }
  listen('agent/created', ({ agent }) => attachAgent(runtime, agent))
  listen('agent/disposed', ({ agent }) => detachAgent(runtime, agent))
  listen('agent/inbox/inserted', ({ agent, message }) => {
    const state = runtime.agentStates.get(agent.id)
    if (state === undefined) return
    state.taskText = extractMessageText(message)
    applyRestriction(state)
  })
  listen('tools/change', () => refreshAll(runtime))
  listen('tools/execute', async (exec, next) => {
    runtime.telemetry.start(exec)
    return next()
  })
  listen('tools/result', (exec, result) => {
    const measured = runtime.telemetry.finish(exec, result)
    runtime.telemetry.record({ kind: 'execute', tool: exec.name, callId: exec.callId, agentId: agentIdOf(exec.agent), ...measured })
    runtime.telemetry.record({ kind: 'result', tool: exec.name, callId: exec.callId, agentId: agentIdOf(exec.agent), ...measured })
    const state = runtime.agentStates.get(agentIdOf(exec.agent))
    if (state !== undefined && !GOVERNANCE_TOOLS.includes(exec.name) && result.isError !== true && !state.recent.includes(exec.name)) {
      state.recent.unshift(exec.name)
      state.recent = state.recent.slice(0, 8)
      applyRestriction(state)
    }
  })
  listen('session/event', (session, event) => {
    if (event?.type !== 'tool/call') return
    const state = runtime.agentStates.get(session?.id)
    runtime.telemetry.record({
      kind: 'selection',
      tool: event.data?.name ?? null,
      callId: event.data?.callId ?? null,
      agentId: session?.id ?? null,
      known: state?.available.has(event.data?.name) === true,
      active: state?.activeNames.includes(event.data?.name) === true,
    })
  })
  listen('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    if (!runtime.config.optimizeDescriptions || result === null || typeof result !== 'object' || !Array.isArray(result.tools)) return result
    const agent = context?.agent ?? [...runtime.agentStates.values()].find((state) => state.agent === context?.scope)?.agent
    if (agent === undefined || !runtime.agentStates.has(agent.id)) return result
    return {
      ...result,
      tools: result.tools.map((tool) => tool.name === 'run_code'
        ? tool
        : {
          ...tool,
          description: typeof runtime.config.descriptionOverrides?.[tool.name] === 'string'
            ? runtime.config.descriptionOverrides[tool.name]
            : optimizeDescription(tool.description),
        }),
    }
  })

  runtime.status = 'running'
  runtime.catalog = buildCatalog(tools.schemas())
  syncCompositeTools(runtime)
  runtime.catalog = buildCatalog(tools.schemas())
  runtime.conflictCandidates = detectConflicts(runtime.catalog)
  for (const agent of listAgents(agents)) attachAgent(runtime, agent)
  appendToolGovernanceAudit({ action: 'start', toolCount: runtime.catalog.size, agentCount: runtime.agentStates.size })
  return dispose
}

function updateToolGovernanceConfig(ctx, patch = {}) {
  const written = writeToolGovernanceConfig(patch)
  if (!written.ok) return { ok: false, error: written.error, state: getToolGovernanceState() }
  lastConfigWarnings = written.warnings ?? []
  if (!written.config.enabled) {
    stopToolGovernance()
  } else if (activeRuntime === null || !['running', 'starting'].includes(activeRuntime.status)) {
    startToolGovernance(ctx)
  } else {
    activeRuntime.config = written.config
    syncCompositeTools(activeRuntime)
    refreshAll(activeRuntime)
  }
  if (activeRuntime !== null) activeRuntime.configWarnings = written.warnings ?? []
  appendToolGovernanceAudit({ action: 'config', enabled: written.config.enabled, maxActiveTools: written.config.maxActiveTools })
  return { ok: true, state: getToolGovernanceState() }
}

function getToolGovernanceSchemaReport() {
  const runtime = activeRuntime
  const report = runtime === null ? buildSchemaReport(new Map()) : buildSchemaReport(runtime.catalog)
  return { ok: true, status: runtime?.status ?? 'inactive', ...report }
}

function previewToolGovernanceSchemas(descriptions = {}) {
  const runtime = activeRuntime
  const source = descriptions !== null && typeof descriptions === 'object' && !Array.isArray(descriptions) ? descriptions : {}
  const items = []
  const unknown = []
  for (const [name, description] of Object.entries(source).slice(0, 50)) {
    if (typeof description !== 'string') continue
    const item = runtime?.catalog.get(name)
    if (item === undefined) {
      unknown.push(name)
      continue
    }
    const next = description.replace(/\s+/gu, ' ').trim().slice(0, 2000)
    const before = item.description
    items.push({
      name,
      before,
      after: next,
      beforeBytes: Buffer.byteLength(before, 'utf8'),
      afterBytes: Buffer.byteLength(next, 'utf8'),
      changed: before !== next,
    })
  }
  return { ok: true, items, unknown }
}

function getToolGovernanceState() {
  const stored = readToolGovernanceConfig()
  const runtime = activeRuntime
  return {
    ok: true,
    enabled: stored.config.enabled,
    status: runtime?.status ?? (stored.config.enabled ? 'inactive' : 'disabled'),
    error: runtime?.error ?? stored.error,
    lastError: runtime?.lastError ?? null,
    conflicts: runtime?.conflicts ?? [],
    conflictCount: runtime?.conflictCandidates?.length ?? 0,
    config: stored.config,
    catalogCount: runtime?.catalog?.size ?? 0,
    compositeCount: runtime?.compositeDefinitions?.size ?? 0,
    compositeConflicts: runtime?.compositeConflicts ?? [],
    capEnforced: runtime === null || runtime === undefined ? true : [...runtime.agentStates.values()].every((state) => state.capEnforced),
    descriptionOverridesCodeModeUnsupported: Object.keys(stored.config.descriptionOverrides ?? {}).length > 0,
    warnings: runtime?.configWarnings ?? lastConfigWarnings,
    summary: runtime?.telemetry?.summary() ?? {
      totalEvents: 0,
      toolCalls: 0,
      unknownCalls: 0,
      inactiveCalls: 0,
      failedCalls: 0,
      avgDurationMs: null,
      lastSchemaBytes: null,
      lastActiveCount: null,
      persistedEvents: 0,
      writeErrors: 0,
    },
    agents: runtime === null || runtime === undefined ? [] : [...runtime.agentStates.values()].map((state) => ({
      id: agentIdOf(state.agent),
      availableCount: state.available.size,
      activeCount: state.visibleNames.length,
      activeTools: state.visibleNames,
      bypassed: state.bypassed,
      catalogCount: state.available.size,
      capEnforced: state.capEnforced,
      scopeOwnedCount: state.scopeOwnedCount,
      recentTools: state.recent,
      activatedTools: state.activated,
    })),
  }
}

export { getToolGovernanceSchemaReport, getToolGovernanceState, previewToolGovernanceSchemas, startToolGovernance, stopToolGovernance, updateToolGovernanceConfig }
