// L1 · domain —— repoland.js（仓库落地：落地目录配置 / 已落地列表 / 克隆；分层 Step 4 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { gitCloneUrls } from './sources.js'
import { execFileAsync, gitEnv } from '../infra/exec.js'
import { removeDirVerified } from '../infra/fsx.js'
import { repoLandConfFile } from '../infra/paths.js'

/** 仓库落地根目录（可配置，默认 ~/.dsh/repos）。 */
let reposDirCache = null

function getReposDir() {
  if (reposDirCache !== null) return reposDirCache
  try {
    if (existsSync(repoLandConfFile())) {
      const conf = JSON.parse(readFileSync(repoLandConfFile(), 'utf8'))
      if (typeof conf.dir === 'string' && conf.dir.trim() !== '') {
        reposDirCache = conf.dir.trim()
        return reposDirCache
      }
    }
  } catch {}
  reposDirCache = join(homedir(), '.dsh', 'repos')
  return reposDirCache
}

function setReposDir(dir) {
  reposDirCache = String(dir ?? '').trim()
  mkdirSync(dirname(repoLandConfFile()), { recursive: true })
  writeFileSync(repoLandConfFile(), JSON.stringify({ dir: reposDirCache }, null, 2), 'utf8')
  return reposDirCache
}

/** 已落地仓库列表：扫描 dir 下两级目录（owner/name 下含 .git）。 */
function listLandedRepos() {
  const dir = getReposDir()
  const out = []
  try {
    if (!existsSync(dir)) return out
    for (const owner of readdirSync(dir, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.name.startsWith('.')) continue
      const ownerDir = join(dir, owner.name)
      for (const entry of readdirSync(ownerDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const repoDir = join(ownerDir, entry.name)
        if (existsSync(join(repoDir, '.git'))) {
          out.push({ owner: owner.name, name: entry.name, repo: `${owner.name}/${entry.name}`, path: repoDir })
        }
      }
    }
  } catch {}
  return out
}

/** 从 execFile 错误里取 git 自己说的话（stderr 末两行）。`--quiet` 只静音进度，
 * 真实原因（HTTP 502 / 无法解析主机 / 认证失败）仍在 stderr 里；只报 `Command failed: …`
 * 等于没告诉用户任何信息（2026-09-20 演练：套装子模块失败只看到 Command failed）。 */
function gitErrorDetail(error) {
  const raw = typeof error?.stderr === 'string' && error.stderr.trim() !== ''
    ? error.stderr
    : (typeof error?.message === 'string' ? error.message : '')
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^Command failed/u.test(line))
    .slice(-2)
    .join(' | ')
}

/** 逐条尝试的错误汇总（纯函数，单测覆盖）：报**第一个**错误（真实原因）+ 尝试清单。
 * 2026-09-26 真机（官方桌面端里装 git 源插件）：ghproxy 卡死 → 我们的超时到了但**没杀 git 进程**，
 * 于是 `git clone` / `git remote-https` / `index-pack --shallow-file …\.git\shallow.lock` 常驻，
 * Windows 不允许删除被打开的文件 → 目标目录清不掉 → 旧代码把它写成"环境禁止删除"并**放弃后续源**。
 * 现在措辞如实：说清"仍有 git 占用（已尝试结束）"，并给出可复制的手动删除命令。 */
function summarizeCloneErrors(errors) {
  const first = errors[0]
  const tried = errors.map((e) => {
    if (e.unclean === true) return `${e.url}（残留目录被占用，已跳过重试）`
    if (e.skipped === true) return `${e.url}（探活失败，已跳过）`
    if (e.timedOut === true) return `${e.url}（超时，进程已结束）`
    return /already exists and is not an empty directory/u.test(e.message) ? `${e.url}（目录非空）` : e.url
  }).join('；')
  const detail = gitErrorDetail(first)
  const stuck = errors.filter((e) => e.unclean === true)
  const stuckNote = stuck.length === 0
    ? ''
    : `；注意：${stuck[0].message}。可手动删除后重试：Remove-Item -Recurse -Force '${stuck[0].dir}'`
  return `git clone 失败（首个错误：${first?.message ?? '未知'}${detail !== '' ? `；git 说：${detail}` : ''}）；已尝试 ${errors.length} 个源：${tried}${stuckNote}`
}

