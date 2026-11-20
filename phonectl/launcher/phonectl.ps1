#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('scrcpy', 'native')][string]$Mode = 'scrcpy',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ScrcpyArgs = @()
)

Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'AdbParse.psm1')

function Resolve-LauncherExecutable {
    param([string[]]$Candidates, [string]$Name)
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function New-LauncherProcess {
    param([string]$FilePath, [string[]]$Arguments, [switch]$CaptureOutput)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = [bool]$CaptureOutput
    $info.RedirectStandardOutput = [bool]$CaptureOutput
    $info.RedirectStandardError = [bool]$CaptureOutput
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw "Cannot start $FilePath" }
        return $process
    } catch {
        $process.Dispose()
        throw
    }
}

function Stop-LauncherProcess {
    param([System.Diagnostics.Process]$Process)
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            $Process.Kill()
            [void]$Process.WaitForExit(2000)
        }
    } finally { $Process.Dispose() }
}

function Invoke-LauncherProcess {
    param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 8, [switch]$CaptureOutput)
    $process = $null
    try {
        $process = New-LauncherProcess -FilePath $FilePath -Arguments $Arguments -CaptureOutput:$CaptureOutput
        if ($CaptureOutput) {
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
        }
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not $process.WaitForExit(100)) {
            if ($TimeoutSeconds -gt 0 -and $timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                return [pscustomobject]@{ ExitCode = 124; Output = ''; Error = 'Process timed out' }
            }
            # Return control to PowerShell so Ctrl+C can unwind the finally blocks.
            Start-Sleep -Milliseconds 20
        }
        $output = ''; $errorText = ''
        if ($CaptureOutput) { $output = $stdout.Result; $errorText = $stderr.Result }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $output; Error = $errorText }
    } finally { Stop-LauncherProcess $process }
}

function Invoke-Adb {
    param([string]$AdbPath, [string[]]$Arguments, [int]$TimeoutSeconds = 8)
    Invoke-LauncherProcess -FilePath $AdbPath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds -CaptureOutput
}

function Read-PhoneSerial {
    param([string]$ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return '' }
    try {
        $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not ($config.PSObject.Properties.Name -contains 'serial') -or
            -not ($config.serial -is [string]) -or [string]::IsNullOrWhiteSpace($config.serial)) {
            throw 'Expected a non-empty string property: serial'
        }
        return $config.serial.Trim()
    } catch { throw "Invalid config ${ConfigPath}: $($_.Exception.Message)" }
}

function Save-PhoneSerial {
    param([string]$ConfigPath, [string]$Serial)
    $directory = Split-Path -Parent $ConfigPath
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory)
    }
    @{ serial = $Serial } | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
}

function Get-ReachableAdbPhones {
    param([string]$AdbPath, [AllowEmptyString()][string]$Serial)
    $result = Invoke-Adb -AdbPath $AdbPath -Arguments @('devices')
    if ($result.ExitCode -ne 0) { return }
    $phones = @()
    foreach ($device in @(ConvertFrom-AdbDevices $result.Output)) {
        if ($device.State -ne 'device') { continue }
        $probe = Invoke-Adb -AdbPath $AdbPath -Arguments @('-s', $device.Id, 'shell', 'getprop', 'ro.serialno') -TimeoutSeconds 3
        $identity = $probe.Output.Trim()
        if ($probe.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($identity) -or $identity -match '\s') { continue }
        if ($Serial -and $identity -cne $Serial) { continue }
        $phone = [pscustomobject]@{ Id = $device.Id; Serial = $identity }
        if ($Serial) { return $phone }
        $phones += $phone
    }
    Get-UniqueAdbPhones -Phones $phones
}

function Wait-AdbPhones {
    param([string]$AdbPath, [AllowEmptyString()][string]$Serial, [int]$Seconds = 10)
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        $phones = @(Get-ReachableAdbPhones -AdbPath $AdbPath -Serial $Serial)
        if ($phones.Count -gt 0) { return $phones }
        if ($timer.Elapsed.TotalSeconds -ge $Seconds) { return }
        Start-Sleep -Milliseconds 1000
    } while ($true)
}

