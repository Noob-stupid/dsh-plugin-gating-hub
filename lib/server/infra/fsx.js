// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra

import { existsSync, rmSync, readdirSync, mkdirSync, copyFileSync, chmodSync, lstatSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 递归复制目录树（绕开 fs.cpSync 在本环境的目录复制 EIO bug：
 * cpSync 复制含子目录的树必报 `EIO, Access is denied`，而逐文件 copyFileSync 正常）。
 * 跳过 .git（技能/包副本不需要版本库元数据）。
 */

/** 清理陈旧包目录与 pnpm _tmp_ 残留（Windows 原子替换 EPERM 的根因），返回清理数量。 */

/** 串行化补丁文件写入，避免并发 toggle 的读改写竞争。 */

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to)
    } else if (entry.isFile()) {
      copyFileSync(from, to)
    }
  }
}
function queuedWrite(fn) {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}
function cleanupStalePackageDir(profileDir, packageName) {
  const segments = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  const dir = join(profileDir, 'node_modules', ...segments)
  const base = basename(dir)
  const parent = dirname(dir)
  let removed = 0
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
    }
  } catch {}
  try {
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(`${base}_tmp_`)) {
        try {
          rmSync(join(parent, entry), { recursive: true, force: true })
          removed += 1
        } catch {}
      }
    }
  } catch {}
  return removed
}
let writeQueue = Promise.resolve()

/**
 * 删除目录树并**核实删除结果**。
 * 为什么要核实：本机某些环境（受限令牌/沙箱/杀软占用）下 `rmSync` 会**静默落空**——不抛错、目录仍在。
 * 路由若删完直接 `{ok:true}` 就是对用户撒谎（2026-09-20 多类型演练实测：同一个 `rmSync` 在
 * `D:\dsh\repos` 删得掉，在 `C:\Users\<user>\.dsh\...` 下返回成功但目录原封不动）。
 * 返回 `{ok, attempts, error}`；`ok:false` 时调用方必须如实报错，不能吞。
 */
function removeDirVerified(dir) {
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch (error) {
      lastError = error
    }
    if (!existsSync(dir)) return { ok: true, attempts: attempt }
  }
  return { ok: false, attempts: 2, error: lastError instanceof Error ? lastError.message : null }
}

/**
 * 清掉树里的只读位（Windows 上 `rmSync` 遇只读文件直接 EPERM，`force` **不会**替你清属性）。
 * 返回清掉的文件数，供日志核对。
 */
function clearReadonly(dir) {
  let cleared = 0
  const walk = (p) => {
    let st = null
    try { st = lstatSync(p) } catch { return }
    try {
      if (st.isDirectory()) {
        for (const name of readdirSync(p)) walk(join(p, name))
      } else if ((st.mode & 0o200) === 0) {
        chmodSync(p, 0o666)
        cleared += 1
      }
    } catch {}
  }
  walk(dir)
  return cleared
}

/** 轮询等待目录真的消失（Windows「删除挂起」期间名字仍可见，立刻 existsSync 会误判失败）。 */
function waitGone(dir, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const tick = () => {
      if (!existsSync(dir)) { resolve(true); return }
      if (Date.now() - startedAt >= timeoutMs) { resolve(false); return }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/** 外部删除兜底：实测本机 PowerShell/.NET 能删掉 Node `rmSync` 静默删不掉的树。 */
async function removeViaShell(dir) {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true, timeout: 120000 })
      return { ok: true, method: 'rmdir' }
    }
    await execFileAsync('rm', ['-rf', '--', dir], { timeout: 120000 })
    return { ok: true, method: 'rm' }
  } catch (error) {
    return { ok: false, method: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 强化版目录删除（清理残余专用，2026-09-24 真机诊断后新增）：
 *   ① 清只读位 → ② `rmSync` → ③ **轮询核实**（容忍删除挂起）→ ④ 失败则外部 `rmdir /s /q` 兜底 → ⑤ 再核实。
 * 为什么不能只用 `rmSync` + 立刻 `existsSync`：真机上出现过「`rmSync` 不抛错、目录仍在」，
 * 面板于是报「有 N 项没能删除（目录仍存在）——当前环境可能禁止删除」，把用户引向并不存在的权限问题；
 * 实测同一棵树用 .NET/PowerShell 能删掉，所以这里补上兜底与轮询，并把真实错误码带回去。
 */
async function removeDirVerifiedAsync(dir, { attempts = 2, pollMs = 600 } = {}) {
  let lastError = null
  let method = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!existsSync(dir)) return { ok: true, attempts: attempt, method: method ?? 'already-gone', error: null }
    try { clearReadonly(dir) } catch {}
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch (error) {
      lastError = error
    }
    if (await waitGone(dir, pollMs)) return { ok: true, attempts: attempt, method: 'rmSync', error: null }
    const shell = await removeViaShell(dir)
    if (shell.ok && await waitGone(dir, pollMs * 3)) return { ok: true, attempts: attempt, method: shell.method, error: null }
    if (shell.error !== undefined && shell.error !== null) lastError = shell.error
  }
  const detail = lastError === null
    ? '删除后目录仍存在（未抛出错误：Windows 删除挂起或占用）'
    : `${lastError.code ?? ''} ${lastError.message ?? lastError}`.trim()
  return { ok: false, attempts, method: null, error: detail }
}

export { copyTree, queuedWrite, cleanupStalePackageDir, removeDirVerified, removeDirVerifiedAsync, clearReadonly, waitGone, removeViaShell, writeQueue }