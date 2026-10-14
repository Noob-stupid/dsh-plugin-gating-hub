# fw-watchdog-task.ps1 —— 注册/卸载 DSH 框架闭包看门狗的计划任务（Windows）
#
# 为什么用计划任务而不是改官方代码：官方启动链没有"启动前执行外部命令"的钩子
#   （取证见 scripts/fw-watchdog.mjs 头注释）。计划任务是**不改任何官方文件**、
#   且 DSH 升级也不会被覆盖的唯一位置。
#
# 用法（在 scripts 目录下）：
#   powershell -ExecutionPolicy Bypass -File fw-watchdog-task.ps1            # 安装（幂等）
#   powershell -ExecutionPolicy Bypass -File fw-watchdog-task.ps1 -Status    # 看状态
#   powershell -ExecutionPolicy Bypass -File fw-watchdog-task.ps1 -Uninstall # 卸载
#   powershell -ExecutionPolicy Bypass -File fw-watchdog-task.ps1 -RunNow    # 立刻跑一轮
#
# 任务形态：登录时启动 → 常驻（脚本内部每 20s 一轮）→ 失败自动重启（3 次 / 间隔 1 分钟）。
#   · 为什么常驻而不是"每 1 分钟触发一次"：任务计划程序的最小重复间隔是 1 分钟，
#     而我们要 20s；常驻 + 内部定时更精确，也避免每分钟拉起一个进程。
#   · 只读判据 + 只修框架闭包：不杀进程、不抢端口、不 spawn dsh、不改官方文件。
Param(
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'
$TaskName = 'DSH-FwWatchdog'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Watchdog = Join-Path $ScriptDir 'fw-watchdog.mjs'

if ($Status) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $t) { Write-Host "任务 $TaskName ：未安装"; exit 0 }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "任务     : $($t.TaskName)"
  Write-Host "状态     : $($t.State)"
  Write-Host "上次运行 : $($info.LastRunTime)   结果码: $($info.LastTaskResult)"
  Write-Host "下次运行 : $($info.NextRunTime)"
  Write-Host "动作     : $($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" })"
  exit 0
}

if ($Uninstall) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $t) { Write-Host "任务 $TaskName 本来就不存在，无需卸载"; exit 0 }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已卸载任务 $TaskName"
  exit 0
}

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "已触发一轮（看日志：~/.dsh/plugin-console/fw-watchdog.log）"
  exit 0
}

# ── 解析 node（钉绝对路径：计划任务里的 PATH 不可靠）────────────────────────
$node = $null
$candidates = @()
if ($env:DSH_DESKTOP_NODE_EXECUTABLE) { $candidates += $env:DSH_DESKTOP_NODE_EXECUTABLE }
foreach ($root in @('D:\dsh-desktop', "$env:ProgramFiles\DeepSeek Harness", "$env:LOCALAPPDATA\Programs\DeepSeek Harness")) {
  if ($root) { $candidates += (Join-Path $root 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe') }
}
$onPath = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($onPath) { $candidates += $onPath }
foreach ($c in $candidates) { if (-not $node -and $c -and (Test-Path -LiteralPath $c)) { $node = $c } }
if (-not $node) { throw "找不到可用的 node —— 请安装 Node.js 后重试" }

if (-not (Test-Path -LiteralPath $Watchdog)) { throw "找不到看门狗脚本：$Watchdog" }

# ── 为什么要 `--daemon` 而不是直接跑 node（★ 2026-10-14 两次实测踩坑后定案）：
#    ① 任务直接跑 node.exe ⇒ Windows 弹出**可见的控制台窗口**（本机实测桌面出现一个
#       Windows Terminal，标题就是 node 的绝对路径），后台看门狗不该占用户桌面；
#    ② 改用 .vbs 启动器（window style 0）⇒ wscript 挂住、拉不起子进程（实测两次都没起来）。
#    最终做法：任务跑 `node … --daemon`，脚本**自己以 detached + stdio:'ignore' +
#    windowsHide 再拉起一份**并立刻返回 ⇒ 任务那条命令秒退、真正干活的那份无窗口在后台跑，
#    重复启动由 pid 锁挡住（幂等）。
Write-Host "node     : $node"
Write-Host "看门狗   : $Watchdog （--daemon：自己脱离，无控制台窗口）"

# ── 注册（幂等：先卸旧的）──────────────────────────────────────────────────
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已移除旧任务，准备重建"
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$Watchdog`" --daemon" -WorkingDirectory $ScriptDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)      # 零 = 不限制运行时长（常驻）

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'DSH 框架闭包看门狗：外壳在跑但服务进程不在时，检查并修复被掏空的框架包（只修闭包，不杀进程/不抢端口/不改官方文件）。日志：~/.dsh/plugin-console/fw-watchdog.log' | Out-Null

Write-Host ""
Write-Host "✅ 已注册计划任务 $TaskName（登录时启动，常驻，20s 一轮）"
Write-Host "   看状态 : powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Status"
Write-Host "   跑一轮 : powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -RunNow"
Write-Host "   卸载   : powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Uninstall"
Write-Host "   日志   : $env:USERPROFILE\.dsh\plugin-console\fw-watchdog.log"
Write-Host ""
Write-Host "现在就启动它（不用等下次登录）："
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "   当前状态: $((Get-ScheduledTask -TaskName $TaskName).State)   上次结果码: $($info.LastTaskResult)"
