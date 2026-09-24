// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra


/** 写请求跨站防护：浏览器同源策略不阻止跨站发送，必须校验 Origin / Sec-Fetch-Site。
 * 非浏览器客户端（无 Origin/Sec-Fetch-Site 头）仍允许，避免 curl/脚本/测试被误伤。 */

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
function isAllowedWriteOrigin(req, port) {
  const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : null
  const site = typeof req.headers?.['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : null
  if (origin !== null && origin !== '' && !ALLOWED_LOCAL_ORIGINS(port).has(origin)) return false
  if (site !== null && site !== 'same-origin' && site !== 'none') return false
  return true
}
function ALLOWED_LOCAL_ORIGINS(port) {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ])
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}
function sendError(res, status, message, details) {
  sendJson(res, status, { ok: false, error: message, ...(details === undefined ? {} : { details }) })
}
async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}
export { isLoopback, isAllowedWriteOrigin, ALLOWED_LOCAL_ORIGINS, sendJson, sendError, readBody }