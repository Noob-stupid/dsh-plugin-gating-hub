// 0.5.84 加法（用户第 6 项）：功能包工具栏的 **link 入口**
//
// 用户原话（大意）：开发式链接的清单藏在「升级安全」里，要找到入口再展开才看得到 ——
// 功能包工具栏上应该有个入口，能直接跳到那份数据。
//
// 本套钉死四件事：
//   ① 工具栏（PluginConsoleTab）里确实有一个 link 按钮，点开就拉 `GET /plugin-console/links`；
//   ② 它展示的是**同一份数据**（同样的字段：ready / target / missingDeps / missingPeers / 垫片 / 持久化），
//      不在客户端自己重算"自足/缺什么"；
//   ③ 安全面板里那块**既有的折叠展示保留不动**（折叠行为是用户 2026-10-17 明确要求的，不得回归）；
//   ④ 主面板里不许出现 fill()（0.5.59「整块空白」事故的根因；两个守卫已钉，这里再就地复述一遍）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

/** 两个组件的区间：[start, end)。区间判定沿用 test-ui-contract ⑨ 的定位方式。 */
const lineOf = (needle) => SRC.split('\n').findIndex((l) => l.includes(needle)) + 1
const mainStart = lineOf('function PluginConsoleTab({')
const safetyStart = lineOf('function PluginSafetyTab({')
check('能定位两个组件（PluginConsoleTab / PluginSafetyTab）', mainStart > 0 && safetyStart > mainStart, `main@${mainStart} safety@${safetyStart}`)
const mainBlock = SRC.split('\n').slice(mainStart - 1, safetyStart - 1).join('\n')
const safetyBlock = SRC.split('\n').slice(safetyStart - 1).join('\n')

console.log('\n=== ① 工具栏入口：有按钮、点开真的打那个只读接口 ===')
{
  check('① 工具栏里有 linksBtn 按钮（属于功能包工具栏那一组 toolItem）',
    /className: styles\.toolItem[\s\S]{0,400}?t\("linksBtn"\)/u.test(mainBlock), '')
  check('① 按钮状态绑定 linksPanelOpen（可与其它面板区分开）', /"data-active": linksPanelOpen \? "true" : "false"/u.test(mainBlock))
  check('① 点开就拉 /plugin-console/links（无 body ⇒ GET，与路由声明的方法一致）',
    /call\("\/plugin-console\/links"\)/u.test(mainBlock))
  check('① 拉取失败也如实展示（不静默成"没有 link 依赖"）',
    /ok: false, items: \[\], count: 0, readyCount: 0, error:/u.test(mainBlock))
  check('① 面板默认关闭（不占版面），且有重新读取入口',
    /const \[linksPanelOpen, setLinksPanelOpen\] = react\.useState\(false\)/u.test(mainBlock) && /t\("linksPanelReload"\)/u.test(mainBlock))
}

console.log('\n=== ② 展示的是同一份数据（字段逐项对齐安全面板那块）===')
{
  const fields = ['x.ready === true', 'x.target', 'x.missingDeps', 'x.missingPeers', 'x.shims', 'x.persisted']
  check('② 链接清单的六类信息都展示了（ready/指向/缺依赖/缺 peer/垫片/持久化）',
    fields.every((f) => mainBlock.includes(f)), fields.filter((f) => !mainBlock.includes(f)).join(', ') || '全部命中')
  check('② 判据不在客户端重算（直接读服务端下发的 ready/missing*，没有本地判定分支）',
    !/planLinkSelfSufficiency|persistReport|readyCount\s*=\s*\(/u.test(mainBlock))
  check('② 摘要行用服务端给的 count/readyCount（占位符朴素替换，不动 fill）',
    /t\("linksTitle"\)\.replace\("\{n\}"/u.test(mainBlock) && /replace\("\{ready\}"/u.test(mainBlock))
}

console.log('\n=== ③ 安全面板里既有的折叠展示保留（用户明确要求的折叠行为不得回归）===')
{
  check('③ 安全面板仍有 linksOpen 折叠状态（默认收起）', /const \[linksOpen, setLinksOpen\] = react\.useState\(false\)/u.test(safetyBlock))
  check('③ 折叠头与 aria-expanded 都在', /"aria-expanded": linksOpen \? "true" : "false"/u.test(safetyBlock) && /setLinksOpen\(\(v\) => !v\)/u.test(safetyBlock))
  check('③ 折叠块仍复用同一个只读接口', /call\("\/plugin-console\/links"\)/u.test(safetyBlock))
}

console.log('\n=== ④ 主面板里不许出现 fill()（0.5.59 空白事故的根因）===')
{
  const codeLines = mainBlock.split('\n').filter((l) => !/^\s*\/\//u.test(l))
  const hits = codeLines.filter((l) => /\bfill\(/u.test(l))
  check('④ 主面板（含本次新增的面板）可执行代码里 0 处 fill(', hits.length === 0, hits.slice(0, 2).map((l) => l.trim()).join(' | ') || '0 处')
}

console.log('\n=== ⑤ i18n：新键中英各一条（en ⊆ zh 由 test-i18n-keys 把守）===')
{
  for (const key of ['linksBtn', 'linksPanelTitle', 'linksPanelLoading', 'linksPanelReload', 'linksPanelEmpty']) {
    const n = (SRC.match(new RegExp(`^\\t{3}${key}:`, 'gmu')) ?? []).length
    check(`⑤ ${key} 在字典里出现两次（zh + en）`, n === 2, `count=${n}`)
  }
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
