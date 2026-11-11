#Requires -Version 5.1
<#
  NewbimAI CADViewer Skill installer (Windows)

  Registers the Skill into the skills folder(s) your agent actually reads, using a
  directory junction (no copy) so edits stay in sync.

  Works for all three layouts (detected from where this script sits):
    - skill package  <pkg>\SKILL.md + <pkg>\scripts\        → script is inside the skill dir
      (zip 内第一层就是 NewbimAI-CADViewer-Skill\；server\web\bin 都在同一层)
    - lightweight bundle <bundle>\Skill\NewbimAI-CADViewer-Skill  (bundle also has server\)
    - full repo          <root>\Skill\NewbimAI-CADViewer-Skill

  Lightweight bundle: it only carries the Skill + the server modules the CLI imports
  (so it stays small enough to upload to agents with a 3MB limit). The rest of the
  product - built interface (web\dist), server entry points (server\*.js), export
  pipeline - is downloaded here from the release archive, so a fresh install ends up
  with the FULL feature set (open / serve / compare / PNG / PDF) without manual steps.

  The closed-source custom-object parser (bin\udo-cli\) is NOT downloaded here:
  it ships only in the full package. Missing it degrades only `udo --coverage`.

  Version: read from the bundled skill.json (injected by scripts/build-skill.mjs from
  server/package.json). The source tree has no version field, so we fall back to
  server\package.json. Skill and App always share one version number.

  After installing, no CADVIEWER_ROOT is needed: the CLI finds the project root
  by walking up from its own script path.

  Usage (inside a skill package - SKILL.md next to this file):
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Force
    powershell -ExecutionPolicy Bypass -File install.ps1 -SkillsDir <dir>
    powershell -ExecutionPolicy Bypass -File install.ps1 -SkipComponents
    powershell -ExecutionPolicy Bypass -File install.ps1 -ComponentsUrl <zip>
  Usage (in the repo):
    powershell -ExecutionPolicy Bypass -File Skill\install.ps1
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipCadcraft,
    [switch]$SkipUdo,
    [switch]$SkipComponents,
    [string]$ComponentsUrl,
    [string]$SkillsDir
)

$ErrorActionPreference = "Stop"

$SKILL_NAME = "NewbimAI-CADViewer-Skill"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 两种布局都要能装：
#   新（标准 agent skill 包，zip 第一层就是 skill 目录）：<pkg>\SKILL.md + <pkg>\scripts\…
#        → source = 脚本所在目录；运行时组件（server\web\bin）也在这层，root 同 source
#   旧（仓库 / 老包）：<pkg>\Skill\<SKILL_NAME>\ + <pkg>\Skill\install.ps1
#        → source = <pkg>\Skill\<SKILL_NAME>；root = <pkg>
if (Test-Path -LiteralPath (Join-Path $scriptDir "SKILL.md")) {
    $source = $scriptDir
    $root = $scriptDir
}
else {
    $source = Join-Path $scriptDir $SKILL_NAME
    $root = Split-Path -Parent $scriptDir
}

# skill.json：名称/版本/依赖模块的唯一机器可读来源（版本由构建脚本注入）
$skillManifest = $null
$skillJson = Join-Path $source "skill.json"
if (Test-Path -LiteralPath $skillJson) {
    try { $skillManifest = Get-Content -Raw -Encoding UTF8 $skillJson | ConvertFrom-Json } catch { $skillManifest = $null }
}

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
if ($skillManifest -and $skillManifest.name) {
    $showVer = if ($skillManifest.version) { [string]$skillManifest.version } else { "(from server/package.json)" }
    Write-Host "  skill  : $($skillManifest.name) $showVer"
}
Write-Host ""

$okCount = 0
$skipCount = 0

