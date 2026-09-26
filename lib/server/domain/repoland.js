// L1 · domain —— repoland.js（仓库落地：落地目录配置 / 已落地列表 / 克隆；分层 Step 4 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { gitCloneCandidates } from './sources.js'
import { execFileAsync, gitEnv, killProcessTree } from '../infra/exec.js'
import { disposeDir, disposeNote } from '../infra/fsx.js'
import { dshHome, repoLandConfFile } from '../infra/paths.js'

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

/** 「上次成功的 git 源」记忆（2026-09-26 加法）：进程内缓存 + 状态文件双保险（两个实例/重启后依然有效）。
 *  为什么需要：本机直连 github.com 不通（curl 000）→ 探活会把直连跳过，**唯一可用源就是 ghproxy**；
 *  一旦 ghproxy 超时，整次安装就彻底失败。记住上次成功的源并优先使用，能省掉一轮无谓的探活/失败等待。 */
const GIT_SOURCE_MEMO_FILE = () => join(dshHome(), 'plugin-console', 'git-source-memo.json')
let gitSourceMemoCache = null

function readGitSourceMemo() {
  if (gitSourceMemoCache !== null) return gitSourceMemoCache
  try {
    const raw = JSON.parse(readFileSync(GIT_SOURCE_MEMO_FILE(), 'utf8'))
    gitSourceMemoCache = typeof raw?.template === 'string' ? raw.template : ''
  } catch {
    gitSourceMemoCache = ''
  }
  return gitSourceMemoCache
}

function rememberGitSource(template) {
  const tpl = String(template ?? '')
  if (tpl === '') return
  gitSourceMemoCache = tpl
  try {
    mkdirSync(dirname(GIT_SOURCE_MEMO_FILE()), { recursive: true })
    writeFileSync(GIT_SOURCE_MEMO_FILE(), JSON.stringify({ template: tpl, at: Date.now() }, null, 2), 'utf8')
  } catch {}
}

/** 把「上次成功过的源」提到最前（其余顺序不变）。纯函数，单测覆盖。 */
function orderGitCandidates(candidates, preferredTemplate) {
  const list = Array.isArray(candidates) ? [...candidates] : []
  const tpl = typeof preferredTemplate === 'string' ? preferredTemplate : ''
  if (tpl === '') return list
  const at = list.findIndex((c) => c !== null && c !== undefined && c.urlTemplate === tpl)
  if (at <= 0) return list
  const [hit] = list.splice(at, 1)
  return [hit, ...list]
}

/** 逐条尝试的错误汇总（纯函数，单测覆盖）：报**第一个**错误（真实原因）+ 尝试清单。
 * 2026-09-26 真机（官方桌面端里装 git 源插件）：ghproxy 卡死 → 我们的超时到了但**没杀 git 进程**，
 * 于是 `git clone` / `git remote-https` / `index-pack --shallow-file …\.git\shallow.lock` 常驻，
 * Windows 不允许删除被打开的文件 → 目标目录清不掉 → 旧代码把它写成"环境禁止删除"并**放弃后续源**。
 * 2026-09-26（本次改错）：措辞与处置都跟着 `disposeDir` 走 —— 残留目录删不掉时不再让用户去命令行
 * （旧文案是「可手动删除后重试：Remove-Item -Recurse -Force …」）：能改名降级就**已经在后台让开了**，
 * 真的连改名都失败才如实说"控制台会稍后自动重试清理"。 */
function summarizeCloneErrors(errors) {
  const first = errors[0]
  const tried = errors.map((e) => {
    if (e.unclean === true) return `${e.url}（残留目录被占用，已跳过重试）`
    if (e.skipped === true) return `${e.url}（探活失败，已跳过）`
    if (e.retrying === true) return `${e.url}（超时，已改用更长超时重试）`
    if (e.timedOut === true) return `${e.url}（超时，进程已结束）`
    return /already exists and is not an empty directory/u.test(e.message) ? `${e.url}（目录非空）` : e.url
  }).join('；')
  const detail = gitErrorDetail(first)
  const stuck = errors.filter((e) => e.unclean === true)
  const stuckNote = stuck.length === 0
    ? ''
    : `；注意：${stuck[0].message}。控制台会在后台自动重试清理，无需手动处理`
  const trashedRecord = errors.find((e) => typeof e.trashNote === 'string' && e.trashNote !== '')
  const trashedNote = trashedRecord === undefined ? '' : `；${trashedRecord.trashNote}`
  const sourceCount = new Set(errors.map((e) => e.url)).size
  return `git clone 失败（首个错误：${first?.message ?? '未知'}${detail !== '' ? `；git 说：${detail}` : ''}）；已尝试 ${sourceCount} 个源（共 ${errors.length} 次尝试）：${tried}${trashedNote}${stuckNote}`
}

