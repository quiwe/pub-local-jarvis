#requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipModelDownload,
    [switch]$CpuOnly,
    [switch]$Rebuild,
    [switch]$NoBrowser,
    [switch]$SkipSmokeTest,
    [string]$HfToken = $env:HF_TOKEN
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
& "$env:SystemRoot\System32\chcp.com" 65001 *> $null

$ProjectRoot = $PSScriptRoot
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$VenvRoot = Join-Path $ProjectRoot ".venv"
$BuildRoot = Join-Path $ProjectRoot "build"
$ModelRoot = Join-Path $ProjectRoot "models\MiniCPM-o-4_5-gguf"
$PipeName = "\\.\pipe\AIJarvis.Worker.v1"
$ModelRevision = "502eec5b03eaee9d0d2ce17a176e3490103c9a63"
$CudaInstallVersion = "13.1"
$CmakeInstallVersion = "4.3.4"

$ModelFiles = @(
    [pscustomobject]@{
        RelativePath = "MiniCPM-o-4_5-Q4_K_M.gguf"
        Size = [int64]5026714400
        Sha256 = "1237a97ee081b8abebc47aa7dad565701e8f5f904cdc92f6723ac4281bbc0932"
    },
    [pscustomobject]@{
        RelativePath = "vision/MiniCPM-o-4_5-vision-F16.gguf"
        Size = [int64]1095113184
        Sha256 = "1453678cc4e4fe18de241952962e234f265cb8dda780773526103ab8ba82f421"
    },
    [pscustomobject]@{
        RelativePath = "audio/MiniCPM-o-4_5-audio-F16.gguf"
        Size = [int64]660167904
        Sha256 = "d5b188ac7feaf98e17175c3f9bd14bf269301bfd187439fdaa3e3a494fc32ef7"
    }
)

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    # Keep command output visible without letting it become part of a function's return value.
    & $FilePath @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Invoke-ExternalWithHeartbeat {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$Activity
    )

    # Run through a child PowerShell so app-execution aliases such as winget
    # reliably propagate their native exit code to Start-Process.
    $escapedFilePath = $FilePath.Replace("'", "''")
    $literalArguments = ($Arguments | ForEach-Object {
        "'$($_.Replace("'", "''"))'"
    }) -join " "
    $childCommand = "& '$escapedFilePath' $literalArguments; exit `$LASTEXITCODE"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand
    ) `
        -NoNewWindow -PassThru
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(15000)) {
        $elapsedMinutes = [math]::Floor($stopwatch.Elapsed.TotalMinutes)
        $elapsedSeconds = $stopwatch.Elapsed.Seconds
        Write-Host "    $Activity is still running ($elapsedMinutes min $elapsedSeconds sec)..." -ForegroundColor DarkGray
    }
    $process.WaitForExit()
    $process.Refresh()
    $exitCode = [int]$process.ExitCode
    if ($exitCode -ne 0) {
        throw "Command failed with exit code $exitCode`: $FilePath $($Arguments -join ' ')"
    }
}

