// 0.5.42 加法（2026-10-06，用户点名）：「门控（兼容门总开关）」模态里那一行**右侧贴底**的 Star 提示 ——
// 静态接线门槛（全离线、纯文本断言，零外网、零 DSH_HOME）。
//
// 用户原话要点：在门控面板的右侧空白区加一行贴底对齐的 Star 提示，样式参考生态里另一插件的那句，
// 但**内容与图标都我们自己实现**；英文界面同样出一句（英文文案）；只加 UI，不动开关/路由/门控语义。
//
// 本套把"接线真的接上了、且只是加法"钉死（每一条都能独立变红）：
//   ① 该行存在，且真的在**门控模态**里、在既有正文**之后**（否则位置就不对）
//   ② 链接指向正确仓库（本仓库 GitHub 地址，且源码里只此一处）
//   ③ `target="_blank"` + `rel="noreferrer"`（与本仓其它外链同款）
//   ④ 中英两份文案都在（英文里不许出现中文；两边不许贴同一句）
//   ⑤ 用的是**内联 SVG** GitHub 标记（16×16 正统几何指纹、14–16px、currentColor、无任何外链资源）
//   ⑥ 贴底/贴右/不挤压：CSS 含 margin-top:auto + sticky bottom + justify-content:flex-end；行内不改左列宽
//   ⑦ 不倒退（只加 UI）：两个开关的 onClick 原文、遮罩点击关闭、门控既有文案键值都还在；
//      新行不挂 onClick、不新增任何请求（fetch/call）
//
// 用法：node tests/test-star-hint-ui.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
// 默认读仓库里的真产物；STAR_UI_SRC 只给"负控"用（把变异副本喂进来，证明本套真的会红）
const SRC = readFileSync(process.env.STAR_UI_SRC ?? join(ROOT, '..', 'lib', 'client.js'), 'utf8')

const REPO_URL = 'https://github.com/Noob-stupid/dsh-plugin-gating-hub'
const ZH_TEXT = '喜欢这个插件？去 GitHub 点个 Star'
const EN_TEXT = 'Enjoying this plugin? Star it on GitHub'
// GitHub Octicons mark-github-16 正统几何的开头（用来证明画的是那个标记，而不是随手一个方块/别的图标）
const MARK_FINGERPRINT = 'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656'

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const countOf = (needle, hay = SRC) => hay.split(needle).length - 1
const between = (from, to, hay = SRC) => {
  const a = hay.indexOf(from)
  if (a < 0) return null
  const b = hay.indexOf(to, a + from.length)
  if (b < 0) return null
  return hay.slice(a, b)
}

/** 取 `const <name> = {` 起花括号配对的行区间 + 该字典的 3 缩进顶层键（与 test-i18n-keys.mjs 同口径）。 */
function dictOf(source, name) {
  const lines = source.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp(`^\\s*const ${name} = \\{$`, 'u').test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  let depth = 0
  let end = -1
  for (let i = start; i < lines.length && end < 0; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break } }
    }
  }
  if (end < 0) return null
  const keys = []
  for (let i = start + 1; i < end; i += 1) {
    const m = lines[i].match(/^\t{3}([A-Za-z_$][\w$]*):\s/u)
    if (m) keys.push({ key: m[1], line: i + 1, text: lines[i] })
  }
  return { keys, from: start + 1, to: end + 1 }
}
const valueOf = (dict, key) => {
  const hit = dict.keys.find((k) => k.key === key)
  if (hit === undefined) return null
  const m = hit.text.match(/:\s*"((?:[^"\\]|\\.)*)"/u)
  return m === null ? null : m[1]
}

const zh = dictOf(SRC, 'zh')
const en = dictOf(SRC, 'en')

// ── 定位：门控模态那一段（从门控卡片的 maxWidth:520 到下一个模态 aiOpen 之前）────────────────
const GATE_CARD_ANCHOR = 'styles.modalCard, style: { maxWidth: 520 }'
const gateSeg = between(GATE_CARD_ANCHOR, 'aiOpen')
const STAR_USE = 'className: styles.starFoot'
const starIdx = SRC.indexOf(STAR_USE)
// 新增那行的完整片段：从它自己的 el("a") 起到 span 文案止（用索引切，避免依赖缩进/换行形态）
const hrefIdx = SRC.indexOf(`href: "${REPO_URL}"`)
const anchorStart = hrefIdx < 0 ? -1 : SRC.lastIndexOf('el("a", {', hrefIdx)
const anchorEndMarker = 'el("span", null, t("starHint"))'
const anchorEnd = SRC.indexOf(anchorEndMarker, hrefIdx)
const anchorSeg = anchorStart < 0 || anchorEnd < 0 ? null : SRC.slice(anchorStart, anchorEnd + anchorEndMarker.length)

