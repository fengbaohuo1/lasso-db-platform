param(
  [int]$Port = 18091,
  [string]$Service = 'http://127.0.0.1:18090'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js，请先安装 Node 18+。'
}

try {
  $health = Invoke-RestMethod "$Service/api/health" -TimeoutSec 3
  if ($health.code -ne '00000') { throw 'db-service 健康检查返回异常' }
  Write-Host ("db-service 正常：{0}（allowWrite={1}）" -f $Service, $health.data.allowWrite)
} catch {
  throw "无法连接 db-service（$Service）。请先启动 db-service（默认端口 18090）。`n$($_.Exception.Message)"
}

Write-Host ("启动 db-platform BFF：http://127.0.0.1:{0} → {1}" -f $Port, $Service)
Write-Host '按 Ctrl+C 停止。'
node (Join-Path $root 'server.mjs') --service $Service --port $Port
