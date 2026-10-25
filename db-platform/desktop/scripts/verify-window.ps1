<#
.SYNOPSIS
    DB Platform 桌面壳验证：窗口 / CDP（对象树 + 12 行数据 + 写模式）/ 端口隔离 / 子进程收尸，
    并用 Win32 PrintWindow 截窗口图到 desktop/verify-window.png。

.PARAMETER Configuration
    debug（默认，端口 18210）或 release（端口 18090）。

.PARAMETER KeepRunning
    验证后不关闭窗口（跳过退出收尸检查）。
#>
[CmdletBinding()]
param(
    [ValidateSet('debug', 'release')]
    [string]$Configuration = 'debug',
    [int]$CdpPort = 9345,
    # 可选：验证已安装副本（缺省用 src-tauri/target/<Configuration> 下的 exe）
    [string]$ExePath = '',
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $PSCommandPath
$DesktopDir = Split-Path -Parent $ScriptDir
$SrcTauriDir = Join-Path $DesktopDir 'src-tauri'
if ([string]::IsNullOrWhiteSpace($ExePath)) {
    $ExePath = Join-Path $SrcTauriDir "target\$Configuration\db-platform-desktop.exe"
}
$ScreenshotPath = Join-Path $DesktopDir 'verify-window.png'
$CdpJsonPath = Join-Path $DesktopDir 'verify-cdp.json'
$CdpScript = Join-Path $ScriptDir 'cdp-check.mjs'
$ExpectedMinWidth = 1200
# 保护端口：本应用（release 固定 18210）不得占用/终止这些 Web/其它产品端口
$GuardPorts = @(18090, 18091, 18100, 18200)

$win32Source = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class DbpWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static IntPtr FindMainWindow(int processId)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint windowProcessId;
            GetWindowThreadProcessId(hWnd, out windowProcessId);
            if (windowProcessId != (uint)processId) return true;
            if (!IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) == 0) return true;
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            if (rect.Right - rect.Left < 400) return true;
            found = hWnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static string Title(IntPtr hWnd)
    {
        var buffer = new StringBuilder(512);
        GetWindowText(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static int Width(IntPtr hWnd)
    {
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) return 0;
        return rect.Right - rect.Left;
    }

    public static int Height(IntPtr hWnd)
    {
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) return 0;
        return rect.Bottom - rect.Top;
    }

    public static string Capture(IntPtr hWnd, string path, out int width, out int height, out int bytes)
    {
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) throw new InvalidOperationException("GetWindowRect 失败");
        width = Math.Max(1, rect.Right - rect.Left);
        height = Math.Max(1, rect.Bottom - rect.Top);
        if (width < 400 || height < 300) throw new InvalidOperationException("窗口尺寸异常：" + width + "x" + height);
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(bitmap))
        {
            IntPtr hdc = graphics.GetHdc();
            bool ok = PrintWindow(hWnd, hdc, 2u); // PW_RENDERFULLCONTENT
            graphics.ReleaseHdc(hdc);
            bitmap.Save(path, ImageFormat.Png);
            bytes = (int)new System.IO.FileInfo(path).Length;
            return ok ? "PrintWindow" : "PrintWindow(未确认)";
        }
    }
}
'@
Add-Type -TypeDefinition $win32Source -ReferencedAssemblies System.Drawing