// ── 括号配对（跳过字符串/注释）：用来证明这一行真的在**门控卡片的子树里**，而不是被挪到别处 ──
const skipStringAt = (src, i) => {
  const q = src[i]
  i += 1
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue }
    if (src[i] === q) return i
    i += 1
  }
  return src.length
}
/** at 指向 `el(` 的 e；返回这次调用的 ( … ) 配对区间。 */
const callSpanOf = (src, at) => {
  const open = src.indexOf('(', at)
  if (open < 0) return null
  let depth = 0
  let i = open
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') { i = skipStringAt(src, i) + 1; continue }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; i = nl; continue }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); i = e < 0 ? src.length : e + 2; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') { depth -= 1; if (depth === 0) return { start: open, end: i } }
    i += 1
  }
  return null
}
const spanOfMarker = (marker, before = SRC.length) => {
  // before：同名标记在仓里不止一处（框架模态与门控模态共用同一个遮罩 onClick）⇒ 取**门控卡片之前**那一处
  const at = SRC.lastIndexOf(marker, before)
  if (at < 0) return null
  const elAt = SRC.lastIndexOf('el(', at)
  return elAt < 0 ? null : callSpanOf(SRC, elAt)
}
const cardAnchorAt = SRC.indexOf(GATE_CARD_ANCHOR)
const gateSpan = spanOfMarker('styles.modalBackdrop, onClick: (event) =>', cardAnchorAt)
const gateCardSpan = spanOfMarker(GATE_CARD_ANCHOR)
const inGateCard = gateCardSpan !== null && starIdx > gateCardSpan.start && starIdx < gateCardSpan.end
const inGateModal = gateSpan !== null && starIdx > gateSpan.start && starIdx < gateSpan.end

