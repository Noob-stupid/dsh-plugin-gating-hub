// 0.5.30 加法：compat 提示可手动关闭（按版本 ack + 展示模式）。
//
// 真机背景（2026-09-28，用户实测）：面板顶部那句「当前 DSH web 包版本 0.2.0-rc.1 不在受支持的
// 0.1.x 系列内，插件控制台的部分功能可能因官方破坏性更新而失效…」以前**关不掉** ——
// 渲染就是一个纯 `<p>`，没有关闭入口、也没有持久化。用户诉求：可以手动关。
//
// 本套钉死展示层语义与三条硬约束（全离线：私有 DSH_HOME、不联网）：
//   ① 不支持 + 默认模式 + 未 ack → 显示（first-sight）
//   ② 同一版本 ack 过 → 不显示（version-acked）
//   ③ 版本一变 → **重新显示**（旧 ack 不能吞掉新版本的披露）
//   ④ mode=always → 即使 ack 过也显示；mode=off → 不显示；非法 mode 回落默认
//   ⑤ supported=true / 无 notice → 一律不显示
//   ⑥ **展示判定不产出 `supported` 字段** —— 判定与展示分离，关提示不可能改门控结论
//   ⑦ ack 落盘/读回；文件损坏 → 降级为"没 ack 过"，不抛
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'compat-notice-home')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
process.env.DSH_HOME = HOME

const {
  COMPAT_ACK_FILE, DEFAULT_NOTICE_MODE, NOTICE_MODES, readCompatAck, resolveNoticeState, writeCompatAck,
} = await import('../lib/server/domain/compat.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

const NOTICE = '当前 DSH web 包版本 0.2.0-rc.1 不在受支持的 0.1.x 系列内…'
const base = { supported: false, notice: NOTICE, webAppVersion: '0.2.0-rc.1' }

check('① 不支持 + 默认模式 + 未 ack → 显示（first-sight）', () => {
  assert.deepEqual(resolveNoticeState({ ...base, noticeMode: DEFAULT_NOTICE_MODE, ackVersion: null }), { visible: true, reason: 'first-sight' })
})

check('② 同一版本 ack 过 → 不显示（version-acked）', () => {
  assert.deepEqual(resolveNoticeState({ ...base, noticeMode: 'once-per-version', ackVersion: '0.2.0-rc.1' }), { visible: false, reason: 'version-acked' })
})

check('③ 版本一变 → 重新显示（旧 ack 不能吞掉新版本的披露）', () => {
  const r = resolveNoticeState({ ...base, webAppVersion: '0.3.0-rc.1', noticeMode: 'once-per-version', ackVersion: '0.2.0-rc.1' })
  assert.equal(r.visible, true)
  assert.equal(r.reason, 'first-sight')
})

check('④ always 照旧显示 / off 不显示 / 非法 mode 回落默认（未 ack 时仍显示）', () => {
  assert.deepEqual(resolveNoticeState({ ...base, noticeMode: 'always', ackVersion: '0.2.0-rc.1' }), { visible: true, reason: 'mode-always' })
  assert.deepEqual(resolveNoticeState({ ...base, noticeMode: 'off', ackVersion: null }), { visible: false, reason: 'mode-off' })
  assert.deepEqual(resolveNoticeState({ ...base, noticeMode: 'bogus', ackVersion: null }), { visible: true, reason: 'first-sight' })
})

check('⑤ supported=true / 无 notice → 一律不显示', () => {
  assert.deepEqual(resolveNoticeState({ ...base, supported: true, noticeMode: 'always', ackVersion: null }), { visible: false, reason: 'supported' })
  assert.deepEqual(resolveNoticeState({ supported: false, notice: null, webAppVersion: '0.2.0-rc.1', noticeMode: 'always', ackVersion: null }), { visible: false, reason: 'no-notice' })
})

check('⑥ 硬约束：展示判定只产出 { visible, reason } —— 不可能顺手改 supported', () => {
  const r = resolveNoticeState({ ...base, noticeMode: 'off', ackVersion: '0.2.0-rc.1' })
  assert.deepEqual(Object.keys(r).sort(), ['reason', 'visible'])
  assert.equal(r.visible, false)
})

check('⑦ ack 落盘 / 读回；文件损坏 → 降级为没 ack 过（不抛）', () => {
  const written = writeCompatAck('0.2.0-rc.1')
  assert.equal(written.version, '0.2.0-rc.1')
  assert.ok(existsSync(COMPAT_ACK_FILE()), 'ack 文件应存在')
  assert.equal(JSON.parse(readFileSync(COMPAT_ACK_FILE(), 'utf8')).version, '0.2.0-rc.1')
  assert.equal(readCompatAck().version, '0.2.0-rc.1')
  writeFileSync(COMPAT_ACK_FILE(), '{ 坏 JSON', 'utf8')
  assert.deepEqual(readCompatAck(), { version: null, at: null })
})

check('⑧ 三态常量固定（always / once-per-version / off；默认 once-per-version）', () => {
  assert.deepEqual(NOTICE_MODES, ['always', 'once-per-version', 'off'])
  assert.equal(DEFAULT_NOTICE_MODE, 'once-per-version')
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)