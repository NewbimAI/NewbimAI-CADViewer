#Requires -Version 5.1
<#
  CADViewer Skill 注册脚本（Windows）

  把 Skill\cadviewer 以目录联接（junction）注册到 OpenCode 的 skills 目录，
  使 agent 能自动发现这个 Skill。用 junction 而不是复制：仓库里的文档改了，
  Skill 立刻同步，不会出现两份不一致的副本。

  用法：
    powershell -ExecutionPolicy Bypass -File Skill\install.ps1
    powershell -ExecutionPolicy Bypass -File Skill\install.ps1 -Force      # 目标已存在且不是链接时，用链接替换它
    powershell -ExecutionPolicy Bypass -File Skill\install.ps1 -SkillsDir <目录>

  幂等：已注册且指向本仓库时，直接成功返回（退出码 0）。
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [string]$SkillsDir
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $scriptDir "cadviewer"
$repoRoot = Split-Path -Parent $scriptDir

if (-not (Test-Path -LiteralPath (Join-Path $source "SKILL.md"))) {
    Write-Host "[FAIL] Cannot find Skill source: $source" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "server\scanner.js"))) {
    Write-Host "[WARN] Parent folder does not look like a CADViewer repo (missing server\scanner.js)." -ForegroundColor Yellow
    Write-Host "       This Skill only works together with the full repo." -ForegroundColor Yellow
}

if (-not $SkillsDir) {
    $SkillsDir = Join-Path $env:USERPROFILE ".config\opencode\skills"
}
$target = Join-Path $SkillsDir "cadviewer"

Write-Host ""
Write-Host "  source : $source"
Write-Host "  target : $target"
Write-Host ""

New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null

$existing = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
if (-not $existing) {
    New-Item -ItemType Junction -Path $target -Target $source | Out-Null
    Write-Host "[OK] Junction created." -ForegroundColor Green
}
else {
    $isLink = [bool]($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    if ($isLink) {
        $raw = @($existing.Target)[0]
        if (-not [System.IO.Path]::IsPathRooted($raw)) {
            $raw = Join-Path (Split-Path -Parent $target) $raw
        }
        $nowPointsTo = (Resolve-Path -LiteralPath $raw).Path.TrimEnd('\')
        $want = (Resolve-Path -LiteralPath $source).Path.TrimEnd('\')
        if ($nowPointsTo -eq $want) {
            Write-Host "[OK] Already registered and pointing here. Nothing to do." -ForegroundColor Green
        }
        elseif ($Force) {
            (Get-Item -LiteralPath $target -Force).Delete()
            New-Item -ItemType Junction -Path $target -Target $source | Out-Null
            Write-Host "[OK] Repointed to this repo (was: $nowPointsTo)." -ForegroundColor Green
        }
        else {
            Write-Host "[SKIP] Already registered but pointing elsewhere:" -ForegroundColor Yellow
            Write-Host "       $nowPointsTo"
            Write-Host "       Re-run with -Force to repoint it here." -ForegroundColor Yellow
            exit 2
        }
    }
    elseif ($Force) {
        Remove-Item -LiteralPath $target -Recurse -Force
        New-Item -ItemType Junction -Path $target -Target $source | Out-Null
        Write-Host "[OK] Replaced an existing copy with a junction." -ForegroundColor Green
    }
    else {
        Write-Host "[SKIP] Target exists and is NOT a link (probably an old copy)." -ForegroundColor Yellow
        Write-Host "       Re-run with -Force to replace it (the folder will be deleted)." -ForegroundColor Yellow
        exit 2
    }
}

Write-Host ""
Write-Host "Next steps" -ForegroundColor Cyan
Write-Host "  1) doctor:  node `"$target\scripts\cad.mjs`" doctor"
Write-Host "  2) read a drawing:  node `"$target\scripts\cad.mjs`" summary `"<path-to-drawing>.dwg`""
Write-Host "  3) optional:  set CADVIEWER_ROOT=$repoRoot   (only needed when the CLI runs outside the repo)"
Write-Host ""
