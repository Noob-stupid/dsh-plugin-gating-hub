// 自动预检子进程协议（0.5.111 加法）
//
// 钉住：子进程结果能回来；超时会**硬终止**并回 state=timeout；worker 不产出 marker 时如实失败。
// 全离线：临时 fixture worker，不跑真实扫描、不联网。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DIR = join(ROOT, '.testdir', 'auto-preflight-child')
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const OK_WORKER = join(DIR, 'ok-worker.mjs')
writeFileSync(OK_WORKER, [
  'const chunks = []',
  'for await (const c of process.stdin) chunks.push(c)',
  'const input = JSON.parse(Buffer.concat(chunks).toString("utf8"))',
  'process.stdout.write("\\n__DSH_PREFLIGHT__" + JSON.stringify({ ok: true, echo: input.foo }) + "\\n")',
].join('\n'), 'utf8')

const SLOW_WORKER = join(DIR, 'slow-worker.mjs')
writeFileSync(SLOW_WORKER, [
  'setTimeout(() => {}, 60000)',
].join('\n'), 'utf8')

const SILENT_WORKER = join(DIR, 'silent-worker.mjs')
writeFileSync(SILENT_WORKER, [
  'process.exitCode = 1',
].join('\n'), 'utf8')

const { runAutoPreflightScanInChild } = await import('../lib/server/domain/auto-preflight-child.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

{
  const result = await runAutoPreflightScanInChild({ foo: 'bar' }, { execPath: process.execPath, workerPath: OK_WORKER, timeoutMs: 5000 })
  check('① 子进程结果能回来（marker 协议）', result.ok === true && result.echo === 'bar', JSON.stringify(result))
}
{
  const started = Date.now()
  const result = await runAutoPreflightScanInChild({}, { execPath: process.execPath, workerPath: SLOW_WORKER, timeoutMs: 120 })
  const elapsed = Date.now() - started
  check('② 超时硬终止且回 state=timeout', result.ok === false && result.state === 'timeout' && elapsed < 3000, JSON.stringify({ result, elapsed }))
}
{
  const result = await runAutoPreflightScanInChild({}, { execPath: process.execPath, workerPath: SILENT_WORKER, timeoutMs: 3000 })
  check('③ 没有 marker 时如实失败（不假装成功）', result.ok === false && /未产出结论/u.test(String(result.reason)), JSON.stringify(result))
}
{
  const result = await runAutoPreflightScanInChild({}, { execPath: join(DIR, 'does-not-exist.exe'), workerPath: OK_WORKER, timeoutMs: 1000 })
  check('④ 启不起来时如实失败（不阻塞、不回退主线程）', result.ok === false && typeof result.reason === 'string', JSON.stringify(result))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
