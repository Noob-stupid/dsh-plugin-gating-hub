// L0 · infra —— 框架升级脚本里的「安装后结构完整性校验」生成器（2026-09-24）
//
// 为什么单独放一个模块：这段是升级脚本里唯一需要**逐项验结构**的地方，而 routes/framework-upgrade.js
// 已经贴着架构守卫的行数上限（那一段 600+ 行的 PowerShell 模板是历史遗留）。抽出来既守住上限，
// 也让这段逻辑能被单独读、单独审 —— 它是"升级完却没装全"这类事故的最后一道闸。
//
// 自包含：只用 target / nodePath / fwRoot 三个值（路径由调用方用 ps() 算好传进来），不依赖任何宿主上下文。

/** 生成"安装后结构校验"的 PowerShell 片段（返回单个字符串，供升级脚本数组作为一个元素展开）。 */
function fwIntegrityCheck(params) {
  const { target, nodePath, fwRoot } = params
  return [
    `  # 安装后结构完整性校验：版本号对 ≠ 装完整。2026-09-24 事故：一次升级的 pnpm 安装被中断，`,
    `  # 顶层 @deepseek-ai\\dsh 目录整个消失、.pnpm 实体只剩 lib 里几个硬链接 —— 只对版本号的校验`,
    `  # 有可能被"package.json 写成功但 lib 没落全"骗过，等下次重启才发现服务起不来。`,
    `  if ($code -eq 0) {`,
    `    try {`,
    `      $fwDsh = Join-Path '${fwRoot}' '@deepseek-ai\\dsh'`,
    `      $binA = Join-Path $fwDsh 'lib\\bin.js'`,
    `      $binB = $null`,
    `      $ent = Get-ChildItem -Path (Join-Path '${fwRoot}' '.pnpm') -Directory -Filter '@deepseek-ai+dsh@${target}*' -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `      if ($ent) { $binB = Join-Path $ent.FullName 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js' }`,
    `      $bin = $null`,
    `      if (Test-Path -LiteralPath $binA) { $bin = $binA } elseif ($binB -and (Test-Path -LiteralPath $binB)) { $bin = $binB }`,
    `      if (-not (Test-Path -LiteralPath (Join-Path $fwDsh 'package.json'))) { Log '结构校验失败：顶层 @deepseek-ai\\dsh\\package.json 不存在（安装不完整）'; $code = 1 }`,
    `      elseif (-not $bin) { Log '结构校验失败：找不到 dsh 的 lib/bin.js（顶层与 .pnpm 都没有）——装完也拉不起来，按失败处理'; $code = 1 }`,
    `      else {`,
    `        $probe = (& '${nodePath}' $bin --version 2>&1 | Out-String).Trim()`,
    `        if ($probe -ne '${target}') { Log ('结构校验失败：CLI 自报版本 ' + $probe + '，目标 ${target}（安装不完整或被其它副本顶替），按失败处理'); $code = 1 }`,
    `        else { Log ('结构校验通过：package.json + bin.js 就位，CLI 自报 ' + $probe) }`,
    `      }`,
    `    } catch { Log ('结构校验异常，按失败处理：' + $_.Exception.Message); $code = 1 }`,
    `  }`,
  ].join('\r\n')
}

export { fwIntegrityCheck }
