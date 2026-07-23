#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$CudaToolkitRoot = $env:CUDA_PATH
)

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
$NativeCpuBuildRoot = Join-Path $ReleaseRoot "native-cpu"
$NativeCudaBuildRoot = Join-Path $ReleaseRoot "native-cuda-13.3"
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

function Get-VisualStudioGenerator {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        throw "Visual Studio Installer (vswhere.exe) was not found. Install Visual Studio C++ Build Tools."
    }
    $installationVersion = (& $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationVersion | Select-Object -First 1).Trim()
    if (-not $installationVersion) {
        throw "No Visual Studio installation with the x64 C++ build tools was found."
    }
    $majorVersion = [int]($installationVersion.Split(".")[0])
    switch ($majorVersion) {
        17 { return "Visual Studio 17 2022" }
        18 { return "Visual Studio 18 2026" }
        default {
            throw "Visual Studio $majorVersion is installed, but this release script does not know its CMake generator name."
        }
    }
}

function Get-CudaToolkitRoot {
    if ($CudaToolkitRoot) {
        $candidate = [IO.Path]::GetFullPath($CudaToolkitRoot)
        if (Test-Path -LiteralPath (Join-Path $candidate "bin\nvcc.exe") -PathType Leaf) {
            return $candidate
        }
    }
    $localToolkit = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "build") `
        -Filter "cuda-toolkit-*" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "bin\nvcc.exe") -PathType Leaf } |
        Select-Object -First 1 -ExpandProperty FullName
    if ($localToolkit) { return [IO.Path]::GetFullPath($localToolkit) }
    $toolkitParent = Join-Path $env:ProgramFiles "NVIDIA GPU Computing Toolkit\CUDA"
    $candidate = Get-ChildItem -LiteralPath $toolkitParent -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "bin\nvcc.exe") -PathType Leaf } |
        Select-Object -First 1 -ExpandProperty FullName
    if ($candidate) { return $candidate }
    throw "CUDA Toolkit 13.1 or newer is required on the release build machine to package NVIDIA acceleration."
}

function Enter-VisualStudioEnvironment {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    $installationPath = (& $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath | Select-Object -First 1).Trim()
    $devCommand = Join-Path $installationPath "Common7\Tools\VsDevCmd.bat"
    if (-not (Test-Path -LiteralPath $devCommand -PathType Leaf)) {
        throw "Visual Studio developer environment script was not found."
    }
    $commandLine = "`"$devCommand`" -arch=x64 -host_arch=x64 >nul && set"
    $environmentLines = & cmd.exe /d /s /c $commandLine
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to initialize the Visual Studio x64 build environment."
    }
    foreach ($line in $environmentLines) {
        $separator = $line.IndexOf("=")
        if ($separator -le 0) { continue }
        [Environment]::SetEnvironmentVariable(
            $line.Substring(0, $separator),
            $line.Substring($separator + 1),
            "Process"
        )
    }
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
    param(
        [Parameter(Mandatory = $true)][string]$BuildRoot,
        [Parameter(Mandatory = $true)][bool]$UseCuda,
        [string]$ToolkitRoot = ""
    )

    New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
    $visualStudioGenerator = Get-VisualStudioGenerator
    $generator = if ($UseCuda) { "Ninja" } else { $visualStudioGenerator }
    if ($UseCuda) { Enter-VisualStudioEnvironment }
    Write-Host "Using CMake generator: $generator"
    $configure = @(
        "-S", $ProjectRoot,
        "-B", $BuildRoot,
        "-G", $generator,
        "-DJARVIS_ENABLE_STUB_RUNTIME=OFF",
        "-DJARVIS_RUNTIME_ENABLE_UPSTREAM=ON",
        "-DJARVIS_RUNTIME_UPSTREAM_SOURCE_DIR=$UpstreamRoot",
        "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DGGML_CUDA=$($UseCuda.ToString().ToUpperInvariant())",
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
    if ($UseCuda) {
        $configure += @(
            "-DCMAKE_BUILD_TYPE=Release",
            "-DCMAKE_C_COMPILER=cl.exe",
            "-DCMAKE_CXX_COMPILER=cl.exe",
            "-DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler",
            "-DCUDAToolkit_ROOT=$ToolkitRoot",
            "-DCMAKE_CUDA_COMPILER=$(Join-Path $ToolkitRoot 'bin\nvcc.exe')",
            "-DCMAKE_CUDA_ARCHITECTURES=75;80;86;89;120",
            "-DGGML_CUDA_NCCL=OFF"
        )
    } else {
        $configure += @("-A", "x64")
    }
    Invoke-Checked -FilePath "cmake.exe" -Arguments $configure
    $build = @("--build", $BuildRoot, "--target", "jarvis-native-worker")
    $build += if ($UseCuda) { @("--parallel", "4") } else { @("--parallel") }
    if (-not $UseCuda) { $build += @("--config", "Release") }
    Invoke-Checked -FilePath "cmake.exe" -Arguments $build
}

