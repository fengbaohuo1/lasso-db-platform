# db-service 一键启动（默认端口 18090，数据目录 data\，日志 data\logs\）
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -AllowWrite -ApiKey "本地密钥"
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Build     # 先离线打包
param(
    [int]$Port = 18090,
    [string]$DataDir = '',
    [switch]$AllowWrite,
    [string]$ApiKey = '',
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $DataDir) { $DataDir = Join-Path $root 'data' }
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$jar = Join-Path $root 'target\db-service.jar'
$logs = Join-Path $DataDir 'logs'
$record = Join-Path $DataDir 'service.json'

Write-Host ''
Write-Host 'DB Service · 数据源服务启动' -ForegroundColor Cyan
Write-Host "项目根目录：$root"

# 1. 前置检查
if (-not (Get-Command java -ErrorAction SilentlyContinue)) { throw '未找到 java，请先安装 JDK 17+' }
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# 2. 幂等：同端口已有健康实例则复用（数据目录必须一致）；-Build 时要求先停止，避免 jar 被运行中进程锁定
function Get-ServiceHealth {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -ErrorAction Stop
        if ($response.code -eq '00000') { return $response }
        return $null
    } catch {
        return $null
    }
}

$existing = Get-ServiceHealth
if ($existing) {
    if ($Build) {
        throw "端口 $Port 上已有健康实例，不能直接 -Build（运行中的 jar 会被锁定）；请先执行 scripts\stop.ps1 停止后再构建/启动。"
    }
    $existingDataDir = [string]$existing.data.dataDir
    try { $existingDataDir = [System.IO.Path]::GetFullPath($existingDataDir) } catch { }
    if ($existingDataDir -and ($existingDataDir.TrimEnd('\') -ne $DataDir.TrimEnd('\'))) {
        throw "端口 $Port 上已有 db-service，但数据目录为 $existingDataDir，与本次请求的 $DataDir 不一致；请换 -Port 或先停止该实例。"
    }
    Write-Host "==> 端口 $Port 上已有健康实例（数据目录一致），直接复用（不重复启动）。"
    Write-Host "    数据源接口：http://127.0.0.1:$Port/api/datasources"
    exit 0
}

if ($Build -or -not (Test-Path $jar)) {
    if (-not (Get-Command mvn -ErrorAction SilentlyContinue)) {
        throw '缺少可执行 jar 且未找到 mvn：请安装 Maven，或先手动执行 mvn -o -B package -DskipTests'
    }
    Write-Host '==> 构建可执行 jar（mvn -o -B package -DskipTests）'
    Push-Location $root
    try {
        & mvn -o -B package -DskipTests | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Maven 构建失败' }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path $jar)) { throw "缺少可执行 jar：$jar（先执行 -Build）" }

# 3. 数据目录占用检查（同一 H2 文件同时只允许一个进程，避免二次启动后 demo 库锁死/报错难读）
$sameDir = @(Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains('db-service') -and
        $_.CommandLine.Contains('--db-service.data-dir=') -and $_.CommandLine.Contains($DataDir)
    })
if ($sameDir.Count -gt 0) {
    $otherIds = ($sameDir | ForEach-Object { $_.ProcessId }) -join ', '
    throw "数据目录 $DataDir 已被另一个 db-service 进程（PID $otherIds）使用；同一 H2 演示库文件同时只能被一个进程打开，请停止该实例或改用 -DataDir。"
}

# 4. 端口占用检查
$occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupied) {
    throw "端口 $Port 已被进程 PID $($occupied.OwningProcess) 占用（不是健康的 db-service），请换 -Port。"
}

# 5. 启动（参数逐个加引号，兼容含空格的 Windows 路径）
$java = (Get-Command java).Source
$arguments = @(
    '-jar'
    "`"$jar`""
    "--server.port=$Port"
    "--db-service.data-dir=`"$DataDir`""
    "--logging.file.name=`"$logs\db-service.log`""
)
if ($AllowWrite) { $arguments += '--db-service.allow-write=true' }
if ($ApiKey) { $env:DB_SERVICE_API_KEY = $ApiKey }

$outLog = Join-Path $logs 'db-service.out.log'
$errLog = Join-Path $logs 'db-service.err.log'
Write-Host "==> 启动：java -jar $jar --server.port=$Port --db-service.data-dir=`"$DataDir`""
$process = Start-Process -FilePath $java -ArgumentList $arguments -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

function Show-StartupFailure {
    param([string]$reason)
    Write-Host "==> $reason" -ForegroundColor Red
    if (Test-Path $errLog) {
        $tail = Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue
        if ($tail) { Write-Host '--- stderr ---'; $tail | Out-Host }
    }
    if (Test-Path $outLog) {
        $tail = Get-Content $outLog -Tail 40 -ErrorAction SilentlyContinue |
            Where-Object { $_ -match 'ERROR|Exception|already in use|Failed' }
        if ($tail) { Write-Host '--- 关键日志 ---'; $tail | Out-Host }
    }
}

$up = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) {
        Show-StartupFailure "启动失败（进程已退出，exit=$($process.ExitCode)）。"
        exit 1
    }
    if (Get-ServiceHealth) { $up = $true; break }
}
if (-not $up) {
    Show-StartupFailure '健康检查超时（60s）。'
    exit 1
}

$recordData = [ordered]@{
    pid        = $process.Id
    port       = $Port
    dataDir    = $DataDir
    allowWrite = [bool]$AllowWrite
    apiKey     = if ($ApiKey) { '***' } else { '' }
    startedAt  = (Get-Date).ToString('o')
}
$recordData | ConvertTo-Json | Set-Content -Path $record -Encoding utf8

Write-Host ''
Write-Host '启动完成' -ForegroundColor Green
Write-Host "  数据源服务：http://127.0.0.1:$Port/api/datasources"
Write-Host "  健康检查  ：http://127.0.0.1:$Port/api/health"
Write-Host "  数据目录  ：$DataDir"
Write-Host "  日志      ：$logs"
Write-Host "  写操作    ：$(if ($AllowWrite) { '已开启（allow-write=true，仍需 confirmed=true）' } else { '已关闭（默认）' })"
Write-Host "  停止命令  ：powershell -ExecutionPolicy Bypass -File scripts\stop.ps1"
Write-Host ''