function Refresh-ProcessEnvironment {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"

    $cudaPath = [Environment]::GetEnvironmentVariable("CUDA_PATH", "Machine")
    if ($cudaPath) {
        $env:CUDA_PATH = $cudaPath
        $cudaBin = Join-Path $cudaPath "bin"
        $cudaRuntimeBin = Join-Path $cudaBin "x64"
        $env:Path = "$cudaRuntimeBin;$cudaBin;$env:Path"
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Restart-LauncherElevated {
    Write-Step "Requesting administrator access to recover Windows Installer"

    $forwardedSwitches = @()
    if ($SkipInstall) { $forwardedSwitches += "-SkipInstall" }
    if ($SkipModelDownload) { $forwardedSwitches += "-SkipModelDownload" }
    if ($CpuOnly) { $forwardedSwitches += "-CpuOnly" }
    if ($Rebuild) { $forwardedSwitches += "-Rebuild" }
    if ($NoBrowser) { $forwardedSwitches += "-NoBrowser" }
    if ($SkipSmokeTest) { $forwardedSwitches += "-SkipSmokeTest" }

    # The elevated process inherits HF_TOKEN. Avoid putting the token on its command line.
    if ($HfToken) {
        $env:HF_TOKEN = $HfToken
    }
    $escapedScriptPath = $PSCommandPath.Replace("'", "''")
    $command = "& '$escapedScriptPath' $($forwardedSwitches -join ' ')"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

    try {
        $process = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru `
            -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand)
    } catch {
        throw "Administrator access was not granted. Approve the UAC prompt, or restart Windows and run start-real.cmd again."
    }
    exit $process.ExitCode
}

function Resolve-WindowsInstallerTransaction {
    $installerService = Get-CimInstance Win32_Service -Filter "Name='msiserver'" -ErrorAction SilentlyContinue
    if (-not $installerService -or $installerService.State -ne "Running" -or
        $installerService.AcceptStop -ne $false) {
        return
    }

    $installerProcesses = @(Get-CimInstance Win32_Process -Filter "Name='msiexec.exe'" -ErrorAction SilentlyContinue)
    if ($installerProcesses.Count -eq 0) {
        return
    }

    $inProgressPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\InProgress"
    $hasInProgressRecord = Test-Path -LiteralPath $inProgressPath
    # Windows Installer normally tears down its idle service process within 10 minutes.
    $cutoff = (Get-Date).AddMinutes(-10)
    $allProcessesAreStale = @($installerProcesses | Where-Object {
        -not $_.CreationDate -or ([datetime]$_.CreationDate) -ge $cutoff
    }).Count -eq 0

    if ($hasInProgressRecord -or -not $allProcessesAreStale) {
        throw "Windows Installer is currently installing another product (MSI 1618). Wait for that installation to finish, then run start-real.cmd again."
    }

    if (-not (Test-IsAdministrator)) {
        Restart-LauncherElevated
    }

    Write-Warning "Recovering a stale Windows Installer transaction left by an interrupted installation."
    foreach ($installerProcess in $installerProcesses) {
        & taskkill.exe /PID $installerProcess.ProcessId /F | Out-Null
    }
    Start-Sleep -Seconds 2

    $remainingProcesses = @(Get-CimInstance Win32_Process -Filter "Name='msiexec.exe'" -ErrorAction SilentlyContinue)
    if ($remainingProcesses.Count -gt 0) {
        throw "Windows Installer has a stale transaction that could not be recovered (MSI 1618). Restart Windows, then run start-real.cmd again."
    }
}

function Install-PortableCMake {
    if ($SkipInstall) {
        throw "CMake is required, and -SkipInstall was specified."
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $toolsRoot = Join-Path $RuntimeRoot "tools"
    $archiveName = "cmake-$CmakeInstallVersion-windows-x86_64.zip"
    $archivePath = Join-Path $toolsRoot $archiveName
    $checksumsPath = Join-Path $toolsRoot "cmake-$CmakeInstallVersion-SHA-256.txt"
    $cmakeRoot = Join-Path $toolsRoot "cmake-$CmakeInstallVersion-windows-x86_64"
    $cmakePath = Join-Path $cmakeRoot "bin\cmake.exe"
    if (Test-Path -LiteralPath $cmakePath -PathType Leaf) {
        return $cmakePath
    }

    Write-Step "Installing portable CMake $CmakeInstallVersion"
    New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
    $releaseRoot = "https://github.com/Kitware/CMake/releases/download/v$CmakeInstallVersion"
    Invoke-WebRequest -Uri "$releaseRoot/cmake-$CmakeInstallVersion-SHA-256.txt" `
        -OutFile $checksumsPath -UseBasicParsing
    $checksumLine = Get-Content -LiteralPath $checksumsPath |
        Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" } |
        Select-Object -First 1
    if (-not $checksumLine -or $checksumLine -notmatch "^([0-9a-fA-F]{64})") {
        throw "The official CMake checksum list does not contain $archiveName."
    }
    $expectedHash = $Matches[1].ToLowerInvariant()
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf) -or
        (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        Invoke-WebRequest -Uri "$releaseRoot/$archiveName" -OutFile $archivePath -UseBasicParsing
    }
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Portable CMake archive SHA-256 mismatch."
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsRoot -Force
    if (-not (Test-Path -LiteralPath $cmakePath -PathType Leaf)) {
        throw "Portable CMake extraction did not produce cmake.exe."
    }
    return $cmakePath
}

function Install-WingetPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [string]$Version,
        [string]$Override,
        [switch]$Force
    )

    if ($SkipInstall) {
        throw "$Id is required, and -SkipInstall was specified."
    }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "winget is required for automatic installation. Install Microsoft App Installer first."
    }

    Resolve-WindowsInstallerTransaction

    Write-Step "Installing $Id$(if ($Version) { " $Version" })"

    $arguments = @(
        "install", "--id", $Id, "--exact", "--silent",
        "--accept-package-agreements", "--accept-source-agreements"
    )
    if ($Version) {
        $arguments += @("--version", $Version)
    }
    if ($Override) {
        $arguments += @("--override", $Override)
    }
    if ($Force) {
        $arguments += "--force"
    }
    Invoke-ExternalWithHeartbeat -FilePath "winget.exe" -Arguments $arguments -Activity "Installing $Id"
    Refresh-ProcessEnvironment
}

function Get-OptionalPropertyValue {
    param(
        [Parameter(Mandatory = $true)]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $property = $InputObject.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }
    return $null
}

