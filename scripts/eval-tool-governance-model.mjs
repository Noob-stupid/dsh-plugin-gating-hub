// Real-model A/B: all tools vs governed active set + search/activate.
//
// This is a model-level tool-selection benchmark using real third-party plugin
// tool schemas (breadboard / OpenViking / marketplace) plus native DSH tools.
// It does NOT execute the target plugin, and it is not a full DSH Agent E2E.
//
// Usage: node scripts/eval-tool-governance-model.mjs
// Reads DEEPSEEK_API_KEY from env or ~/.dsh/.credentials.yaml; never prints it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildCatalog } from '../lib/server/agent/catalog.js'
import { selectActiveTools } from '../lib/server/agent/policy.js'

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const KEY = loadKey()

function loadKey() {
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim() !== '') return process.env.DEEPSEEK_API_KEY.trim()
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = /DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s]+)["']?/u.exec(text)
    return m ? m[1] : ''
  } catch { return '' }
}

const t = (name, description, properties = {}) => ({ name, description, parameters: { type: 'object', additionalProperties: false, properties, required: [] } })
const native = [
  t('read', 'Read a local file from the workspace', { path: { type: 'string' } }),
  t('write', 'Write a local file in the workspace', { path: { type: 'string' }, content: { type: 'string' } }),
  t('edit', 'Edit a local file with an exact string replacement', { path: { type: 'string' } }),
  t('glob', 'Find files by path pattern', { pattern: { type: 'string' } }),
  t('grep', 'Search file contents by regular expression', { pattern: { type: 'string' } }),
  t('web_search', 'Search the public web for current information', { queries: { type: 'array', items: { type: 'string' } } }),
  t('web_fetch', 'Fetch an HTTP(S) URL and return readable text', { url: { type: 'string' } }),
  t('bash', 'Run a shell command in the workspace', { command: { type: 'string' } }),
]
const breadboard = [
  t('hw_list_projects', 'List hardware sandbox projects and whether their software/hardware link is connected'),
  t('hw_import_project', 'Import a hardware project into the sandbox, placing all parts and wires', { projectId: { type: 'string' } }),
  t('hw_get_assembly', 'Read the current virtual hardware assembly, components, ports and wires'),
  t('hw_run_simulation', 'Run a real project against the virtual hardware for a given virtual duration', { projectPath: { type: 'string' }, duration: { type: 'number' } }),
  t('hw_network_devices', 'List network devices, protocol, endpoint, online status and readings'),
  t('hw_inject_fault', 'Inject a hardware fault such as disconnect, nack, busy or a forced reading', { target: { type: 'string' }, type: { type: 'string' } }),
]
const openviking = [
  t('mcp__openviking__find', 'Fast semantic retrieval across memories and resources', { query: { type: 'string' } }),
  t('mcp__openviking__search', 'Deep semantic retrieval with session context and ranked memories', { query: { type: 'string' } }),
  t('mcp__openviking__remember', 'Store facts, preferences or decisions into long-term memory', { messages: { type: 'array', items: { type: 'object' } } }),
  t('mcp__openviking__read', 'Read files from the OpenViking knowledge scope', { uris: { type: 'array', items: { type: 'string' } } }),
]
const misc = [
  t('dshmarket_search', 'Search the DSH plugin marketplace for installable packages', { query: { type: 'string' } }),
  t('connection_card_send', 'Send a message to a connected peer session', { text: { type: 'string' } }),
  t('schedule_create', 'Create a scheduled reminder task', { title: { type: 'string' }, prompt: { type: 'string' }, rrule: { type: 'string' } }),
  t('image_generate', 'Generate an image from a text prompt', { prompt: { type: 'string' } }),
  t('office_sheet', 'Create a spreadsheet document', { title: { type: 'string' } }),
  t('lsp', 'Query language-server diagnostics for a workspace file', { path: { type: 'string' } }),
]
const all = [...native, ...breadboard, ...openviking, ...misc]
const catalog = buildCatalog(all)
const GOVERN = ['plugin_console_tool_search', 'plugin_console_tool_activate']
const governanceTools = [
  t('plugin_console_tool_search', 'Search the complete tool catalog when the needed tool is not currently exposed', { query: { type: 'string' } }),
  t('plugin_console_tool_activate', 'Activate hidden tools by name for the next model step', { names: { type: 'array', items: { type: 'string' } } }),
]

const TASKS = [
  { id: 'hw-list', prompt: '先看看本机硬件沙盒里有哪些项目，并告诉我哪个项目是智座、当前是否连通。', expected: 'hw_list_projects' },
  { id: 'hw-run', prompt: '把智座项目放进硬件沙盒，然后运行一次仿真，确认双红外读数能被系统收到。', expected: 'hw_run_simulation' },
  { id: 'memory-find', prompt: '查一下我们之前关于 issue #28 核心包诊断的结论。', expected: ['mcp__openviking__find', 'mcp__openviking__search'] },
  { id: 'memory-store', prompt: '记住我的偏好：插件界面尽量使用 DSH 原生风格，不要自建设计语言。', expected: 'mcp__openviking__remember' },
  { id: 'repo-search', prompt: '在 README 里找一下 tool govern 相关的内容。', expected: 'grep' },
  { id: 'web-search', prompt: '查一下 DeepSeek Harness 最近的发布信息。', expected: 'web_search' },
]

