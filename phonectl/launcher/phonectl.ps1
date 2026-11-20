#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('scrcpy', 'native')][string]$Mode = 'scrcpy',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ScrcpyArgs = @()
)

Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'AdbParse.psm1') -Force
$script:LauncherLogPath = ''

function Write-LauncherLog {
    param([string]$Message, [string]$LogPath = $script:LauncherLogPath)
    if (-not $LogPath) { return }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $lines = @($Message -split '\r?\n' | Where-Object { $_ -ne '' } | ForEach-Object {
        '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $_
    })
    [System.IO.File]::AppendAllText($LogPath, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), $encoding)
    # Keep a single bounded file, including during a long-running scrcpy session.
    if ((Get-Item -LiteralPath $LogPath).Length -gt 1MB) {
        $bytes = [System.IO.File]::ReadAllBytes($LogPath)
        $start = $bytes.Length - 1MB
        while ($start -lt $bytes.Length -and $bytes[$start] -ne 10) { $start++ }
        $tail = $encoding.GetString($bytes, [Math]::Min($start + 1, $bytes.Length), [Math]::Max(0, $bytes.Length - $start - 1))
        [System.IO.File]::WriteAllText($LogPath, $tail, $encoding)
    }
}

function Write-LauncherMessage {
    param([string]$Message)
    Write-Host $Message
    Write-LauncherLog $Message
}

function Resolve-LauncherExecutable {
    param([string[]]$Candidates, [string]$Name)
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    # A console opened before `winget install` keeps a stale PATH: re-read the saved one.
    $savedPath = @('User', 'Machine') | ForEach-Object { [Environment]::GetEnvironmentVariable('Path', $_) }
    foreach ($dir in (($savedPath -join ';') -split ';')) {
        if (-not $dir) { continue }
        $candidate = Join-Path ([Environment]::ExpandEnvironmentVariables($dir)) $Name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function New-LauncherProcess {
    param([string]$FilePath, [string[]]$Arguments, [switch]$CaptureOutput, [switch]$RedirectInput)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = [bool]$CaptureOutput
    $info.RedirectStandardInput = [bool]$RedirectInput
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
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [int]$TimeoutSeconds = 8,
        [switch]$CaptureOutput,
        [switch]$LogOutput,
        [System.Diagnostics.Process]$CompanionProcess = $null
    )
    $process = $null
    try {
        $process = New-LauncherProcess -FilePath $FilePath -Arguments $Arguments -CaptureOutput:($CaptureOutput -or $LogOutput)
        if ($LogOutput) {
            $readers = @{ stdout = $process.StandardOutput; stderr = $process.StandardError }
            $pending = @{ stdout = $readers.stdout.ReadLineAsync(); stderr = $readers.stderr.ReadLineAsync() }
        } elseif ($CaptureOutput) {
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
        }
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        do {
            $exited = $process.WaitForExit(100)
            if ($LogOutput) {
                foreach ($stream in @('stdout', 'stderr')) {
                    if ($null -ne $pending[$stream] -and $pending[$stream].IsCompleted) {
                        $line = $pending[$stream].Result
                        if ($null -eq $line) { $pending[$stream] = $null }
                        else {
                            Write-LauncherMessage "scrcpy ${stream}: $line"
                            $pending[$stream] = $readers[$stream].ReadLineAsync()
                        }
                    }
                }
            }
            if (-not $exited -and $null -ne $CompanionProcess -and $CompanionProcess.HasExited) {
                $exited = $process.WaitForExit(300)
                if (-not $exited -or $CompanionProcess.ExitCode -ne 0) {
                    return [pscustomobject]@{ ExitCode = 1; Output = ''; Error = 'Companion process exited' }
                }
            }
            if (-not $exited -and $TimeoutSeconds -gt 0 -and $timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                return [pscustomobject]@{ ExitCode = 124; Output = ''; Error = 'Process timed out' }
            }
            # Return control to PowerShell so Ctrl+C can unwind the finally blocks.
            Start-Sleep -Milliseconds 20
        } while (-not $exited -or ($LogOutput -and ($null -ne $pending.stdout -or $null -ne $pending.stderr)))
        $output = ''; $errorText = ''
        if ($CaptureOutput -and -not $LogOutput) { $output = $stdout.Result; $errorText = $stderr.Result }
        $exitCode = $process.ExitCode
        if ($null -ne $CompanionProcess -and $CompanionProcess.HasExited -and $CompanionProcess.ExitCode -ne 0 -and $exitCode -eq 0) {
            $exitCode = 1
        }
        return [pscustomobject]@{ ExitCode = $exitCode; Output = $output; Error = $errorText }
    } finally { Stop-LauncherProcess $process }
}

function Invoke-Adb {
    param([string]$AdbPath, [string[]]$Arguments, [int]$TimeoutSeconds = 8)
    Invoke-LauncherProcess -FilePath $AdbPath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds -CaptureOutput
}

function Read-PhoneCtlConfig {
    param([string]$ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return (Merge-PhoneCtlConfig) }
    try {
        $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $config) { throw 'Expected a JSON object.' }
        return (Merge-PhoneCtlConfig -Config $config)
    } catch { throw "Invalid config ${ConfigPath}: $($_.Exception.Message)" }
}

