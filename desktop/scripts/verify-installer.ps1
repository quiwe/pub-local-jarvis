#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$InstallRoot,
    [switch]$FullStartup,
    [switch]$RequireCuda,
    [switch]$KeepInstalled,
    [ValidateRange(1, 180)][int]$StartupTimeoutMinutes = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$DesktopRoot = Split-Path -Parent $PSScriptRoot
if (-not $InstallerPath) {
    $InstallerPath = Get-ChildItem -LiteralPath (Join-Path $DesktopRoot "dist") `
        -Filter "AI-Jarvis-Setup-*-x64.exe" -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "No AI Jarvis installer was found. Run npm run build first."
}
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)

$temporaryInstall = -not $InstallRoot
if (-not $InstallRoot) {
    $InstallRoot = Join-Path ([IO.Path]::GetTempPath()) `
        ("AIJarvis-Installer-Smoke-" + [Guid]::NewGuid().ToString("N"))
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"
if ($temporaryInstall -and -not $InstallRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The generated verification install path must stay below the temporary directory."
}

$appPath = Join-Path $InstallRoot "AI Jarvis.exe"
$runtimePath = Join-Path $InstallRoot "resources\backend\runtime\jarvis-launcher.exe"
$cpuWorkerPath = Join-Path $InstallRoot "resources\backend\runtime\jarvis-native-worker-cpu.exe"
$cudaWorkerPath = Join-Path $InstallRoot "resources\backend\runtime\jarvis-native-worker-cuda.exe"
$uninstallerPath = Join-Path $InstallRoot "Uninstall AI Jarvis.exe"
$desktopProcess = $null
$portBlocker = $null
$verificationSucceeded = $false
$originalEnvironment = @{}
$environmentKeys = @(
    "PATH", "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "JARVIS_DATA_ROOT",
    "JARVIS_MODEL_ROOT", "JARVIS_AUTO_START", "JARVIS_ELECTRON_USER_DATA_ROOT",
    "JARVIS_STATE_FILE", "JARVIS_SERVER_PORT", "JARVIS_PIPE_NAME",
    "JARVIS_ACTIVE_INFERENCE_BACKEND"
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
    Write-Host "Installing into isolated directory: $InstallRoot"
    $installer = Start-Process -FilePath $InstallerPath -ArgumentList @(
        "/S", "/D=$InstallRoot"
    ) -Wait -PassThru
    if ($installer.ExitCode -ne 0) {
        throw "Installer exited with code $($installer.ExitCode)."
    }
    foreach ($requiredPath in @(
        $appPath, $runtimePath, $cpuWorkerPath, $cudaWorkerPath, $uninstallerPath
    )) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Installed file is missing: $requiredPath"
        }
    }

    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    foreach ($key in $environmentKeys | Where-Object { $_ -ne "PATH" }) {
        [Environment]::SetEnvironmentVariable($key, $null, "Process")
    }
    $env:JARVIS_ELECTRON_USER_DATA_ROOT = Join-Path $InstallRoot "verification-electron-data"

    Write-Host "Checking the bundled runtime without Python or build tools on PATH..."
    & $runtimePath --self-test
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled runtime self-test failed with code $LASTEXITCODE."
    }

    Write-Host "Launching the installed desktop app..."
    $desktopProcess = Start-Process -FilePath $appPath -PassThru
    Start-Sleep -Seconds 8
    if ($desktopProcess.HasExited) {
        throw "Installed desktop app exited during its launch smoke test."
    }
    Stop-ProcessTree -Process $desktopProcess
    $desktopProcess = $null

    if ($FullStartup) {
        $env:JARVIS_DATA_ROOT = Join-Path $InstallRoot "verification-data"
        $env:JARVIS_STATE_FILE = Join-Path $InstallRoot "verification-state.json"
        $env:JARVIS_AUTO_START = "1"
        $existingModelRoot = Join-Path $env:LOCALAPPDATA "AIJarvis\models\MiniCPM-o-4_5-gguf"
        if (Test-Path -LiteralPath (Join-Path $existingModelRoot ".aijarvis-model.json") -PathType Leaf) {
            $env:JARVIS_MODEL_ROOT = $existingModelRoot
        }
        try {
            $portBlocker = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 31847)
            $portBlocker.Start()
            Write-Host "Occupied preferred port 31847 to verify automatic fallback."
        } catch [Net.Sockets.SocketException] {
            $portBlocker = $null
            Write-Host "Preferred port 31847 was already occupied; using it as the fallback test."
        }
        Write-Host "Starting the installed app through the same one-click startup path..."
        $desktopProcess = Start-Process -FilePath $appPath -PassThru
        $deadline = [DateTime]::UtcNow.AddMinutes($StartupTimeoutMinutes)
        $healthy = $false
        $serverPort = $null
        $appState = $null
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($desktopProcess.HasExited) {
                throw "Installed desktop app exited during the complete startup test."
            }
            foreach ($candidatePort in 31848..31867) {
                try {
                    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$candidatePort/api/v1/health" `
                        -TimeoutSec 1
                    if ($health.status -eq "ok" -and $health.native_connected) {
                        $healthy = $true
                        $serverPort = $candidatePort
                        break
                    }
                } catch {}
            }
            if (Test-Path -LiteralPath $env:JARVIS_STATE_FILE -PathType Leaf) {
                try {
                    $appState = Get-Content -LiteralPath $env:JARVIS_STATE_FILE -Raw -Encoding UTF8 |
                        ConvertFrom-Json
                    if ($appState.phase -eq "error") {
                        throw "Installed app reported a startup error: $($appState.error)"
                    }
                    if (
                        $healthy -and
                        $appState.phase -eq "running" -and
                        $appState.environmentStatus -eq "ready"
                    ) {
                        break
                    }
                } catch [System.Management.Automation.RuntimeException] {
                    throw
                } catch {}
            }
            if ($healthy) {
                $healthy = $false
                $serverPort = $null
            }
            Start-Sleep -Seconds 2
        }
        if (-not $healthy -or -not $serverPort) {
            $stateDetail = if (Test-Path -LiteralPath $env:JARVIS_STATE_FILE -PathType Leaf) {
                Get-Content -LiteralPath $env:JARVIS_STATE_FILE -Raw -Encoding UTF8
            } else {
                "No application state was produced."
            }
            throw "Installed app did not finish startup within $StartupTimeoutMinutes minutes. $stateDetail"
        }
        if ($RequireCuda -and $appState.inferenceBackend -ne "cuda") {
            throw "CUDA was required, but the installed app selected '$($appState.inferenceBackend)'. Reason: $($appState.inferenceReason)"
        }
        Write-Host "Environment model is ready with inference backend '$($appState.inferenceBackend)'."
        Write-Host "Requesting a real text generation from the installed model..."
        $chat = Invoke-RestMethod -Uri "http://127.0.0.1:$serverPort/api/v1/assistant/chat" `
            -Method Post `
            -ContentType "application/json; charset=utf-8" `
            -Body ([Text.Encoding]::UTF8.GetBytes('{"message":"Reply with exactly these two words: TEST SUCCESS"}')) `
            -TimeoutSec 300
        if (-not $chat.reply -or -not $chat.reply.Trim()) {
            throw "Installed model returned an empty text response."
        }
        Write-Host "Installed model generated text successfully: $($chat.reply)"
    }

    $verificationSucceeded = $true
    Write-Host "Installer verification passed."
} finally {
    Stop-ProcessTree -Process $desktopProcess
    if ($portBlocker) { $portBlocker.Stop() }
    foreach ($key in $environmentKeys) {
        [Environment]::SetEnvironmentVariable($key, $originalEnvironment[$key], "Process")
    }
    if ($verificationSucceeded -and -not $KeepInstalled -and (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
        Write-Host "Removing the isolated verification installation..."
        $uninstaller = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
        if ($uninstaller.ExitCode -ne 0) {
            Write-Warning "Uninstaller exited with code $($uninstaller.ExitCode)."
        }
    }
    if ($verificationSucceeded -and $temporaryInstall -and -not $KeepInstalled -and (Test-Path -LiteralPath $InstallRoot)) {
        $resolvedInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
        if (-not $resolvedInstallRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean a verification path outside the temporary directory."
        }
        Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force
    } elseif (-not $verificationSucceeded -and $temporaryInstall) {
        Write-Warning "Verification failed; the isolated installation was preserved for diagnostics: $InstallRoot"
    }
}
