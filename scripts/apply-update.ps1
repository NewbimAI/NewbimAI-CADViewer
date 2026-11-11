<#
  应用已经下载并解压好的更新包（由 server/update.js 的 stageUpdate 生成 stage 目录）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\apply-update.ps1 `
      -Root "D:\软件\CADViewer" `
      -Stage "D:\软件\CADViewer\data\updates\0.2.5\stage" `
      -Pid 12345 `
      -Restart

  说明：
    · 先等 -Pid 对应的服务进程退出，再备份、复制、校验；失败自动回滚。
    · 只覆盖 server\ 与 web\dist\ 等应用文件，绝不改动 data\、node\、bin\。
    · 所有日志追加到 <Root>\data\updates\apply.log。
#>
param(
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][string]$Stage,
  # 注意：$PID 是 PowerShell 只读自动变量，不能直接作为参数名；
  # 用 Alias("Pid") 保持命令行 -Pid 的调用方式不变。
  [Parameter(Mandatory)][Alias("Pid")][int]$ProcessId,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$script:LogFile = $null

# 这些变量在 try 之前声明，便于异常时回滚。
$serverDir = $null
$webDistDir = $null
$backupServer = $null
$backupWebDist = $null
$movedServer = $false
$movedWeb = $false

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  if ($script:LogFile) {
    try {
      Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    } catch {
      # 日志写不进去也不能影响更新本身。
    }
  }
}

# 用备份恢复被替换的目录。
function Restore-Backup {
  if (-not $serverDir) { return }
  Write-Log "开始回滚…"

  if ($backupServer -and (Test-Path -LiteralPath $backupServer)) {
    if (Test-Path -LiteralPath $serverDir) {
      Remove-Item -LiteralPath $serverDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Move-Item -LiteralPath $backupServer -Destination $serverDir -Force
    Write-Log "server 目录已回滚。"
  }

  if ($backupWebDist -and (Test-Path -LiteralPath $backupWebDist)) {
    if (Test-Path -LiteralPath $webDistDir) {
      Remove-Item -LiteralPath $webDistDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $webParent = Split-Path -Parent $webDistDir
    New-Item -ItemType Directory -Force -Path $webParent | Out-Null
    Move-Item -LiteralPath $backupWebDist -Destination $webDistDir -Force
    Write-Log "web\dist 目录已回滚。"
  }
}

try {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    Write-Host "[ERROR] 安装目录不存在：$Root"
    exit 1
  }

  $logDir = Join-Path $Root "data\updates"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $script:LogFile = Join-Path $logDir "apply.log"

  Write-Log "=== 开始应用更新 ==="
  Write-Log "安装目录：$Root"
  Write-Log "更新暂存：$Stage"

  if (-not (Test-Path -LiteralPath $Stage -PathType Container)) {
    Write-Log "更新暂存目录不存在，放弃本次更新。"
    exit 1
  }

  # ---------------------------------------------------------------- 等待旧进程退出
  if ($ProcessId -gt 0) {
    Write-Log "等待进程 $ProcessId 退出（最多 120 秒）…"
    $deadline = (Get-Date).AddSeconds(120)
    while ($true) {
      $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
      if ($null -eq $proc) { break }
      if ((Get-Date) -ge $deadline) {
        Write-Log "等待进程 $ProcessId 退出超时，放弃本次更新（未改动任何文件）。"
        exit 1
      }
      Start-Sleep -Milliseconds 300
    }
    Write-Log "进程 $ProcessId 已退出。"
  }

  # ---------------------------------------------------------------- 备份
  $serverDir = Join-Path $Root "server"
  $webDistDir = Join-Path $Root "web\dist"

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDir = Join-Path $Root ".backup-$stamp"
  if (Test-Path -LiteralPath $backupDir) {
    $backupDir = Join-Path $Root ".backup-$stamp-$PID"
  }
  $backupServer = Join-Path $backupDir "server"
  $backupWebDist = Join-Path $backupDir "web\dist"

  New-Item -ItemType Directory -Force -Path (Join-Path $backupDir "web") | Out-Null

  if (Test-Path -LiteralPath $serverDir) {
    Move-Item -LiteralPath $serverDir -Destination $backupServer -Force
    $movedServer = $true
    Write-Log "已备份 server → $backupServer"
  }
  if (Test-Path -LiteralPath $webDistDir) {
    Move-Item -LiteralPath $webDistDir -Destination $backupWebDist -Force
    $movedWeb = $true
    Write-Log "已备份 web\dist → $backupWebDist"
  }

  # ---------------------------------------------------------------- 复制
  # 保护用户数据、运行时与转换器：按目录名排除，源里即使带了也不会覆盖。
  $excludeDirs = @("data", "node", "bin")
  $robocopyArgs = @(
    $Stage,
    $Root,
    "/E",
    "/R:5",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/XD"
  ) + $excludeDirs

  & robocopy @robocopyArgs | Out-Null
  $robocopyCode = $LASTEXITCODE
  Write-Log "robocopy 退出码：$robocopyCode"

  # robocopy 约定：0-7 视为成功，>=8 表示出错。
  if ($robocopyCode -ge 8) {
    Write-Log "复制文件失败，开始回滚。"
    Restore-Backup
    Write-Log "回滚完成，本次更新中止。"
    exit 1
  }

  # ---------------------------------------------------------------- 校验
  $indexOk = Test-Path -LiteralPath (Join-Path $Root "server\index.js")
  $htmlOk = Test-Path -LiteralPath (Join-Path $Root "web\dist\index.html")
  if (-not ($indexOk -and $htmlOk)) {
    Write-Log "更新后缺少关键文件（server\index.js 或 web\dist\index.html），开始回滚。"
    Restore-Backup
    Write-Log "回滚完成，本次更新失败。"
    exit 1
  }

  Write-Log "更新复制完成，结构校验通过。"
  Write-Log "旧文件备份保留在：$backupDir"

  # 备份目录会随每次更新累积；只保留最近 3 份，其余删掉。
  try {
    Get-ChildItem -LiteralPath $Root -Directory -Filter ".backup-*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 3 |
      ForEach-Object {
        try {
          Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
          Write-Log "已清理旧备份：$($_.Name)"
        } catch {
          Write-Log "旧备份清理失败（可手动删除）：$($_.Name)"
        }
      }
  } catch {
    # 清理失败不影响本次更新结果。
  }

  # ---------------------------------------------------------------- 重启
  if ($Restart) {
    $startBat = Join-Path $Root "start.bat"
    if (Test-Path -LiteralPath $startBat) {
      try {
        Start-Process -FilePath $startBat -WorkingDirectory $Root
      } catch {
        # 少数环境下 .bat 不能直接 Start-Process，退回 cmd.exe。
        Start-Process -FilePath $env:ComSpec -ArgumentList @("/c", "`"$startBat`"") -WorkingDirectory $Root
      }
      Write-Log "已重新启动应用。"
    } else {
      Write-Log "未找到 start.bat，无法自动重启。"
    }
  }

  Write-Log "=== 更新完成 ==="
  exit 0
} catch {
  Write-Log "更新脚本异常：$($_.Exception.Message)"
  try {
    if ($movedServer -or $movedWeb) { Restore-Backup }
  } catch {
    Write-Log "回滚也失败了：$($_.Exception.Message)"
  }
  exit 1
}