console.log('=== ① 该行存在，且在门控模态里、在既有正文之后（贴底的位置）===')
{
  check('① 能定位到门控模态（卡片 maxWidth:520 … 下一个模态之前）', gateSeg !== null && gateSeg.includes('gateModalTitle'), `anchor=${GATE_CARD_ANCHOR}`)
  check('① 新增行存在（styles.starFoot 恰好 1 处使用）', countOf(STAR_USE) === 1, `count=${countOf(STAR_USE)}`)
  check('① 括号配对能定位门控卡片子树（检测器自校验）',
    gateCardSpan !== null && gateSpan !== null && gateCardSpan.end <= gateSpan.end && SRC.slice(gateCardSpan.start, gateCardSpan.end).includes('gateModalTitle'),
    `card=${gateCardSpan === null ? '未配对' : `${gateCardSpan.start}..${gateCardSpan.end}`} backdrop=${gateSpan === null ? '未配对' : `${gateSpan.start}..${gateSpan.end}`}`)
  check('① 新增行在**门控卡片的子树里**（不是被挪到别的面板/别的模态/模态外）', inGateCard, `star@${starIdx}`)
  check('① 新增行也在门控遮罩内（点卡片外可关闭的同一棵子树）', inGateModal, `star@${starIdx}`)
  const bodyLast = gateSeg === null ? -1 : SRC.indexOf(GATE_CARD_ANCHOR) + gateSeg.lastIndexOf('gateRowAdoptable')
  check('① 新增行排在门控既有正文**之后**（不在正文中间插队）', bodyLast > 0 && starIdx > bodyLast, `star@${starIdx} bodyLast@${bodyLast}`)
  check('① 新增行挂在卡片上（styles.starFoot 是 el("div") 的 className）', /el\("div", \{ className: styles\.starFoot \}/u.test(SRC))
  check('① 检测器自校验：不存在的标记必须取不到片段（负控）', between('这一行在源码里不存在', 'aiOpen') === null)
  check('① 检测器自校验：pairSpan 不会把"别处"误算进来（负控：门控卡片子树里不含 AI 模态）',
    gateCardSpan !== null && !SRC.slice(gateCardSpan.start, gateCardSpan.end).includes('aiEmpowerLabel'))
}

console.log('\n=== ② 链接指向正确仓库（且只此一处）===')
{
  check('② href 就是本仓库 GitHub 地址', anchorSeg !== null && anchorSeg.includes(`href: "${REPO_URL}"`), REPO_URL)
  check('② 该地址在 client.js 里只出现 1 次（没有第二份漂移的链接）', countOf(REPO_URL) === 1, `count=${countOf(REPO_URL)}`)
  check('② 链接文本走 i18n 键，不是硬编码中文', anchorSeg !== null && anchorSeg.includes('t("starHint")'))
}

console.log('\n=== ③ target / rel（与本仓其它外链同款）===')
{
  check('③ 有 target: "_blank"', anchorSeg !== null && anchorSeg.includes('target: "_blank"'))
  check('③ 有 rel: "noreferrer"', anchorSeg !== null && anchorSeg.includes('rel: "noreferrer"'))
  check('③ 仓内其它 GitHub 外链仍是同一写法（noreferrer 至少 2 处：既有 + 新增）', countOf('rel: "noreferrer"') >= 2, `count=${countOf('rel: "noreferrer"')}`)
}

console.log('\n=== ④ 中英两份文案都在（英文界面不许露中文）===')
{
  check('④ zh 词典有 starHint / starHintTitle', valueOf(zh, 'starHint') !== null && valueOf(zh, 'starHintTitle') !== null)
  check('④ en 词典有 starHint / starHintTitle', valueOf(en, 'starHint') !== null && valueOf(en, 'starHintTitle') !== null)
  check(`④ zh starHint 文案就位（${ZH_TEXT}）`, valueOf(zh, 'starHint') === ZH_TEXT, String(valueOf(zh, 'starHint')))
  check(`④ en starHint 文案就位（${EN_TEXT}）`, valueOf(en, 'starHint') === EN_TEXT, String(valueOf(en, 'starHint')))
  check('④ en 文案里 0 个中日韩字符（否则英文界面露中文）', !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(valueOf(en, 'starHint'))), String(valueOf(en, 'starHint')))
  check('④ en 标题里 0 个中日韩字符', !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(valueOf(en, 'starHintTitle'))), String(valueOf(en, 'starHintTitle')))
  check('④ zh 标题里确有中文（不是拿英文凑）', /[\u4e00-\u9fff]/u.test(String(valueOf(zh, 'starHintTitle'))), String(valueOf(zh, 'starHintTitle')))
  check('④ 两边不是同一句（防"只改一边"贴同一份文案）', valueOf(zh, 'starHint') !== valueOf(en, 'starHint'))
  check('④ 新键在英文词典里不缺席（en ⊆ zh 口径）',
    ['starHint', 'starHintTitle'].every((k) => zh.keys.some((x) => x.key === k) && en.keys.some((x) => x.key === k)))
}

