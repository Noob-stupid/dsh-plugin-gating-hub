// L0 · infra —— npm-cache.js（npm cacache **直读** + 零依赖解 tgz；0.5.50 加法）
//
// 为什么需要它（2026-10-14 真机停机事故的修复侧）：
//   框架包被掏空后，`node_modules` 里只剩空壳，但**本地 npm 缓存里通常还留着原始 tarball**。
//   实测本机：`cordis` / `dsh-llm` / `dsh-tools` / `dsh-web` 四个包的 tarball 全在
//   `D:\node_cache\_cacache`，按 `package-lock.json` 的 `integrity` **逐字节命中**，110KB 的包
//   从"发现"到"装回"在 1 秒内完成 —— 全程离线、不联网、不 spawn、不需要 pnpm。
//
// 两条硬约束（都是真机踩出来的）：
//   ① **零依赖**：不 require npm 自带的 `cacache` / `tar`。
//      实测在 `D:\dsh` 目录下 `require('npm/node_modules/cacache')` 会炸
//      `ERR_INVALID_PACKAGE_CONFIG`（那儿有个 0 字节的 `package.json`）—— 靠 npm 内部模块
//      就等于把"打不开时唯一的出路"押在另一个可能坏的东西上。
//   ② **cacache 布局是确定性的**，直接按哈希路径取文件即可：
//      `content-v2/sha512/<hex[0:2]>/<hex[2:4]>/<hex[4:]>`，其中 `hex = base64 解码 integrity 后的十六进制`。
//      这条路不依赖 index-v5 的元数据，也不受 registry 地址（npmjs / npmmirror）影响。
//
// 解 tgz 自带一个最小 tar 解析器（ustar + GNU 长名 + pax 头跳过）——见 extractTgz。
//
// 分层：L0 · infra（不得 import domain/routes/index —— tests/test-architecture-guard.mjs 断言②）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { gunzipSync } from 'node:zlib'

/**
 * 候选 npm 缓存根（按"最可能先命中"排序）。
 * 显式 env 优先（`npm_config_cache` / `NPM_CONFIG_CACHE`），再退到用户 .npmrc 的常见落点。
 */
function candidateCacheRoots({ env = process.env, home = homedir() } = {}) {
  const out = []
  const push = (dir) => {
    if (typeof dir !== 'string' || dir === '') return
    const withCache = dir.endsWith('_cacache') ? dir : join(dir, '_cacache')
    if (!out.includes(withCache)) out.push(withCache)
  }
  push(env.npm_config_cache)
  push(env.NPM_CONFIG_CACHE)
  push('D:\\node_cache')
  push(join(env.LOCALAPPDATA ?? '', 'npm-cache'))
  push(join(home, 'AppData', 'Local', 'npm-cache'))
  push(join(home, '.npm'))
  // 只要真的存在 `content-v2` 才算数（光有目录名不算）
  return out.filter((p) => existsSync(join(p, 'content-v2')))
}

/**
 * `sha512-<base64>` → cacache 内容文件的绝对路径。
 * 非法 integrity / 长度不对时返回 null（**不猜**：宁可报"取不到"，也不去读一个碰巧存在的路径）。
 */
