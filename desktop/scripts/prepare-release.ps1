#requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:VSLANG = "1033"

$DesktopRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $DesktopRoot
$ReleaseRoot = Join-Path $ProjectRoot "build\release"
$NativeBuildRoot = Join-Path $ReleaseRoot "native"
$UpstreamRoot = Join-Path $ReleaseRoot "upstream"
$RuntimeDistRoot = Join-Path $DesktopRoot "build\runtime"
$RuntimeRoot = Join-Path $RuntimeDistRoot "jarvis-launcher"
$VendorRoot = Join-Path $ProjectRoot "third_party\runtime\vendor"
$PatchPath = Join-Path $ProjectRoot "third_party\runtime\patches\0001-text-input-runtime.patch"
$PatchMarker = Join-Path $UpstreamRoot ".jarvis-patches-applied"
$PackagedRuntimeRoot = Join-Path $DesktopRoot "dist\win-unpacked\resources\backend\runtime"

if (Test-Path -LiteralPath $PackagedRuntimeRoot -PathType Container) {
    $runtimePrefix = [IO.Path]::GetFullPath($PackagedRuntimeRoot).TrimEnd("\") + "\"
    $runningPackagedProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ExecutablePath -and
            $_.ExecutablePath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)
        })
    if ($runningPackagedProcesses.Count -gt 0) {
        $processList = ($runningPackagedProcesses | ForEach-Object {
            "$($_.Name) (PID $($_.ProcessId))"
        }) -join ", "
        throw "Close the packaged AI Jarvis runtime before building: $processList"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Get-CompatiblePython {
    $candidates = @(
        (Join-Path $ProjectRoot ".venv\Scripts\python.exe"),
        "python.exe"
    )
    foreach ($candidate in $candidates) {
        try {
            & $candidate -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)" *>$null
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } catch {}
    }
    throw "Python 3.12 or newer is required on the release build machine."
}

