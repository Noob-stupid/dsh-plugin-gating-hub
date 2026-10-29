// issue #26 的回归钉子：`validatePatchYaml` 对含盘符路径的序列项误报「文件末尾仍有未闭合的引号」。
//
// 现场（用户 eternaljichen，Windows 11 + desktop profile）：真实 cordis.patch.yml 228 行 / 50 个顶层条目，
// js-yaml 能正常解析、框架也能正常启动，但 `validatePatchYaml` 报「未闭合引号」⇒
// safe-boot 的写盘前闸门全程空转 ⇒ 一份安全启动快照都写不出来（restore-last-good 整条救火链失效）。
//
// 根因：`- 'D:/x/y.js'` 里盘符的冒号被 key:value 正则当成分隔符，value 变成 `/x/y.js'`（首字符不是引号），
// 行尾的 `'` 于是被当作「引号开口」跨行挂到文件末尾。
//
// 这份测试同时钉住「别把该报的漏掉」：截断/未闭合/tab 缩进/顶层键值对必须仍然报错。
import assert from 'node:assert/strict'
import { validatePatchYaml } from '../lib/server/domain/patch-yaml-check.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) {
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
const problems = (src) => {
  const r = validatePatchYaml(src)
  return { ok: r?.ok === true, list: Array.isArray(r?.problems) ? r.problems : [] }
}

// ① 误报：盘符序列项（issue 的最小复现原文）
check('① 带盘符的序列项不再误报未闭合引号（issue 最小复现）', () => {
  const r = problems("- id: a\n  args:\n    - 'D:/x/y.js'\n")
  assert.equal(r.ok, true, `仍报错：${r.list.join(' | ')}`)
})

// ② 双引号版 + 多个盘符项 + 反斜杠路径
check('② 双引号盘符项、多个盘符项、Windows 反斜杠路径都不误报', () => {
  for (const src of [
    '- id: a\n  args:\n    - "C:/x/y.js"\n',
    "- id: a\n  args:\n    - 'D:/a.js'\n    - 'C:/b.js'\n",
    "- id: a\n  args:\n    - 'D:\\\\AI\\\\dsh\\\\x.js'\n",
  ]) {
    const r = problems(src)
    assert.equal(r.ok, true, `误报：${src.split('\n')[2]} ⇒ ${r.list.join(' | ')}`)
  }
})

// ③ 真阳性不能漏：值以引号开头且跨行没闭合
check('③ 真的未闭合引号仍然报错', () => {
  const r = problems("- id: a\n  description: '第一行\n    续行不收尾\n")
  assert.equal(r.ok, false, '该报的没报')
  assert.ok(r.list.some((p) => p.includes('未闭合')), `报的不是未闭合：${r.list.join(' | ')}`)
})

// ④ 其它真阳性照旧：tab 缩进、顶层键值对、空文件
check('④ tab 缩进 / 顶层键值对 / 空文件仍按原判据报错', () => {
  assert.equal(problems('- id: a\n\tdescription: x\n').ok, false, 'tab 缩进该报')
  assert.equal(problems('foo: 1\n').ok, false, '顶层键值对该报')
  // 空补丁是合法的（等于没有任何覆盖项）—— 这条钉的是「别把它算成错误」，不是放宽原判据
  assert.equal(problems('').ok, true, '空文件本来就该通过')
})

// ⑤ 合法补丁整体通过：多行 + 盘符 + 嵌套
check('⑤ 一份含盘符与嵌套的合法补丁整体通过', () => {
  const src = [
    '- id: a',
    '  disabled: false',
    '  args:',
    "    - 'D:/AI/DSH/downloads/x.js'",
    '    - plain-value',
    '- id: b',
    '  note: "带 \"引号\" 的值"',
    '',
  ].join('\n')
  const r = problems(src)
  assert.equal(r.ok, true, `合法补丁被误报：${r.list.join(' | ')}`)
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
