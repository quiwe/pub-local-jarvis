#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$RuntimePath,
    [string]$ModelRoot,
    [string]$DataRoot,
    [ValidateRange(1, 65535)][int]$Port = 31877,
    [ValidateRange(1, 60)][int]$StartupTimeoutMinutes = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$DesktopRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $DesktopRoot
if (-not $RuntimePath) {
    $RuntimePath = Join-Path $DesktopRoot "build\runtime\jarvis-launcher\jarvis-launcher.exe"
}
if (-not $ModelRoot) {
    $ModelRoot = Join-Path $env:LOCALAPPDATA "AIJarvis\models\MiniCPM-o-4_5-gguf"
}
if (-not $DataRoot) {
    $DataRoot = Join-Path $ProjectRoot "build\gpu-runtime-smoke"
}
$RuntimePath = [IO.Path]::GetFullPath($RuntimePath)
$ModelRoot = [IO.Path]::GetFullPath($ModelRoot)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)

foreach ($required in @(
    $RuntimePath,
    (Join-Path $ModelRoot "MiniCPM-o-4_5-Q4_K_M.gguf")
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required GPU smoke-test file is missing: $required"
    }
}

New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
$stdoutPath = Join-Path $DataRoot "launcher-stdout.log"
$stderrPath = Join-Path $DataRoot "launcher-stderr.log"
$runtimeProcess = $null
$originalEnvironment = @{}
$environmentKeys = @(
    "JARVIS_DATA_ROOT", "JARVIS_MODEL_ROOT", "JARVIS_SERVER_PORT", "JARVIS_PIPE_NAME"
)
foreach ($key in $environmentKeys) {
    $originalEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

function Stop-ProcessTree {
    param([Diagnostics.Process]$Process)
    if (-not $Process -or $Process.HasExited) { return }
    & taskkill.exe /PID $Process.Id /T /F *> $null
}

try {
    $env:JARVIS_DATA_ROOT = $DataRoot
    $env:JARVIS_MODEL_ROOT = $ModelRoot
    $env:JARVIS_SERVER_PORT = [string]$Port
    $env:JARVIS_PIPE_NAME = "\\.\pipe\AIJarvis.Worker.gpu-smoke.$([Guid]::NewGuid().ToString('N'))"

    Write-Host "Starting the frozen runtime and requiring CUDA..."
    $runtimeProcess = Start-Process -FilePath $RuntimePath -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $deadline = [DateTime]::UtcNow.AddMinutes($StartupTimeoutMinutes)
    $health = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($runtimeProcess.HasExited) {
            $stdout = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
            $stderr = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
            throw "Launcher exited with code $($runtimeProcess.ExitCode).`n$stdout`n$stderr"
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 2
            if ($health.native_connected) { break }
        } catch {}
        Start-Sleep -Seconds 2
    }
    if (-not $health -or -not $health.native_connected) {
        throw "GPU runtime did not become healthy within $StartupTimeoutMinutes minutes."
    }
    if ($health.inference_backend -ne "cuda") {
        $output = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
        throw "Expected CUDA, but the launcher selected '$($health.inference_backend)'.`n$output"
    }
    Write-Host "Health check reports CUDA with native inference connected."
    & nvidia-smi.exe

    $commandBody = @{ command = "start_monitoring"; arguments = @{} } | ConvertTo-Json -Depth 3
    Invoke-RestMethod "http://127.0.0.1:$Port/api/v1/commands" -Method Post `
        -ContentType "application/json" -Body $commandBody -TimeoutSec 180 | Out-Null

    $duplexDeadline = [DateTime]::UtcNow.AddMinutes(10)
    $duplex = $null
    while ([DateTime]::UtcNow -lt $duplexDeadline) {
        try {
            $duplex = Invoke-RestMethod "http://127.0.0.1:$Port/api/v1/duplex" -TimeoutSec 2
            if ($duplex.active) { break }
        } catch {}
        Start-Sleep -Seconds 2
    }
    if (-not $duplex -or -not $duplex.active) {
        throw "Environment perception did not become active within 10 minutes."
    }
    Write-Host "Environment perception is active."

    $chatBody = @{ message = "Reply with exactly these two words: TEST SUCCESS" } | ConvertTo-Json
    $chat = Invoke-RestMethod "http://127.0.0.1:$Port/api/v1/assistant/chat" -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($chatBody)) -TimeoutSec 300
    if (-not $chat.reply -or -not $chat.reply.Trim()) {
        throw "The installed model returned an empty text response."
    }
    Write-Host "Model text response: $($chat.reply)"
    Write-Host "GPU runtime verification passed."
} finally {
    Stop-ProcessTree -Process $runtimeProcess
    foreach ($key in $environmentKeys) {
        [Environment]::SetEnvironmentVariable($key, $originalEnvironment[$key], "Process")
    }
}
