// 跨请求共享的可变运行时状态（分层 Step 8a 从 lib/index.js 抽出）
//
// 为什么单独成模块：ESM 的导入绑定是**只读**的（守卫 ⑧ 会拦截"外部给导入绑定赋值"），
// 而路由拆分后这些状态的写点会散落到 lib/server/routes/**。所以这里：
//   · 只导出**读取绑定**（读没问题）+ setter / next 函数；
//   · 所有赋值都发生在本模块内部（合法且可查）。


export let marketIndexCache = null
export let fwCheckCache = null
export let patchHealAt = null
export let patchHealReport = null
export let installJobSeq = 0
export let aiJobSeq = 0
export const installJobs = new Map()

export const setMarketIndexCache = (v) => { marketIndexCache = v }
export const setFwCheckCache = (v) => { fwCheckCache = v }
export const setPatchHealAt = (v) => { patchHealAt = v }
export const setPatchHealReport = (v) => { patchHealReport = v }
export const nextInstallJobSeq = () => (installJobSeq += 1)
export const nextAiJobSeq = () => (aiJobSeq += 1)