function Assert-RealProviderSource {
    $problems = [System.Collections.Generic.List[string]]::new()
    $patchPath = Join-Path $ProjectRoot "third_party\runtime\patches\0001-text-input-runtime.patch"
    $nativeCmakePath = Join-Path $ProjectRoot "native\CMakeLists.txt"
    $mainPath = Join-Path $ProjectRoot "native\src\main.cpp"
    $nativeSourcePath = Join-Path $ProjectRoot "native\src"

    if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
        $problems.Add("Missing reviewed upstream patch: third_party/runtime/patches/0001-text-input-runtime.patch")
    } else {
        try {
            $manifestPath = Join-Path $ProjectRoot "third_party\runtime\VENDOR.json"
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            $patchEntry = @($manifest.patches | Where-Object {
                $file = Get-OptionalPropertyValue -InputObject $_ -Name "file"
                $path = Get-OptionalPropertyValue -InputObject $_ -Name "path"
                $file -eq "0001-text-input-runtime.patch" -or
                $path -eq "0001-text-input-runtime.patch" -or
                $path -eq "patches/0001-text-input-runtime.patch"
            }) | Select-Object -First 1
            $expectedPatchHash = if ($patchEntry) {
                Get-OptionalPropertyValue -InputObject $patchEntry -Name "sha256"
            } else { $null }
            if (-not $expectedPatchHash) {
                $problems.Add("The runtime patch is not SHA-256 pinned in third_party/runtime/VENDOR.json")
            } else {
                $actualPatchHash = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actualPatchHash -ne ([string]$expectedPatchHash).ToLowerInvariant()) {
                    $problems.Add("The runtime patch does not match its VENDOR.json SHA-256")
                }
            }
        } catch {
            $problems.Add("Unable to validate the runtime patch manifest: $($_.Exception.Message)")
        }
    }

    $nativeCmake = Get-Content -LiteralPath $nativeCmakePath -Raw
    if ($nativeCmake -notmatch [regex]::Escape("jarvis::runtime_provider")) {
        $problems.Add("native/CMakeLists.txt does not link jarvis::runtime_provider")
    }

    $mainSource = Get-Content -LiteralPath $mainPath -Raw
    if ($mainSource -match [regex]::Escape("no MiniCPM-o inference provider is linked")) {
        $problems.Add("native/src/main.cpp still hard-exits when stub mode is disabled")
    }

    $implementations = Get-ChildItem -LiteralPath $nativeSourcePath -Filter "*.cpp" -File |
        Select-String -Pattern "public\s+IOmniRuntime"
    $realImplementations = @($implementations | Where-Object { $_.Line -notmatch "StubOmniRuntime" })
    if ($realImplementations.Count -eq 0) {
        $problems.Add("No non-stub IOmniRuntime adapter exists under native/src")
    }

    if ($problems.Count -gt 0) {
        Write-Host "`nREAL INFERENCE SOURCE GATE FAILED" -ForegroundColor Red
        Write-Host "This launcher stopped before installing large toolchains or downloading 6.32 GiB of models." -ForegroundColor Yellow
        foreach ($problem in $problems) {
            Write-Host "  - $problem" -ForegroundColor Red
        }
        Write-Host "`nJARVIS_ENABLE_STUB_RUNTIME will never be enabled by this launcher." -ForegroundColor Yellow
        throw "The repository does not yet contain a runnable real MiniCPM-o provider."
    }
}

function Get-CompatiblePython {
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        & $python.Source -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)" *>$null
        if ($LASTEXITCODE -eq 0) {
            return [pscustomobject]@{ FilePath = $python.Source; Prefix = @() }
        }
    }

    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        foreach ($selector in @("-3.13", "-3.12", "-3")) {
            & $launcher.Source $selector -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)" *>$null
            if ($LASTEXITCODE -eq 0) {
                return [pscustomobject]@{ FilePath = $launcher.Source; Prefix = @($selector) }
            }
        }
    }
    return $null
}

