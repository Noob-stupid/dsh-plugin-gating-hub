import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

function createTelemetry({ maxEvents = 500, file = null, maxFileBytes = 1024 * 1024, maxFiles = 3 } = {}) {
  const events = []
  const starts = new Map()
  const limit = Math.max(50, Number(maxEvents) || 500)
  const byteLimit = Math.max(4096, Number(maxFileBytes) || 1024 * 1024)
  const rotations = Math.max(1, Number(maxFiles) || 3)
  let persistedEvents = 0
  let writeErrors = 0

  function rotate() {
    if (file === null || !existsSync(file)) return true
    try {
      rmSync(`${file}.${rotations}`, { force: true })
      for (let index = rotations - 1; index >= 1; index -= 1) {
        const from = `${file}.${index}`
        if (existsSync(from)) renameSync(from, `${file}.${index + 1}`)
      }
      renameSync(file, `${file}.1`)
      return true
    } catch {
      return false
    }
  }

  function persist(line) {
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const size = existsSync(file) ? statSync(file).size : 0
      if (size > 0 && size + Buffer.byteLength(line, 'utf8') > byteLimit && !rotate()) {
        writeErrors += 1
        return
      }
      appendFileSync(file, line, 'utf8')
      persistedEvents += 1
    } catch {
      writeErrors += 1
    }
  }

  function record(event) {
    if (event === null || typeof event !== 'object') return
    const safe = {
      at: Date.now(),
      kind: typeof event.kind === 'string' ? event.kind : 'unknown',
      tool: typeof event.tool === 'string' ? event.tool : null,
      callId: typeof event.callId === 'string' ? event.callId : null,
      agentId: typeof event.agentId === 'string' ? event.agentId : null,
      durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
      isError: event.isError === true,
      errorCode: typeof event.errorCode === 'string' ? event.errorCode : null,
      contentBytes: Number.isFinite(event.contentBytes) ? Math.max(0, Math.round(event.contentBytes)) : null,
      activeCount: Number.isFinite(event.activeCount) ? Math.max(0, Math.round(event.activeCount)) : null,
      schemaBytes: Number.isFinite(event.schemaBytes) ? Math.max(0, Math.round(event.schemaBytes)) : null,
      known: event.known === true,
      active: event.active === true,
    }
    events.push(safe)
    if (events.length > limit) events.splice(0, events.length - limit)
    persist(`${JSON.stringify(safe)}\n`)
  }

  function start(exec) {
    starts.set(exec.callId, Date.now())
  }

  function finish(exec, result) {
    const startedAt = starts.get(exec.callId)
    starts.delete(exec.callId)
    return {
      durationMs: startedAt === undefined ? null : Date.now() - startedAt,
      isError: result?.isError === true,
      errorCode: result?.error?.info?.code ?? result?.error?.name ?? null,
      contentBytes: Array.isArray(result?.content)
        ? result.content.reduce((sum, block) => sum + (typeof block?.text === 'string' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
        : 0,
    }
  }

  function summary() {
    const calls = events.filter((event) => event.kind === 'selection')
    const executions = events.filter((event) => event.kind === 'execute')
    const durations = executions.map((event) => event.durationMs).filter((value) => value !== null)
    const errors = events.filter((event) => event.kind === 'result' && event.isError)
    return {
      totalEvents: events.length,
      toolCalls: calls.length,
      unknownCalls: calls.filter((event) => !event.known).length,
      inactiveCalls: calls.filter((event) => event.known && !event.active).length,
      failedCalls: errors.length,
      avgDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      lastSchemaBytes: [...events].reverse().find((event) => event.kind === 'exposure')?.schemaBytes ?? null,
      lastActiveCount: [...events].reverse().find((event) => event.kind === 'exposure')?.activeCount ?? null,
      persistedEvents,
      writeErrors,
    }
  }

  function recent(count = 20) {
    return events.slice(-Math.min(100, Math.max(1, Number(count) || 20)))
  }

  return { record, start, finish, summary, recent }
}

export { createTelemetry }