/** 结束**整棵**进程树。超时/中断后必须做：git 会派生 remote-https / index-pack 子进程，
 * 只 kill 父进程会留下孤儿继续占着 .git 里的文件（2026-09-26 实测占住 pack 临时文件与 shallow.lock）。
 * 2026-09-26（本次）：实现搬进 infra/exec.js（pnpm 通道复用同一份，domain 不再各留一份拷贝），
 * 这里保留同名 re-export —— **对外导出名与调用点一个字都没变**。 */

/** 等子进程真的退出（轮询 exitCode，并监听 close/exit），超时返回 false。
 * 为什么必须有：Windows 上「taskkill /T /F 返回了」≠「句柄已经释放」——删目录要在进程真的没了之后再动手，
 * 否则会出现「杀树明明成功（git 进程 0）却报残留被占用」的假失败（2026-09-26 真机）。 */
function waitChildExit(child, timeoutMs, pollMs = 60) {
  return new Promise((resolve) => {
    if (child === null || child === undefined) { resolve(true); return }
    if (typeof child.exitCode === 'number') { resolve(true); return }
    let settled = false
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); clearInterval(ticker); resolve(ok) } }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const ticker = setInterval(() => { if (child.exitCode !== undefined && child.exitCode !== null) finish(true) }, pollMs)
    try { child.on?.('close', () => finish(true)); child.on?.('exit', () => finish(true)) } catch {}
  })
}

/** 跑一次 git clone：支持超时，且**超时即杀掉整棵树并等它真的退出**。返回 { code, stderr, timedOut, pid, exited }。 */
function runGitClone(url, dest, timeout, { spawnFn = spawn, killTree = killProcessTree, exitWaitMs = 800, exitWaitMs2 = 300 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
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
      finish({ code: -1, stderr: String(error?.message ?? error), timedOut: false, pid: null, exited: true })
      return
    }
    const timer = setTimeout(async () => {
      timedOut = true
      killTree(child.pid)
      // ① 先等整棵树退出（句柄释放）② 还没退就再杀一次、再等（Windows 上偶发第一次 taskkill 未落地）
      let exited = await waitChildExit(child, exitWaitMs)
      if (!exited) {
        try { killTree(child.pid) } catch {}
        exited = await waitChildExit(child, exitWaitMs2)
      }
      finish({ code: -1, stderr: stderr.trim(), timedOut: true, pid: child.pid, exited })
    }, timeout)
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); if (timedOut) return; finish({ code: -1, stderr: String(error?.message ?? error), timedOut: false, pid: child.pid, exited: true }) })
    // 超时分支自己收尾（要先把退出等完），这里的 close 不能再抢答
    child.on('close', (code) => { clearTimeout(timer); if (timedOut) return; finish({ code: typeof code === 'number' ? code : -1, stderr: stderr.trim(), timedOut: false, pid: child.pid, exited: true }) })
  })
}

/** 源探活：镜像站"连得上但传不动"探不出来，但**域名挂掉/被墙**能提前识别，省掉一整个克隆超时的白等。 */
async function probeSourceAlive(url, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    return res.ok || res.status === 403 || res.status === 405 // 部分站点不支持 HEAD，按"活着"处理
  } catch { return false }
}

/** git clone（镜像→直连；gitee 直连），返回 { url, attempt, dir, source, retried } 或抛错。
 * 每次尝试都用**全新唯一目录** `.tryN`，成功后才 rename 到 dest —— 这样即使上一轮残留目录被占用，
 * 也不会再出现"一个源失败 → 后面所有源都因目录非空而无效"的连锁失效。
 * 2026-09-26 真机加法：① 超时杀树后**等进程真的退出**（runGitClone 内两轮 kill+wait）；
 *                      ② 失败后的清理走 removeDirVerifiedWithRetry（3 轮 × 250ms）——
 * 杀树成功但 Windows 句柄晚一拍释放时，不再"一次定生死"、也不再误报"残留被占用"；
 *                      ③ 源策略：**同一个源超时后用更长超时（默认 1.75 倍）重试一次**，
 * 并把**上次成功过的源**提到最前来试（本机直连 github 不通、唯一可用源就是 ghproxy，
 * 一旦它超时就"整次安装彻底失败"——现在先重试它一次，再谈别的源）。
 * 2026-09-26（本次改错）：清理默认实现由 removeDirVerifiedWithRetry 换成 **disposeDir**
 * （删不掉就改名降级成同父目录的 `.trash-<ts>-<rand>`，见 infra/fsx.js）——残留目录不再需要用户
 * 手动删除，也不再因为"清不掉"而放弃后面本来可用的源。`deps.removeDir` 这个注入口名字没变。 */
