// L1 · domain —— 开发区根（dev roots）：**"钉住任意目录"的安全边界**（0.5.57 加法）
//
// 用户 2026-10-15 的三个决定（原话）：
//   ① 「允许」—— 允许注册自己的开发区根（不只 `~/.dsh/plugin-src`）；
//   ② 「不允许」—— **不允许任意目录**：目标必须落在某个已注册的根里；
//   ③ 「要，默认关闭」—— agent 自动钉住必须由用户勾选，且默认关闭。
//
// 本模块只负责 ①②：登记表 + **包含性判定**。③ 属于动作层的开关，见 domain/pin-dev-dir.js。
//
// 为什么包含性判定必须写在这里、且写得死板：
//   它是"不许任意目录"这条决定的**唯一执行点**。写松了（比如只用 startsWith 字符串前缀），
//   `C:\dev` 会命中 `C:\devil\evil`；用 realpath 才能挡掉"根里放一个指向别处的 junction"。
//   三条都做到才算数：**realpath 归一 → Windows 大小写不敏感 → 路径分隔符边界**。
//
// 文件：`<DSH_HOME>/plugin-console/dev-roots.json`
//   { "roots": ["C:\\Users\\x\\.dsh\\plugin-src", "D:\\my-dev"] }
//   缺省 = 只有 `<DSH_HOME>/plugin-src`（用户现有 7 个 link 里 6 个就在这）。
//
// 分层：L1 domain —— 收 home（已解开的字符串），不认 ctx；不联网、不 spawn。
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const DEV_ROOTS_FILE = 'dev-roots.json'

/** DSH 家目录（与其它模块同口径：优先 env，否则 ~/.dsh）。 */
function homeDirOf(home) {
  if (typeof home === 'string' && home !== '') return home
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 登记表文件路径。 */
function devRootsFile(home) {
  return join(homeDirOf(home), 'plugin-console', DEV_ROOTS_FILE)
}

/** 默认根：`<DSH_HOME>/plugin-src`（用户现有 link 目标绝大多数在这里）。 */
function defaultDevRoot(home) {
  return join(homeDirOf(home), 'plugin-src')
}

/** 归一化：realpath（存在时）→ 去尾分隔符 → Windows 大小写折叠。判等/包含都走它。 */
function normalizePath(p) {
  if (typeof p !== 'string' || p.trim() === '') return null
  let out = resolve(p)
  try { if (existsSync(out)) out = realpathSync(out) } catch {}
  out = out.replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? out.toLowerCase() : out
}

/** child 是否**严格位于** root 之内（不含 root 本身）。分隔符边界必须成立。 */
function isInside(childNorm, rootNorm) {
  if (childNorm === null || rootNorm === null) return false
  if (childNorm === rootNorm) return false
  return childNorm.startsWith(rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep)
}

/**
 * 读登记表。**缺省即默认根**；坏文件降级为默认根（并如实带 warnings，不假装一切正常）。
 * @returns {{ roots: string[], warnings: string[], file: string }}
 */
function readDevRoots(home) {
  const file = devRootsFile(home)
  const fallback = { roots: [defaultDevRoot(home)], warnings: [], file }
  if (!existsSync(file)) return fallback
  let parsed = null
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    return { ...fallback, roots: [defaultDevRoot(home)], warnings: [`${file} 读不出来或不是合法 JSON（${error instanceof Error ? error.message : String(error)}）；已按默认根处理`] }
  }
  const list = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.roots) ? parsed.roots : null
  if (list === null) return { ...fallback, warnings: [`${file} 缺少 roots 数组；已按默认根处理`] }
  const roots = list.filter((x) => typeof x === 'string' && x !== '')
  if (roots.length === 0) return fallback
  return { roots, warnings: [], file }
}

/** 原子写登记表（备份 + 临时文件 + rename）。 */
function writeDevRoots(home, roots) {
  const file = devRootsFile(home)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify({ roots }, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

/**
 * 判定一个目录是否可以成为"开发区里的目标"。
 *
 * @returns {{ ok: boolean, reason: string|null, normalized: string|null, root: string|null }}
 *   ok=false 时 reason 是**给人看的**一句话（面板直接显示）。
 */
function checkInsideDevRoots(home, candidate) {
  const norm = normalizePath(candidate)
  if (norm === null) return { ok: false, reason: '没有提供目录', normalized: null, root: null }
  if (!existsSync(candidate)) return { ok: false, reason: `目录不存在：${candidate}`, normalized: norm, root: null }
  let isDir = false
  try { isDir = statSync(candidate).isDirectory() } catch {}
  if (!isDir) return { ok: false, reason: `不是目录：${candidate}`, normalized: norm, root: null }
  const { roots } = readDevRoots(home)
  for (const root of roots) {
    const rootNorm = normalizePath(root)
    if (isInside(norm, rootNorm)) return { ok: true, reason: null, normalized: norm, root }
  }
  return {
    ok: false,
    reason: `不在任何已注册的开发区根里：${candidate}\n已注册：${roots.join(' / ')}\n（这是刻意的限制：只允许钉住开发区里的目录，不允许任意路径）`,
    normalized: norm,
    root: null,
  }
}

/** 注册一个新根（必须存在、是目录、不与已有根重复/互相包含）。返回 { ok, error, roots, file }。 */
function addDevRoot(home, dir) {
  const norm = normalizePath(dir)
  if (norm === null) return { ok: false, error: '没有提供目录', roots: readDevRoots(home).roots, file: devRootsFile(home) }
  if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}`, roots: readDevRoots(home).roots, file: devRootsFile(home) }
  let isDir = false
  try { isDir = statSync(dir).isDirectory() } catch {}
  if (!isDir) return { ok: false, error: `不是目录：${dir}`, roots: readDevRoots(home).roots, file: devRootsFile(home) }
  const current = readDevRoots(home)
  const normRoots = current.roots.map((r) => normalizePath(r))
  if (normRoots.includes(norm)) return { ok: true, error: null, roots: current.roots, file: current.file, note: '已经注册过了' }
  for (const [i, rootNorm] of normRoots.entries()) {
    if (isInside(norm, rootNorm) || isInside(rootNorm, norm)) {
      return { ok: false, error: `与已注册的根重叠：${current.roots[i]}（不要嵌套注册，包含关系已覆盖）`, roots: current.roots, file: current.file }
    }
  }
  const roots = [...current.roots, resolve(dir)]
  return { ok: true, error: null, roots, file: writeDevRoots(home, roots) }
}

/** 取消注册（默认根不允许取消 —— 它是兜底，去掉会让人连自己现有的插件都钉不回来）。 */
function removeDevRoot(home, dir) {
  const norm = normalizePath(dir)
  const current = readDevRoots(home)
  const idx = current.roots.findIndex((r) => normalizePath(r) === norm)
  if (idx < 0) return { ok: false, error: `未注册：${dir}`, roots: current.roots, file: current.file }
  if (norm === normalizePath(defaultDevRoot(home))) {
    return { ok: false, error: `默认根不能取消注册：${defaultDevRoot(home)}（它是兜底）`, roots: current.roots, file: current.file }
  }
  const roots = current.roots.filter((_, i) => i !== idx)
  return { ok: true, error: null, roots, file: writeDevRoots(home, roots) }
}

export { DEV_ROOTS_FILE, homeDirOf, devRootsFile, defaultDevRoot, normalizePath, isInside, readDevRoots, writeDevRoots, checkInsideDevRoots, addDevRoot, removeDevRoot }
