// M3 · evaluator.js —— 检索层 golden task A/B
//
// 这里评测的是「治理策略是否把那把该用的工具放进了当前可见集合」，
// 不是模型端到端任务成功率。模型 A/B 仍需要真实会话/费用，不能由本模块冒充。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'
import { buildCatalog } from './catalog.js'
import { selectActiveTools } from './policy.js'

const GOLDEN_TASKS = [
  { id: 'docs', task: 'search project documentation pages', expected: ['svc_45_search_docs'] },
  { id: 'issue', task: 'look up a GitHub issue and read comments', expected: ['svc_46_issue_lookup'] },
  { id: 'database', task: 'query the database rows', expected: ['svc_47_db_query'] },
  { id: 'web', task: 'fetch a web page from the internet', expected: ['svc_48_web_fetch'] },
  { id: 'files', task: 'read and edit a local file', expected: ['svc_49_file_read', 'svc_50_file_edit'] },
  { id: 'office', task: 'create an office spreadsheet document', expected: ['svc_51_office_sheet'] },
  { id: 'calendar', task: 'list calendar events for today', expected: ['svc_52_calendar_list'] },
  { id: 'mail', task: 'send an email message', expected: ['svc_53_mail_send'] },
  { id: 'image', task: 'generate an image from a prompt', expected: ['svc_54_image_generate'] },
  { id: 'shell', task: 'run a shell command in the workspace', expected: ['svc_55_shell_run'] },
]

const SPECIAL = {
  45: ['search_docs', 'Search project documentation pages and return matches'],
  46: ['issue_lookup', 'Look up a GitHub issue and read its comments'],
  47: ['db_query', 'Query database rows with SQL-like filters'],
  48: ['web_fetch', 'Fetch a web page from the internet'],
  49: ['file_read', 'Read a local file from the workspace'],
  50: ['file_edit', 'Edit a local file in the workspace'],
  51: ['office_sheet', 'Create an office spreadsheet document'],
  52: ['calendar_list', 'List calendar events for a date range'],
  53: ['mail_send', 'Send an email message'],
  54: ['image_generate', 'Generate an image from a text prompt'],
  55: ['shell_run', 'Run a shell command in the workspace'],
}

function fixtureTools() {
  const items = []
  for (let i = 0; i < 80; i += 1) {
    const special = SPECIAL[i]
    const name = special ? `svc_${i}_${special[0]}` : `svc_${i}_op`
    items.push({
      name,
      description: special ? special[1] : `Service operation ${i} for workspace resource ${i}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Resource identifier' },
          query: { type: 'string', description: 'Optional query text' },
          limit: { type: 'integer', description: 'Maximum rows' },
          cursor: { type: 'string', description: 'Pagination cursor' },
          include: { type: 'array', items: { type: 'string' }, description: 'Fields to include' },
          dryRun: { type: 'boolean', description: 'Preview only' },
        },
      },
    })
  }
  return items
}

function bytesOf(catalog, names) {
  return names.reduce((sum, name) => sum + (catalog.get(name)?.schemaBytes ?? 0), 0)
}

function evaluateOne(catalog, item, options) {
  const all = [...catalog.keys()]
  const governed = selectActiveTools({
    available: catalog,
    governanceTools: ['plugin_console_tool_search', 'plugin_console_tool_activate'],
    baselineTools: options.baselineTools,
    maxActiveTools: options.maxActiveTools,
    taskText: item.task,
  })
  const expected = item.expected.filter((name) => catalog.has(name))
  const hits = expected.filter((name) => governed.includes(name))
  return {
    id: item.id,
    task: item.task,
    expected,
    governed,
    hits,
    recall: expected.length === 0 ? 0 : hits.length / expected.length,
    precision: governed.length === 0 ? 0 : hits.length / governed.length,
    baselineSchemaBytes: bytesOf(catalog, all),
    governedSchemaBytes: bytesOf(catalog, governed),
  }
}

/**
 * 纯评测：不调用模型、不访问宿主。
 * @returns {{ok:boolean, tasks:object[], summary:object, mode:string}}
 */
function evaluateGoldenTasks({ maxActiveTools = 12, baselineTools = ['svc_0_op', 'svc_1_op'] } = {}) {
  const items = fixtureTools()
  const catalog = buildCatalog(items)
  const tasks = GOLDEN_TASKS.map((item) => evaluateOne(catalog, item, { maxActiveTools, baselineTools }))
  const average = (pick) => tasks.length === 0 ? 0 : tasks.reduce((sum, task) => sum + pick(task), 0) / tasks.length
  const baselineBytes = tasks.length === 0 ? 0 : tasks[0].baselineSchemaBytes
  const governedBytes = average((task) => task.governedSchemaBytes)
  return {
    ok: true,
    mode: 'retrieval-level golden tasks (no model calls)',
    tasks,
    summary: {
      count: tasks.length,
      recall: Math.round(average((task) => task.recall) * 1000) / 1000,
      precision: Math.round(average((task) => task.precision) * 1000) / 1000,
      avgActiveTools: Math.round(average((task) => task.governed.length) * 10) / 10,
      baselineSchemaBytes: baselineBytes,
      governedSchemaBytes: Math.round(governedBytes),
      schemaReductionPct: baselineBytes === 0 ? 0 : Math.round((1 - governedBytes / baselineBytes) * 1000) / 10,
    },
  }
}

function evalFile(home = undefined) {
  return join(home ?? dshHome(), 'plugin-console', 'tool-governance-eval.json')
}

function latestEvaluation({ home = undefined } = {}) {
  try { return JSON.parse(readFileSync(evalFile(home), 'utf8')) } catch { return null }
}

function runGoldenEvaluation({ home = undefined, now = Date.now(), write = true } = {}) {
  const result = evaluateGoldenTasks()
  const record = { at: new Date(now).toISOString(), ...result }
  if (write === true) {
    try {
      const file = evalFile(home)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch {}
  }
  return record
}

export { evaluateGoldenTasks, latestEvaluation, runGoldenEvaluation }