$script:desktopProcess = $null
trap {
    Write-Host "[verify] 验证失败：$($_.Exception.Message)" -ForegroundColor Red
    $desktopLog = Join-Path $env:APPDATA 'com.jnf.dbplatform.desktop\data\logs\desktop.log'
    if (Test-Path -LiteralPath $desktopLog) {
        Write-Host '[verify] desktop.log 末尾：' -ForegroundColor DarkGray
        Get-Content -LiteralPath $desktopLog -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
    if ($script:desktopProcess) {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($script:desktopProcess.Id)" -ErrorAction SilentlyContinue)
        foreach ($child in $children) {
            if ($child.Name -ieq 'java.exe') { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
        }
        Stop-Process -Id $script:desktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
    exit 1
}

function Wait-Until {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$Label,
        [int]$IntervalMs = 500
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $value = & $Condition
        if ($null -ne $value -and $value -ne $false) { return $value }
        Start-Sleep -Milliseconds $IntervalMs
    }
    throw "等待超时（${TimeoutSeconds}s）：$Label"
}

function Get-ListenerSnapshot {
    param([int[]]$Ports)
    $items = @()
    foreach ($port in $Ports) {
        $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        foreach ($listener in $listeners) {
            $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            $items += [pscustomobject]@{
                Port        = $port
                Pid         = [int]$listener.OwningProcess
                ProcessName = if ($process) { $process.ProcessName } else { '' }
            }
        }
    }
    return , $items
}

function Format-Snapshot {
    param($Snapshot)
    if (-not $Snapshot -or $Snapshot.Count -eq 0) { return '(无监听)' }
    return (($Snapshot | ForEach-Object { "port=$($_.Port) pid=$($_.Pid) $($_.ProcessName)" }) -join '; ')
}

if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "未找到可执行文件：$ExePath`n请先构建：cd desktop\src-tauri; cargo build"
}

# 只清理同路径的旧实例：不要误杀用户正在运行的 debug 窗口/其它副本
Get-Process -Name 'db-platform-desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and ($_.Path -eq $ExePath) } |
    Stop-Process -Force

# 记录 18090/18091/18100/18200 现有监听，确保全程不被本应用占用/杀掉
$guardBefore = Get-ListenerSnapshot -Ports $GuardPorts
Write-Host "[verify] 保留端口快照(前): $(Format-Snapshot $guardBefore)"

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:TEMP "dbp-desktop-verify-profile"
$script:desktopProcess = Start-Process -FilePath $ExePath -PassThru -RedirectStandardOutput (Join-Path $DesktopDir 'verify-app.out.log') -RedirectStandardError (Join-Path $DesktopDir 'verify-app.err.log')
$desktopProcess = $script:desktopProcess
Write-Host "[verify] exe            : $ExePath"
Write-Host "[verify] 桌面进程 PID    : $($desktopProcess.Id)（$Configuration 期望端口 18210）"

# 窗口要等 db-service 健康后才创建
$windowHandle = Wait-Until -TimeoutSeconds 150 -Label '主窗口出现且尺寸就绪' -Condition {
    $process = Get-Process -Id $desktopProcess.Id -ErrorAction SilentlyContinue
    if (-not $process) { throw "桌面进程提前退出（PID $($desktopProcess.Id)）" }
    $handle = [DbpWin32]::FindMainWindow([int]$desktopProcess.Id)
    if ($handle -eq [IntPtr]::Zero) { return $null }
    if ([DbpWin32]::Width($handle) -lt $ExpectedMinWidth) { return $null }
    if ([DbpWin32]::Title($handle) -notlike '*DB Platform*') { return $null }
    return $handle
}
$windowTitle = [DbpWin32]::Title($windowHandle)
Write-Host "[verify] 窗口句柄        : $windowHandle"
Write-Host "[verify] 窗口标题        : $windowTitle"
Write-Host "[verify] 窗口尺寸        : $([DbpWin32]::Width($windowHandle))x$([DbpWin32]::Height($windowHandle))"

$javaChild = Wait-Until -TimeoutSeconds 90 -Label 'java 子进程出现' -Condition {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktopProcess.Id)" -ErrorAction SilentlyContinue)
    $child = $children | Where-Object { $_.Name -ieq 'java.exe' } | Select-Object -First 1
    if ($child) { return $child }
    return $null
}
$javaPid = [int]$javaChild.ProcessId
$javaCmdline = [string]$javaChild.CommandLine
Write-Host "[verify] java 子进程 PID : $javaPid"

