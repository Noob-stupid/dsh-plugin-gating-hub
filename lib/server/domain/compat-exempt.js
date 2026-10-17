// L1 · domain —— 兼容豁免的**写入**（0.5.56 加法：把"只读"补成"可操作"）
//
// 为什么需要：
//   0.5.53 让"被框架跳过的 bundle"可见了，提示里写着三条出路（更新 / 授精确版本豁免 / 从 bundles 删掉），
//   但控制台**只会读** `compatibility.json`，从不会写 —— 于是那句提示等于把活推回给用户：
//   "你自己去编辑那个文件，格式自己查"。这就是半截活。
//
// 格式（与框架 `readProfileCompatibility` 逐字对齐，读错会静默失效）：
//   {
//     "@scope/pkg@1.2.3": ["0.2.1-rc.2", "0.2.1-rc.1"]      // 精确包版本 → 允许的精确 DSH 版本列表
//   }
//   · 键必须是**精确** `name@version`（框架用 isExactPluginVersion 校验，范围/前缀一律被忽略）
//   · 值必须是精确版本字符串数组
//   · 坏记录被框架**忽略**（不是致命）——所以写入方必须自己保证格式，否则"写了但没生效"且没人知道
//
// 纪律：
//   · **绝不静默**：每一次写盘都先备份、写完**读回来验证**，验证不过就回滚并如实报错；
//   · 只增删**指定那一条**，其余记录（含用户手写的）原样保留、键序不变；
//   · 撤销 = 从该键的列表里去掉当前框架版本；列表空了才删键（不误伤同一包的其它授权）。
//
// 分层：L1 domain —— 收已解开的 profileDir，不认 ctx；不联网、不 spawn。
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMPATIBILITY_FILE, readCompatExemptions } from './bundle-veto.js'

const readJsonSafe = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 精确版本判据（框架同义：不接受范围/前缀/空白）。 */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
/** 精确 `name@version` 键。 */
function isExactPackageVersionKey(key) {
  if (typeof key !== 'string') return false
  const at = key.lastIndexOf('@')
  if (at <= 0) return false
  return EXACT_VERSION_RE.test(key.slice(at + 1)) && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(key.slice(0, at))
}

/**
 * 规划一次豁免写入（**纯函数，不写盘**）。
 *
 * @param {object} p
 * @param {string} p.profileDir profile 根目录
 * @param {string} p.packageName 包名
 * @param {string} p.version 该包的**精确**版本
 * @param {string} p.frameworkVersion 要授权的**精确** DSH 版本
 * @param {'grant'|'revoke'} [p.mode] grant=加一条授权（默认），revoke=撤销当前框架版本的授权
 * @returns {{ ok: boolean, status: number, error: string|null, file: string, next: object|null,
 *             changed: boolean, key: string|null, note: string|null }}
 */
function planExemption({ profileDir, packageName, version, frameworkVersion, mode = 'grant' } = {}) {
  const file = typeof profileDir === 'string' && profileDir !== '' ? join(profileDir, COMPATIBILITY_FILE) : null
  const base = { ok: false, status: 400, error: null, file, next: null, changed: false, key: null, note: null }
  if (file === null) return { ...base, error: '拿不到 profile 目录，拒绝改动' }
  if (typeof packageName !== 'string' || packageName === '') return { ...base, error: '缺少 packageName' }
  if (typeof version !== 'string' || !EXACT_VERSION_RE.test(version)) {
    return { ...base, error: `version 必须是精确版本（收到 ${JSON.stringify(version)}）；豁免按精确版本生效，范围没有意义` }
  }
  if (typeof frameworkVersion !== 'string' || !EXACT_VERSION_RE.test(frameworkVersion)) {
    return { ...base, error: `拿不到精确的框架版本（收到 ${JSON.stringify(frameworkVersion)}）—— 拒绝写一条"授权了但不知道授权给谁"的记录` }
  }
  const key = `${packageName}@${version}`
  if (!isExactPackageVersionKey(key)) return { ...base, error: `键 ${key} 不是合法的精确 name@version` }

  // 现有文件：坏文件不覆盖（那是用户的文件，覆盖等于丢数据）
  let current = {}
  if (existsSync(file)) {
    const parsed = readJsonSafe(file)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...base, status: 409, error: `${file} 已存在但不是合法对象；为避免覆盖你的文件，本动作已停止（请先手工修好或删掉它）` }
    }
    current = parsed
  }
  const next = { ...current }
  const existing = Array.isArray(next[key]) ? next[key].filter((v) => typeof v === 'string') : []

  if (mode === 'revoke') {
    if (!existing.includes(frameworkVersion)) {
      return { ...base, ok: true, status: 200, next: current, changed: false, key, note: `没有 ${key} → ${frameworkVersion} 的授权，无需撤销` }
    }
    const left = existing.filter((v) => v !== frameworkVersion)
    if (left.length === 0) delete next[key]
    else next[key] = left
    return { ...base, ok: true, status: 200, next, changed: true, key, note: `已撤销 ${key} 对 ${frameworkVersion} 的授权` }
  }

  if (existing.includes(frameworkVersion)) {
    return { ...base, ok: true, status: 200, next: current, changed: false, key, note: `${key} 已授权 ${frameworkVersion}，无需重复写入` }
  }
  next[key] = [...existing, frameworkVersion]
  return { ...base, ok: true, status: 200, next, changed: true, key, note: `已授权 ${key} 在 ${frameworkVersion} 上使用` }
}

/**
 * 执行写入：备份 → 原子写（临时文件 + rename）→ **读回来验证** → 失败则回滚。
 * 绝不谎报成功：验证不过一律返回 ok:false 并把原因写清。
 */
function applyExemption(input) {
  const plan = planExemption(input)
  if (plan.ok !== true || plan.changed !== true) return plan
  const { file, next, key } = plan
  const backup = `${file}.bak-${Date.now()}`
  try {
    if (existsSync(file)) copyFileSync(file, backup)
    const tmp = `${file}.tmp-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    // 写失败：把备份放回去（有备份时），如实报
    try { if (existsSync(backup)) copyFileSync(backup, file) } catch {}
    return { ...plan, ok: false, status: 500, error: `写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, backup }
  }
  // 读回来验证：框架读得出来的才算真的生效（"写了但没生效"是最坏的一种假绿）
  const verify = readCompatExemptions(typeof input?.profileDir === 'string' ? input.profileDir : '')
  const granted = Array.isArray(verify[key]) ? verify[key] : []
  const want = input?.mode === 'revoke'
    ? !granted.includes(input?.frameworkVersion)
    : granted.includes(input?.frameworkVersion)
  if (!want) {
    try { if (existsSync(backup)) copyFileSync(backup, file) } catch {}
    return { ...plan, ok: false, status: 500, error: `写入后验证失败（${file} 读回来不符合预期），已回滚`, backup }
  }
  return { ...plan, ok: true, backup }
}

export { EXACT_VERSION_RE, isExactPackageVersionKey, planExemption, applyExemption }
