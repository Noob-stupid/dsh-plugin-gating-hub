// L1 · domain —— archive-source.js（archive 通道：用 HTTP 下载仓库压缩包替代 git 协议取仓库内容）
//
// 为什么需要它（2026-09-27 真机实测）：**同一个 ghproxy.net 域名**
//   · archive（普通 HTTP GET）能跑到 4 MB/s —— 429 MB / 105 秒下完；
//   · git 协议 0 B/s —— `git clone` 挂到停滞判据判死为止，一个字节都没有。
// 于是"git 拉不动"不该等于"这个仓库装不上"：下载 tar.gz → 解压 → 建仓，得到与 clone **等价的结果**，
// 让上层（套装装配 / 仓库落地）无感。
//
// 设计（沿用既有工程约定）：
//   · 源模板与 gitSources **同形**（{owner}/{repo} 占位符 + 主→备 + 可在「软件源」里配置），
//     另支持 {branch} 占位符；默认两条：ghproxy 镜像 / GitHub codeload 官方。
//   · 超时/杀树/等退出一律复用 infra 的 execFileWithKillTree（它超时会杀整棵进程树并等它退出）；
//   · 半成品目录清理一律复用 infra 的 disposeDir（删不掉就改名降级成 .trash-*）；
//   · 失败记录带上"本次已下载多少字节"（与 git 通道同一套事实口径，见 repoland.js 的 measureProgressBytes）。

import { existsSync, mkdirSync, statSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileWithKillTree, gitEnv } from '../infra/exec.js'
import { disposeDir, disposeNote } from '../infra/fsx.js'
import { readSources, DEFAULT_SOURCES } from './sources.js'

/** 单次 archive 下载的超时（默认 180 秒）：真机 429 MB / 4 MB/s ≈ 105 秒，留出余量。
 * 比 git 通道的 60 秒宽 —— archive 是"能跑满带宽"的传输，用 git 的短超时反而会误杀大仓库。 */
const ARCHIVE_TIMEOUT_MS = 180000

/** 解压 + `git init/add/commit` 的超时（大仓库的首个 commit 会慢，但失败不致命，见 archiveRepo）。 */
const ARCHIVE_COMMIT_TIMEOUT_MS = 120000

/** 分支候选顺序：调用方给的分支打头，再回退 main / master / dev，最多试 3 条
 * （真机 dsh-web 的默认分支就是 dev；分支不对时 archive 会 404，必须能自己找回来）。 */
function archiveBranchOrder(branch, defaults = ['main', 'master', 'dev']) {
  const list = Array.isArray(branch) ? branch : [branch]
  const merged = [...list, ...defaults].filter((b) => typeof b === 'string' && b.trim() !== '')
  return [...new Set(merged.map((b) => b.trim()))].slice(0, 3)
}

/** archive 候选（带源 id/名称/模板/最终 URL）：与 gitCloneCandidates 同形的排序逻辑。
 * 模板里没有 {branch} 时照旧替换（同一 URL 对任何分支都成立，由站点自己决定）。 */
function archiveCandidates(repo, branch = 'main', sources = null) {
  const full = String(repo ?? '')
  const parts = full.split('/')
  const owner = parts[0] ?? ''
  const repoName = parts[1] ?? ''
  let list = []
  try {
    list = (sources ?? readSources().archiveSources) ?? DEFAULT_SOURCES.archiveSources
  } catch {
    list = DEFAULT_SOURCES.archiveSources
  }
  const ordered = [...list].sort((a, b) => (b.primary === true ? 1 : 0) - (a.primary === true ? 1 : 0))
  const out = []
  for (const s of ordered) {
    const tpl = typeof s?.urlTemplate === 'string' ? s.urlTemplate : ''
    if (tpl === '') continue
    const url = tpl
      .replace(/\{owner\}/gu, owner)
      .replace(/\{repo\}/gu, repoName)
      .replace(/\{branch\}/gu, String(branch ?? 'main'))
    if (url === '') continue
    out.push({ id: typeof s.id === 'string' ? s.id : '', name: typeof s.name === 'string' ? s.name : '', urlTemplate: tpl, url })
  }
  if (out.length === 0) {
    out.push({
      id: 'codeload-archive',
      name: 'GitHub codeload',
      urlTemplate: 'https://codeload.github.com/{owner}/{repo}/tar.gz/refs/heads/{branch}',
      url: `https://codeload.github.com/${full}/tar.gz/refs/heads/${String(branch ?? 'main')}`,
    })
  }
  return out
}

