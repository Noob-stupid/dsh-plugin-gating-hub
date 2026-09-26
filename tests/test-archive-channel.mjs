// 批次 C-⑨（2026-09-27 加法）：archive 通道 —— 用普通 HTTP 下载压缩包替代 git 协议取仓库内容。
//
// 真机依据：**同一个 ghproxy.net 域名**下 archive GET 能跑到 4 MB/s（429 MB / 105 秒），
// 而 git 协议 0 B/s。于是"git 拉不动"不该等于"这个仓库装不上"。
// 本用例全部离线（exec / removeDir / rename 全注入），只钉死协议与失败处置：
//   · 源模板与 gitSources 同形（{owner}/{repo}，可选 {branch}）+ 主→备顺序
//   · 分支自动回退（main → master → dev，最多 3 条）
//   · 成功：内容落到 dest，返回与 clone 同形（source=archive:<id>、archive:true、branch、bytes）
//   · 失败：超时也带"已下载多少字节"；半成品目录走 disposeDir（删不掉就 .trash-* 降级）
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ARCHIVE_TIMEOUT_MS, archiveBranchOrder, archiveCandidates, archiveRepo, flattenSingleDir } from '../lib/server/domain/archive-source.js'
import { DEFAULT_SOURCES } from '../lib/server/domain/sources.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const ROOT = join(tmpdir(), `dsh-archive-unit-${process.pid}`)
const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'archive-profile')
disposeDir(ROOT)
mkdirSync(ROOT, { recursive: true })

// ── ① 默认软件源里的两条 archive 模板（与需求给的示例逐字一致）──────────────────
{
  const list = DEFAULT_SOURCES.archiveSources
  check('默认两条：ghproxy 镜像（主） + GitHub codeload（备）',
    list.length === 2 && list.filter((s) => s.primary === true).length === 1, JSON.stringify(list.map((s) => s.id)))
  check('★ 模板形状与需求示例一致（{owner}/{repo} 占位符 + {branch}）',
    list[0].urlTemplate === 'https://ghproxy.net/https://github.com/{owner}/{repo}/archive/refs/heads/{branch}.tar.gz'
    && list[1].urlTemplate === 'https://codeload.github.com/{owner}/{repo}/tar.gz/refs/heads/{branch}',
    `${list[0].urlTemplate} | ${list[1].urlTemplate}`)
}

// ── ② 候选替换 + 主备顺序 + 无 {branch} 模板也能用 ─────────────────────────────
{
  const cands = archiveCandidates('octocat/Hello-World', 'master')
  check('★ {owner}/{repo}/{branch} 全部替换到位',
    cands[0].url === 'https://ghproxy.net/https://github.com/octocat/Hello-World/archive/refs/heads/master.tar.gz'
    && cands[1].url === 'https://codeload.github.com/octocat/Hello-World/tar.gz/refs/heads/master',
    cands.map((c) => c.url).join(' | '))
  const noBranch = archiveCandidates('o/r', 'dev', [{ id: 'x', name: 'x', urlTemplate: 'https://mirror/{owner}/{repo}.tar.gz', primary: true }])
  check('模板里没有 {branch} 时照旧替换（同一 URL 对任何分支都成立）',
    noBranch.length === 1 && noBranch[0].url === 'https://mirror/o/r.tar.gz', noBranch[0]?.url)
  const ordered = archiveCandidates('o/r', 'main', [
    { id: 'b', name: 'b', urlTemplate: 'https://b/{owner}/{repo}', primary: false },
    { id: 'a', name: 'a', urlTemplate: 'https://a/{owner}/{repo}', primary: true },
  ])
  check('主源排在前面（与 gitSources 同一套顺序语义）', ordered[0].id === 'a', ordered.map((c) => c.id).join(' > '))
  check('★ 分支回退顺序：给的分支打头，然后 main / master / dev，最多 3 条',
    JSON.stringify(archiveBranchOrder('dev')) === JSON.stringify(['dev', 'main', 'master'])
    && JSON.stringify(archiveBranchOrder('main')) === JSON.stringify(['main', 'master', 'dev'])
    && JSON.stringify(archiveBranchOrder(null)) === JSON.stringify(['main', 'master', 'dev']),
    `${archiveBranchOrder('dev')} / ${archiveBranchOrder(null)}`)
}

