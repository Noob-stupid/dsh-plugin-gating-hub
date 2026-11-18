// L1 · domain —— version-gate.js（版本变更自动拦截：一次扫描 + 写禁用块 + 记待适配；0.5.111 加法）
//
// 用户 2026-11-18：「连版本自动拦截是有的，但是拦截成功后门控好像不显示，默认开呗」。
// 这里把「版本变更 → 跑一次适配门」从**我们自己的升级流程**扩展到**任何来源的版本变化**：
//   · 触发源：/state 或 /compat-status 看到 runtimeVersion !== compat-gate.version；
//   · 判据：复用 domain/framework.js#preflightDisableIncompatible（与升级前预扫同一条链）；
//   · 结果：只禁 fail 行（框架自带/受保护/自身永不禁用），并写 compat-pending（面板「待适配」）；
//   · 默认开：compat-gate.json#autoDisable 默认 true；关掉则只记版本、不写补丁。
//
// 硬边界：
//   · 绝不阻塞调用方：schedule 返回后扫描在后台跑；面板靠 versionGate.scheduled 自动刷新一次；
//   · 同一版本只跑一次（in-flight + 成功后写 gate.version）；
//   · 扫描失败/写补丁失败不写 version，下一轮会重试；不假装成功。
import { readCompatGate, writeCompatGate } from './compat.js'
import { preflightDisableIncompatible } from './framework.js'

const inFlight = new Map()

/** 判定（纯函数）：这个版本需不需要跑一次版本门。 */
function shouldRunVersionGate({ currentVersion = null, gate = null } = {}) {
  if (typeof currentVersion !== 'string' || currentVersion === '') return { run: false, reason: 'no-version' }
  const version = gate !== null && typeof gate === 'object' ? gate.version : null
  if (version === currentVersion) return { run: false, reason: 'same-version' }
  return { run: true, reason: version === null ? 'first-seen' : 'version-changed' }
}

/**
 * 真正跑一次。返回 `{ok, ran, version, disabled, skipped, reason, error}`。
 * 写 gate.version 只在扫描成功之后（失败重试，不丢机会）。
 */
async function runVersionGate({ ports, profileDir, patchPath, currentVersion, gate = readCompatGate() } = {}) {
  const version = typeof currentVersion === 'string' && currentVersion !== '' ? currentVersion : null
  if (version === null) return { ok: false, ran: false, version: null, reason: 'no-version' }
  if (gate.version === version) return { ok: true, ran: false, version, reason: 'same-version' }
  if (gate.autoDisable !== true) {
    // 关掉自动禁用：只记“这个版本看过了”，不写补丁；面板不会出现待适配记录（如实）
    writeCompatGate({ version, gatedAt: Date.now() })
    return { ok: true, ran: false, version, reason: 'auto-disable-off', disabled: [], skipped: [] }
  }
  let result
  try {
    result = await preflightDisableIncompatible({ ports, profileDir, patchPath, targetVersion: version })
  } catch (error) {
    return { ok: false, ran: false, version, reason: 'failed', error: error instanceof Error ? error.message : String(error), disabled: [], skipped: [] }
  }
  if (result === null || typeof result !== 'object') {
    return { ok: false, ran: false, version, reason: 'failed', error: '预检没有返回结论', disabled: [], skipped: [] }
  }
  writeCompatGate({ version, gatedAt: Date.now() })
  return {
    ok: true,
    ran: true,
    version,
    disabled: Array.isArray(result.disabled) ? result.disabled : [],
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
  }
}

/**
 * 非阻塞调度：同一版本只起一个任务；返回给 `/state` / `/compat-status` 的
 * `{scheduled, version, reason}`，面板据此自动刷新一次。
 */
function scheduleVersionGate({ ports, profileDir, patchPath, currentVersion, gate = readCompatGate() } = {}) {
  const verdict = shouldRunVersionGate({ currentVersion, gate })
  if (verdict.run !== true) return { scheduled: false, version: typeof currentVersion === 'string' ? currentVersion : null, reason: verdict.reason }
  const version = currentVersion
  if (inFlight.has(version)) return { scheduled: true, version, reason: 'in-flight' }
  const task = runVersionGate({ ports, profileDir, patchPath, currentVersion: version, gate })
    .catch(() => ({ ok: false, ran: false, version, reason: 'failed' }))
    .finally(() => { inFlight.delete(version) })
  inFlight.set(version, task)
  return { scheduled: true, version, reason: verdict.reason }
}

export { runVersionGate, scheduleVersionGate, shouldRunVersionGate }
