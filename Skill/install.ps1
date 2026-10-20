#Requires -Version 5.1
<#
  CADViewer Skill installer (Windows)

  Registers Skill\cadviewer into the skills folder(s) your agent actually reads,
  using a directory junction (no copy) so edits in the bundle stay in sync.

  Works for both layouts:
    - full repo          <root>\Skill\cadviewer
    - lightweight bundle <bundle>\Skill\cadviewer   (bundle also has server\scanner.js)

  After installing, no CADVIEWER_ROOT is needed: the CLI finds the project root
  by walking up from its own script path.

  Usage:
    powershell -ExecutionPolicy Bypass -File Skill\install.ps1
    powershell -ExecutionPolicy Bypass -File Skill\install.ps1 -Force
    powershell -ExecutionPolicy Bypass -File Skill\install.ps1 -SkillsDir <dir>
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipCadcraft,
    [string]$SkillsDir
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $scriptDir "cadviewer"
$root = Split-Path -Parent $scriptDir

if (-not (Test-Path -LiteralPath (Join-Path $source "SKILL.md"))) {
    Write-Host "[FAIL] Cannot find Skill source: $source" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $root "server\scanner.js"))) {
    Write-Host "[FAIL] Missing $root\server\scanner.js" -ForegroundColor Red
    Write-Host "       The Skill only works next to a 'server' folder (repo or lightweight bundle)." -ForegroundColor Red
    exit 1
}

# Which skills folders to register into.
if ($SkillsDir) {
    $targets = @($SkillsDir)
}
else {
    $targets = @()
    # OpenCode is the default target; always register.
    $targets += (Join-Path $env:USERPROFILE ".config\opencode\skills")
    # Other agents: only if that agent is actually present on this machine.
    foreach ($pair in @(
        @{ parent = (Join-Path $env:USERPROFILE ".claude"); dir = (Join-Path $env:USERPROFILE ".claude\skills") },
        @{ parent = (Join-Path $env:USERPROFILE ".cursor"); dir = (Join-Path $env:USERPROFILE ".cursor\skills") }
    )) {
        if (Test-Path -LiteralPath $pair.parent) { $targets += $pair.dir }
    }
}

Write-Host ""
Write-Host "  source : $source"
Write-Host "  root   : $root"
Write-Host ""

$okCount = 0
$skipCount = 0

foreach ($dir in $targets) {
    $target = Join-Path $dir "cadviewer"
    Write-Host "  -> $target"

    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $existing = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-Item -ItemType Junction -Path $target -Target $source | Out-Null
        Write-Host "     [OK] linked" -ForegroundColor Green
        $okCount++
        continue
    }

    $isLink = [bool]($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    if ($isLink) {
        $raw = @($existing.Target)[0]
        if (-not [System.IO.Path]::IsPathRooted($raw)) {
            $raw = Join-Path (Split-Path -Parent $target) $raw
        }
        $nowPointsTo = (Resolve-Path -LiteralPath $raw).Path.TrimEnd('\')
        $want = (Resolve-Path -LiteralPath $source).Path.TrimEnd('\')
        if ($nowPointsTo -eq $want) {
            Write-Host "     [OK] already linked here" -ForegroundColor Green
            $okCount++
        }
        elseif ($Force) {
            (Get-Item -LiteralPath $target -Force).Delete()
            New-Item -ItemType Junction -Path $target -Target $source | Out-Null
            Write-Host "     [OK] repointed (was $nowPointsTo)" -ForegroundColor Green
            $okCount++
        }
        else {
            Write-Host "     [SKIP] already linked somewhere else:" -ForegroundColor Yellow
            Write-Host "            $nowPointsTo"
            Write-Host "            re-run with -Force to repoint here" -ForegroundColor Yellow
            $skipCount++
        }
    }
    elseif ($Force) {
        Remove-Item -LiteralPath $target -Recurse -Force
        New-Item -ItemType Junction -Path $target -Target $source | Out-Null
        Write-Host "     [OK] replaced an old copy with a link" -ForegroundColor Green
        $okCount++
    }
    else {
        Write-Host "     [SKIP] target exists and is not a link (old copy?)" -ForegroundColor Yellow
        Write-Host "            re-run with -Force to replace it (folder will be deleted)" -ForegroundColor Yellow
        $skipCount++
    }
}

# ---- cadcraft（DWG 转换器）：一次性装好；装好后只有打开 DWG 时才会被调用 ----
$cadDir = Join-Path $root "bin\cadcraft"
$cli = Get-ChildItem -Path $cadDir -Recurse -Filter "cadcraft-cli.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cli) {
    Write-Host "  cadcraft: already installed" -ForegroundColor Cyan
}
elseif ($SkipCadcraft) {
    Write-Host "  cadcraft: skipped (-SkipCadcraft)" -ForegroundColor Yellow
}
else {
    $ver = "0.8.0"
    $zipName = "cadcraft-$ver-windows-x64-portable.zip"
    $url = "https://github.com/storytold/cadcraft/releases/download/v$ver/$zipName"
    $tmp = Join-Path $env:TEMP $zipName
    try {
        Write-Host "  cadcraft: downloading $zipName (~57MB)..." -ForegroundColor Cyan
        $ProgressPreference = "SilentlyContinue"   # 否则 57MB 会下载得很慢
        $ok = $false
        # 优先 curl：尊重 HTTPS_PROXY、能重试、失败信息更清楚
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            $oldPref = $ErrorActionPreference
            $ErrorActionPreference = "Continue"   # curl 往 stderr 写进度，别被 Stop 当异常
            & curl.exe -fL --retry 2 --max-time 900 -s -o "$tmp" "$url" 2>$null
            $curlExit = $LASTEXITCODE
            $ErrorActionPreference = $oldPref
            if ($curlExit -eq 0 -and (Test-Path $tmp) -and ((Get-Item $tmp).Length -gt 1MB)) { $ok = $true }
        }
        if (-not $ok) {
            Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
            $ok = $true
        }
        New-Item -ItemType Directory -Force -Path $cadDir | Out-Null
        Expand-Archive -LiteralPath $tmp -DestinationPath $cadDir -Force
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        $cli = Get-ChildItem -Path $cadDir -Recurse -Filter "cadcraft-cli.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cli) {
            $v = (& $cli.FullName --version) 2>$null
            Write-Host "  cadcraft: installed ($v)" -ForegroundColor Green
        }
        else {
            Write-Host "  cadcraft: [WARN] extracted but cadcraft-cli.exe not found" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host ("  cadcraft: [WARN] download failed: " + $_.Exception.Message) -ForegroundColor Yellow
        Write-Host "            install manually: $url -> $root\bin\cadcraft\" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  $okCount linked, $skipCount skipped" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next (the only step needed):" -ForegroundColor Cyan
Write-Host "  node `"$source\scripts\cad.mjs`" doctor"
Write-Host ""
Write-Host "Do NOT run npm install / vite build - web/dist is already in the repo." -ForegroundColor DarkGray
Write-Host "Do NOT hunt for a sample drawing to verify - doctor is enough." -ForegroundColor DarkGray
Write-Host "cadcraft (DWG) is installed above; the local service starts on demand only." -ForegroundColor DarkGray
Write-Host ""

if ($skipCount -gt 0 -and $okCount -eq 0) { exit 2 }
exit 0
