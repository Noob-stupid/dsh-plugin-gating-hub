// L0 · infra —— registry-versions.js（registry 元数据探针：包名 → 某版本是否已发布；0.5.30 加法）
//
// 用途：**升级前**核对「profile 补丁里引用的框架包，在目标版本里还在不在」。
// 真机事故 2026-09-28：0.2.0-rc.1 移除了 `@deepseek-ai/dsh-workflow-worker-thread`（引擎改为 ptc），
// 补丁仍指向旧包 → 升级后 `workflowEngine` 无提供方 → 老会话 resume 失败。
// 这类「官方移除/改名」在升级前**只能用 registry 元数据看见**（目标版本还没装到本机）。
//
// 三个取舍：
//   ① 同一次预检里**同一个包只查一次**（内存缓存）—— 补丁里同名包可能出现在多处；
//   ② 网络失败/元数据缺失 → 返回 **null（未知）**，绝不当作「不存在」；
//   ③ 小并发（默认 4）+ 单请求超时，避免预检被 30 个包串行拖死。

import { fetchJsonUrl } from './http.js'

/** 包名 → URL 片段（`@a/b` → `@a%2fb`）。 */
function encodePackageName(name) {
  return String(name).replace('/', '%2f')
}

/** 造版本探针：`(name) => { ok, versions?, error? }`（带内存缓存）。 */
function makeVersionProbe({ registry, fetchJson, timeoutMs = 9000, cache = new Map() } = {}) {
  const fetchImpl = typeof fetchJson === 'function' ? fetchJson : (url, t) => fetchJsonUrl(url, t)
  return async (name) => {
    if (cache.has(name)) return cache.get(name)
    let result
    try {
      const meta = await fetchImpl(`${registry}/${encodePackageName(name)}`, timeoutMs)
      const versions = meta && typeof meta === 'object' && meta.versions !== null && typeof meta.versions === 'object'
        ? Object.keys(meta.versions)
        : []
      result = { ok: true, versions }
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) }
    }
    cache.set(name, result)
    return result
  }
}

/** 批量核对：`[{name, lines}]` → `[{name, lines, published: true|false|null}]`（小并发，保序）。 */
async function checkPublishedVersions(entries, { probe, version, concurrency = 4 } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const width = Math.max(1, Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 4)
  const out = new Array(list.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      const entry = list[index]
      let published = null
      try {
        const res = await probe(entry.name)
        if (res?.ok === true) published = Array.isArray(res.versions) ? res.versions.includes(version) : null
      } catch { published = null }
      out[index] = { name: entry.name, lines: Array.isArray(entry.lines) ? entry.lines : [], published }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, () => worker()))
  return out.filter((x) => x !== undefined)
}

export { checkPublishedVersions, encodePackageName, makeVersionProbe }