async function gitCloneRepo(repo, dest, source = 'github', timeout = 180000, deps = {}) {
  const {
    spawnFn = spawn,
    killTree = killProcessTree,
    probe = probeSourceAlive,
    removeDir = disposeDir,
    renameDir = renameSync,
    exitWaitMs = 800,
    retryFactor = 1.75,
    readMemo = readGitSourceMemo,
    writeMemo = rememberGitSource,
  } = deps
  let preferred = ''
  try { preferred = readMemo() } catch { preferred = '' }
  const candidates = orderGitCandidates(gitCloneCandidates(repo, source), preferred)
  const retryTimeout = Math.max(timeout + 1, Math.round(timeout * retryFactor))
  const errors = []
  let partSeq = 0
  for (const [sourceIndex, cand] of candidates.entries()) {
    const url = cand.url
    const alive = await probe(url)
    if (!alive) {
      partSeq += 1
      errors.push({ url, message: `源探活失败（连不上）：${url}`, skipped: true, dir: `${dest}.try${partSeq}` })
      continue
    }
    // 同一个源最多两次：正常超时 → 更长超时重试一次
    for (let round = 0; round < 2; round += 1) {
      partSeq += 1
      const part = `${dest}.try${partSeq}`
      const useTimeout = round === 0 ? timeout : retryTimeout
      try { removeDir(part) } catch {}
      // eslint-disable-next-line no-await-in-loop
      const res = await runGitClone(url, part, useTimeout, { spawnFn, killTree, exitWaitMs })
      if (res.code === 0) {
        try {
          removeDir(dest)
          renameDir(part, dest)
          try { writeMemo(cand.urlTemplate) } catch {}
          return { url, attempt: sourceIndex + 1, tries: partSeq, dir: dest, source: cand.id, retried: round > 0 }
        } catch (error) {
          errors.push({ url, message: `克隆成功但落地失败（${error instanceof Error ? error.message : String(error)}）`, dir: part })
          break
        }
      }
      // 失败：先尽力清掉半成品目录（带重试的核实删除 → 删不掉则**改名降级**成 .trash-*）；
      // 只有连改名都失败才如实说明（不再谎报"环境禁止删除"，也不再让用户去命令行手动删）
      const cleared = removeDir(part)
      const trashNote = cleared !== null && cleared !== undefined && typeof cleared.trashPath === 'string' && cleared.trashPath !== ''
        ? disposeNote(cleared)
        : ''
      const trashField = trashNote === '' ? {} : { trashed: cleared.trashPath, trashNote }
      if (cleared && cleared.ok === false) {
        errors.push({
          url,
          message: res.timedOut === true
            ? (res.exited === false
              ? `克隆超时；git 进程在等待后仍未退出（清理已重试 ${cleared.rounds ?? cleared.attempts ?? 1} 轮、改名降级也失败），残留目录清不掉：${part}`
              : `克隆超时；git 进程已结束，但残留目录重试 ${cleared.rounds ?? cleared.attempts ?? 1} 轮后仍清不掉（改名降级也失败，多为杀软/其它程序占用）：${part}`)
            : `克隆失败，且残留目录重试 ${cleared.rounds ?? cleared.attempts ?? 1} 轮后仍清不掉（改名降级也失败）：${part}`,
          stderr: res.stderr,
          unclean: true,
          timedOut: res.timedOut === true,
          exited: res.exited !== false,
          dir: part,
        })
        break // 清不掉的残留和这个源绑着，换下一个源（新目录不受影响）
      }
      if (res.timedOut === true && round === 0) {
        // ★ 同源、更长超时，重试一次（真机：ghproxy 卡死时短超时不够，长超时能过）
        errors.push({ url, message: `克隆超时（${useTimeout}ms），改用 ${retryTimeout}ms 同源重试`, stderr: res.stderr, timedOut: true, retrying: true, dir: part, ...trashField })
        continue
      }
      errors.push({ url, message: res.timedOut === true ? `克隆超时（${url}）` : (res.stderr !== '' ? res.stderr : `git clone 退出码 ${res.code}`), stderr: res.stderr, timedOut: res.timedOut === true, dir: part, ...trashField })
      break
    }
  }
  throw new Error(summarizeCloneErrors(errors))
}

export { reposDirCache, getReposDir, setReposDir, listLandedRepos, gitCloneRepo, summarizeCloneErrors, orderGitCandidates, readGitSourceMemo, rememberGitSource, killProcessTree, probeSourceAlive }