function Connect-AdbMdnsPhone {
    param([string]$AdbPath, [AllowEmptyString()][string]$Serial)
    $result = Invoke-Adb -AdbPath $AdbPath -Arguments @('mdns', 'services')
    if ($result.ExitCode -ne 0) { return }
    $services = @(ConvertFrom-AdbMdnsServices $result.Output)
    foreach ($service in @(Select-AdbMdnsCandidates -Services $services -Serial $Serial)) {
        Write-Host "Connecting to $($service.Address)..."
        $connection = Invoke-Adb -AdbPath $AdbPath -Arguments @('connect', $service.Address)
        if ($connection.ExitCode -ne 0) { Write-Host $connection.Error }
        $phones = @(Wait-AdbPhones -AdbPath $AdbPath -Serial $Serial -Seconds 2)
        if ($phones.Count -gt 0) { return $phones }
    }
}

function Select-LauncherPhone {
    param([object[]]$Phones, [string]$ConfigPath, [AllowEmptyString()][string]$Serial)
    if ($Serial) { return $Phones[0] }
    $index = 0
    if ($Phones.Count -gt 1) {
        for ($i = 0; $i -lt $Phones.Count; $i++) {
            Write-Host ("{0}. {1} ({2})" -f ($i + 1), $Phones[$i].Serial, $Phones[$i].Id)
        }
        $answer = Read-Host 'Select phone number (asked once)'
        $number = 0
        if (-not [int]::TryParse($answer, [ref]$number) -or $number -lt 1 -or $number -gt $Phones.Count) {
            throw 'Invalid phone selection. Run the launcher again to choose.'
        }
        $index = $number - 1
    }
    $phone = $Phones[$index]
    Save-PhoneSerial -ConfigPath $ConfigPath -Serial $phone.Serial
    return $phone
}

function Sync-NativeServer {
    param([string]$AdbPath, [string]$DeviceId, [string]$JarPath)
    $hash = (Get-FileHash -LiteralPath $JarPath -Algorithm SHA256).Hash
    $remote = Invoke-Adb -AdbPath $AdbPath -Arguments @('-s', $DeviceId, 'shell', 'sha256sum', '/data/local/tmp/server.jar')
    if ($remote.ExitCode -ne 0 -or (Test-AdbServerPushRequired -LocalHash $hash -RemoteOutput $remote.Output)) {
        $push = Invoke-Adb -AdbPath $AdbPath -Arguments @('-s', $DeviceId, 'push', $JarPath, '/data/local/tmp/server.jar') -TimeoutSeconds 60
        if ($push.ExitCode -ne 0) { throw "Push server.jar failed: $($push.Error) $($push.Output)" }
    }
    $forward = Invoke-Adb -AdbPath $AdbPath -Arguments @('-s', $DeviceId, 'forward', 'tcp:27183', 'localabstract:phonectl')
    if ($forward.ExitCode -ne 0) { throw "ADB forward failed: $($forward.Error) $($forward.Output)" }
}

function Start-NativeServer {
    param([string]$AdbPath, [string]$DeviceId)
    # Keep this adb shell alive for the entire native session; no remote '&'.
    New-LauncherProcess -FilePath $AdbPath -Arguments @('-s', $DeviceId, 'shell', 'CLASSPATH=/data/local/tmp/server.jar', 'app_process', '/', 'com.phonectl.Server')
}

function Invoke-NativeSession {
    param([string]$AdbPath, [string]$DeviceId, [string]$JarPath)
    $serverProcess = $null
    $forwarded = $false
    try {
        Sync-NativeServer -AdbPath $AdbPath -DeviceId $DeviceId -JarPath $JarPath
        $forwarded = $true
        $serverProcess = Start-NativeServer -AdbPath $AdbPath -DeviceId $DeviceId
        Write-Host 'Native server running on tcp:27183; client is not implemented. Ctrl+C to stop.'
        while (-not $serverProcess.WaitForExit(100)) { Start-Sleep -Milliseconds 100 }
        # A server exit always means a lost session, even when app_process returns 0.
        return 1
    } finally {
        Stop-LauncherProcess $serverProcess
        if ($forwarded) {
            $null = Invoke-Adb -AdbPath $AdbPath -Arguments @('-s', $DeviceId, 'forward', '--remove', 'tcp:27183')
        }
    }
}