/** 结束**整棵**进程树。超时/中断后必须做：git 会派生 remote-https / index-pack 子进程，
 * 只 kill 父进程会留下孤儿继续占着 .git 里的文件（2026-09-26 实测占住 pack 临时文件与 shallow.lock）。 */
function killProcessTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 15000 })
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { return false } }
    }
    return true
  } catch { return false }
}

/** 跑一次 git clone：支持超时，且**超时即杀掉整棵树**。返回 { code, stderr, timedOut, pid }。 */
function runGitClone(url, dest, timeout, { spawnFn = spawn, killTree = killProcessTree } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload) } }
    let child = null
    let stderr = ''
    try {
      child = spawnFn('git', ['clone', '--depth', '1', '--quiet', url, dest], {
        windowsHide: true,
        env: gitEnv(),
        detached: process.platform !== 'win32', // POSIX：自成进程组，便于 -pid 整体杀
      })
    } catch (error) {
      finish({ code: -1, stderr: String(error?.message ?? error), timedOut: false, pid: null })
      return
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish({ code: -1, stderr: stderr.trim(), timedOut: true, pid: child.pid })
    }, timeout)
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); finish({ code: -1, stderr: String(error?.message ?? error), timedOut: false, pid: child.pid }) })
    child.on('close', (code) => { clearTimeout(timer); finish({ code: typeof code === 'number' ? code : -1, stderr: stderr.trim(), timedOut: false, pid: child.pid }) })
  })
}

/** 源探活：镜像站"连得上但传不动"探不出来，但**域名挂掉/被墙**能提前识别，省掉一整个克隆超时的白等。 */
async function probeSourceAlive(url, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    return res.ok || res.status === 403 || res.status === 405 // 部分站点不支持 HEAD，按"活着"处理
  } catch { return false }
}

/** git clone（镜像→直连；gitee 直连），返回 { url, attempt, dir } 或抛错。
 * 每次尝试都用**全新唯一目录** `.tryN`，成功后才 rename 到 dest —— 这样即使上一轮残留目录被占用，
 * 也不会再出现"一个源失败 → 后面所有源都因目录非空而无效"的连锁失效。 */
async function gitCloneRepo(repo, dest, source = 'github', timeout = 180000, deps = {}) {
  const {
    spawnFn = spawn,
    killTree = killProcessTree,
    probe = probeSourceAlive,
    removeDir = removeDirVerified,
    renameDir = renameSync,
  } = deps
  const urls = gitCloneUrls(repo, source)
  const errors = []
  for (const [attempt, url] of urls.entries()) {
    const part = `${dest}.try${attempt + 1}`
    // eslint-disable-next-line no-await-in-loop
    const alive = await probe(url)
    if (!alive) {
      errors.push({ url, message: `源探活失败（连不上）：${url}`, skipped: true, dir: part })
      continue
    }
    try { removeDir(part) } catch {}
    // eslint-disable-next-line no-await-in-loop
    const res = await runGitClone(url, part, timeout, { spawnFn, killTree })
    if (res.code === 0) {
      try {
        removeDir(dest)
        renameDir(part, dest)
        return { url, attempt: attempt + 1, dir: dest }
      } catch (error) {
        errors.push({ url, message: `克隆成功但落地失败（${error instanceof Error ? error.message : String(error)}）`, dir: part })
        continue
      }
    }
    // 失败：先尽力清掉半成品目录；清不掉就**如实说明**（这次不再谎报"环境禁止删除"）
    const cleared = removeDir(part)
    if (cleared && cleared.ok === false) {
      errors.push({
        url,
        message: res.timedOut === true
          ? `克隆超时，且残留目录仍被 git 占用（进程已尝试结束）：${part}`
          : `克隆失败，且残留目录无法清理（可能仍被 git 占用）：${part}`,
        stderr: res.stderr,
        unclean: true,
        timedOut: res.timedOut === true,
        dir: part,
      })
      continue // **继续试下一个源**（新目录不受影响），不再像旧代码那样直接 break
    }
    errors.push({ url, message: res.timedOut === true ? `克隆超时（${url}）` : (res.stderr !== '' ? res.stderr : `git clone 退出码 ${res.code}`), stderr: res.stderr, timedOut: res.timedOut === true, dir: part })
  }
  throw new Error(summarizeCloneErrors(errors))
}

export { reposDirCache, getReposDir, setReposDir, listLandedRepos, gitCloneRepo, summarizeCloneErrors, killProcessTree, probeSourceAlive }
