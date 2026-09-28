// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分层分组：L0 · infra（边界由 tests/test-architecture-guard.mjs 断言）


function maskUrl(url) {
  try {
    const u = new URL(url)
    if (u.password !== '') u.password = '***'
    if (u.username !== '') u.username = '***'
    if (u.search !== '') u.search = ''
    return u.toString()
  } catch {
    return String(url).split(/[?#]/u)[0]
  }
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
export { maskUrl, escapeRegExp }