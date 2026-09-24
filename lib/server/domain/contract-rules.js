// L1 · domain —— 契约规则库的读取层
//
// 为什么把规则做成「数据」而不是散在代码里（2026-09-24 桌面端复盘）：
//   门控此前寄生在「我们自己的升级流程」上；官方桌面端一旦自带升级器、或官方只发桌面端，
//   触发点就没了。规则外置之后，**预检对任何来源的框架变更都成立**：只要有人把框架版本从 A
//   变成 B，就能拿规则库比对（我们的升级器、官方升级器、手动 pnpm 都一样）。
//   同时规则库是唯一能被社区直接 PR 的产物 —— 事故进规则、规则进测试。
//
// 数据文件随包发布（lib/contracts/rules.json，`files` 白名单已含 lib/**），
// 因此用户装到的是同一份规则；仓库侧另有 docs/contracts/README.md 说明格式与收录方式。
//
// 读不到文件时退化为**空规则库**（如实回报 source='unavailable'），绝不让预检因为规则文件
// 缺失而假装「零发现」——调用方拿 source 字段判断可信度。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginRoot } from '../infra/paths.js'

const RULES_RELATIVE = join('lib', 'contracts', 'rules.json')
const KINDS = ['contract-edge', 'dependency-api', 'config-schema', 'removed-api', 'loader-contract']
const SEVERITIES = ['blocker', 'warn']

function rulesPath() {
  return join(pluginRoot(), RULES_RELATIVE)
}

/** 只保留字段齐全、取值合法的规则（脏数据宁可丢一条，也不要让预检报错或误报）。 */
function normalizeRule(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  const since = typeof raw.since === 'string' && raw.since !== '' ? raw.since : null
  if (id === null || since === null) return null
  return {
    id,
    since,
    kind: KINDS.includes(raw.kind) ? raw.kind : 'contract-edge',
    severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'warn',
    title: typeof raw.title === 'string' ? raw.title : id,
    detect: typeof raw.detect === 'string' ? raw.detect : '',
    fix: typeof raw.fix === 'string' ? raw.fix : '',
    implementedBy: typeof raw.implementedBy === 'string' && raw.implementedBy !== '' ? raw.implementedBy : null,
    evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
  }
}

/**
 * 读规则库。
 * @returns {{ source: 'pack'|'unavailable', version: number|null, updatedAt: string|null, rules: object[], error: string|null }}
 */
function loadContractRules() {
  const path = rulesPath()
  if (!existsSync(path)) {
    return { source: 'unavailable', version: null, updatedAt: null, rules: [], error: `规则库文件不存在：${RULES_RELATIVE}` }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const rules = Array.isArray(parsed?.rules) ? parsed.rules.map(normalizeRule).filter((r) => r !== null) : []
    return {
      source: 'pack',
      version: typeof parsed?.version === 'number' ? parsed.version : null,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
      rules,
      error: null,
    }
  } catch (error) {
    return { source: 'unavailable', version: null, updatedAt: null, rules: [], error: `规则库解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 规则摘要（给面板/接口用，避免把整段说明塞进响应）。 */
function summarizeContractRules(pack) {
  const blockers = pack.rules.filter((r) => r.severity === 'blocker').length
  return {
    source: pack.source,
    version: pack.version,
    updatedAt: pack.updatedAt,
    total: pack.rules.length,
    blockers,
    autoDetected: pack.rules.filter((r) => r.implementedBy !== null).length,
    ids: pack.rules.map((r) => r.id),
    error: pack.error,
  }
}

export { KINDS, RULES_RELATIVE, SEVERITIES, loadContractRules, normalizeRule, rulesPath, summarizeContractRules }