if ($javaCmdline -notmatch '--server\.port=(\d+)') { throw "无法从 java 命令行解析 --server.port：$javaCmdline" }
$servicePort = [int]$Matches[1]
Write-Host "[verify] db-service 端口 : $servicePort"
$expectedPort = 18210
if ($env:DBP_SERVICE_PORT -and [int]::TryParse($env:DBP_SERVICE_PORT, [ref]$null)) {
    $expectedPort = [int]$env:DBP_SERVICE_PORT
}
if ($servicePort -ne $expectedPort) {
    Write-Host "[verify] 警告            : 端口 $servicePort 不是期望的 $expectedPort（可能被占用后自动避让）"
}
if ($GuardPorts -contains $servicePort) { throw "端口冲突：db-service 占用了保留端口 $servicePort" }

if ($javaCmdline -notmatch '--db-service\.data-dir=(.+?)(?= --|$)') { throw "无法从 java 命令行解析 --db-service.data-dir：$javaCmdline" }
$dataDir = $Matches[1].Trim()
Write-Host "[verify] 数据目录        : $dataDir"
if ($javaCmdline -notmatch '--db-service\.allow-write=true') { throw "db-service 未带 --db-service.allow-write=true" }
if ($javaCmdline -notmatch '--logging\.file\.name=') { throw "db-service 未带 --logging.file.name" }

# 健康接口
$health = Wait-Until -TimeoutSeconds 120 -Label 'db-service /api/health' -Condition {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$servicePort/api/health" -TimeoutSec 3
        if ($response.code -eq '00000') { return $response }
    } catch { }
    return $null
}
Write-Host "[verify] health code     : $($health.code) allowWrite=$($health.data.allowWrite)"
if ($health.data.allowWrite -ne $true) { throw "db-service allowWrite 不是 true" }

