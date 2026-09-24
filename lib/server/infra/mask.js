// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra


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