function Invoke-PhoneCtl {
    param([string]$ProjectRoot, [string]$Mode, [string[]]$ScrcpyArgs)
    $jarPath = Join-Path $ProjectRoot 'server\build\server.jar'
    if ($Mode -eq 'native' -and -not (Test-Path -LiteralPath $jarPath -PathType Leaf)) {
        Write-Host 'server not built yet'
        return 1
    }
    $adbCandidates = @((Join-Path $ProjectRoot 'vendor\platform-tools\adb.exe'), 'E:\Android\Sdk\platform-tools\adb.exe')
    if ($env:ANDROID_HOME) { $adbCandidates += Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
    $adbPath = Resolve-LauncherExecutable -Candidates $adbCandidates -Name 'adb.exe'
    if (-not $adbPath) { throw 'adb.exe not found. Run tools\fetch-platform-tools.ps1 or add Android platform-tools to PATH.' }
    $scrcpyPath = $null
    if ($Mode -eq 'scrcpy') {
        $scrcpyPath = Resolve-LauncherExecutable -Candidates @((Join-Path $ProjectRoot 'vendor\scrcpy\scrcpy.exe')) -Name 'scrcpy.exe'
        if (-not $scrcpyPath) { Write-Host 'winget install Genymobile.scrcpy'; return 1 }
    }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
    $configPath = Join-Path $env:LOCALAPPDATA 'phonectl\config.json'
    $serial = Read-PhoneSerial $configPath
    $previousAdb = [Environment]::GetEnvironmentVariable('ADB', 'Process')
    try {
        $env:ADB = $adbPath
        $backoff = 2
        while ($true) {
            $started = Invoke-Adb -AdbPath $adbPath -Arguments @('start-server')
            $phones = @()
            if ($started.ExitCode -eq 0) {
                $phones = @(Wait-AdbPhones -AdbPath $adbPath -Serial $serial)
                if ($phones.Count -eq 0) { $phones = @(Connect-AdbMdnsPhone -AdbPath $adbPath -Serial $serial) }
            } else { Write-Host "adb start-server failed: $($started.Error)" }
            if ($phones.Count -gt 0) {
                $phone = Select-LauncherPhone -Phones $phones -ConfigPath $configPath -Serial $serial
                $serial = $phone.Serial
                Write-Host "Using $serial via $($phone.Id)"
                $sessionTimer = [System.Diagnostics.Stopwatch]::StartNew()
                if ($Mode -eq 'native') {
                    try { $code = Invoke-NativeSession -AdbPath $adbPath -DeviceId $phone.Id -JarPath $jarPath }
                    catch [System.Management.Automation.PipelineStoppedException] { throw }
                    catch { Write-Host "Native session failed: $($_.Exception.Message)"; $code = 1 }
                } else {
                    $session = Invoke-LauncherProcess -FilePath $scrcpyPath -Arguments (@('-s', $phone.Id, '-S', '-w') + $ScrcpyArgs) -TimeoutSeconds 0
                    $code = $session.ExitCode
                    if ($code -eq 0) { return 0 }
                }
                Write-Host "Session ended (code $code)."
                # A session that ran for a while was healthy: reconnect fast instead of using an old backoff.
                if ($sessionTimer.Elapsed.TotalSeconds -ge 60) { $backoff = 2 }
            } else { Write-Host 'Phone unavailable. Check Wireless debugging, pairing and Wi-Fi.' }
            Write-Host "Retrying in $backoff seconds (Ctrl+C to stop)..."
            Start-Sleep -Seconds $backoff
            $backoff = [Math]::Min(30, $backoff * 2)
        }
    } finally { [Environment]::SetEnvironmentVariable('ADB', $previousAdb, 'Process') }
}

# Dot-sourcing exposes helpers for fixture-based tests without starting ADB.
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    try {
        exit (Invoke-PhoneCtl -ProjectRoot (Split-Path -Parent $PSScriptRoot) -Mode $Mode -ScrcpyArgs $ScrcpyArgs)
    } catch [System.Management.Automation.PipelineStoppedException] {
        exit 0
    } catch {
        Write-Host "phonectl: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