function Build-PythonRuntime {
    $bootstrapPython = Get-CompatiblePython
    $buildVenv = Join-Path $ReleaseRoot "python-env"
    $python = Join-Path $buildVenv "Scripts\python.exe"
    if (Test-Path -LiteralPath $buildVenv) {
        $resolvedBuildVenv = [IO.Path]::GetFullPath($buildVenv)
        $releasePrefix = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\") + "\"
        if (-not $resolvedBuildVenv.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace a Python build environment outside build/release."
        }
        Remove-Item -LiteralPath $resolvedBuildVenv -Recurse -Force
    }
    Invoke-Checked -FilePath $bootstrapPython -Arguments @("-m", "venv", $buildVenv)
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
    param([Parameter(Mandatory = $true)][string]$ToolkitRoot)

    $cpuWorker = Join-Path $NativeCpuBuildRoot "native\Release\jarvis-native-worker.exe"
    $cudaWorker = Join-Path $NativeCudaBuildRoot "native\jarvis-native-worker.exe"
    foreach ($worker in @($cpuWorker, $cudaWorker)) {
        if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
            throw "Native release worker was not produced: $worker"
        }
    }
    Copy-Item -LiteralPath $cpuWorker `
        -Destination (Join-Path $RuntimeRoot "jarvis-native-worker-cpu.exe") -Force
    Copy-Item -LiteralPath $cudaWorker `
        -Destination (Join-Path $RuntimeRoot "jarvis-native-worker-cuda.exe") -Force
    Copy-Item -LiteralPath (Join-Path $VendorRoot "tools\omni\assets\default_ref_audio\default_ref_audio.wav") `
        -Destination (Join-Path $RuntimeRoot "default_ref_audio.wav") -Force

    $cudaBinRoots = @(
        (Join-Path $ToolkitRoot "bin"),
        (Join-Path $ToolkitRoot "bin\x64")
    )
    $cudaRuntimeFiles = @()
    foreach ($pattern in @("cudart64_*.dll", "cublas64_*.dll", "cublasLt64_*.dll")) {
        $matches = @($cudaBinRoots | ForEach-Object {
            Get-ChildItem -LiteralPath $_ -Filter $pattern -File -ErrorAction SilentlyContinue
        })
        if ($matches.Count -eq 0) {
            throw "CUDA runtime dependency was not found: $pattern"
        }
        $cudaRuntimeFiles += $matches
    }
    foreach ($file in $cudaRuntimeFiles | Sort-Object FullName -Unique) {
        Copy-Item -LiteralPath $file.FullName -Destination $RuntimeRoot -Force
    }

    $artifacts = Get-ChildItem -LiteralPath $RuntimeRoot -File | ForEach-Object {
        [ordered]@{
            name = $_.Name
            size = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $manifest = [ordered]@{
        schema = 2
        architecture = "x64"
        inference = @("cuda", "cpu")
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
$resolvedCudaToolkitRoot = Get-CudaToolkitRoot
Write-Host "Building the portable CPU native runtime..."
Build-NativeRuntime -BuildRoot $NativeCpuBuildRoot -UseCuda $false
Write-Host "Building the NVIDIA CUDA native runtime..."
Build-NativeRuntime -BuildRoot $NativeCudaBuildRoot -UseCuda $true `
    -ToolkitRoot $resolvedCudaToolkitRoot
Write-Host "Freezing the Python backend..."
Build-PythonRuntime
Write-Host "Assembling the self-contained runtime..."
Copy-NativeRuntime -ToolkitRoot $resolvedCudaToolkitRoot
Invoke-Checked -FilePath (Join-Path $RuntimeRoot "jarvis-launcher.exe") -Arguments @("--self-test")
Write-Host "Release runtime is ready: $RuntimeRoot"