# CDP：对象树 / 12 行数据 / 写模式
# 注意：node 的 stderr 在 $ErrorActionPreference=Stop 下会被当成终止错误，这里临时放宽以便完整捕获输出
$savedErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$cdpOutput = & node $CdpScript $CdpPort 2>&1
$cdpExit = $LASTEXITCODE
$ErrorActionPreference = $savedErrorAction
$cdpText = ($cdpOutput | Out-String)
Set-Content -Path $CdpJsonPath -Value $cdpText -Encoding UTF8
if ($cdpExit -ne 0) {
    Write-Host $cdpText
    throw "CDP 断言失败（退出码 $cdpExit）：$($cdpText.Split("`n")[0])"
}
$cdp = $cdpOutput | Out-String | ConvertFrom-Json
if (-not $cdp.ok) {
    Write-Host ($cdpOutput | Out-String)
    throw "CDP 断言未通过"
}
foreach ($check in $cdp.checks) {
    Write-Host ("[verify] CDP 断言       : {0} -> {1}" -f $check.name, $check.passed)
}
Write-Host "[verify] 页面标题        : $($cdp.page.title)"
Write-Host "[verify] 页面 apiBase     : $($cdp.page.apiBase)"
Write-Host "[verify] 页面 href        : $($cdp.page.href)"
Write-Host "[verify] 对象树文本      : $(($cdp.page.tree -replace '\s+', ' ').Substring(0, [Math]::Min(240, ($cdp.page.tree -replace '\s+', ' ').Length)))"
if ($cdp.consoleErrors -and @($cdp.consoleErrors).Count -gt 0) {
    Write-Host "[verify] 警告            : 交互期控制台错误 $((@($cdp.consoleErrors)).Count) 条" -ForegroundColor Yellow
}

# PrintWindow 截图（先激活窗口，抓两帧避免 WebView2 合成层旧帧）
[void][DbpWin32]::ShowWindow($windowHandle, 5)
[void][DbpWin32]::SetForegroundWindow($windowHandle)
Start-Sleep -Milliseconds 1200
$pngWidth = 0
$pngHeight = 0
$pngBytes = 0
$null = [DbpWin32]::Capture($windowHandle, $ScreenshotPath, [ref]$pngWidth, [ref]$pngHeight, [ref]$pngBytes)
Start-Sleep -Milliseconds 500
$captureMode = [DbpWin32]::Capture($windowHandle, $ScreenshotPath, [ref]$pngWidth, [ref]$pngHeight, [ref]$pngBytes)
Write-Host "[verify] 截图            : $ScreenshotPath"
Write-Host "[verify] 截图信息        : $captureMode ${pngWidth}x${pngHeight} $([math]::Round($pngBytes / 1KB, 1)) KB"
if ($pngWidth -lt $ExpectedMinWidth) { throw "截图宽度异常：$pngWidth" }
if ($pngBytes -lt 10000) { throw "截图文件过小：$pngBytes 字节（可能为黑屏）" }

# 保留端口：本应用不得监听；原有监听进程不得被本应用杀掉
$guardAfterRun = Get-ListenerSnapshot -Ports $GuardPorts
foreach ($item in $guardAfterRun) {
    if ($item.Pid -eq [int]$desktopProcess.Id -or $item.Pid -eq $javaPid) {
        throw "本应用占用了保留端口 $($item.Port)（PID $($item.Pid)）"
    }
}
foreach ($item in @($guardBefore)) {
    if ($item -and -not (Get-Process -Id $item.Pid -ErrorAction SilentlyContinue)) {
        throw "运行期间保留端口进程消失：port=$($item.Port) pid=$($item.Pid) $($item.ProcessName)"
    }
}
Write-Host "[verify] 保留端口快照(后): $(Format-Snapshot $guardAfterRun)（未被本应用占用/终止）"

$expectedDataFiles = @(
    (Join-Path $dataDir 'logs'),
    $dataDir
)
foreach ($path in $expectedDataFiles) {
    if (-not (Test-Path -LiteralPath $path)) { throw "缺少数据目录产物：$path" }
}
Write-Host "[verify] 数据产物        : $dataDir 已生成（含 db-service.log）"

if ($KeepRunning) {
    Write-Host "[verify] 已保留运行：desktop PID=$($desktopProcess.Id) java PID=$javaPid"
} else {
    [void][DbpWin32]::PostMessage($windowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)  # WM_CLOSE
    $null = Wait-Until -TimeoutSeconds 45 -Label '桌面进程退出' -Condition {
        $process = Get-Process -Id $desktopProcess.Id -ErrorAction SilentlyContinue
        if (-not $process) { return $true }
        return $null
    }
    Start-Sleep -Seconds 1
    if (Get-Process -Id $javaPid -ErrorAction SilentlyContinue) { throw "退出后 java 子进程仍在运行：PID $javaPid" }
    $portStillOpen = @(Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue)
    if ($portStillOpen.Count -gt 0) { throw "退出后端口 $servicePort 仍被监听" }
    Write-Host "[verify] 退出收尸        : 桌面进程与 java 子进程均已退出，端口 $servicePort 已释放"
    $guardAfterExit = Get-ListenerSnapshot -Ports $GuardPorts
    foreach ($item in $guardAfterExit) {
        if ($item.Pid -eq [int]$desktopProcess.Id -or $item.Pid -eq $javaPid) {
            throw "退出后保留端口仍被本应用进程占用：port=$($item.Port) pid=$($item.Pid)"
        }
    }
    foreach ($item in @($guardBefore)) {
        if ($item -and -not (Get-Process -Id $item.Pid -ErrorAction SilentlyContinue)) {
            throw "退出后保留端口进程消失：port=$($item.Port) pid=$($item.Pid) $($item.ProcessName)"
        }
    }
}

Write-Host ''
Write-Host '===== 验证通过 ====='
Write-Host "窗口标题 : $windowTitle"
Write-Host "截图     : $ScreenshotPath"
Write-Host "CDP 结果 : $CdpJsonPath（ok=$($cdp.ok)）"
Write-Host "端口     : $servicePort（java PID $javaPid；18090/18091/18100/18200 未受影响）"
Write-Host "数据目录 : $dataDir"