function Read-PhoneSerial {
    param([string]$ConfigPath)
    $config = Read-PhoneCtlConfig $ConfigPath
    if (@($config.PSObject.Properties | Where-Object Name -eq 'serial').Count -gt 0) { return $config.serial }
    return ''
}

function Save-PhoneSerial {
    param([string]$ConfigPath, [string]$Serial)
    $directory = Split-Path -Parent $ConfigPath
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory)
    }
    $config = Merge-PhoneCtlConfig -Config (Read-PhoneCtlConfig $ConfigPath) -Serial $Serial
    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
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
        Write-LauncherMessage "Connecting to $($service.Address)..."
        $connection = Invoke-Adb -AdbPath $AdbPath -Arguments @('connect', $service.Address)
        if ($connection.ExitCode -ne 0) { Write-LauncherMessage $connection.Error }
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
        Write-LauncherMessage 'Native server running on tcp:27183; client is not implemented. Ctrl+C to stop.'
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

function Get-PhoneWlanAddress {
    param([string]$AdbPath, [string]$DeviceId)
    $result = Invoke-Adb -AdbPath $AdbPath -Arguments @('-s', $DeviceId, 'shell', 'ip', '-4', 'addr', 'show', 'wlan0') -TimeoutSeconds 5
    if ($result.ExitCode -ne 0) { throw "Cannot read phone wlan0 IPv4: $($result.Error) $($result.Output)" }
    $ip = ConvertFrom-AdbWlanAddress $result.Output
    if (-not $ip) { throw "No IPv4 address found on phone wlan0: $($result.Output.Trim())" }
    return $ip
}

function Get-LaptopLanAddress {
    param([string]$PhoneAddress)
    $target = $null
    if (-not [System.Net.IPAddress]::TryParse($PhoneAddress, [ref]$target) -or
        $target.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw "Invalid phone IPv4 address: $PhoneAddress"
    }
    $socket = New-Object System.Net.Sockets.Socket(
        [System.Net.Sockets.AddressFamily]::InterNetwork,
        [System.Net.Sockets.SocketType]::Dgram,
        [System.Net.Sockets.ProtocolType]::Udp
    )
    try {
        $socket.Connect((New-Object System.Net.IPEndPoint($target, 9)))
        $localIp = ([System.Net.IPEndPoint]$socket.LocalEndPoint).Address.ToString()
        if ([string]::IsNullOrWhiteSpace($localIp) -or $localIp -eq '0.0.0.0') {
            throw "Cannot determine laptop LAN IPv4 for $PhoneAddress"
        }
        return $localIp
    } finally {
        $socket.Dispose()
    }
}

function Get-RandomLanPort {
    $bytes = New-Object byte[] 4
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $value = [System.BitConverter]::ToUInt32($bytes, 0)
    return [int](20000 + ($value % 41000))
}

function New-LanSessionFilePath {
    $directory = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'phonectl' } else { [System.IO.Path]::GetTempPath() }
    [void][System.IO.Directory]::CreateDirectory($directory)
    return (Join-Path $directory ('session-' + [guid]::NewGuid().ToString('N')))
}

