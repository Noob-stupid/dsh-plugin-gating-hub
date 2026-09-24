// L1 · domain —— profile 清单（<profile>/package.json）的写入层：bundles 层 + dependencies 声明
//
// 为什么单独成模块（2026-09-24）：安装落点原本散在 install.js 里，而 install.js 已经贴着
// 架构守卫的 600 行上限；更重要的是，「装了但没声明」这一类问题反复出现（官方面板看不见 /
// pnpm 按清单还原 / 我们的清理判据误当孤儿），把「怎么写清单」收口到一处才好统一保证。
//
// 规矩：
//   · 所有写操作走 fsx 的写队列（queuedWrite），避免并发读改写互相覆盖；
//   · **安装即声明**：装到哪版就把 dependencies 写成哪版（读磁盘真实版本，不猜）；
//   · **卸载即撤销**：否则清单留幽灵依赖，下次 pnpm 操作把它装回来；
//   · 来源型 spec（link:/file:/git:/URL）绝不改写成版本号 —— 改写等于丢来源。

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { queuedWrite } from '../infra/fsx.js'
import { resolvePackageJson } from '../infra/paths.js'

/** 官方 profile 模板自带的 bundle（其余 bundle 视为用户额外添加）。 */
const DEFAULT_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 读磁盘上真实安装的版本（读不到返回 null，绝不猜）。 */
async function installedVersionOf(profileDir, packageName) {
  try {
    const pkgPath = resolvePackageJson(packageName, profileDir)
    if (pkgPath === null) return null
    const version = JSON.parse(await readFile(pkgPath, 'utf8')).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

async function readManifest(profileDir) {
  return JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
}

async function writeManifest(profileDir, manifest) {
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * 把包追加进 profile 的 `dsh.profile.bundles` 层（与官方 `dsh plugin add` 的 reconcile 一致），
 * 同一把写锁内**顺手声明 dependencies**（安装即声明）。
 * @returns {{ version: string|null }}
 */
async function addBundleToManifest(profileDir, packageName) {
  return queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    let touched = false
    if (!bundles.includes(packageName)) {
      bundles.push(packageName)
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
      touched = true
    }
    const version = await installedVersionOf(profileDir, packageName)
    if (version !== null) {
      const deps = { ...(manifest.dependencies ?? {}) }
      if (deps[packageName] !== version) { deps[packageName] = version; manifest.dependencies = deps; touched = true }
    }
    if (touched) await writeManifest(profileDir, manifest)
    return { version }
  })
}

/** 从 profile manifest 移除一个 bundle（同时撤销 dependencies 声明，避免留下幽灵依赖）。 */
async function removeBundleFromManifest(profileDir, bundlePkg) {
  return queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const next = bundles.filter((name) => name !== bundlePkg)
    let touched = false
    if (next.length !== bundles.length) {
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: next } }
      touched = true
    }
    const deps = { ...(manifest.dependencies ?? {}) }
    if (bundlePkg in deps) { delete deps[bundlePkg]; manifest.dependencies = deps; touched = true }
    if (touched) await writeManifest(profileDir, manifest)
    return { changed: touched }
  })
}

/**
 * 安装即声明：把包写进 profile 清单的 `dependencies`。
 *
 * 三个现象同一个根因（2026-09-24 复盘）：
 *   · 官方「设置 → 插件」的**已安装**分区只显示清单里声明过的包 —— 我们手铺的包在那里看不见；
 *   · 任何一次 pnpm 操作都会按清单 + lock 重装，未声明的包会被**还原/清掉**；
 *   · 连我们自己的「清理残余」也按「有没有被声明」判孤儿 —— 判据病根也在这里。
 * @returns {{ changed: boolean, version: string|null, reason: string|null }}
 */
async function declareProfileDependency(profileDir, packageName, version = null) {
  return queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const resolved = typeof version === 'string' && version !== '' ? version : await installedVersionOf(profileDir, packageName)
    if (resolved === null) return { changed: false, version: null, reason: '读不到已安装版本' }
    const deps = { ...(manifest.dependencies ?? {}) }
    if (deps[packageName] === resolved) return { changed: false, version: resolved, reason: null }
    deps[packageName] = resolved
    manifest.dependencies = deps
    await writeManifest(profileDir, manifest)
    return { changed: true, version: resolved, reason: null }
  })
}

/** 卸载即撤销声明。 */
async function undeclareProfileDependency(profileDir, packageName) {
  return queuedWrite(async () => {
    const manifest = await readManifest(profileDir)
    const deps = { ...(manifest.dependencies ?? {}) }
    if (!(packageName in deps)) return { changed: false }
    delete deps[packageName]
    manifest.dependencies = deps
    await writeManifest(profileDir, manifest)
    return { changed: true }
  })
}

export { DEFAULT_BUNDLES, addBundleToManifest, declareProfileDependency, installedVersionOf, removeBundleFromManifest, undeclareProfileDependency }