/** 解压出来的顶层目录名不可预测（GitHub 的 tar.gz 顶层是 `{repo}-{branch}/`），
 * 统一用 `--strip-components=1` 摊平；万一某天的 tar 不认这个选项，这里再兜一层：
 * 若目标目录里只有一个子目录且没有 package.json，就把它的内容提上来。 */
function flattenSingleDir(part, deps = {}) {
  const readdir = deps.readdir ?? readdirSync
  const exists = deps.exists ?? existsSync
  const rename = deps.rename ?? renameSync
  if (exists(join(part, 'package.json'))) return false
  let entries = []
  try { entries = readdir(part, { withFileTypes: true }) } catch { return false }
  const dirs = entries.filter((e) => e.isDirectory())
  if (dirs.length !== 1) return false
  const inner = join(part, dirs[0].name)
  let innerEntries = []
  try { innerEntries = readdir(inner, { withFileTypes: true }) } catch { return false }
  for (const entry of innerEntries) {
    try { rename(join(inner, entry.name), join(part, entry.name)) } catch { return false }
  }
  try { disposeDir(inner) } catch {}
  return true
}

/** 下载 + 解压 + 建仓，把结果落到 dest。成功返回
 * `{ url, dir, source, archive: true, branch, bytes, gitNote }`，全部候选失败则抛错。
 * deps（exec/removeDir/renameDir/exists/now/branch/timeoutMs/sources/curlBin/tarBin/gitInit）只为注入。 */
