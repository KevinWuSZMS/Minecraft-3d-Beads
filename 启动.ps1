param(
    [ValidateRange(1, 65535)][int]$Port = 4173,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$siteUrl = "http://127.0.0.1:$Port"

function Get-SiteHealth {
    try {
        $response = Invoke-WebRequest -Uri "$siteUrl/__mc3dbeads_health" -UseBasicParsing -TimeoutSec 2
        $health = $response.Content | ConvertFrom-Json
        if ($health.app -eq 'MC3DBeads' -and $health.root -and
            [IO.Path]::GetFullPath([string]$health.root).TrimEnd('\') -eq $projectPath -and
            [int]$health.port -eq $Port) {
            return $true
        }
    } catch { }
    return $false
}

function Test-LocalPort {
    $connection = New-Object Net.Sockets.TcpClient
    try {
        $attempt = $connection.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (!$attempt.AsyncWaitHandle.WaitOne(400)) { return $false }
        $connection.EndConnect($attempt)
        return $connection.Connected
    } catch { return $false } finally { $connection.Dispose() }
}

if (!(Test-Path -LiteralPath (Join-Path $projectPath 'public/index.html'))) {
    throw '网站文件不完整：缺少 public/index.html。'
}
if (!(Test-Path -LiteralPath (Join-Path $projectPath 'public/data/catalog.json'))) {
    throw '缺少 Minecraft 目录，请按 README.md 重新导入本机游戏资源。'
}

if (!(Get-SiteHealth)) {
    if (Test-LocalPort) {
        throw "端口 $Port 已被其他服务或旧版服务占用；不会停止该进程。请用 -Port 指定其他端口，或自行关闭旧服务。"
    }
    $runtimeDirectory = Join-Path $projectPath 'runtime'
    $manifestPath = Join-Path $runtimeDirectory 'manifest.json'
    if (!(Test-Path -LiteralPath $manifestPath)) { throw '便携运行时缺失：请完整下载本仓库，包含 runtime 目录。' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $archive = $manifest.archives.'win-x64'
    if (!$archive -or $archive.file -notmatch '^node-v\d+\.\d+\.\d+-win-x64\.zip$' -or
        $archive.directory -notmatch '^node-v\d+\.\d+\.\d+-win-x64$') { throw 'Windows 运行时清单无效。' }
    $archivePath = Join-Path $runtimeDirectory $archive.file
    if (!(Test-Path -LiteralPath $archivePath)) { throw "缺少运行时归档：$($archive.file)" }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $archive.sha256) { throw '运行时校验失败，请重新下载完整仓库。' }
    $runtimeCache = Join-Path $projectPath '.cache/runtime'
    $nodePath = Join-Path (Join-Path $runtimeCache $archive.directory) 'node.exe'
    if (!(Test-Path -LiteralPath $nodePath)) {
        New-Item -ItemType Directory -Path $runtimeCache -Force | Out-Null
        Write-Host '正在展开项目内的 Node.js，首次启动需要片刻…'
        Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeCache -Force
    }
    if (!(Test-Path -LiteralPath $nodePath)) { throw '运行时解压失败：未找到 node.exe。' }
    if (!(Test-Path -LiteralPath (Join-Path $projectPath 'public/vendor/three.module.js'))) {
        if (!(Test-Path -LiteralPath (Join-Path $projectPath 'node_modules/three/build/three.module.js'))) {
            throw '缺少 Three.js。请先按 README.md 安装依赖并运行构建命令。'
        }
        & $nodePath (Join-Path $projectPath 'scripts/build.mjs')
        if ($LASTEXITCODE -ne 0) { throw '网站依赖准备失败。' }
    }
    $cacheDirectory = Join-Path $projectPath '.cache'
    New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
    $serverScript = Join-Path $projectPath 'scripts/server.mjs'
    $serverProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $serverScript + '"'), '--port', [string]$Port) `
        -WorkingDirectory $projectPath -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $cacheDirectory "server-$Port.log") `
        -RedirectStandardError (Join-Path $cacheDirectory "server-$Port.error.log")
    $ready = $false
    for ($attemptNumber = 0; $attemptNumber -lt 40; $attemptNumber++) {
        if (Get-SiteHealth) { $ready = $true; break }
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { break }
        Start-Sleep -Milliseconds 250
    }
    if (!$ready) {
        throw "网站服务未就绪，请查看 .cache/server-$Port.error.log。"
    }
}

Write-Host "MC3DBeads 已就绪：$siteUrl"
if (!$NoBrowser) { Start-Process -FilePath $siteUrl }
