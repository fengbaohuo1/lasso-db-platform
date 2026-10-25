# db-service 一键停止：只停止本脚本启动的进程（依据 data\service.json 记录的 PID + 命令行校验）
param(
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $DataDir) { $DataDir = Join-Path $root 'data' }
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$record = Join-Path $DataDir 'service.json'
$jar = Join-Path $root 'target\db-service.jar'

Write-Host ''
Write-Host 'DB Service · 停止' -ForegroundColor Cyan
if (-not (Test-Path $record)) {
    Write-Host "未找到运行记录 $record（服务可能未启动或已被清理）。"
    exit 0
}

$state = Get-Content $record -Raw | ConvertFrom-Json
$pidValue = [int]$state.pid
$port = [int]$state.port
Write-Host "运行记录：pid=$pidValue port=$port dataDir=$($state.dataDir)"

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
if ($process) {
    $commandLine = [string]$process.CommandLine
    # 兼容旧版 jar 名（db-service-0.1.0.jar）与新 jar 名（db-service.jar）：按“项目根目录 + db-service + 端口”校验
    $rootKey = $root.TrimEnd('\')
    if ($commandLine -notlike "*$rootKey*" -or $commandLine -notlike '*db-service*' `
            -or $commandLine -notlike "*--server.port=$port*") {
        Write-Host "PID $pidValue 命令行不属于本服务，拒绝停止：" -ForegroundColor Yellow
        Write-Host "  $commandLine"
        exit 1
    }
    Write-Host "停止进程 PID $pidValue ..."
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
} else {
    Write-Host "PID $pidValue 已不存在。"
}

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "端口 $port 仍被 PID $($listening.OwningProcess) 占用，请手动确认。" -ForegroundColor Yellow
} else {
    Write-Host "端口 $port 已释放。"
}
Remove-Item $record -Force -ErrorAction SilentlyContinue
Write-Host '已清理运行记录；数据目录（data\）保留。'
Write-Host ''
