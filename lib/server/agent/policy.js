import { tokenize } from './catalog.js'

const INTERNAL_GOVERNANCE_TOOLS = new Set(['plugin_console_tool_search', 'plugin_console_tool_activate', 'run_code'])

function extractMessageText(message) {
  const parts = []
  const content = message?.content
  if (typeof content === 'string') parts.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function scoreTool(item, taskTokens) {
  if (taskTokens.length === 0) return 0
  const name = item.name.toLowerCase()
  const description = item.description.toLowerCase()
  const paramNames = Object.keys(item.parameters?.properties ?? {}).join(' ').toLowerCase()
  let score = 0
  for (const token of taskTokens) {
    if (name === token) score += 12
    else if (name.includes(token)) score += 6
    if (description.includes(token)) score += 3
    if (paramNames.includes(token)) score += 2
  }
  return score
}

function selectActiveTools({
  available,
  governanceTools = [],
  baselineTools = [],
  protectedTools = [],
  pinnedTools = [],
  hiddenTools = [],
  recentTools = [],
  activatedTools = [],
  composites = [],
  maxActiveTools = 12,
  taskText = '',
}) {
  const items = [...(available instanceof Map ? available.values() : available)]
  const byName = new Map(items.map((item) => [item.name, item]))
  const compositeMap = new Map(composites.map((item) => [item.name, item]))
  const hidden = new Set(hiddenTools)
  const protectedSet = new Set(protectedTools)
  // Native/host tools are always visible; the active cap applies to the remaining
  // (mostly third-party) tools. This is the product boundary: governance must not
  // hide DSH's own search/file tools just because the task text lacks English words.
  const limit = protectedSet.size + Math.max(governanceTools.length, Number(maxActiveTools) || 12)
  const selected = new Set([...governanceTools, ...protectedTools])
  const add = (name) => {
    if (selected.size >= limit || !byName.has(name) || hidden.has(name)) return false
    selected.add(name)
    return true
  }
  const dependencyList = (name, seen = new Set()) => {
    if (seen.has(name)) return []
    seen.add(name)
    const dependencies = []
    for (const step of compositeMap.get(name)?.steps ?? []) {
      if (hidden.has(step.tool) || !byName.has(step.tool)) return null
      dependencies.push(step.tool)
      if (compositeMap.has(step.tool)) {
        const nested = dependencyList(step.tool, seen)
        if (nested === null) return null
        dependencies.push(...nested)
      }
    }
    return [...new Set(dependencies)]
  }
  const addWithDependencies = (name) => {
    if (selected.has(name)) return true
    if (!byName.has(name) || hidden.has(name)) return false
    const dependencies = dependencyList(name)
    if (dependencies === null) return false
    const missing = dependencies.filter((dependency) => !selected.has(dependency))
    if (selected.size + 1 + missing.length > limit) return false
    selected.add(name)
    for (const dependency of missing) add(dependency)
    return true
  }
  for (const name of baselineTools) add(name)
  for (const name of pinnedTools) addWithDependencies(name)
  for (const name of activatedTools) addWithDependencies(name)
  for (const name of recentTools) add(name)
  const taskTokens = tokenize(taskText)
  if (taskTokens.length > 0) {
    const ranked = items
      .filter((item) => !selected.has(item.name) && !hidden.has(item.name) && !INTERNAL_GOVERNANCE_TOOLS.has(item.name))
      .map((item) => ({ item, score: scoreTool(item, taskTokens) }))
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    for (const { item, score } of ranked) {
      if (selected.size >= limit) break
      // 只收任务相关（正分）；零分的不再按字母序塞满上限。
      if (score <= 0) break
      if (compositeMap.has(item.name)) addWithDependencies(item.name)
      else add(item.name)
    }
  }
  return items.filter((item) => selected.has(item.name)).map((item) => item.name)
}

export { extractMessageText, scoreTool, selectActiveTools }