function Prepare-PatchedUpstream {
    $expectedHash = (Get-FileHash -LiteralPath $PatchPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $currentHash = if (Test-Path -LiteralPath $PatchMarker -PathType Leaf) {
        (Get-Content -LiteralPath $PatchMarker -Raw).Trim()
    } else { "" }
    if ($currentHash -eq $expectedHash) { return }

    if (Test-Path -LiteralPath $UpstreamRoot) {
        $resolved = [IO.Path]::GetFullPath($UpstreamRoot)
        $releasePrefix = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\") + "\"
        if (-not $resolved.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace an upstream tree outside build/release."
        }
        Remove-Item -LiteralPath $UpstreamRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $UpstreamRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $VendorRoot -Force | Copy-Item -Destination $UpstreamRoot -Recurse -Force

    Invoke-Checked -FilePath "git.exe" -Arguments @("-C", $UpstreamRoot, "init", "--quiet")
    Invoke-Checked -FilePath "git.exe" -Arguments @("-C", $UpstreamRoot, "config", "core.autocrlf", "false")
    Invoke-Checked -FilePath "git.exe" -Arguments @("-C", $UpstreamRoot, "add", "--all")
    Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $UpstreamRoot, "-c", "user.name=AI Jarvis Build",
        "-c", "user.email=build@aijarvis.invalid", "commit", "--quiet", "-m", "Pinned upstream"
    )
    $applyOptions = @("--ignore-space-change", "--ignore-whitespace")
    Invoke-Checked -FilePath "git.exe" -Arguments (
        @("-C", $UpstreamRoot, "apply", "--check") + $applyOptions + @($PatchPath)
    )
    Invoke-Checked -FilePath "git.exe" -Arguments (
        @("-C", $UpstreamRoot, "apply") + $applyOptions + @($PatchPath)
    )
    [IO.File]::WriteAllText($PatchMarker, $expectedHash, [Text.UTF8Encoding]::new($false))
}

function Build-NativeRuntime {
    New-Item -ItemType Directory -Path $NativeBuildRoot -Force | Out-Null
    $configure = @(
        "-S", $ProjectRoot,
        "-B", $NativeBuildRoot,
        "-G", "Visual Studio 17 2022",
        "-A", "x64",
        "-DJARVIS_ENABLE_STUB_RUNTIME=OFF",
        "-DJARVIS_RUNTIME_ENABLE_UPSTREAM=ON",
        "-DJARVIS_RUNTIME_UPSTREAM_SOURCE_DIR=$UpstreamRoot",
        "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DGGML_CUDA=OFF",
        "-DGGML_CCACHE=OFF",
        "-DGGML_OPENMP=OFF",
        "-DLLAMA_OPENSSL=OFF",
        "-DBUILD_TESTING=OFF",
        "-DLLAMA_BUILD_TESTS=OFF",
        "-DLLAMA_BUILD_EXAMPLES=OFF",
        "-DLLAMA_BUILD_SERVER=OFF",
        "-DLLAMA_BUILD_APP=OFF",
        "-DLLAMA_BUILD_COMMON=ON",
        "-DLLAMA_BUILD_TOOLS=ON"
    )
    Invoke-Checked -FilePath "cmake.exe" -Arguments $configure
    Invoke-Checked -FilePath "cmake.exe" -Arguments @(
        "--build", $NativeBuildRoot, "--config", "Release",
        "--target", "jarvis-native-worker", "--parallel"
    )
}

function Build-PythonRuntime {
    $bootstrapPython = Get-CompatiblePython
    $buildVenv = Join-Path $ReleaseRoot "python-env"
    $python = Join-Path $buildVenv "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        Invoke-Checked -FilePath $bootstrapPython -Arguments @("-m", "venv", $buildVenv)
    }
    Invoke-Checked -FilePath $python -Arguments @("-m", "pip", "install", "--upgrade", "pip")
    Invoke-Checked -FilePath $python -Arguments @("-m", "pip", "install", "$ProjectRoot[packaging]")
    Invoke-Checked -FilePath $python -Arguments @(
        "-m", "pip", "install", "--no-deps", "--force-reinstall", $ProjectRoot
    )
    if (Test-Path -LiteralPath $RuntimeDistRoot) {
        Remove-Item -LiteralPath $RuntimeDistRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $RuntimeDistRoot -Force | Out-Null
    $assets = Join-Path $ProjectRoot "src\jarvis_backend\assets"
    Invoke-Checked -FilePath $python -Arguments @(
        "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onedir", "--console",
        "--name", "jarvis-launcher",
        "--paths", (Join-Path $ProjectRoot "src"),
        "--add-data", "$assets;jarvis_backend/assets",
        "--hidden-import", "hf_xet",
        "--copy-metadata", "hf-xet",
        "--distpath", $RuntimeDistRoot,
        "--workpath", (Join-Path $ReleaseRoot "pyinstaller-work"),
        "--specpath", $ReleaseRoot,
        (Join-Path $ProjectRoot "src\jarvis_backend\packaged_launcher.py")
    )
}

function Copy-NativeRuntime {
    $worker = Join-Path $NativeBuildRoot "native\Release\jarvis-native-worker.exe"
    if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
        throw "Native release worker was not produced."
    }
    Copy-Item -LiteralPath $worker -Destination $RuntimeRoot -Force

    $artifacts = Get-ChildItem -LiteralPath $RuntimeRoot -File | ForEach-Object {
        [ordered]@{
            name = $_.Name
            size = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $manifest = [ordered]@{
        schema = 1
        architecture = "x64"
        inference = "cpu"
        artifacts = @($artifacts)
    } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText(
        (Join-Path $RuntimeRoot "runtime-manifest.json"),
        $manifest,
        [Text.UTF8Encoding]::new($false)
    )
}

Write-Host "Preparing the pinned native source..."
Prepare-PatchedUpstream
Write-Host "Building the portable CPU native runtime..."
Build-NativeRuntime
Write-Host "Freezing the Python backend..."
Build-PythonRuntime
Write-Host "Assembling the self-contained runtime..."
Copy-NativeRuntime
Invoke-Checked -FilePath (Join-Path $RuntimeRoot "jarvis-launcher.exe") -Arguments @("--self-test")
Write-Host "Release runtime is ready: $RuntimeRoot"