// ── ③ 成功路径：下载 → 解压 →（建仓）→ 落地，返回与 clone 同形 ────────────────────
{
  const dest = join(ROOT, 'ok')
  const calls = []
  const exec = async (bin, argv, opts) => {
    calls.push({ bin, argv, cwd: opts?.cwd ?? null })
    if (bin.includes('curl')) {
      // 造一个"下载物"：只有体积，不真解压
      const out = argv[argv.indexOf('-o') + 1]
      writeFileSync(out, 'x'.repeat(2048))
      return { stdout: '', stderr: '' }
    }
    if (bin === 'tar') {
      const dir = argv[argv.indexOf('-C') + 1]
      mkdirSync(join(dir, 'packages', 'sub'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'octocat-demo', private: true }), 'utf8')
      writeFileSync(join(dir, 'README'), 'hello', 'utf8')
      return { stdout: '', stderr: '' }
    }
    // git init / add / commit
    if (argv[0] === 'init') mkdirSync(join(opts.cwd, '.git'), { recursive: true })
    return { stdout: '', stderr: '' }
  }
  const res = await archiveRepo('octocat/Hello-World', dest, {
    branch: 'master',
    deps: { exec, removeDir: disposeDir, renameDir: (a, b) => { rmSync(b, { recursive: true, force: true }); renameSync(a, b) }, now: Date.now },
  })
  check('★ 成功返回与 clone 同形（source=archive / sourceId / archive:true / branch / bytes / dir）',
    res.source === 'archive' && res.sourceId === 'ghproxy-archive' && res.archive === true && res.branch === 'master' && res.bytes === 2048 && res.dir === dest,
    JSON.stringify({ source: res.source, sourceId: res.sourceId, branch: res.branch, bytes: res.bytes }))
  check('★ 内容真的落到 dest（package.json + 其它文件）',
    existsSync(join(dest, 'package.json')) && existsSync(join(dest, 'README')), dest)
  check('建仓三步都跑了（git init → add -A → commit；"当作克隆结果"的关键）',
    calls.some((c) => c.argv.includes('init')) && calls.some((c) => c.argv.includes('add') && c.argv.includes('-A')) && calls.some((c) => c.argv.includes('commit')),
    calls.filter((c) => c.bin.includes('git')).map((c) => c.argv.join(' ')).join(' → ').slice(0, 120))
  check('解压用的是 --strip-components=1（摊平 {repo}-{branch}/ 顶层目录）',
    calls.some((c) => c.bin === 'tar' && c.argv.join(' ').includes('--strip-components=1')), 'tar … --strip-components=1')
  disposeDir(dest)
}

// ── ④ 失败路径：超时/HTTP 失败都带"已下载多少字节"，半成品目录交给 disposeDir ─────────
{
  const dest = join(ROOT, 'fail')
  const removed = []
  const trashPath = join(ROOT, '.trash-1-abc')
  const exec = async (bin, argv) => {
    if (bin.includes('curl')) {
      const out = argv[argv.indexOf('-o') + 1]
      writeFileSync(out, 'y'.repeat(4096)) // 下载了一半就被掐
      const err = new Error('Command failed: curl …\n（超时 500ms：已终止整棵进程树 pid=123）')
      err.timedOut = true
      throw err
    }
    return { stdout: '', stderr: '' }
  }
  let err = null
  try {
    await archiveRepo('o/r', dest, {
      branch: 'main',
      timeoutMs: 500,
      deps: {
        exec,
        // 第一次删不掉 → 返回 rename 降级（真实 disposeDir 的形状）
        removeDir: (dir) => { removed.push(dir); return dir.endsWith('.archive1') ? { ok: true, status: 'trashed', trashPath, trashNote: '已改名降级' } : { ok: true, status: 'removed' } },
        renameDir: () => {},
        now: Date.now,
      },
    })
  } catch (error) { err = error }
  check('★ 超时失败：文案带上"本次已下载多少字节"（与 git 通道同一套事实口径）',
    /archive 下载超时（本次已下载 4096 B）/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 160))
  check('★ 失败信息列出尝试过的候选与各自收到多少（不假装"网络错误"了事）',
    /已尝试 \d+ 次/u.test(err?.message ?? '') && /超时，已下载 4096 B/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 220))
  check('★ 半成品目录走了 disposeDir（删不掉就 .trash-* 降级，不留残留）',
    removed.some((d) => d.endsWith('.archive1')) && /trashed|archive/u.test(JSON.stringify(removed.slice(0, 3))), JSON.stringify(removed.slice(0, 3)))
}