function Invoke-Python {
    param(
        [Parameter(Mandatory = $true)]$Python,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Invoke-External -FilePath $Python.FilePath -Arguments (@($Python.Prefix) + $Arguments)
}

function Get-VisualStudioPath {
    $vswhereCandidates = @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
        "$env:ProgramFiles\Microsoft Visual Studio\Installer\vswhere.exe"
    )
    foreach ($candidate in $vswhereCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $installationPath = & $candidate -latest -products * `
                -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
                -property installationPath
            if ($LASTEXITCODE -eq 0 -and $installationPath) {
                return ($installationPath | Select-Object -First 1)
            }
        }
    }
    return $null
}

function Get-NvccPath {
    $command = Get-Command nvcc.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    $cudaPath = $env:CUDA_PATH
    if (-not $cudaPath) {
        $cudaPath = [Environment]::GetEnvironmentVariable("CUDA_PATH", "Machine")
    }
    if ($cudaPath) {
        $candidate = Join-Path $cudaPath "bin\nvcc.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return $null
}

function Get-CudaVersion {
    param([Parameter(Mandatory = $true)][string]$NvccPath)
    $output = (& $NvccPath --version | Out-String)
    if ($LASTEXITCODE -ne 0 -or $output -notmatch "release\s+(\d+\.\d+)") {
        throw "Unable to determine the CUDA Toolkit version from $NvccPath."
    }
    return [version]$Matches[1]
}

function Get-ListeningPortOwner {
    param([Parameter(Mandatory = $true)][int]$Port)
    try {
        $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
            Select-Object -First 1
        if ($connection) {
            return $connection.OwningProcess
        }
    } catch {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $pending = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
            if ($pending.AsyncWaitHandle.WaitOne(300) -and $client.Connected) {
                return "unknown"
            }
        } finally {
            $client.Dispose()
        }
    }
    return $null
}

function Test-NamedPipePresent {
    param([Parameter(Mandatory = $true)][string]$FullName)

    $prefix = "\\.\pipe\"
    if (-not $FullName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Invalid Windows named pipe path: $FullName"
    }
    $name = $FullName.Substring($prefix.Length)
    return @(
        Get-ChildItem -LiteralPath $prefix -ErrorAction Stop |
            Where-Object { $_.Name -eq $name }
    ).Count -gt 0
}

function Assert-FreeSpace {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int64]$MinimumBytes,
        [Parameter(Mandatory = $true)][string]$Purpose
    )
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path))
    $driveName = $root.Substring(0, 1)
    $drive = Get-PSDrive -Name $driveName
    if ($drive.Free -lt $MinimumBytes) {
        $requiredGiB = [math]::Ceiling($MinimumBytes / 1GB)
        throw "Drive $root needs at least $requiredGiB GiB free for $Purpose."
    }
}

function Ensure-Environment {
    Write-Step "Checking Python, CMake, MSVC, and CUDA"

    $python = Get-CompatiblePython
    if (-not $python) {
        Install-WingetPackage -Id "Python.Python.3.12"
        $python = Get-CompatiblePython
    }
    if (-not $python) {
        throw "Python 3.12 or newer was installed but is not visible yet. Reopen the terminal and run again."
    }

    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) {
        Install-WingetPackage -Id "Git.Git"
        $git = Get-Command git.exe -ErrorAction SilentlyContinue
    }
    if (-not $git) {
        throw "Git was installed but is not visible yet. Reopen the terminal and run again."
    }

    $cmake = Get-Command cmake.exe -ErrorAction SilentlyContinue
    if (-not $cmake) {
        $portableCmake = Install-PortableCMake
        $cmake = Get-Command $portableCmake -ErrorAction Stop
    }
    if (-not $cmake) {
        throw "CMake was installed but is not visible yet. Reopen the terminal and run again."
    }
    $cmakeVersionLine = (& $cmake.Source --version | Select-Object -First 1)
    if ($cmakeVersionLine -notmatch "(\d+\.\d+\.\d+)") {
        throw "Unable to determine the CMake version."
    }
    $cmakeVersion = [version]$Matches[1]
    if ($cmakeVersion -lt [version]"3.24.0") {
        $portableCmake = Install-PortableCMake
        $cmake = Get-Command $portableCmake -ErrorAction Stop
        $cmakeVersionLine = (& $cmake.Source --version | Select-Object -First 1)
        $null = $cmakeVersionLine -match "(\d+\.\d+\.\d+)"
        $cmakeVersion = [version]$Matches[1]
    }

    $visualStudioPath = Get-VisualStudioPath
    if (-not $visualStudioPath) {
        Assert-FreeSpace -Path $env:SystemDrive -MinimumBytes 20GB -Purpose "Visual Studio C++ Build Tools"
        Install-WingetPackage -Id "Microsoft.VisualStudio.2022.BuildTools" `
            -Override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
        $visualStudioPath = Get-VisualStudioPath
    }
    if (-not $visualStudioPath) {
        throw "Visual Studio 2022 C++ Build Tools are not available yet. A reboot may be required; then run again."
    }

    $useCuda = $false
    $cudaArchitectures = ""
    if (-not $CpuOnly -and (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)) {
        $useCuda = $true
        $computeCaps = @(& nvidia-smi.exe --query-gpu=compute_cap --format=csv,noheader,nounits |
            ForEach-Object { $_.Trim() } | Where-Object { $_ -match "^\d+\.\d+$" })
        if ($LASTEXITCODE -ne 0 -or $computeCaps.Count -eq 0) {
            throw "Unable to determine the NVIDIA GPU compute capability."
        }
        $cudaArchitectures = (($computeCaps | ForEach-Object { $_.Replace(".", "") } |
            Select-Object -Unique) -join ";")

        $nvcc = Get-NvccPath
        if (-not $nvcc) {
            Assert-FreeSpace -Path $env:SystemDrive -MinimumBytes 15GB -Purpose "the CUDA Toolkit"
            Install-WingetPackage -Id "Nvidia.CUDA" -Version $CudaInstallVersion -Force
            $nvcc = Get-NvccPath
        }
        if (-not $nvcc) {
            throw "CUDA Toolkit was installed but nvcc is not visible yet. A reboot may be required; then run again."
        }
        $cudaVersion = Get-CudaVersion -NvccPath $nvcc
        if ($cudaVersion -lt [version]"12.8") {
            if ($SkipInstall) {
                throw "CUDA Toolkit 12.8 or newer is required by this pinned runtime."
            }
            Install-WingetPackage -Id "Nvidia.CUDA" -Version $CudaInstallVersion -Force
            $nvcc = Get-NvccPath
            $cudaVersion = Get-CudaVersion -NvccPath $nvcc
            if ($cudaVersion -lt [version]"12.8") {
                throw "CUDA Toolkit 12.8 or newer is required by this pinned runtime."
            }
        }

        $cudaRuntime = Join-Path $env:CUDA_PATH "bin\x64\cublas64_13.dll"
        if (-not (Test-Path -LiteralPath $cudaRuntime -PathType Leaf)) {
            throw "CUDA $cudaVersion is missing its cuBLAS runtime: $cudaRuntime"
        }

        $hasBlackwell = @($computeCaps | Where-Object { [version]$_ -ge [version]"12.0" }).Count -gt 0
        $cmakeSupportsBlackwell = (
            ($cmakeVersion -ge [version]"3.31.8" -and $cmakeVersion -lt [version]"4.0.0") -or
            $cmakeVersion -ge [version]"4.0.2"
        )
        if ($hasBlackwell -and -not $cmakeSupportsBlackwell) {
            $portableCmake = Install-PortableCMake
            $cmake = Get-Command $portableCmake -ErrorAction Stop
        }
        $gpuSummary = @(& nvidia-smi.exe --query-gpu=name,memory.total,driver_version --format=csv,noheader)
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to query the NVIDIA GPU summary."
        }
        foreach ($gpuLine in $gpuSummary) {
            Write-Host "    GPU: $gpuLine"
        }
    } elseif (-not $CpuOnly) {
        Write-Warning "No NVIDIA GPU was detected. The real model will be built for CPU and will be very slow."
    }

    return [pscustomobject]@{
        Python = $python
        CMake = $cmake.Source
        UseCuda = $useCuda
        CudaArchitectures = $cudaArchitectures
        VisualStudioPath = $visualStudioPath
    }
}

