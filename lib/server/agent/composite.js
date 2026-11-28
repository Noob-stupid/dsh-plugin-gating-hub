function text(value) {
  return [{ type: 'text', text: String(value) }]
}

function parametersOf(definition) {
  const properties = {}
  const required = []
  for (const [name, schema] of Object.entries(definition.inputs ?? {})) {
    properties[name] = { type: schema.type, description: schema.description ?? '' }
    if (schema.required === true) required.push(name)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function validateArgs(args, definition) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${definition.name} expects an object`)
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(definition.inputs ?? {}, key)) throw new Error(`${definition.name} does not accept input "${key}"`)
  }
  for (const [name, schema] of Object.entries(definition.inputs ?? {})) {
    const value = args[name]
    if (schema.required === true && value === undefined) throw new Error(`${definition.name} requires "${name}"`)
    if (value === undefined) continue
    const valid = schema.type === 'array'
      ? Array.isArray(value)
      : schema.type === 'object'
        ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : schema.type === 'integer'
          ? Number.isInteger(value)
          : schema.type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === schema.type
    if (!valid) throw new Error(`${definition.name} input "${name}" must be ${schema.type}`)
  }
}

function resolveValue(value, args, definition) {
  if (typeof value === 'string') {
    const exact = /^\$\{([A-Za-z0-9_-]+)\}$/u.exec(value)
    if (exact !== null) {
      const name = exact[1]
      if (!Object.hasOwn(args, name)) throw new Error(`${definition.name} references missing input "${name}"`)
      return args[name]
    }
    return value.replace(/\$\{([A-Za-z0-9_-]+)\}/gu, (_match, name) => {
      if (!Object.hasOwn(args, name)) throw new Error(`${definition.name} references missing input "${name}"`)
      return typeof args[name] === 'object' && args[name] !== null ? JSON.stringify(args[name]) : String(args[name])
    })
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, args, definition))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, args, definition)]))
  }
  return value
}

function errorMessage(result) {
  if (typeof result?.error?.message === 'string') return result.error.message
  const block = Array.isArray(result?.content) ? result.content.find((item) => item?.type === 'text') : null
  return typeof block?.text === 'string' ? block.text : 'tool failed'
}

async function executeNestedTool(runtime, input) {
  if (typeof runtime.tools.selectExecutor === 'function') {
    const batch = await runtime.tools.execute({
      calls: [{ id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
      agent: input.agent,
      signal: input.signal,
      ...(input.toolSet === undefined ? {} : { toolSet: input.toolSet }),
    })
    const result = batch?.results?.[0]?.result
    if (result === undefined) throw new Error('tool executor returned no result for composite step')
    return result
  }
  return runtime.tools.execute(input)
}

async function runStep(runtime, definition, step, index, args, exec) {
  exec.signal?.throwIfAborted?.()
  const tool = runtime.tools.get(step.tool, exec.agent)
  if (tool === undefined) throw new Error(`${definition.name} dependency "${step.tool}" is not visible`)
  const result = await executeNestedTool(runtime, {
    callId: `${exec.callId}:composite:${index}`,
    rootCallId: exec.rootCallId ?? exec.callId,
    name: step.tool,
    arguments: resolveValue(step.args, args, definition),
    agent: exec.agent,
    parent: exec.token,
    signal: exec.signal,
    ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
  })
  return {
    index,
    tool: step.tool,
    isError: result.isError === true,
    ...(result.isError === true ? { error: errorMessage(result).slice(0, 500) } : {}),
  }
}

function createCompositeTool(runtime, definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: parametersOf(definition),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          completedSteps: { type: 'integer' },
          totalSteps: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                tool: { type: 'string' },
                isError: { type: 'boolean' },
                error: { type: 'string' },
              },
              required: ['index', 'tool', 'isError'],
            },
          },
        },
        required: ['ok', 'completedSteps', 'totalSteps', 'results'],
      },
      render: (_args, value) => {
        const lines = value.results.map((item) => `${item.index + 1}. ${item.tool} — ${item.isError ? `FAILED: ${item.error}` : 'ok'}`)
        return text(`${value.ok ? 'Composite completed' : 'Composite stopped'} (${value.completedSteps}/${value.totalSteps})\n${lines.join('\n')}`)
      },
    },
    presentCall: (args) => ({ card: 'generic', title: definition.name, kind: 'execute', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: definition.name, content: result.content }),
    async execute(args, exec) {
      validateArgs(args, definition)
      const parentStack = exec.parent === undefined ? [] : runtime.compositeStacks?.get(exec.parent) ?? []
      if (parentStack.includes(definition.name)) throw new Error(`recursive composite call detected: ${definition.name}`)
      if (parentStack.length >= 8) throw new Error('composite nesting limit exceeded')
      const stack = [...parentStack, definition.name]
      runtime.compositeStacks?.set(exec.token, stack)
      try {
        const results = []
        const steps = definition.steps
        let index = 0
        while (index < steps.length) {
          const group = []
          if (steps[index].parallel === true) {
            while (index < steps.length && steps[index].parallel === true) group.push({ step: steps[index], index: index++ })
          } else {
            group.push({ step: steps[index], index: index++ })
          }
          const canParallel = group.length > 1 && typeof runtime.tools.executionMode === 'function' && group.every(({ step }) => {
            const resolved = resolveValue(step.args, args, definition)
            return runtime.tools.get(step.tool, exec.agent) !== undefined
              && runtime.tools.executionMode({ name: step.tool, arguments: resolved, agent: exec.agent }).kind === 'parallel'
          })
          const groupResults = canParallel
            ? await Promise.all(group.map(({ step, index: stepIndex }) => runStep(runtime, definition, step, stepIndex, args, exec)))
            : []
          if (!canParallel) {
            for (const { step, index: stepIndex } of group) groupResults.push(await runStep(runtime, definition, step, stepIndex, args, exec))
          }
          results.push(...groupResults)
          const failed = groupResults.find((item) => item.isError)
          if (failed !== undefined) {
            return { ok: false, completedSteps: results.length, totalSteps: steps.length, results }
          }
        }
        return { ok: true, completedSteps: results.length, totalSteps: steps.length, results }
      } finally {
        runtime.compositeStacks?.delete(exec.token)
      }
    },
  }
}

function syncCompositeTools(runtime) {
  for (const dispose of runtime.compositeDisposers ?? []) {
    try { dispose() } catch {}
  }
  if (typeof runtime.compositePolicyDispose === 'function') {
    try { runtime.compositePolicyDispose() } catch {}
  }
  runtime.compositeDisposers = []
  runtime.compositePolicyDispose = null
  runtime.compositeDefinitions = new Map()
  runtime.compositeConflicts = []
  const existing = new Set(runtime.tools.schemas().map((schema) => schema.name))
  for (const definition of runtime.config.composites ?? []) {
    if (existing.has(definition.name)) {
      runtime.compositeConflicts.push(definition.name)
      continue
    }
    try {
      runtime.compositeDisposers.push(runtime.tools.register(createCompositeTool(runtime, definition)))
      runtime.compositeDefinitions.set(definition.name, definition)
      existing.add(definition.name)
    } catch (error) {
      runtime.compositeConflicts.push(definition.name)
      runtime.lastError = String(error?.message ?? error)
    }
  }
  if (runtime.compositeDefinitions.size > 0 && typeof runtime.ctx.on === 'function') {
    runtime.compositePolicyDispose = runtime.ctx.on('tools/pre-execute', async (exec, next) => {
      const definition = runtime.compositeDefinitions.get(exec.name)
      if (definition?.requiresConfirmation === true) {
        return { kind: 'ask', reason: `Run composite tool "${definition.name}"?` }
      }
      return next()
    })
  }
}

export { createCompositeTool, parametersOf, resolveValue, syncCompositeTools, validateArgs }