async function archiveRepo(repo, dest, { branch = 'main', timeoutMs = ARCHIVE_TIMEOUT_MS, deps = {} } = {}) {
  const {
    exec = execFileWithKillTree,
    removeDir = disposeDir,
    renameDir = renameSync,
    exists = existsSync,
    now = Date.now,
    curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl',
    tarBin = 'tar',
    gitBinName = process.platform === 'win32' ? 'git.exe' : 'git',
    sources = null,
    gitInit = true,
    commitTimeoutMs = ARCHIVE_COMMIT_TIMEOUT_MS,
  } = deps
  const errors = []
  const branches = archiveBranchOrder(branch)
  const candidates = archiveCandidates(repo, branches[0], sources)
  const workRoot = join(tmpdir(), `pc-archive-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(workRoot, { recursive: true })
  let seq = 0
  for (const cand of candidates) {
    for (const br of branches) {
      seq += 1
      const part = `${dest}.archive${seq}`
      const url = cand.urlTemplate.includes('{branch}')
        ? cand.urlTemplate.replace(/\{owner\}/gu, String(repo).split('/')[0] ?? '').replace(/\{repo\}/gu, String(repo).split('/')[1] ?? '').replace(/\{branch\}/gu, br)
        : cand.url
      const tgz = join(workRoot, `repo-${seq}.tar.gz`)
      const startedAt = now()
      try { removeDir(part) } catch {}
      mkdirSync(part, { recursive: true })
      try {
        // ① 下载（curl：-f 让 HTTP 错误码直接失败；--max-time 与 exec 超时双保险）
        // eslint-disable-next-line no-await-in-loop
        await exec(curlBin, ['-f', '-L', '-sS', '--max-time', String(Math.max(5, Math.round(timeoutMs / 1000))), '-o', tgz, url], {
          timeout: timeoutMs + 5000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        })
        // ② 解压（--strip-components=1 摊平 {repo}-{branch}/ 顶层目录）
        // eslint-disable-next-line no-await-in-loop
        await exec(tarBin, ['-xzf', tgz, '-C', part, '--strip-components=1'], { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        flattenSingleDir(part, { readdir: readdirSync, exists, rename: renameDir })
        // 判据是"解压出来有没有东西"，**不是**"有没有 package.json"：
        // 套装仓库、纯技能仓库、示例仓库（真机验收用的 octocat/Hello-World）都没有根 package.json，
        // 拿它当成功判据会把它们全部误判成失败。分支不对时站点回 404（curl -f 直接失败），
        // 若站点对不存在的路径回 200 + 错误页，tar 解压会自己报错 —— 两条都在下面被如实记录。
        let extracted = 0
        try { extracted = readdirSync(part).length } catch {}
        if (extracted === 0) {
          errors.push({ url, message: `archive 解压后目录为空（可能分支 ${br} 不存在或仓库为空）`, branch: br, bytes: 0 })
          continue
        }
        // ③ 建仓：让"下载来的目录"与 `git clone` 的结果等价（有 .git、有首个 commit）
        let gitNote = null
        if (gitInit) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await exec(gitBinName, ['init', '-q'], { cwd: part, timeout: commitTimeoutMs, windowsHide: true, env: gitEnv() })
            // eslint-disable-next-line no-await-in-loop
            await exec(gitBinName, ['add', '-A'], { cwd: part, timeout: commitTimeoutMs, windowsHide: true, env: gitEnv() })
            // eslint-disable-next-line no-await-in-loop
            await exec(gitBinName, ['-c', 'user.email=plugin-console@local', '-c', 'user.name=plugin-console', 'commit', '-qm', `archive ${repo}@${br}`], { cwd: part, timeout: commitTimeoutMs, windowsHide: true, env: gitEnv() })
          } catch (error) {
            // 内容已经拿到手了：建仓失败只记 note，绝不因此让"仓库内容可用"这件事失败
            gitNote = `已下载并解压，但建仓（git init/add/commit）失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
          }
        }
        let bytes = 0
        try { bytes = statSync(tgz).size } catch {}
        try {
          removeDir(dest)
          renameDir(part, dest)
        } catch (error) {
          errors.push({ url, message: `archive 内容就绪但落地失败（${error instanceof Error ? error.message : String(error)}）`, branch: br, bytes })
          continue
        }
        return { url, dir: dest, source: 'archive', archive: true, branch: br, sourceId: cand.id, bytes, gitNote, extracted, tries: seq, ms: now() - startedAt }
      } catch (error) {
        let bytes = 0
        try { bytes = exists(tgz) ? statSync(tgz).size : 0 } catch {}
        const cleared = removeDir(part)
        const trashNote = cleared && typeof cleared.trashPath === 'string' && cleared.trashPath !== '' ? disposeNote(cleared) : ''
        // 超时有两种来源，都要认：① 我们自己的 exec 超时（error.timedOut = 杀树收尾）
        // ② curl 自己的 --max-time（`curl: (28) Operation timed out`）—— 后者不带 timedOut 字段，
        // 只按字段判会把"超时"误报成普通失败，用户就看不出"镜像卡住了"。
        const raw = String(error?.message ?? error)
        const timedOut = error?.timedOut === true || /timed out|timeout|超时/iu.test(raw)
        errors.push({
          url,
          branch: br,
          bytes,
          bytesReceived: bytes, // 与 git 通道同一字段名：汇总文案（summarizeCloneErrors）直接复用
          timedOut,
          message: timedOut
            ? `archive 下载超时（${bytes > 0 ? `本次已下载 ${bytes} B` : '本次仅收到 0 B'}）`
            : `archive 通道失败：${raw.split(/\r?\n/u)[0].slice(0, 200)}`,
          ...(trashNote === '' ? {} : { trashed: cleared.trashPath, trashNote }),
        })
      } finally {
        try { removeDir(tgz) } catch {}
      }
    }
  }
  try { removeDir(workRoot) } catch {}
  const first = errors[0]
  const triedList = errors.map((e) => `${e.url}（${e.timedOut === true ? (e.bytes > 0 ? `超时，已下载 ${e.bytes} B` : '超时，仅收到 0 B') : (e.bytes > 0 ? `失败，已下载 ${e.bytes} B` : '失败')}）`).join('；')
  throw new Error(`archive 通道失败（首个错误：${first?.message ?? '未知'}）；已尝试 ${errors.length} 次：${triedList}`)
}

export { ARCHIVE_TIMEOUT_MS, ARCHIVE_COMMIT_TIMEOUT_MS, archiveBranchOrder, archiveCandidates, archiveRepo, flattenSingleDir }
