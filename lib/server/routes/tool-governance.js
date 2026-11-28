import { getToolGovernanceSchemaReport, getToolGovernanceState, previewToolGovernanceSchemas, updateToolGovernanceConfig } from '../agent/runtime.js'
import { sendError, sendJson } from '../infra/httpd.js'

async function routeToolGovernanceStateGet(_req, res) {
  sendJson(res, 200, getToolGovernanceState())
}

async function routeToolGovernanceSchemaReportGet(_req, res) {
  sendJson(res, 200, getToolGovernanceSchemaReport())
}

async function routeToolGovernanceSchemaPreview(_req, res, rc) {
  sendJson(res, 200, previewToolGovernanceSchemas(rc.body?.descriptions))
}

async function routeToolGovernanceConfig(_req, res, rc) {
  const result = updateToolGovernanceConfig(rc.ctx, rc.body ?? {})
  if (!result.ok) {
    sendError(res, 400, result.error ?? '无法保存工具治理配置')
    return
  }
  sendJson(res, 200, result.state)
}

export { routeToolGovernanceConfig, routeToolGovernanceSchemaPreview, routeToolGovernanceSchemaReportGet, routeToolGovernanceStateGet }