const toolsFor = (names) => [...names].map((name) => {
  const item = [...all, ...governanceTools].find((tool) => tool.name === name)
  return item ? { type: 'function', function: { name: item.name, description: item.description, parameters: item.parameters } } : null
}).filter(Boolean)

function search(query) {
  const tokens = String(query ?? '').toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/u).filter((x) => x.length > 1)
  return [...catalog.values()]
    .map((item) => {
      const text = `${item.name} ${item.description}`.toLowerCase()
      let score = 0
      for (const token of tokens) if (text.includes(token)) score += item.name.includes(token) ? 3 : 1
      return { name: item.name, description: item.description, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
}

async function chat(messages, tools) {
  const started = Date.now()
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, temperature: 0, tools, tool_choice: 'auto', messages }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`model HTTP ${response.status}: ${body?.error?.message ?? 'unknown'}`)
  return { message: body.choices?.[0]?.message ?? {}, usage: body.usage ?? {}, latencyMs: Date.now() - started }
}

async function runOne(task, mode) {
  const baseline = native.map((x) => x.name)
  const active = mode === 'baseline'
    ? all.map((x) => x.name)
    : [...new Set([...GOVERN, ...selectActiveTools({ available: catalog, governanceTools: GOVERN, baselineTools: baseline, protectedTools: baseline, maxActiveTools: 12, taskText: task.prompt })])]
  let visible = mode === 'baseline' ? active : active
  const messages = [
    { role: 'system', content: 'You are a DSH agent. Use one tool to accomplish the user request. Prefer a specialized tool over bash/grep. If the tool you need is not listed, call plugin_console_tool_search first. Do not answer with prose when a tool is required.' },
    { role: 'user', content: task.prompt },
  ]
  const calls = []
  const expected = Array.isArray(task.expected) ? task.expected : [task.expected]
  for (let step = 0; step < 5; step += 1) {
    const { message, usage, latencyMs } = await chat(messages, toolsFor(visible))
    calls.push({ step, tool: message.tool_calls?.[0]?.function?.name ?? null, latencyMs })
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      return { ...task, mode, success: false, calls, visible: active.length, usage, reason: 'no tool call' }
    }
    const call = message.tool_calls[0]
    const name = call.function?.name
    const args = (() => { try { return JSON.parse(call.function?.arguments ?? '{}') } catch { return {} } })()
    messages.push({ role: 'assistant', tool_calls: [call] })
    if (name === 'plugin_console_tool_search') {
      const result = search(args.query)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      continue
    }
    if (name === 'plugin_console_tool_activate') {
      const names = Array.isArray(args.names) ? args.names.filter((x) => typeof x === 'string') : []
      const added = names.filter((x) => catalog.has(x) || x === 'lsp')
      visible = [...new Set([...visible, ...added])]
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ activated: added, effectiveNextStep: added.length > 0 }) })
      continue
    }
    if (expected.includes(name)) {
      return { ...task, mode, success: true, called: name, calls, visible: active.length, usage, reason: 'expected tool called' }
    }
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Tool ${name} is not the best match; choose another tool from the current list or search.` }) })
  }
  return { ...task, mode, success: false, calls, visible: active.length, reason: 'step limit' }
}

if (KEY === '') {
  console.error('No DEEPSEEK_API_KEY; set env or add it to ~/.dsh/.credentials.yaml')
  process.exit(2)
}

const results = []
for (const task of TASKS) {
  for (const mode of ['baseline', 'governed']) {
    try {
      const result = await runOne(task, mode)
      results.push(result)
      console.log(`${mode.padEnd(8)} ${task.id.padEnd(12)} success=${result.success} tool=${result.called ?? result.calls?.[0]?.tool ?? 'none'} visible=${result.visible}`)
    } catch (error) {
      results.push({ ...task, mode, success: false, error: String(error?.message ?? error) })
      console.log(`${mode.padEnd(8)} ${task.id.padEnd(12)} ERROR ${String(error?.message ?? error)}`)
    }
  }
}

const summarize = (mode) => {
  const rows = results.filter((x) => x.mode === mode)
  const success = rows.filter((x) => x.success).length
  const usage = rows.reduce((acc, x) => ({ prompt: acc.prompt + (x.usage?.prompt_tokens ?? 0), completion: acc.completion + (x.usage?.completion_tokens ?? 0) }), { prompt: 0, completion: 0 })
  return { mode, tasks: rows.length, success, successRate: rows.length === 0 ? 0 : Math.round((success / rows.length) * 1000) / 1000, promptTokens: usage.prompt, completionTokens: usage.completion }
}
const summary = { baseline: summarize('baseline'), governed: summarize('governed') }
const out = { at: new Date().toISOString(), model: MODEL, tasks: TASKS.length, summary, results }
mkdirSync(join(process.cwd(), 'docs'), { recursive: true })
writeFileSync(join(process.cwd(), 'docs', 'tool-governance-model-eval.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log('\nSummary:', JSON.stringify(summary, null, 2))
