// L1 · domain —— auto-preflight-worker.js（子进程入口：把同步预检搬出宿主事件循环；0.5.111 加法）
//
// 为什么需要子进程（真机 2026-11-17）：`runAutoPreflightScan` 是同步函数，本次实测阻塞宿主
// 事件循环 **5469ms**；`withTimeout` 只是 Promise.race，无法打断同步代码。把它放进子进程后：
//   · 宿主只等一个 IPC 结果，事件循环不被扫描占住；
//   · 超时由父进程 `child.kill('SIGKILL')` 硬终止，不依赖协作式取消。
//
// 协议：stdin 收 JSON 输入；stdout 输出一行 `__DSH_PREFLIGHT__<JSON>`。
// 只被 auto-preflight-child.js 调用；不要在这里读 ctx / 不要写补丁。
import { runAutoPreflightScan } from './auto-preflight-run.js'

const MARKER = '__DSH_PREFLIGHT__'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** 纯入口（测试可直接调用）：输入对象 → 扫描结果。 */
async function runWorker(input) {
  const value = await runAutoPreflightScan(input ?? {})
  return value
}

async function main() {
  try {
    const text = await readStdin()
    const input = text.trim() === '' ? {} : JSON.parse(text)
    const value = await runWorker(input)
    process.stdout.write(`\n${MARKER}${JSON.stringify(value)}\n`)
  } catch (error) {
    process.stdout.write(`\n${MARKER}${JSON.stringify({ ok: false, reason: `自动预检子进程异常：${error instanceof Error ? error.message : String(error)}` })}\n`)
    process.exitCode = 1
  }
}

const isMain = process.env.DSH_AUTO_PREFLIGHT_WORKER === '1'
if (isMain) void main()

export { MARKER, runWorker }