function Ensure-PythonEnvironment {
    param([Parameter(Mandatory = $true)]$Environment)

    Write-Step "Creating the Python virtual environment and installing dependencies"
    $venvPython = Join-Path $VenvRoot "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        Invoke-Python -Python $Environment.Python -Arguments @("-m", "venv", $VenvRoot)
    }

    & $venvPython -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
    if ($LASTEXITCODE -ne 0) {
        throw ".venv uses an unsupported Python version. Remove .venv and run this launcher again."
    }

    Invoke-External -FilePath $venvPython -Arguments @(
        "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"
    )
    Invoke-External -FilePath $venvPython -Arguments @(
        "-m", "pip", "install", "-e", $ProjectRoot, "huggingface-hub>=0.30,<2"
    )
    return $venvPython
}

function Test-ModelFiles {
    param([switch]$VerifyHash)

    foreach ($model in $ModelFiles) {
        $path = Join-Path $ModelRoot $model.RelativePath
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $false
        }
        $item = Get-Item -LiteralPath $path
        if ($item.Length -ne $model.Size) {
            return $false
        }
        if ($VerifyHash) {
            Write-Host "Verifying $($model.RelativePath)..."
            $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $model.Sha256) {
                throw "SHA-256 mismatch for $($model.RelativePath). Delete that file and run again."
            }
        }
    }
    return $true
}

function Ensure-Models {
    param([Parameter(Mandatory = $true)][string]$VenvPython)

    Write-Step "Checking the pinned MiniCPM-o 4.5 GGUF files"
    $allPresent = Test-ModelFiles
    if (-not $allPresent) {
        if ($SkipModelDownload) {
            throw "Model files are missing or incomplete, and -SkipModelDownload was specified."
        }
        Assert-FreeSpace -Path $ProjectRoot -MinimumBytes 8GB -Purpose "the MiniCPM-o model files"
        New-Item -ItemType Directory -Path $ModelRoot -Force | Out-Null

        if ($HfToken) {
            $env:HF_TOKEN = $HfToken
        }
        $env:JARVIS_MODEL_DIR = $ModelRoot
        $env:JARVIS_MODEL_REVISION = $ModelRevision
        $downloadCode = @'
import os
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="openbmb/MiniCPM-o-4_5-gguf",
    revision=os.environ["JARVIS_MODEL_REVISION"],
    local_dir=os.environ["JARVIS_MODEL_DIR"],
    allow_patterns=[
        "MiniCPM-o-4_5-Q4_K_M.gguf",
        "vision/MiniCPM-o-4_5-vision-F16.gguf",
        "audio/MiniCPM-o-4_5-audio-F16.gguf",
    ],
)
'@
        # Windows PowerShell 5 can strip nested quotes from a multiline python -c
        # argument. A UTF-8 helper file keeps the Python source byte-for-byte intact.
        New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
        $downloadScriptPath = Join-Path $RuntimeRoot "download-models.py"
        [IO.File]::WriteAllText(
            $downloadScriptPath,
            $downloadCode,
            [Text.UTF8Encoding]::new($false)
        )
        Invoke-External -FilePath $VenvPython -Arguments @($downloadScriptPath)
    }

    if (-not (Test-ModelFiles -VerifyHash)) {
        throw "The required model set is incomplete."
    }
}