function Start-LanRelay {
    param([string]$RelayPath, [string]$PhoneAddress, [int]$PhonePort, [string]$LaptopAddress, [string]$SessionPath)
    $previousPeer = [Environment]::GetEnvironmentVariable('PHONECTL_PEER', 'Process')
    $process = $null
    try {
        [Environment]::SetEnvironmentVariable('PHONECTL_PEER', $LaptopAddress, 'Process')
        $process = New-LauncherProcess -FilePath $RelayPath -Arguments @() -CaptureOutput -RedirectInput
        $process.StandardInput.WriteLine($PhoneAddress)
        $process.StandardInput.WriteLine("$PhonePort")
        $process.StandardInput.WriteLine($SessionPath)
        $process.StandardInput.Flush()
        $readyTask = $process.StandardOutput.ReadLineAsync()
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not $readyTask.IsCompleted) {
            if ($process.WaitForExit(50) -and -not $readyTask.IsCompleted) { break }
            if ($timer.Elapsed.TotalSeconds -ge 10) { throw 'Timed out waiting for relay READY.' }
        }
        $line = if ($readyTask.IsCompleted) { $readyTask.Result } else { $null }
        $relayPort = ConvertFrom-RelayReadyLine $line
        if ($null -eq $relayPort) {
            $err = ''
            try { $err = $process.StandardError.ReadToEnd() } catch { }
            throw ("Relay failed to start: $line $err").Trim()
        }
        return [pscustomobject]@{ Process = $process; Port = $relayPort }
    } catch {
        Stop-LauncherProcess $process
        throw
    } finally {
        [Environment]::SetEnvironmentVariable('PHONECTL_PEER', $previousPeer, 'Process')
    }
}

function Stop-LanRelay {
    param($Relay)
    if ($null -eq $Relay) { return }
    $process = if ($Relay -is [System.Diagnostics.Process]) { $Relay } else { $Relay.Process }
    if ($null -eq $process) { return }
    try {
        if (-not $process.HasExited) {
            try { $process.StandardInput.Close() } catch { }
            [void]$process.WaitForExit(1000)
        }
    } finally {
        Stop-LauncherProcess $process
    }
}

function Resolve-PhoneCtlScrcpyTransport {
    param([string]$ProjectRoot, [string]$ScrcpyPath, [string]$Transport = 'lan')
    if ($Transport -eq 'adb') { return 'adb' }
    $serverPath = Join-Path $ProjectRoot 'server\build\scrcpy-server'
    if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        Write-LauncherMessage "WARNING: $serverPath not found; using stock scrcpy server over ADB."
        return 'adb'
    }
    $versionResult = Invoke-LauncherProcess -FilePath $ScrcpyPath -Arguments @('--version') -TimeoutSeconds 5 -CaptureOutput
    if ($versionResult.ExitCode -ne 0 -or -not (Test-ScrcpyForkCompatible $versionResult.Output)) {
        $version = ConvertFrom-ScrcpyVersion $versionResult.Output
        $reported = if ($version) { $version } else { 'unknown' }
        Write-LauncherMessage "WARNING: scrcpy version is $reported (expected 5.0.1); using stock scrcpy server over ADB."
        return 'adb'
    }
    return 'lan'
}