// ── ⑤ 兜底：解压出来是空的（分支不存在/仓库为空）不算成功，且如实说明原因 ──────────────
//    注意判据是"解压后有没有东西"，**不是**"有没有 package.json"—— 套装/技能/示例仓库
//    （真机验收用的 octocat/Hello-World）都没有根 package.json，拿它当判据会全部误判成失败。
{
  const dest = join(ROOT, 'no-pkg')
  const exec = async (bin, argv) => {
    if (bin === 'tar') return { stdout: '', stderr: '' } // 解压出空目录
    return { stdout: '', stderr: '' }
  }
  let err = null
  try {
    await archiveRepo('o/r', dest, { branch: 'main', deps: { exec, removeDir: () => ({ ok: true, status: 'removed' }), renameDir: () => {}, now: Date.now } })
  } catch (error) { err = error }
  check('解压后空目录 → 不算成功，错误里说明可能原因',
    /解压后目录为空/u.test(err?.message ?? '') && /分支/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 140))
}
{
  // 没有 package.json 但有内容（比如 Hello-World 那种示例仓库）→ 必须算成功
  const dest = join(ROOT, 'no-package-json')
  const exec = async (bin, argv, opts) => {
    if (bin === 'tar') {
      const dir = argv[argv.indexOf('-C') + 1]
      writeFileSync(join(dir, 'README'), 'Hello World!\n', 'utf8')
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, 'docs', 'a.md'), 'x', 'utf8')
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const res = await archiveRepo('octocat/Hello-World', dest, {
    branch: 'master',
    deps: { exec, removeDir: (d) => { rmSync(d, { recursive: true, force: true }); return { ok: true, status: 'removed' } }, renameDir: (a, b) => { rmSync(b, { recursive: true, force: true }); renameSync(a, b) }, now: Date.now },
  })
  check('★ 没有 package.json 但有内容 → 算成功（示例/套装/技能仓库不该被误判）',
    res.archive === true && res.extracted >= 2 && existsSync(join(dest, 'README')), `extracted=${res.extracted}`)
  disposeDir(dest)
}

// ── ⑥ flattenSingleDir：tar 版本不支持 --strip-components 时的兜底 ────────────────
{
  const part = join(ROOT, 'flat')
  mkdirSync(join(part, 'repo-main', 'sub'), { recursive: true })
  writeFileSync(join(part, 'repo-main', 'README'), 'x', 'utf8')
  const moved = flattenSingleDir(part, {})
  check('★ 只有一个顶层目录且没有 package.json → 内容提上来（.git 不在这里，纯文件搬运）',
    moved === true && existsSync(join(part, 'README')) && existsSync(join(part, 'sub')), `moved=${moved}`)
  const part2 = join(ROOT, 'flat2')
  mkdirSync(part2, { recursive: true })
  writeFileSync(join(part2, 'package.json'), '{}', 'utf8')
  check('已经有 package.json → 不动它（避免把正常结构搬乱）', flattenSingleDir(part2, {}) === false)
}

check('单次 archive 下载超时默认 180 秒（真机 429 MB / 4 MB/s ≈ 105 秒，留余量）',
  ARCHIVE_TIMEOUT_MS === 180000, String(ARCHIVE_TIMEOUT_MS))

assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