function Get-PatchedUpstreamSource {
    $vendorManifestPath = Join-Path $ProjectRoot "third_party\runtime\VENDOR.json"
    $vendorSource = Join-Path $ProjectRoot "third_party\runtime\vendor"
    $patchRoot = Join-Path $ProjectRoot "third_party\runtime\patches"
    $manifest = Get-Content -LiteralPath $vendorManifestPath -Raw | ConvertFrom-Json
    $patchFiles = @(Get-ChildItem -LiteralPath $patchRoot -Filter "*.patch" -File | Sort-Object Name)
    if ($patchFiles.Count -eq 0) {
        throw "No reviewed runtime patches were found."
    }

    $patchFingerprint = ($patchFiles | ForEach-Object {
        (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }) -join "-"
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $fingerprintBytes = [Text.Encoding]::UTF8.GetBytes($patchFingerprint)
        $shortFingerprint = ([BitConverter]::ToString($hasher.ComputeHash($fingerprintBytes))).Replace("-", "").Substring(0, 12).ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
    $cacheName = "$($manifest.upstream.revision.Substring(0, 12))-$shortFingerprint"
    $cacheRoot = Join-Path $RuntimeRoot "u\$cacheName"
    $readyMarker = Join-Path $cacheRoot ".jarvis-patches-applied"
    if (Test-Path -LiteralPath $readyMarker -PathType Leaf) {
        & "git.exe" -C $cacheRoot rev-parse --verify HEAD *>$null
        if ($LASTEXITCODE -ne 0) {
            Invoke-External -FilePath "git.exe" -Arguments @(
                "-c", "core.autocrlf=false", "-C", $cacheRoot, "add", "--all"
            )
            Invoke-External -FilePath "git.exe" -Arguments @(
                "-C", $cacheRoot,
                "-c", "user.name=AI Jarvis",
                "-c", "user.email=local@aijarvis.invalid",
                "commit", "--quiet", "-m", "Apply reviewed Jarvis runtime patches"
            )
        }
        return $cacheRoot
    }

    Write-Step "Preparing the checksum-pinned upstream runtime"
    if (Test-Path -LiteralPath $cacheRoot) {
        $resolvedRuntime = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\") + "\"
        $resolvedCache = [IO.Path]::GetFullPath($cacheRoot)
        if (-not $resolvedCache.StartsWith($resolvedRuntime, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace an upstream cache outside .runtime."
        }
        Remove-Item -LiteralPath $cacheRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $vendorSource -Force | Copy-Item -Destination $cacheRoot -Recurse -Force
    Invoke-External -FilePath "git.exe" -Arguments @("-C", $cacheRoot, "init", "--quiet")
    Invoke-External -FilePath "git.exe" -Arguments @(
        "-C", $cacheRoot, "config", "core.autocrlf", "false"
    )

    foreach ($patch in $patchFiles) {
        $manifestEntry = @($manifest.patches | Where-Object {
            $file = Get-OptionalPropertyValue -InputObject $_ -Name "file"
            $path = Get-OptionalPropertyValue -InputObject $_ -Name "path"
            $file -eq $patch.Name -or $path -eq $patch.Name -or $path -eq "patches/$($patch.Name)"
        }) | Select-Object -First 1
        $expectedPatchHash = if ($manifestEntry) {
            Get-OptionalPropertyValue -InputObject $manifestEntry -Name "sha256"
        } else { $null }
        if (-not $expectedPatchHash) {
            throw "Patch $($patch.Name) is not SHA-256 pinned in third_party/runtime/VENDOR.json."
        }
        $actualPatchHash = (Get-FileHash -LiteralPath $patch.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualPatchHash -ne ([string]$expectedPatchHash).ToLowerInvariant()) {
            throw "Patch checksum mismatch: $($patch.Name)"
        }
        Invoke-External -FilePath "git.exe" -Arguments @("-C", $cacheRoot, "apply", "--check", $patch.FullName)
        Invoke-External -FilePath "git.exe" -Arguments @("-C", $cacheRoot, "apply", $patch.FullName)
    }
    Invoke-External -FilePath "git.exe" -Arguments @(
        "-c", "core.autocrlf=false", "-C", $cacheRoot, "add", "--all"
    )
    Invoke-External -FilePath "git.exe" -Arguments @(
        "-C", $cacheRoot,
        "-c", "user.name=AI Jarvis",
        "-c", "user.email=local@aijarvis.invalid",
        "commit", "--quiet", "-m", "Apply reviewed Jarvis runtime patches"
    )
    Set-Content -LiteralPath $readyMarker -Value $patchFingerprint -Encoding ASCII
    return $cacheRoot
}

function Build-NativeWorker {
    param([Parameter(Mandatory = $true)]$Environment)

    Write-Step "Configuring a non-stub native worker"
    $upstreamSource = Get-PatchedUpstreamSource
    New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null

    $cudaCompiler = $null
    $cudaToolkitRoot = $null
    $generatorToolset = $null
    if ($Environment.UseCuda) {
        $cudaCompiler = Get-NvccPath
        if (-not $cudaCompiler) {
            throw "CUDA was selected, but nvcc.exe is no longer available."
        }
        $cudaToolkitRoot = Split-Path -Parent (Split-Path -Parent $cudaCompiler)
        $generatorToolset = "cuda=$cudaToolkitRoot"
    }

    $configureArguments = @(
        "-S", $ProjectRoot,
        "-B", $BuildRoot,
        "-G", "Visual Studio 17 2022",
        "-A", "x64"
    )
    if ($generatorToolset) {
        $configureArguments += @("-T", $generatorToolset)
    }
    $configureArguments += @(
        "-DJARVIS_ENABLE_STUB_RUNTIME=OFF",
        "-DJARVIS_RUNTIME_ENABLE_UPSTREAM=ON",
        "-DJARVIS_RUNTIME_UPSTREAM_SOURCE_DIR=$upstreamSource",
        "-DBUILD_TESTING=OFF",
        "-DLLAMA_BUILD_TESTS=OFF",
        "-DLLAMA_BUILD_EXAMPLES=OFF",
        "-DLLAMA_BUILD_SERVER=OFF",
        "-DLLAMA_BUILD_APP=OFF",
        "-DLLAMA_BUILD_COMMON=ON",
        "-DLLAMA_BUILD_TOOLS=ON"
    )
    if ($Environment.UseCuda) {
        $configureArguments += @(
            "-DGGML_CUDA=ON",
            "-DCMAKE_CUDA_ARCHITECTURES=$($Environment.CudaArchitectures)",
            "-DCMAKE_CUDA_COMPILER=$cudaCompiler",
            "-DCUDAToolkit_ROOT=$cudaToolkitRoot"
        )
    } else {
        $configureArguments += "-DGGML_CUDA=OFF"
    }
    $needsFreshConfigure = $Rebuild
    $cachePath = Join-Path $BuildRoot "CMakeCache.txt"
    if ($generatorToolset -and (Test-Path -LiteralPath $cachePath -PathType Leaf)) {
        $existingCache = Get-Content -LiteralPath $cachePath -Raw
        $expectedToolset = "CMAKE_GENERATOR_TOOLSET:INTERNAL=$generatorToolset"
        if ($existingCache -notmatch "(?m)^$([regex]::Escape($expectedToolset))\r?$") {
            Write-Warning "Refreshing the CMake cache to attach the installed CUDA Toolkit to Visual Studio."
            $needsFreshConfigure = $true
        }
    }
    if ($needsFreshConfigure) {
        $configureArguments = @("--fresh") + $configureArguments
    }
    Invoke-External -FilePath $Environment.CMake -Arguments $configureArguments

    $cache = Get-Content -LiteralPath $cachePath -Raw
    if ($cache -notmatch "JARVIS_ENABLE_STUB_RUNTIME:BOOL=OFF") {
        throw "CMake cache unexpectedly enables the stub runtime."
    }
    if ($cache -notmatch "JARVIS_RUNTIME_ENABLE_UPSTREAM:BOOL=ON") {
        throw "CMake cache does not enable the real upstream runtime."
    }

    Write-Step "Building the real native worker"
    Invoke-ExternalWithHeartbeat -FilePath $Environment.CMake -Activity "Native build" -Arguments @(
        "--build", $BuildRoot, "--config", "Release",
        "--target", "jarvis-native-worker", "--parallel", "4",
        "--", "/nologo", "/verbosity:quiet"
    )

    $worker = Get-ChildItem -LiteralPath $BuildRoot -Filter "jarvis-native-worker.exe" -File -Recurse |
        Where-Object { $_.FullName -match "[\\/]Release[\\/]" } |
        Select-Object -First 1
    if (-not $worker) {
        throw "The native worker build completed but jarvis-native-worker.exe was not found."
    }
    return $worker.FullName
}

function Convert-ToTomlPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return ([IO.Path]::GetFullPath($Path)).Replace("\", "/").Replace('"', '\"')
}

function Write-RealConfig {
    param([Parameter(Mandatory = $true)][string]$WorkerPath)

    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    $configPath = Join-Path $RuntimeRoot "real.toml"
    $escapedPipe = $PipeName.Replace("\", "\\")
    $config = @"
[app]
name = "AI Jarvis"
environment = "production"
log_level = "INFO"

[server]
host = "127.0.0.1"
port = 8000

[native]
mode = "process"
protocol_version = 1
pipe_name = "$escapedPipe"
worker_path = "$(Convert-ToTomlPath $WorkerPath)"
model_path = "$(Convert-ToTomlPath $ModelRoot)"
request_timeout_seconds = 120.0
heartbeat_interval_seconds = 10.0
max_frame_bytes = 8388608

[memory]
root = "$(Convert-ToTomlPath (Join-Path $ProjectRoot 'memory'))"

[interaction]
ordinary_bubble_cooldown_seconds = 60.0
course_bubble_cooldown_seconds = 90.0
game_barrage_repeat_seconds = 12.0
game_barrage_output_ratio = 0.667

[courses]
sessions_root = "$(Convert-ToTomlPath (Join-Path $ProjectRoot 'courses\sessions'))"
"@
    # Windows PowerShell 5.1 writes a BOM for -Encoding UTF8; tomllib rejects it.
    Set-Content -LiteralPath $configPath -Value $config -Encoding ASCII
    return $configPath
}

function Assert-RealInferenceSmokeTest {
    param([Parameter(Mandatory = $true)][string]$ApiRoot)

    Write-Step "Running a real-inference smoke test"
    $body = @{
        command = "ask"
        arguments = @{ text = "Respond with exactly JARVIS_REAL_READY" }
    } | ConvertTo-Json -Depth 4 -Compress
    $response = Invoke-RestMethod -Uri "$ApiRoot/commands" -Method Post `
        -ContentType "application/json" -Body $body -TimeoutSec 10
    if (-not $response.accepted) {
        throw "The native worker rejected the inference smoke test."
    }

    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        $events = @(
            Invoke-RestMethod -Uri "$ApiRoot/events?topic=answer.completed" -TimeoutSec 5
        ) | Where-Object { $null -ne $_ }
        $answer = $events | Where-Object {
            $payload = Get-OptionalPropertyValue -InputObject $_ -Name "payload"
            $text = if ($payload) {
                Get-OptionalPropertyValue -InputObject $payload -Name "text"
            } else { $null }
            -not [string]::IsNullOrWhiteSpace([string]$text)
        } | Select-Object -Last 1
        if ($answer) {
            $text = [string]$answer.payload.text
            if ($text -match "(?i)\[stub OmniRuntime\]|inference backend not linked|^runtime error:") {
                throw "The worker returned a stub/runtime-error response: $text"
            }
            if ($text -notmatch "(?i)JARVIS_REAL_READY") {
                throw "The model returned text but did not follow the smoke-test prompt. Text prefill is not working: $text"
            }
            $displayText = ($text -replace "\s+", " ").Trim()
            if ($displayText.Length -gt 160) {
                $displayText = $displayText.Substring(0, 160) + "..."
            }
            Write-Host "Real inference response: $displayText" -ForegroundColor Green
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "The real model did not produce a non-empty answer within 5 minutes."
}

function Quote-ProcessArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-Jarvis {
    param(
        [Parameter(Mandatory = $true)][string]$VenvPython,
        [Parameter(Mandatory = $true)][string]$WorkerPath,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    Write-Step "Starting the native worker and FastAPI control plane"
    if (Test-NamedPipePresent -FullName $PipeName) {
        throw "$PipeName already exists. Stop the existing Jarvis worker before starting another instance."
    }
    $portOwner = Get-ListeningPortOwner -Port 8000
    if ($portOwner) {
        throw "TCP port 8000 is already in use by process $portOwner."
    }

    Invoke-External -FilePath $VenvPython -Arguments @(
        "-c", "import tomllib; tomllib.load(open(r'$ConfigPath', 'rb'))"
    )
    $workerOutLog = Join-Path $RuntimeRoot "native-worker.out.log"
    $workerErrorLog = Join-Path $RuntimeRoot "native-worker.err.log"
    $nativeDependencyPath = Join-Path $BuildRoot "bin\Release"
    if (-not (Test-Path -LiteralPath $nativeDependencyPath -PathType Container)) {
        throw "Native dependency directory is missing: $nativeDependencyPath"
    }
    $env:Path = "$nativeDependencyPath;$env:Path"
    $workerArguments = @(
        (Quote-ProcessArgument $PipeName),
        (Quote-ProcessArgument ([IO.Path]::GetFullPath($ModelRoot)))
    )
    $workerProcess = Start-Process -FilePath $WorkerPath -ArgumentList $workerArguments `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $workerOutLog -RedirectStandardError $workerErrorLog

    $backendProcess = $null
    try {
        $deadline = [DateTime]::UtcNow.AddMinutes(10)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($workerProcess.HasExited) {
                $errorTail = if (Test-Path $workerErrorLog) {
                    (Get-Content -LiteralPath $workerErrorLog -Tail 40) -join "`n"
                } else { "No worker error log was produced." }
                throw "Native worker exited with code $($workerProcess.ExitCode).`n$errorTail"
            }
            if (Test-NamedPipePresent -FullName $PipeName) {
                break
            }
            Start-Sleep -Milliseconds 500
        }
        if (-not (Test-NamedPipePresent -FullName $PipeName)) {
            throw "The native worker did not create $PipeName within 10 minutes."
        }

        $env:JARVIS_CONFIG = $ConfigPath
        $backendExecutable = Join-Path $VenvRoot "Scripts\jarvis-backend.exe"
        if (-not (Test-Path -LiteralPath $backendExecutable -PathType Leaf)) {
            throw "jarvis-backend.exe is missing from the virtual environment."
        }
        $backendProcess = Start-Process -FilePath $backendExecutable -WorkingDirectory $ProjectRoot `
            -NoNewWindow -PassThru

        $healthUri = "http://127.0.0.1:8000/api/v1/health"
        $healthDeadline = [DateTime]::UtcNow.AddSeconds(180)
        $healthy = $false
        while ([DateTime]::UtcNow -lt $healthDeadline) {
            if ($backendProcess.HasExited) {
                throw "FastAPI exited with code $($backendProcess.ExitCode)."
            }
            try {
                $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 3
                if ($health.status -eq "ok" -and $health.native_connected) {
                    $healthy = $true
                    break
                }
            } catch {
                # The model and pipe may still be initializing.
            }
            Start-Sleep -Seconds 1
        }
        if (-not $healthy) {
            throw "FastAPI did not report a real native connection within 180 seconds."
        }

        $apiRoot = "http://127.0.0.1:8000/api/v1"
        if (-not $SkipSmokeTest) {
            Assert-RealInferenceSmokeTest -ApiRoot $apiRoot
        }

        Write-Host "`nAI Jarvis is running in real process mode: $healthUri" -ForegroundColor Green
        if (-not $NoBrowser) {
            Write-Host "Opening the Jarvis console: http://127.0.0.1:8000/" -ForegroundColor Green
        }
        Write-Host "Press Ctrl+C to stop both processes." -ForegroundColor Green
        if (-not $NoBrowser) {
            Start-Process "http://127.0.0.1:8000/"
        }
        $healthFailures = 0
        while (-not $backendProcess.HasExited -and -not $workerProcess.HasExited) {
            Start-Sleep -Seconds 2
            try {
                $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 3
                if ($health.status -eq "ok" -and $health.native_connected) {
                    $healthFailures = 0
                } else {
                    $healthFailures++
                }
            } catch {
                $healthFailures++
            }
            if ($healthFailures -ge 5) {
                throw "Jarvis lost its native connection or health endpoint."
            }
        }
        if ($workerProcess.HasExited) {
            throw "The native worker exited unexpectedly with code $($workerProcess.ExitCode)."
        }
        if ($backendProcess.ExitCode -ne 0) {
            throw "FastAPI exited unexpectedly with code $($backendProcess.ExitCode)."
        }
    } finally {
        if ($backendProcess -and -not $backendProcess.HasExited) {
            Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
        }
        if (-not $workerProcess.HasExited) {
            Stop-Process -Id $workerProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-Main {
    if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitOperatingSystem) {
        throw "This launcher requires 64-bit Windows."
    }
    if ($ProjectRoot -match "[^\x00-\x7F]") {
        throw "The current native worker cannot safely handle a non-ASCII project/model path. Move the repository to an ASCII-only path."
    }

    Set-Location -LiteralPath $ProjectRoot
    Refresh-ProcessEnvironment
    Write-Step "Enforcing the real-inference source gate"
    Assert-RealProviderSource

    Assert-FreeSpace -Path $ProjectRoot -MinimumBytes 12GB -Purpose "models and build artifacts"
    $environment = Ensure-Environment
    if (-not $environment.PSObject.Properties["Python"] -or
        -not $environment.PSObject.Properties["CMake"]) {
        throw "The environment check returned an invalid result. Rerun start-real.cmd; if this repeats, report the complete output."
    }
    $venvPython = Ensure-PythonEnvironment -Environment $environment
    Ensure-Models -VenvPython $venvPython
    $workerPath = Build-NativeWorker -Environment $environment
    $configPath = Write-RealConfig -WorkerPath $workerPath
    Start-Jarvis -VenvPython $venvPython -WorkerPath $workerPath -ConfigPath $configPath
}

try {
    Invoke-Main
} catch {
    Write-Host "`n[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
