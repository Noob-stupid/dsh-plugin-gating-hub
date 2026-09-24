/**
 * strict-ctx.mjs —— Cordis 语义的「严格测试替身」（2026-09-22 事故的机制化防线，别删）。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────────────
 * 0.3.59（预览线 beta.13）为单测留了个「安装通道实现注入缝」，写成了 `ports?.installChannels`（属性访问）。
 * 单测喂进去的 ctx 是**手写普通对象** —— 读任何属性都返回 undefined，于是测试全绿；
 * 而生产路径上 `ports` 就是 cordis 的 ctx 代理，读一个没写进 `inject` 的名字会**同步抛**：
 *
 *     cannot get property "installChannels" without inject
 *
 * → 每一次安装都在进入通道之前失败（面板：「操作失败：cannot get property ... without inject」）。
 * 0.3.60/0.3.61 用 try/catch 抢修了症状，但**根因没解决**：假 ctx 不拒绝未声明的属性访问，
 * 所以「单测全绿 / 生产必炸」这类缺陷可以反复发生。本文件把 cordis 的语义复刻成替身。
 *
 * ── 复刻的语义（对照 @deepseek-ai/cordis 的 ReflectService.handler）────────────────
 *   · `ctx.get(name)` —— 可选读取的**正规写法**：永不校验 inject，未提供时返回 undefined；
 *   · `ctx.NAME`      —— 只对 **inject 声明过**的名字合法（数组或 `{ required, optional }` 都认）；
 *                        只是被 provide 进来、却没进 inject 的服务（如测试注入的 installChannels）
 *                        一律抛 `cannot get property "NAME" without inject`，并记进账本；
 *   · symbol / `then` / `prototype` / 纯数字串 / `_` 开头的名字 —— cordis 的 isSpecialProperty，直接透传
 *                        （否则 `await ctx`、`console.log(ctx)`、`{...ctx}` 都会误炸）；
 *   · `ctx.effect` 等 Context 核心成员 —— 相当于 ctx 自身的属性，属性访问合法。
 *
 * ── 用法（两条线的测试保持一致）──────────────────────────────────────────────────
 *   import { strictCtx, violationsOf } from './strict-ctx.mjs'
 *   const ctx = strictCtx({
 *     inject: PLUGIN_INJECT,                                    // 插件真实导出的 inject（别手抄，抄了会漂移）
 *     services: { webServer, loader, installChannels: stub },    // 按名字提供；只有 inject 里的能属性访问
 *     own: { baseUrl: 'file:///…' },                             // ctx 自身属性/核心方法（属性访问合法）
 *   })
 *   … 跑真实代码 …
 *   check('没有属性式访问未声明的名字', violationsOf(ctx).length === 0, violationsOf(ctx).join('、'))
 *
 * `violationsOf(ctx)` 是**关键**：未声明属性被读取时既抛错、又记账 —— 即使调用方用 try/catch 把异常
 * 吞了（0.3.60/0.3.61 的兜底正是 try/catch），账本仍然能证明「这里读过未声明的名字」，测试必须红。
 */

/** cordis 的 isSpecialProperty：这些名字不走 inject 校验（cordis/lib/index.js）。 */
const RESERVED_PROPS = ['prototype', 'then']

function isSpecialProperty(prop) {
  return typeof prop === 'symbol'
    || RESERVED_PROPS.includes(prop)
    || String(Number.parseInt(prop, 10)) === prop
    || prop.startsWith('_')
}

/** `export const inject = ['a', 'b']` 与方案 B 的 `{ required: [...], optional: [...] }` 都要认。 */
function normalizeInject(inject) {
  if (Array.isArray(inject)) return { required: [...inject], optional: [] }
  return { required: [...(inject?.required ?? [])], optional: [...(inject?.optional ?? [])] }
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

/**
 * 造一个严格替身 ctx。
 * @param inject   插件声明的注入（数组或 { required, optional }）—— 只有这些名字能属性式读取
 * @param services 按名字提供的服务（模拟 cordis 的 provide：进 store，不进 ctx 自身属性）
 * @param own      ctx 自身属性/核心方法（模拟 `this.baseUrl = undefined`、原型上的 effect 等）
 */
function strictCtx({ inject = [], services = {}, own = {} } = {}) {
  const { required, optional } = normalizeInject(inject)
  const declared = new Set([...required, ...optional])
  const violations = []
  const target = {
    // Context 核心成员：cordis 里在实例/原型上，属性访问不需要 inject（effect 返回 disposer）
    effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    ...own,
    // 可选读取的正规入口：不校验 inject，未提供返回 undefined（cordis ReflectService.get）
    get: (name) => (hasOwn(services, name) ? services[name] : undefined),
    __violations: violations,
  }
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (isSpecialProperty(prop)) return Reflect.get(t, prop, receiver)
      if (Reflect.has(t, prop)) return Reflect.get(t, prop, receiver)
      if (declared.has(prop)) return hasOwn(services, prop) ? services[prop] : undefined
      violations.push(String(prop))
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
    has(t, prop) {
      if (isSpecialProperty(prop)) return Reflect.has(t, prop)
      if (Reflect.has(t, prop)) return true
      return declared.has(prop) || hasOwn(services, prop)
    },
    set(t, prop, value, receiver) {
      if (isSpecialProperty(prop) || Reflect.has(t, prop) || declared.has(prop)) return Reflect.set(t, prop, value, receiver)
      violations.push(String(prop))
      throw new Error(`cannot set property "${String(prop)}" without provide`)
    },
  })
}

/** 未声明名字被属性式访问的次数（含异常被 try/catch 吞掉的那些）——测试据此断言"代码里没有这类访问"。 */
function violationsOf(ctx) {
  const list = ctx?.__violations
  return Array.isArray(list) ? list : []
}

export { isSpecialProperty, normalizeInject, strictCtx, violationsOf }