console.log('\n=== ⑤ 图标：内联 SVG 的**标准 GitHub 标记**（不抄别家代码/资源）===')
{
  const svgSeg = anchorSeg === null ? null : between('el("svg", {', 'el("span", null, t("starHint"))', anchorSeg)
  check('⑤ 图标是内联 el("svg")（不是位图/字体图标）', svgSeg !== null, svgSeg === null ? `anchorSeg=${anchorSeg === null ? '未取到' : 'ok'}` : undefined)
  check('⑤ 16×16 视图 + currentColor 填充', svgSeg !== null && svgSeg.includes('viewBox: "0 0 16 16"') && svgSeg.includes('fill: "currentColor"'))
  check('⑤ 尺寸在 14–16px（用户要求约 14–16、与文字同尺度）',
    svgSeg !== null && (() => { const w = Number((svgSeg.match(/width:\s*(\d+)/u) ?? [])[1]); const h = Number((svgSeg.match(/height:\s*(\d+)/u) ?? [])[1]); return w >= 14 && w <= 16 && w === h })(),
    svgSeg === null ? undefined : (svgSeg.match(/width:\s*\d+/u) ?? [''])[0])
  check('⑤ 画的是 GitHub 标记本体（Octicons 正统几何指纹）', svgSeg !== null && svgSeg.includes(MARK_FINGERPRINT))
  check('⑤ 图标对读屏隐藏（aria-hidden），且不可聚焦', svgSeg !== null && svgSeg.includes('"aria-hidden": "true"') && svgSeg.includes('focusable: "false"'))
  check('⑤ 0 处外链资源（没有 <img>/url()/外链 icon）', !/<img|url\(|\.svg["']|background-image/iu.test(anchorSeg ?? ''))
  check('⑤ 检测器自校验：换个不存在的几何指纹必须判否（负控）', !SRC.includes('M0.000 0.000c-not-a-real-mark'))
}

console.log('\n=== ⑥ 贴底 / 贴右 / 不挤压：CSS 规则到位 ===')
{
  const footCss = (SRC.match(/\.pc_starFoot\{([^}]*)\}/u) ?? [])[1] ?? ''
  const linkCss = (SRC.match(/\.pc_starLink\{([^}]*)\}/u) ?? [])[1] ?? ''
  check('⑥ .pc_starFoot 存在', footCss !== '')
  check('⑥ 贴底：margin-top:auto（卡片有富余高度时把这一行推到底）', /margin-top:auto/u.test(footCss), footCss)
  check('⑥ 贴底：position:sticky + bottom:0（正文超长滚动时仍钉在卡片下沿）', /position:sticky/u.test(footCss) && /bottom:0/u.test(footCss), footCss)
  check('⑥ 贴右：justify-content:flex-end', /justify-content:flex-end/u.test(footCss))
  check('⑥ 整行是一个 flex 行（不占左侧正文的换行空间）', /display:flex/u.test(footCss))
  check('⑥ 不挤压：这一行不设 width/flex，链接 flex:none（绝不抢左列宽度）', !/width:/u.test(footCss) && !/flex:/u.test(footCss) && /flex:none/u.test(linkCss), `foot={${footCss}}`)
  check('⑥ 次级灰：color:var(--dsw-alias-label-secondary)', /color:var\(--dsw-alias-label-secondary\)/u.test(linkCss), linkCss)
  check('⑥ 图标与文字对齐：inline-flex + align-items:center + gap', /display:inline-flex/u.test(linkCss) && /align-items:center/u.test(linkCss) && /gap:/u.test(linkCss))
  check('⑥ 链接样式不喧宾夺主：常态无下划线', /text-decoration:none/u.test(linkCss))
  check('⑥ 有 :hover 态（可发现它是可点的）', /\.pc_starLink:hover\{/u.test(SRC))
  check('⑥ styles 映射与 CSS 类名对得上（防"映射写错→样式整条丢失"）',
    SRC.includes('starFoot: "pc_starFoot"') && SRC.includes('starLink: "pc_starLink"') && SRC.includes('.pc_starFoot{') && SRC.includes('.pc_starLink{'))
}

console.log('\n=== ⑦ 只加 UI：开关/门控语义/请求都没动 ===')
{
  check('⑦ 开关 1 的 onClick 原文还在（升级时自动禁用）', SRC.includes('onClick: () => setCompatGate({ autoDisable: !gateAutoDisable })'))
  check('⑦ 开关 2 的 onClick 原文还在（打开时自动检测）', SRC.includes('onClick: () => setCompatGate({ autoDetect: !gateAutoDetect })'))
  check('⑦ 遮罩点击关闭仍在（点卡片外关掉门控模态）', SRC.includes('if (event.target === event.currentTarget) setGateOpen(false);'))
  check('⑦ 新增行不挂 onClick（纯链接，无点击副作用）', anchorSeg !== null && !anchorSeg.includes('onClick'))
  check('⑦ 新增行不引入任何请求（无 fetch/call(，只加一行 UI 不改路由）', anchorSeg !== null && !/fetch\(|\bcall\(/u.test(anchorSeg))
  check('⑦ 门控模态标题与既有文案没被动过', valueOf(zh, 'gateModalTitle') === '门控（兼容门总开关）' && valueOf(en, 'gateModalTitle') === 'Gating (compat gate master switches)')
  check('⑦ 两个开关的标签/提示键值没被动过',
    valueOf(zh, 'compatGateAutoDisable') === '升级时自动禁用不适配插件'
    && valueOf(zh, 'compatGateAutoDetect') === '打开时自动检测已适配（仅提示）'
    && valueOf(en, 'compatGateAutoDisable') === 'Auto-disable incompatible plugins on upgrade')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