function Invoke-LanScrcpySession {
    param(
        [string]$ProjectRoot,
        [string]$AdbPath,
        [string]$ScrcpyPath,
        [string]$DeviceId,
        [string]$WindowTitle,
        [string[]]$ScrcpyArgs = @()
    )
    $serverPath = Join-Path $ProjectRoot 'server\build\scrcpy-server'
    $relayPath = Join-Path $ProjectRoot 'relay\build\phonectl-relay.exe'
    $phoneIp = Get-PhoneWlanAddress -AdbPath $AdbPath -DeviceId $DeviceId
    $laptopIp = Get-LaptopLanAddress -PhoneAddress $phoneIp
    $phonePort = Get-RandomLanPort
    $sessionPath = New-LanSessionFilePath
    $relay = $null
    $previousServerPath = [Environment]::GetEnvironmentVariable('SCRCPY_SERVER_PATH', 'Process')
    try {
        try {
            $relay = Start-LanRelay -RelayPath $relayPath -PhoneAddress $phoneIp -PhonePort $phonePort -LaptopAddress $laptopIp -SessionPath $sessionPath
            $push = Invoke-Adb -AdbPath $AdbPath -Arguments @('-s', $DeviceId, 'push', $sessionPath, '/data/local/tmp/phonectl-session') -TimeoutSeconds 15
            if ($push.ExitCode -ne 0) { throw "Push phonectl-session failed: $($push.Error) $($push.Output)" }
            $chmod = Invoke-Adb -AdbPath $AdbPath -Arguments @('-s', $DeviceId, 'shell', 'chmod', '600', '/data/local/tmp/phonectl-session') -TimeoutSeconds 5
            if ($chmod.ExitCode -ne 0) { throw "chmod phonectl-session failed: $($chmod.Error) $($chmod.Output)" }
        } finally {
            if ($sessionPath -and (Test-Path -LiteralPath $sessionPath -PathType Leaf)) {
                Remove-Item -LiteralPath $sessionPath -Force -ErrorAction SilentlyContinue
            }
        }
        [Environment]::SetEnvironmentVariable('SCRCPY_SERVER_PATH', $serverPath, 'Process')
        $arguments = @(
            '-s', $DeviceId, '-S', '-w', '--window-title', $WindowTitle,
            '--force-adb-forward', '--tunnel-host=127.0.0.1', "--tunnel-port=$($relay.Port)"
        ) + $ScrcpyArgs
        if ($relay.Process -is [System.Diagnostics.Process]) {
            $session = Invoke-LauncherProcess -FilePath $ScrcpyPath -Arguments $arguments -TimeoutSeconds 0 -LogOutput -CompanionProcess $relay.Process
        } else {
            $session = Invoke-LauncherProcess -FilePath $ScrcpyPath -Arguments $arguments -TimeoutSeconds 0 -LogOutput
        }
        return $session.ExitCode
    } finally {
        [Environment]::SetEnvironmentVariable('SCRCPY_SERVER_PATH', $previousServerPath, 'Process')
        Stop-LanRelay $relay
    }
}

