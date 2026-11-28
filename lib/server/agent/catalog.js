function schemaBytes(schema) {
  try {
    return Buffer.byteLength(JSON.stringify(schema ?? {}), 'utf8')
  } catch {
    return 0
  }
}

function sourceKindOf(name) {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name.startsWith('plugin_console_')) return 'console'
  return 'unknown'
}

function riskHintsOf(name, description = '') {
  const text = `${name} ${description}`.toLowerCase()
  const hints = []
  if (/\b(write|edit|create|delete|remove|install|toggle|deploy|execute|run|bash|shell|command)\b/u.test(text)) hints.push('write')
  if (/\b(http|https|fetch|search|web|network|mcp|github|gitee)\b/u.test(text)) hints.push('network')
  if (/\b(read|list|get|search|query|status|inspect|view)\b/u.test(text)) hints.push('read')
  return hints.length > 0 ? hints : ['unknown']
}

function summarizeSchema(schema) {
  const name = typeof schema?.name === 'string' ? schema.name : ''
  const description = typeof schema?.description === 'string' ? schema.description : ''
  const parameters = schema?.parameters !== null && typeof schema?.parameters === 'object' ? schema.parameters : {}
  return {
    name,
    description,
    parameters,
    schemaBytes: schemaBytes(parameters),
    sourceKind: sourceKindOf(name),
    riskHints: riskHintsOf(name, description),
  }
}

function buildCatalog(schemas) {
  const catalog = new Map()
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    const item = summarizeSchema(schema)
    if (item.name === '') continue
    catalog.set(item.name, item)
  }
  return catalog
}

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
}

function searchCatalog(catalog, query, limit = 10) {
  const tokens = tokenize(query)
  const max = Math.min(20, Math.max(1, Number(limit) || 10))
  const scored = []
  for (const item of catalog.values()) {
    if (item.name === 'plugin_console_tool_search' || item.name === 'plugin_console_tool_activate') continue
    const name = item.name.toLowerCase()
    const description = item.description.toLowerCase()
    const paramNames = Object.keys(item.parameters?.properties ?? {}).join(' ').toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (name.includes(token)) score += token === name ? 12 : 6
      if (description.includes(token)) score += 3
      if (paramNames.includes(token)) score += 2
    }
    if (tokens.length === 0 || score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
  const items = scored.slice(0, max).map(({ item }) => ({
    name: item.name,
    description: item.description.slice(0, 180),
    sourceKind: item.sourceKind,
    riskHints: item.riskHints,
    schemaBytes: item.schemaBytes,
  }))
  return { items, total: scored.length, truncated: scored.length > items.length }
}

function normalizeName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '')
}

function detectConflicts(catalog) {
  const entries = [...catalog.values()].slice(0, 500)
  const conflicts = []
  const byNormalized = new Map()
  for (const item of entries) {
    const key = normalizeName(item.name)
    const list = byNormalized.get(key) ?? []
    list.push(item.name)
    byNormalized.set(key, list)
  }
  for (const names of byNormalized.values()) {
    if (names.length > 1) conflicts.push({ kind: 'name', tools: names })
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]
      const b = entries[j]
      if (a.sourceKind !== b.sourceKind) continue
      const aTokens = new Set(tokenize(a.description))
      const bTokens = new Set(tokenize(b.description))
      if (aTokens.size < 4 || bTokens.size < 4) continue
      let intersection = 0
      for (const token of aTokens) if (bTokens.has(token)) intersection += 1
      const union = aTokens.size + bTokens.size - intersection
      const similarity = union === 0 ? 0 : intersection / union
      if (similarity >= 0.82) conflicts.push({ kind: 'description', tools: [a.name, b.name], similarity })
    }
  }
  return conflicts
}

function optimizeDescription(description) {
  return String(description ?? '').replace(/\s+/gu, ' ').trim()
}

function analyzeSchema(item) {
  const issues = []
  const description = typeof item.description === 'string' ? item.description : ''
  const parameters = item.parameters !== null && typeof item.parameters === 'object' ? item.parameters : {}
  const properties = parameters.properties !== null && typeof parameters.properties === 'object' ? parameters.properties : {}
  if (description.trim() === '') issues.push({ code: 'empty-description', severity: 'high', message: 'Description is empty.' })
  else if (optimizeDescription(description) !== description) issues.push({ code: 'description-whitespace', severity: 'low', message: 'Description contains repeated whitespace.' })
  if (parameters.type !== undefined && parameters.type !== 'object') issues.push({ code: 'non-object-parameters', severity: 'high', message: 'Tool parameters should be an object schema.' })
  if (parameters.additionalProperties !== false) issues.push({ code: 'open-parameters', severity: 'medium', message: 'Undeclared parameters are currently allowed.' })
  for (const [name, schema] of Object.entries(properties)) {
    if (schema === null || typeof schema !== 'object' || typeof schema.description !== 'string' || schema.description.trim() === '') {
      issues.push({ code: 'missing-parameter-description', severity: 'medium', message: `Parameter "${name}" has no description.` })
    }
  }
  const required = Array.isArray(parameters.required) ? parameters.required : []
  for (const name of required) {
    if (!Object.hasOwn(properties, name)) issues.push({ code: 'required-not-declared', severity: 'high', message: `Required parameter "${name}" is not declared.` })
  }
  if (item.schemaBytes > 4096) issues.push({ code: 'large-schema', severity: 'medium', message: `Parameter schema is ${item.schemaBytes} bytes.` })
  return issues
}

function suggestDescription(item) {
  const current = optimizeDescription(item.description)
  if (current !== '') return current
  const names = Object.keys(item.parameters?.properties ?? {})
  return names.length === 0 ? `Invoke the ${item.name} tool.` : `Invoke the ${item.name} tool with: ${names.join(', ')}.`
}

function buildSchemaReport(catalog) {
  const items = [...catalog.values()].map((item) => ({
    name: item.name,
    sourceKind: item.sourceKind,
    schemaBytes: item.schemaBytes,
    originalDescription: item.description,
    suggestedDescription: suggestDescription(item),
    issues: analyzeSchema(item),
  }))
  items.sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name))
  return {
    items,
    summary: {
      tools: items.length,
      toolsWithIssues: items.filter((item) => item.issues.length > 0).length,
      highIssues: items.reduce((sum, item) => sum + item.issues.filter((issue) => issue.severity === 'high').length, 0),
      totalSchemaBytes: items.reduce((sum, item) => sum + item.schemaBytes, 0),
    },
  }
}

export { analyzeSchema, buildCatalog, buildSchemaReport, detectConflicts, optimizeDescription, schemaBytes, searchCatalog, suggestDescription, summarizeSchema, tokenize }