foreach ($dir in $targets) {
    $target = Join-Path $dir $SKILL_NAME
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
    # 顺手清掉旧的 GUI 主程序（见下方解压后的说明）
    Get-ChildItem -Path $cadDir -Recurse -Filter "cadcraft.exe" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
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
        # 便携包里的 cadcraft.exe 是 EGUI 桌面主程序（约 75MB），本项目的 CLI 链路从不调用它。
        # 只留 cadcraft-cli.exe：安装体积从 ~128MB 降到 ~53MB。
        Get-ChildItem -Path $cadDir -Recurse -Filter "cadcraft.exe" -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
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

# ---- 自定义对象解析组件（bin\udo-cli）：只在完整包随附；解码实现不在这里展开 ----
$udoExe = Join-Path $root "bin\udo-cli\udo-cli.exe"
if (Test-Path -LiteralPath $udoExe) {
    Write-Host "  udo-cli: present (custom objects: walls / openings / text / dimensions)" -ForegroundColor Cyan
}
elseif ($SkipUdo) {
    Write-Host "  udo-cli: skipped (-SkipUdo) - custom-object parsing disabled" -ForegroundColor Yellow
}
else {
    # 解析组件是闭源二进制，不在 git 仓库里，只能从 Release 取（独立小包 2.7MB，含许可附件）
    $udoVer = $null
    if ($skillManifest -and $skillManifest.version) { $udoVer = [string]$skillManifest.version }
    if (-not $udoVer) {
        $pkgFile = Join-Path $root "server\package.json"
        if (Test-Path -LiteralPath $pkgFile) {
            try {
                $p = Get-Content -Raw -Encoding UTF8 $pkgFile | ConvertFrom-Json
                if ($p.version) { $udoVer = [string]$p.version }
            }
            catch { $udoVer = $null }
        }
    }
    if (-not $udoVer) { $udoVer = "0.3.0" }
    $udoZip = "udo-cli-$udoVer-win64.zip"
    $udoUrl = "https://github.com/NewbimAI/NewbimAI-CADViewer/releases/download/v$udoVer/$udoZip"
    $udoTmp = Join-Path $env:TEMP $udoZip
    $udoDir = Join-Path $env:TEMP ("udo-cli-" + [Guid]::NewGuid().ToString("N"))
    try {
        Write-Host "  udo-cli: downloading $udoZip (~2.7MB)..." -ForegroundColor Cyan
        Write-Host "           $udoUrl" -ForegroundColor DarkGray
        $ProgressPreference = "SilentlyContinue"
        $ok = $false
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            $oldPref = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            & curl.exe -fL --retry 2 --max-time 600 -s -o "$udoTmp" "$udoUrl" 2>$null
            $curlExit = $LASTEXITCODE
            $ErrorActionPreference = $oldPref
            if ($curlExit -eq 0 -and (Test-Path $udoTmp) -and ((Get-Item $udoTmp).Length -gt 1MB)) { $ok = $true }
        }
        if (-not $ok) {
            Invoke-WebRequest -Uri $udoUrl -OutFile $udoTmp -UseBasicParsing
            $ok = $true
        }
        if (-not (Test-Path -LiteralPath $udoTmp)) { throw "no file downloaded" }
        Remove-Item -LiteralPath $udoDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $udoDir | Out-Null
        Expand-Archive -LiteralPath $udoTmp -DestinationPath $udoDir -Force
        $inner = Get-ChildItem -LiteralPath $udoDir -Directory | Select-Object -First 1
        $srcBin = if ($inner) { Join-Path $inner.FullName "bin" } else { Join-Path $udoDir "bin" }
        if (-not (Test-Path -LiteralPath (Join-Path $srcBin "udo-cli"))) { throw "archive has no bin/udo-cli" }
        # 二进制 + licenses 一起落到 App 根：许可是分发闭源二进制的强制义务
        New-Item -ItemType Directory -Force -Path (Join-Path $root "bin") | Out-Null
        Copy-Item -LiteralPath (Join-Path $srcBin "udo-cli") -Destination (Join-Path $root "bin\udo-cli") -Recurse -Force
        $licSrc = if ($inner) { Join-Path $inner.FullName "licenses" } else { Join-Path $udoDir "licenses" }
        if (Test-Path -LiteralPath $licSrc) {
            New-Item -ItemType Directory -Force -Path (Join-Path $root "licenses") | Out-Null
            Copy-Item -Path (Join-Path $licSrc "*") -Destination (Join-Path $root "licenses") -Recurse -Force
        }
        if (Test-Path -LiteralPath $udoExe) {
            $uv = (& $udoExe version) 2>$null
            Write-Host "  udo-cli: installed ($udoVer)" -ForegroundColor Green
        }
        else {
            Write-Host "  udo-cli: [WARN] extracted but udo-cli.exe not found" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host ("  udo-cli: [WARN] download failed: " + $_.Exception.Message) -ForegroundColor Yellow
        Write-Host "            install manually: $udoUrl -> $root\bin\udo-cli\" -ForegroundColor Yellow
        Write-Host "            everything else (stats / compare / export) still works" -ForegroundColor Yellow
    }
    finally {
        Remove-Item -LiteralPath $udoTmp -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $udoDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---- components（界面 + 服务端入口 + 导出链路）----
# 小包里只有 CLI 真正 import 的几个模块（为了能传到有 3MB 限制的 agent 上）。
# 这里把剩下的东西补回来：web/dist（已构建界面）、server/*.js（index / dxf-web /
# export-worker …）。补完就是完整功能——open 出链接、serve 起界面、compare 对比、PNG/PDF 导出都可用。
$needDist = -not (Test-Path -LiteralPath (Join-Path $root "web\dist\index.html"))
$needServer = -not (Test-Path -LiteralPath (Join-Path $root "server\index.js"))
if (-not $needDist -and -not $needServer) {
    Write-Host "  components: already present (interface + server)" -ForegroundColor Cyan
}
elseif ($SkipComponents) {
    Write-Host "  components: skipped (-SkipComponents) - open/serve/compare will not work" -ForegroundColor Yellow
}
else {
    # 版本：优先包内 skill.json（构建时从 server/package.json 注入），源码树回退 server/package.json。
    # 两者都没有才退回 main；退回 main 时**明确警告**（可能与包内 CLI 版本错配）。
    $ref = "main"
    $ver = $null
    if ($skillManifest -and $skillManifest.version) { $ver = [string]$skillManifest.version }
    if (-not $ver) {
        $pkgFile = Join-Path $root "server\package.json"
        if (Test-Path -LiteralPath $pkgFile) {
            try {
                $pkg = Get-Content -Raw -Encoding UTF8 $pkgFile | ConvertFrom-Json
                if ($pkg.version) { $ver = [string]$pkg.version }
            }
            catch { $ver = $null }
        }
    }
    if ($ver) { $ref = "v" + $ver }
    else {
        Write-Host "  components: [WARN] no skill.json/server package version - falling back to 'main'" -ForegroundColor Yellow
        Write-Host "              the downloaded server may not match this bundle's CLI" -ForegroundColor Yellow
    }

    $urls = @()
    if ($ComponentsUrl) {
        $urls += $ComponentsUrl
    }
    else {
        if ($ref -ne "main") {
            $urls += "https://github.com/NewbimAI/NewbimAI-CADViewer/archive/refs/tags/$ref.zip"
            $urls += "https://codeload.github.com/NewbimAI/NewbimAI-CADViewer/zip/refs/tags/$ref"
        }
        $urls += "https://github.com/NewbimAI/NewbimAI-CADViewer/archive/refs/heads/main.zip"
        $urls += "https://codeload.github.com/NewbimAI/NewbimAI-CADViewer/zip/refs/heads/main"
    }

    $tmpZip = Join-Path $env:TEMP "NewbimAI-CADViewer-components-$ref.zip"
    $tmpDir = Join-Path $env:TEMP ("NewbimAI-CADViewer-components-" + [Guid]::NewGuid().ToString("N"))
    $src = $null

    foreach ($url in $urls) {
        Write-Host "  components: downloading interface + server (~18MB)..." -ForegroundColor Cyan
        Write-Host "              $url" -ForegroundColor DarkGray
        try {
            Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
            $ok = $false
            # 优先 curl：尊重 HTTPS_PROXY、能重试、失败信息更清楚
            if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
                $oldPref = $ErrorActionPreference
                $ErrorActionPreference = "Continue"   # curl 往 stderr 写进度，别被 Stop 当异常
                & curl.exe -fL --retry 2 --max-time 900 -s -o "$tmpZip" "$url" 2>$null
                $curlExit = $LASTEXITCODE
                $ErrorActionPreference = $oldPref
                if ($curlExit -eq 0) { $ok = $true }
            }
            if (-not $ok) {
                Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing
                $ok = $true
            }
            if (-not (Test-Path -LiteralPath $tmpZip)) { throw "no file downloaded" }
            if ((Get-Item -LiteralPath $tmpZip).Length -lt 1MB) { throw "download too small" }

            Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
            Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force
            $cand = Get-ChildItem -LiteralPath $tmpDir -Directory | Select-Object -First 1
            if (-not $cand) { throw "archive has no top-level folder" }
            if (-not (Test-Path -LiteralPath (Join-Path $cand.FullName "server\index.js"))) { throw "archive has no server/index.js" }
            $src = $cand.FullName
            break
        }
        catch {
            Write-Host ("              failed: " + $_.Exception.Message) -ForegroundColor DarkYellow
        }
    }

    if (-not $src) {
        # 只告警：统计 / JSON / DXF 导出不依赖这些组件
        Write-Host "  components: [WARN] download failed - open/serve unavailable for now" -ForegroundColor Yellow
        Write-Host "              statistics, JSON and DXF export still work." -ForegroundColor Yellow
        Write-Host "              retry later, or pass a local archive: -ComponentsUrl <zip>" -ForegroundColor Yellow
    }
    else {
        $dstServer = Join-Path $root "server"
        New-Item -ItemType Directory -Force -Path $dstServer | Out-Null
        $srcServer = Join-Path $src "server"
        # 包里自带的模块是这个包对应版本的权威副本，不要被归档里的同名文件覆盖；
        # 其余 *.js（index / dxf-web / block-text / export-worker …）补齐即可。
        # 权威副本清单来自 skill.json 的 requires.serverModules（不再硬编码）。
        $own = @()
        if ($skillManifest -and $skillManifest.requires -and $skillManifest.requires.serverModules) {
            $own = @($skillManifest.requires.serverModules)
        }
        if ($own.Count -eq 0) { $own = @("cadcraft.js", "scanner.js", "udo-detect.js", "svg-pdf.js", "udo-convert.js") }
        $own += @("package.json", "package-lock.json")
        Get-ChildItem -LiteralPath $srcServer -Filter "*.js" -File | ForEach-Object {
            if ($own -notcontains $_.Name) {
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dstServer $_.Name) -Force
            }
        }
        foreach ($name in @("package.json", "package-lock.json", "start.bat")) {
            $p = Join-Path $srcServer $name
            $d = Join-Path $dstServer $name
            if ((Test-Path -LiteralPath $p) -and -not (Test-Path -LiteralPath $d)) {
                Copy-Item -LiteralPath $p -Destination $d -Force
            }
        }
        $srcDist = Join-Path $src "web\dist"
        if (Test-Path -LiteralPath (Join-Path $srcDist "index.html")) {
            $dstDist = Join-Path $root "web\dist"
            New-Item -ItemType Directory -Force -Path $dstDist | Out-Null
            Copy-Item -Path (Join-Path $srcDist "*") -Destination $dstDist -Recurse -Force
        }

        if ((Test-Path -LiteralPath (Join-Path $root "web\dist\index.html")) -and
            (Test-Path -LiteralPath (Join-Path $root "server\index.js"))) {
            Write-Host "  components: installed (interface + server)" -ForegroundColor Green
        }
        else {
            Write-Host "  components: [WARN] incomplete after copy" -ForegroundColor Yellow
        }
    }

    Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  $okCount linked, $skipCount skipped" -ForegroundColor Cyan
# 装完直接自检（只读本地文件，不碰任何图纸）——省掉「再跑一条命令」这一步
$cliPath = Join-Path $source "scripts\cad.mjs"
if (Test-Path $cliPath) {
    $tmpOut = Join-Path $env:TEMP ("cadviewer-doctor-" + [Guid]::NewGuid().ToString("N") + ".json")
    $tmpErr = $tmpOut + ".err"
    try {
        $nodeExe = (Get-Command node -ErrorAction Stop).Source
        Start-Process -FilePath $nodeExe -ArgumentList @("`"$cliPath`"", "doctor") -NoNewWindow -Wait `
            -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr | Out-Null
        $obj = (Get-Content -Raw -Encoding UTF8 $tmpOut) | ConvertFrom-Json
        $deg = ""
        if ($obj.degraded -and @($obj.degraded).Count -gt 0) { $deg = " (degraded: " + (@($obj.degraded) -join ", ") + ")" }
        if ($obj.versions) {
            Write-Host ("  versions: skill " + $obj.versions.skillVersion + " / app " + $obj.versions.appVersion +
                " (source: " + $obj.versions.versionSource + ")") -ForegroundColor Cyan
        }
        if ($obj.ok) {
            Write-Host ("  doctor: ok" + $deg) -ForegroundColor Green
        }
        else {
            Write-Host ("  doctor: NOT ok - run manually: node `"$cliPath`" doctor") -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host ("  doctor: skipped - run manually: node `"$cliPath`" doctor") -ForegroundColor Yellow
    }
    finally {
        Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Nothing else to do. Do NOT verify with a drawing; do NOT run npm install / vite build." -ForegroundColor DarkGray
Write-Host "The local service starts on demand only (open / serve / compare)." -ForegroundColor DarkGray
Write-Host "Custom-object parsing (udo --coverage) uses bin\udo-cli (installed by default)." -ForegroundColor DarkGray
Write-Host ""

if ($skipCount -gt 0 -and $okCount -eq 0) { exit 2 }
exit 0