function integrityToContentPath(cacheRoot, integrity) {
  const m = /^sha512-(.+)$/u.exec(String(integrity ?? ''))
  if (m === null) return null
  let hex = ''
  try { hex = Buffer.from(m[1], 'base64').toString('hex') } catch { return null }
  if (hex.length !== 128 || !/^[0-9a-f]+$/u.test(hex)) return null
  return join(cacheRoot, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
}

/** 按 integrity 从缓存读出 tarball 字节；取不到返回 null（绝不抛）。 */
function readTarball(cacheRoot, integrity, { deps = {} } = {}) {
  const exists = deps.exists ?? existsSync
  const read = deps.read ?? ((p) => readFileSync(p))
  const p = integrityToContentPath(cacheRoot, integrity)
  if (p === null) return null
  try { return exists(p) ? read(p) : null } catch { return null }
}

/** 依次在多个缓存根里找同一个 integrity，返回第一个命中的 `{ buf, cacheRoot }`。 */
function readTarballFromAny(roots, integrity, { deps = {} } = {}) {
  for (const root of Array.isArray(roots) ? roots : []) {
    const buf = readTarball(root, integrity, { deps })
    if (buf !== null && buf.length > 0) return { buf, cacheRoot: root }
  }
  return null
}

/** 读 tar 头里的一个数值字段（八进制，容忍空格/NUL 结尾与 GNU base-256）。 */
function tarNumber(header, offset, length) {
  const raw = header.subarray(offset, offset + length)
  if ((raw[0] & 0x80) !== 0) {
    // GNU base-256（大文件/长数字）：低位大端
    let value = 0
    for (const byte of raw) value = value * 256 + (byte & 0x7f)
    return value
  }
  const text = raw.toString('utf8').replace(/\0.*$/u, '').trim()
  const n = parseInt(text, 8)
  return Number.isFinite(n) ? n : 0
}

/** 读 tar 头里的一个字符串字段（NUL 截断）。 */
function tarString(header, offset, length) {
  return header.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/u, '')
}

/**
 * 解开 tar 归档（**零依赖**最小实现：ustar 前缀 + GNU longname/longlink + pax 头跳过）。
 *
 * 安全：条目路径必须落在 `destDir` 内（拒绝绝对路径与 `..` 穿越）—— 归档来自本地缓存，
 * 但仍按"不可信输入"处理，避免一次坏缓存把文件写到树外。
 *
 * @returns {{ files: number, dirs: number, skipped: number }}
 */
function extractTar(tarBuf, destDir, { deps = {} } = {}) {
  const mkdir = deps.mkdir ?? ((d) => mkdirSync(d, { recursive: true }))
  const write = deps.write ?? ((p, data) => writeFileSync(p, data))
  const root = resolve(destDir)
  const rootWithSep = root.endsWith(sep) ? root : root + sep

  let files = 0
  let dirs = 0
  let skipped = 0
  let offset = 0
  let longName = null
  let longLink = null

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512)
    // 全零块 = 归档结束
    let allZero = true
    for (const byte of header) { if (byte !== 0) { allZero = false; break } }
    if (allZero) break

    const size = tarNumber(header, 124, 12)
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156])
    const prefix = tarString(header, 345, 155)
    const rawName = tarString(header, 0, 100)
    const body = tarBuf.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    // GNU 长名/长链接：内容即下一条目的真名，本条自身不落盘
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/u, ''); continue }
    if (type === 'K') { longLink = body.toString('utf8').replace(/\0.*$/u, ''); continue }
    // pax 扩展头：按"不认识就跳过"处理（不改判据、不猜语义）
    if (type === 'x' || type === 'g') { skipped += 1; continue }

    const name = longName !== null ? longName : (prefix === '' ? rawName : `${prefix}/${rawName}`)
    longName = null
    longLink = null
    if (name === '') { skipped += 1; continue }

    // npm tarball 统一带 `package/` 前缀 —— 剥掉后落到目标目录
    const rel = name.replace(/^package\//u, '').replace(/^\.\//u, '')
    if (rel === '') { skipped += 1; continue }

    const out = resolve(join(root, rel))
    if (out !== root && !out.startsWith(rootWithSep)) { skipped += 1; continue }

    if (type === '5') { mkdir(out); dirs += 1; continue }
    if (type === '1' || type === '2' || type === '3' || type === '4' || type === '6') { skipped += 1; continue }
    mkdir(dirname(out))
    write(out, body)
    files += 1
  }
  return { files, dirs, skipped }
}

/** 解开 `.tgz`（gunzip + extractTar）。 */
function extractTgz(tgzBuf, destDir, { deps = {} } = {}) {
  const gunzip = deps.gunzip ?? gunzipSync
  return extractTar(gunzip(tgzBuf), destDir, { deps })
}

export {
  candidateCacheRoots,
  extractTar,
  extractTgz,
  integrityToContentPath,
  readTarball,
  readTarballFromAny,
}