function Invoke-PhoneCtl {
    param([string]$ProjectRoot, [string]$Mode, [string[]]$ScrcpyArgs)
    $jarPath = Join-Path $ProjectRoot 'server\build\server.jar'
    if ($Mode -eq 'native' -and -not (Test-Path -LiteralPath $jarPath -PathType Leaf)) {
        Write-LauncherMessage 'server not built yet'
        return 1
    }
    $adbCandidates = @((Join-Path $ProjectRoot 'vendor\platform-tools\adb.exe'), 'E:\Android\Sdk\platform-tools\adb.exe')
    if ($env:ANDROID_HOME) { $adbCandidates += Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
    $adbPath = Resolve-LauncherExecutable -Candidates $adbCandidates -Name 'adb.exe'
    if (-not $adbPath) { throw 'adb.exe not found. Run tools\fetch-platform-tools.ps1 or add Android platform-tools to PATH.' }
    $scrcpyPath = $null
    if ($Mode -eq 'scrcpy') {
        $scrcpyPath = Resolve-LauncherExecutable -Candidates @((Join-Path $ProjectRoot 'vendor\scrcpy\scrcpy.exe')) -Name 'scrcpy.exe'
        if (-not $scrcpyPath) { Write-LauncherMessage 'winget install Genymobile.scrcpy'; return 1 }
    }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
    $configPath = Join-Path $env:LOCALAPPDATA 'phonectl\config.json'
    $config = Read-PhoneCtlConfig $configPath
    $serial = ''
    if (@($config.PSObject.Properties | Where-Object Name -eq 'serial').Count -gt 0) { $serial = $config.serial }
    $transport = Get-PhoneCtlTransport -Config $config
    $ScrcpyArgs = @(Merge-PhoneCtlScrcpyArgs -Config $config -ScrcpyArgs $ScrcpyArgs)
    if ($Mode -eq 'scrcpy') {
        $transport = Resolve-PhoneCtlScrcpyTransport -ProjectRoot $ProjectRoot -ScrcpyPath $scrcpyPath -Transport $transport
    }
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
            } else { Write-LauncherMessage "adb start-server failed: $($started.Error) $($started.Output)" }
            if ($phones.Count -gt 0) {
                $phone = Select-LauncherPhone -Phones $phones -ConfigPath $configPath -Serial $serial
                $serial = $phone.Serial
                Write-LauncherMessage "Using $serial via $($phone.Id)"
                $sessionTimer = [System.Diagnostics.Stopwatch]::StartNew()
                if ($Mode -eq 'native') {
                    try { $code = Invoke-NativeSession -AdbPath $adbPath -DeviceId $phone.Id -JarPath $jarPath }
                    catch [System.Management.Automation.PipelineStoppedException] { throw }
                    catch { Write-LauncherMessage "Native session failed: $($_.Exception.Message)"; $code = 1 }
                } else {
                    $model = Invoke-Adb -AdbPath $adbPath -Arguments @('-s', $phone.Id, 'shell', 'getprop', 'ro.product.model') -TimeoutSeconds 3
                    $title = $model.Output.Trim()
                    if ($model.ExitCode -ne 0 -or -not $title) { $title = $serial }
                    Write-LauncherMessage "Starting scrcpy ($title)."
                    if ($transport -eq 'lan') {
                        try {
                            $code = Invoke-LanScrcpySession -ProjectRoot $ProjectRoot -AdbPath $adbPath -ScrcpyPath $scrcpyPath -DeviceId $phone.Id -WindowTitle $title -ScrcpyArgs $ScrcpyArgs
                        } catch [System.Management.Automation.PipelineStoppedException] {
                            throw
                        } catch {
                            Write-LauncherMessage "LAN session failed: $($_.Exception.Message)"
                            $code = 1
                        }
                    } else {
                        $session = Invoke-LauncherProcess -FilePath $scrcpyPath -Arguments (@('-s', $phone.Id, '-S', '-w', '--window-title', $title) + $ScrcpyArgs) -TimeoutSeconds 0 -LogOutput
                        $code = $session.ExitCode
                    }
                    if ($code -eq 0) { Write-LauncherMessage 'scrcpy closed normally.'; return 0 }
                }
                Write-LauncherMessage "Session ended (code $code)."
                # A session that ran for a while was healthy: reconnect fast instead of using an old backoff.
                if ($sessionTimer.Elapsed.TotalSeconds -ge 60) { $backoff = 2 }
            } else { Write-LauncherMessage 'Phone unavailable. Check Wireless debugging, pairing and Wi-Fi.' }
            Write-LauncherMessage "Retrying in $backoff seconds (Ctrl+C to stop)..."
            Start-Sleep -Seconds $backoff
            $backoff = [Math]::Min(30, $backoff * 2)
        }
    } finally { [Environment]::SetEnvironmentVariable('ADB', $previousAdb, 'Process') }
}

function Invoke-PhoneCtlLauncher {
    param([string]$ProjectRoot, [string]$Mode, [string[]]$ScrcpyArgs)
    $mutex = $null
    $owned = $false
    try {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $mutexName = if ($env:PHONECTL_MUTEX) { $env:PHONECTL_MUTEX } else { "Local\phonectl-$sid" }
        $mutex = New-Object System.Threading.Mutex($false, $mutexName)
        try { $owned = $mutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { Write-Host 'phonectl already running'; return 0 }
        if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
        $directory = Join-Path $env:LOCALAPPDATA 'phonectl'
        [void][System.IO.Directory]::CreateDirectory($directory)
        $script:LauncherLogPath = Join-Path $directory 'launcher.log'
        Write-LauncherMessage 'Launcher started.'
        return (Invoke-PhoneCtl -ProjectRoot $ProjectRoot -Mode $Mode -ScrcpyArgs $ScrcpyArgs)
    } catch [System.Management.Automation.PipelineStoppedException] {
        throw
    } catch {
        Write-LauncherLog "ERROR: $($_.Exception.Message)"
        throw
    } finally {
        $script:LauncherLogPath = ''
        if ($owned) { $mutex.ReleaseMutex() }
        if ($null -ne $mutex) { $mutex.Dispose() }
    }
}

# Dot-sourcing exposes helpers for fixture-based tests without starting ADB.
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    try {
        exit (Invoke-PhoneCtlLauncher -ProjectRoot (Split-Path -Parent $PSScriptRoot) -Mode $Mode -ScrcpyArgs $ScrcpyArgs)
    } catch [System.Management.Automation.PipelineStoppedException] {
        exit 0
    } catch {
        Write-Host "phonectl: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
