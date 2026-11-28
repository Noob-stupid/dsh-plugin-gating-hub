import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'

const CONFIG_FILE = 'tool-governance.json'
const AUDIT_FILE = 'tool-governance-audit.jsonl'
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  minCatalogTools: 10,
  maxActiveTools: 12,
  protectedTools: ['read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep', 'bash', 'web_search', 'web_fetch'],
  baselineTools: ['bash', 'str_replace_editor', 'glob', 'grep', 'read', 'write', 'edit'],
  pinnedTools: [],
  hiddenTools: [],
  descriptionOverrides: {},
  composites: [],
  optimizeDescriptions: true,
}

function stateDir(home = undefined) {
  return join(home ?? dshHome(), 'plugin-console')
}

function configPath(home = undefined) {
  return join(stateDir(home), CONFIG_FILE)
}

function eventsFile(home = undefined) {
  return join(stateDir(home), 'tool-governance-events.jsonl')
}

function normalizeNames(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || !NAME_PATTERN.test(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= 200) break
  }
  return out
}

function normalizeOverrides(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [name, description] of Object.entries(value).slice(0, 200)) {
    if (!NAME_PATTERN.test(name) || UNSAFE_KEYS.has(name) || typeof description !== 'string') continue
    const text = description.replace(/\s+/gu, ' ').trim().slice(0, 2000)
    if (text !== '') out[name] = text
  }
  return out
}

const INPUT_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'object', 'array'])

function normalizeInputSchema(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (!INPUT_TYPES.has(value.type)) return null
  return {
    type: value.type,
    description: typeof value.description === 'string' ? value.description.slice(0, 500) : '',
    required: value.required === true,
  }
}

function normalizeComposite(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!NAME_PATTERN.test(name) || !name.startsWith('plugin_console_')) return null
  const inputs = {}
  if (value.inputs !== null && typeof value.inputs === 'object' && !Array.isArray(value.inputs)) {
    for (const [key, schema] of Object.entries(value.inputs).slice(0, 20)) {
      if (!NAME_PATTERN.test(key) || UNSAFE_KEYS.has(key)) continue
      const normalized = normalizeInputSchema(schema)
      if (normalized !== null) inputs[key] = normalized
    }
  }
  const steps = []
  if (Array.isArray(value.steps)) {
    for (const step of value.steps.slice(0, 20)) {
      if (step === null || typeof step !== 'object' || Array.isArray(step)) continue
      const tool = typeof step.tool === 'string' ? step.tool.trim() : ''
      if (!NAME_PATTERN.test(tool)) continue
      if (step.args === null || typeof step.args !== 'object' || Array.isArray(step.args)) continue
      steps.push({ tool, args: step.args, parallel: step.parallel === true })
    }
  }
  if (steps.length === 0) return null
  return {
    name,
    description: typeof value.description === 'string' ? value.description.replace(/\s+/gu, ' ').trim().slice(0, 1000) : name,
    inputs,
    steps,
    requiresConfirmation: value.requiresConfirmation !== false,
  }
}

function normalizeComposites(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value.slice(0, 50)) {
    const composite = normalizeComposite(item)
    if (composite === null || seen.has(composite.name)) continue
    seen.add(composite.name)
    out.push(composite)
  }
  const byName = new Map(out.map((item) => [item.name, item]))
  const cyclic = new Set()
  const visit = (name, stack) => {
    if (cyclic.has(name)) return
    const at = stack.indexOf(name)
    if (at >= 0) {
      for (const item of stack.slice(at)) cyclic.add(item)
      return
    }
    const composite = byName.get(name)
    if (composite === undefined) return
    for (const step of composite.steps) {
      if (byName.has(step.tool)) visit(step.tool, [...stack, name])
    }
  }
  for (const name of byName.keys()) visit(name, [])
  return out.filter((item) => !cyclic.has(item.name))
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const maxActiveTools = Number(source.maxActiveTools)
  return {
    version: 1,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_CONFIG.enabled,
    minCatalogTools: Number.isInteger(Number(source.minCatalogTools)) ? Math.min(1000, Math.max(4, Number(source.minCatalogTools))) : DEFAULT_CONFIG.minCatalogTools,
    maxActiveTools: Number.isInteger(maxActiveTools) ? Math.min(100, Math.max(4, maxActiveTools)) : DEFAULT_CONFIG.maxActiveTools,
    protectedTools: normalizeNames(source.protectedTools === undefined ? DEFAULT_CONFIG.protectedTools : source.protectedTools),
    baselineTools: normalizeNames(source.baselineTools === undefined ? DEFAULT_CONFIG.baselineTools : source.baselineTools),
    pinnedTools: normalizeNames(source.pinnedTools),
    hiddenTools: normalizeNames(source.hiddenTools),
    descriptionOverrides: normalizeOverrides(source.descriptionOverrides),
    composites: normalizeComposites(source.composites),
    optimizeDescriptions: typeof source.optimizeDescriptions === 'boolean' ? source.optimizeDescriptions : DEFAULT_CONFIG.optimizeDescriptions,
  }
}

function readToolGovernanceConfig({ home = undefined } = {}) {
  const file = configPath(home)
  try {
    if (!existsSync(file)) return { config: { ...DEFAULT_CONFIG }, file, exists: false, error: null }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { config: normalizeConfig(raw), file, exists: true, error: null }
  } catch (error) {
    return { config: { ...DEFAULT_CONFIG }, file, exists: true, error: String(error?.message ?? error) }
  }
}

function writeToolGovernanceConfig(patch = {}, { home = undefined } = {}) {
  const current = readToolGovernanceConfig({ home })
  const next = normalizeConfig({ ...current.config, ...(patch !== null && typeof patch === 'object' ? patch : {}) })
  const file = configPath(home)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    const warnings = []
    if (patch?.maxActiveTools !== undefined && Number(patch.maxActiveTools) !== next.maxActiveTools) {
      warnings.push(`maxActiveTools was normalized to ${next.maxActiveTools}.`)
    }
    for (const key of ['baselineTools', 'pinnedTools', 'hiddenTools']) {
      if (Array.isArray(patch?.[key]) && next[key].length !== patch[key].length) warnings.push(`Some ${key} entries were invalid or duplicated and were ignored.`)
    }
    if (Array.isArray(patch?.composites) && next.composites.length !== patch.composites.length) {
      warnings.push('Some composite definitions were invalid, duplicated, or cyclic and were ignored.')
    }
    if (patch?.descriptionOverrides !== null && typeof patch?.descriptionOverrides === 'object' && !Array.isArray(patch.descriptionOverrides)) {
      const requested = Object.keys(patch.descriptionOverrides).length
      if (Object.keys(next.descriptionOverrides).length !== requested) warnings.push('Some description overrides were invalid and were ignored.')
    }
    return { ok: true, config: next, file, warnings, error: null }
  } catch (error) {
    try { if (existsSync(tmp)) renameSync(tmp, `${file}.failed-${Date.now()}`) } catch {}
    return { ok: false, config: current.config, file, error: String(error?.message ?? error) }
  }
}

function appendToolGovernanceAudit(entry, { home = undefined } = {}) {
  const file = join(stateDir(home), AUDIT_FILE)
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

export { DEFAULT_CONFIG, appendToolGovernanceAudit, eventsFile, readToolGovernanceConfig, writeToolGovernanceConfig }
