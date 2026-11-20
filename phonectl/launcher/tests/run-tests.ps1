#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'phonectl.ps1')
$fixtures = Join-Path $PSScriptRoot 'fixtures'
$script:passed = 0
$script:failed = 0

function Assert-Equal {
    param($Actual, $Expected, [string]$Message = 'Values differ')
    if ($Actual -cne $Expected) { throw "$Message`: expected [$Expected], got [$Actual]" }
}
function Assert-True {
    param([bool]$Condition, [string]$Message = 'Expected true')
    if (-not $Condition) { throw $Message }
}
function Test-Case {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:passed++
        Write-Host "PASS $Name"
    } catch {
        $script:failed++
        Write-Host "FAIL $Name`: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host $_.ScriptStackTrace
    }
}
function New-AdbResult {
    param([string]$Output = '', [int]$ExitCode = 0, [string]$ErrorText = '')
    [pscustomobject]@{ Output = $Output; ExitCode = $ExitCode; Error = $ErrorText }
}

Test-Case 'devices: whitespace, long rows, daemon noise and states' {
    $rows = @(ConvertFrom-AdbDevices (Get-Content (Join-Path $fixtures 'devices.txt') -Raw))
    Assert-Equal $rows.Count 6
    Assert-Equal $rows[0].State 'device'
    Assert-Equal $rows[1].Id '192.168.1.42:37123'
    Assert-Equal $rows[3].State 'offline'
    Assert-Equal $rows[4].State 'unauthorized'
    Assert-Equal $rows[5].State 'recovery'
    Assert-Equal @(ConvertFrom-AdbDevices '').Count 0
}

Test-Case 'mdns: tabs, spaces, dots, IPv6, deduplication, pairing exclusion' {
    $services = @(ConvertFrom-AdbMdnsServices (Get-Content (Join-Path $fixtures 'mdns.txt') -Raw))
    Assert-Equal $services.Count 4
    Assert-Equal $services[0].Serial 'PHONE123'
    Assert-Equal $services[1].Name 'adb-PHONE123-next'
    Assert-Equal $services[3].Address '[fe80::1%12]:38123'
    Assert-Equal @(ConvertFrom-AdbMdnsServices '').Count 0
    $hyphenated = @(ConvertFrom-AdbMdnsServices 'adb-phone-with-dash-random _adb-tls-connect._tcp. 10.0.0.1:1234')
    Assert-Equal $hyphenated[0].Serial 'phone-with-dash'
}

Test-Case 'mdns: configured serial, single fallback and ambiguous services' {
    $services = @(ConvertFrom-AdbMdnsServices (Get-Content (Join-Path $fixtures 'mdns.txt') -Raw))
    Assert-Equal @(Select-AdbMdnsCandidates $services 'PHONE123').Count 2
    Assert-Equal @(Select-AdbMdnsCandidates $services 'missing').Count 0
    Assert-Equal @(Select-AdbMdnsCandidates $services '').Count 0
    Assert-Equal @(Select-AdbMdnsCandidates @($services[0]) 'missing').Count 1
    Assert-Equal @(Select-AdbMdnsCandidates @() '').Count 0
    Assert-Equal @(Select-AdbMdnsCandidates $services 'phone123').Count 0
}

Test-Case 'phone identity: duplicate transports collapse, serial is case-sensitive' {
    $phones = @(
        [pscustomobject]@{ Id = 'mdns'; Serial = 'PHONE' },
        [pscustomobject]@{ Id = 'ip'; Serial = 'PHONE' },
        [pscustomobject]@{ Id = 'other'; Serial = 'phone' }
    )
    $unique = @(Get-UniqueAdbPhones $phones)
    Assert-Equal $unique.Count 2
    Assert-Equal $unique[0].Id 'mdns'
}

Test-Case 'hash: matching hash skips push; missing, bad or changed hash pushes' {
    $remote = Get-Content (Join-Path $fixtures 'sha256.txt') -Raw
    Assert-Equal (Test-AdbServerPushRequired ('A' * 64) $remote) $false
    Assert-Equal (Test-AdbServerPushRequired ('b' * 64) $remote) $true
    Assert-Equal (Test-AdbServerPushRequired ('a' * 64) '') $true
    Assert-Equal (Test-AdbServerPushRequired ('a' * 64) 'sha256sum: not found') $true
}

Test-Case 'Windows argument quoting preserves spaces, quotes and trailing slashes' {
    Assert-Equal (ConvertTo-WindowsCommandLineArgument '') '""'
    Assert-Equal (ConvertTo-WindowsCommandLineArgument 'simple') 'simple'
    Assert-Equal (ConvertTo-WindowsCommandLineArgument 'two words') '"two words"'
    Assert-Equal (ConvertTo-WindowsCommandLineArgument 'C:\two words\') '"C:\two words\\"'
    Assert-Equal (ConvertTo-WindowsCommandLineArgument 'a"b') '"a\"b"'
    Assert-Equal (ConvertTo-WindowsCommandLineArgument 'a\"b') '"a\\\"b"'
}

Test-Case 'executable resolution: ordered candidates then PATH' {
    $state = @{ PathLookups = 0 }
    function Test-Path { param($LiteralPath, $PathType); $LiteralPath -in @('vendor', 'sdk') }
    function Get-Item { param($LiteralPath); [pscustomobject]@{ FullName = "resolved:$LiteralPath" } }
    function Get-Command {
        param($Name, $CommandType, $ErrorAction)
        $state.PathLookups++
        [pscustomobject]@{ Source = 'path:adb.exe' }
    }
    Assert-Equal (Resolve-LauncherExecutable @('vendor', 'sdk') 'adb.exe') 'resolved:vendor'
    Assert-Equal (Resolve-LauncherExecutable @('missing', 'sdk') 'adb.exe') 'resolved:sdk'
    Assert-Equal $state.PathLookups 0
    Assert-Equal (Resolve-LauncherExecutable @('missing') 'adb.exe') 'path:adb.exe'
}

Test-Case 'probe: failed mDNS alias falls back to answering IP; ignores unavailable states' {
    $state = @{ Probes = New-Object System.Collections.Generic.List[string] }
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        if ($Arguments[0] -eq 'devices') { return New-AdbResult (Get-Content (Join-Path $fixtures 'devices.txt') -Raw) }
        $state.Probes.Add($Arguments[1])
        Assert-Equal $TimeoutSeconds 3
        if ($Arguments[1] -like 'adb-*') { return New-AdbResult '' 124 }
        if ($Arguments[1] -eq 'USB456') { return New-AdbResult "USB456`n" }
        return New-AdbResult "PHONE123`r`n"
    }
    $phones = @(Get-ReachableAdbPhones 'fake-adb' 'PHONE123')
    Assert-Equal $phones.Count 1
    Assert-Equal $phones[0].Id '192.168.1.42:37123'
    Assert-Equal $state.Probes.Count 2
    $phones = @(Get-ReachableAdbPhones 'fake-adb' '')
    Assert-Equal $phones.Count 2
    Assert-Equal ($state.Probes -contains 'LOCKED123') $false
    Assert-Equal ($state.Probes -contains '192.168.1.43:40000') $false
}

Test-Case 'probe: responding duplicate aliases prompt for only one physical phone' {
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        if ($Arguments[0] -eq 'devices') { return New-AdbResult "alias device`nip:1234 device`n" }
        New-AdbResult 'PHONE123'
    }
    $phones = @(Get-ReachableAdbPhones 'fake' '')
    Assert-Equal $phones.Count 1
    Assert-Equal $phones[0].Serial 'PHONE123'
}

Test-Case 'probe: never select wrong serial, empty identity or failed devices command' {
    $state = @{ FailDevices = $false }
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        if ($Arguments[0] -eq 'devices') {
            if ($state.FailDevices) { return New-AdbResult '' 1 }
            return New-AdbResult "wrong device`nempty device`n"
        }
        if ($Arguments[1] -eq 'empty') { return New-AdbResult '' }
        New-AdbResult 'OTHER'
    }
    Assert-Equal @(Get-ReachableAdbPhones 'fake' 'PHONE123').Count 0
    $state.FailDevices = $true
    Assert-Equal @(Get-ReachableAdbPhones 'fake' '').Count 0
}

Test-Case 'mdns connect: try matching endpoints until one answers then re-check identity' {
    $state = @{ Connected = New-Object System.Collections.Generic.List[string] }
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        if ($Arguments[0] -eq 'mdns') { return New-AdbResult (Get-Content (Join-Path $fixtures 'mdns.txt') -Raw) }
        Assert-Equal $Arguments[0] 'connect'
        $state.Connected.Add($Arguments[1])
        New-AdbResult 'connected'
    }
    function Wait-AdbPhones {
        param($AdbPath, $Serial, $Seconds)
        Assert-Equal $Serial 'PHONE123'
        if ($state.Connected.Count -eq 2) { [pscustomobject]@{ Id = 'answer'; Serial = $Serial } }
    }
    $phones = @(Connect-AdbMdnsPhone 'fake' 'PHONE123')
    Assert-Equal $state.Connected.Count 2
    Assert-Equal $state.Connected[0] '192.168.1.42:37123'
    Assert-Equal $state.Connected[1] '192.168.1.42:37124'
    Assert-Equal $phones[0].Serial 'PHONE123'
}

Test-Case 'selection: auto-save one phone, ask once for many, honor existing config' {
    $state = @{ Prompts = 0; Saved = '' }
    function Read-Host { param($Prompt); $state.Prompts++; '2' }
    function Save-PhoneSerial { param($ConfigPath, $Serial); $state.Saved = $Serial }
    $first = [pscustomobject]@{ Id = 'a'; Serial = 'FIRST' }
    $second = [pscustomobject]@{ Id = 'b'; Serial = 'SECOND' }
    Assert-Equal (Select-LauncherPhone @($first) 'unused' '').Serial 'FIRST'
    Assert-Equal $state.Saved 'FIRST'
    Assert-Equal $state.Prompts 0
    Assert-Equal (Select-LauncherPhone @($first, $second) 'unused' '').Serial 'SECOND'
    Assert-Equal $state.Saved 'SECOND'
    Assert-Equal $state.Prompts 1
    Assert-Equal (Select-LauncherPhone @($second) 'unused' 'SECOND').Serial 'SECOND'
    Assert-Equal $state.Prompts 1
}

Test-Case 'selection: invalid choice fails after one prompt without saving' {
    $state = @{ Prompts = 0; Saved = $false }
    function Read-Host { param($Prompt); $state.Prompts++; 'bad' }
    function Save-PhoneSerial { param($ConfigPath, $Serial); $state.Saved = $true }
    $phone = [pscustomobject]@{ Id = 'a'; Serial = 'FIRST' }
    $threw = $false
    try { $null = Select-LauncherPhone @($phone, $phone) 'unused' '' } catch { $threw = $true }
    Assert-True $threw
    Assert-Equal $state.Prompts 1
    Assert-Equal $state.Saved $false
}

Test-Case 'native sync: push only on changed/missing hash and always forward' {
    $state = @{ Remote = Get-Content (Join-Path $fixtures 'sha256.txt') -Raw; Code = 0; Calls = New-Object System.Collections.Generic.List[string] }
    function Get-FileHash { param($LiteralPath, $Algorithm); [pscustomobject]@{ Hash = 'A' * 64 } }
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        $state.Calls.Add(($Arguments -join ' '))
        if ($Arguments[2] -eq 'shell') { return New-AdbResult $state.Remote $state.Code }
        New-AdbResult
    }
    Sync-NativeServer 'fake' 'transport' 'server.jar'
    Assert-Equal $state.Calls.Count 2
    Assert-Equal $state.Calls[1] '-s transport forward tcp:27183 localabstract:phonectl'
    $state.Remote = 'missing'; $state.Code = 1; $state.Calls.Clear()
    Sync-NativeServer 'fake' 'transport' 'server.jar'
    Assert-Equal $state.Calls.Count 3
    Assert-Equal $state.Calls[1] '-s transport push server.jar /data/local/tmp/server.jar'
    $state.Remote = ('b' * 64) + '  /data/local/tmp/server.jar'; $state.Code = 0; $state.Calls.Clear()
    Sync-NativeServer 'fake' 'transport' 'server.jar'
    Assert-Equal $state.Calls.Count 3
}

Test-Case 'native sync: push failure stops before forward' {
    $state = @{ Calls = 0 }
    function Get-FileHash { param($LiteralPath, $Algorithm); [pscustomobject]@{ Hash = 'A' * 64 } }
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        $state.Calls++
        New-AdbResult '' 1 'mock failure'
    }
    $message = ''
    try { Sync-NativeServer 'fake' 'transport' 'server.jar' } catch { $message = $_.Exception.Message }
    Assert-True ($message -like 'Push server.jar failed:*mock failure*')
    Assert-Equal $state.Calls 2
}

Test-Case 'native start: foreground app_process command is retained' {
    function New-LauncherProcess {
        param($FilePath, $Arguments)
        Assert-Equal $FilePath 'fake-adb'
        Assert-Equal ($Arguments -join ' ') '-s transport shell CLASSPATH=/data/local/tmp/server.jar app_process / com.phonectl.Server'
        'kept-process'
    }
    Assert-Equal (Start-NativeServer 'fake-adb' 'transport') 'kept-process'
}

Test-Case 'native cleanup: failed sync does not remove an unowned forward' {
    $state = @{ Removed = $false }
    function Sync-NativeServer { throw 'mock sync failed' }
    function Invoke-Adb { param($AdbPath, $Arguments); $state.Removed = $true; New-AdbResult }
    $message = ''
    try { $null = Invoke-NativeSession 'fake' 'transport' 'server.jar' } catch { $message = $_.Exception.Message }
    Assert-Equal $message 'mock sync failed'
    Assert-Equal $state.Removed $false
}

Test-Case 'config: missing, valid and malformed input without filesystem writes' {
    $state = @{ Exists = $false; Content = '{"serial":"PHONE123"}' }
    function Test-Path { param($LiteralPath); $state.Exists }
    function Get-Content { param($LiteralPath, [switch]$Raw, $Encoding); $state.Content }
    Assert-Equal (Read-PhoneSerial 'unused') ''
    $state.Exists = $true
    Assert-Equal (Read-PhoneSerial 'unused') 'PHONE123'
    foreach ($bad in @('{bad', '{}', '{"serial":1}', '{"serial":" "}', 'null')) {
        $state.Content = $bad
        $message = ''
        try { $null = Read-PhoneSerial 'unused' } catch { $message = $_.Exception.Message }
        Assert-True ($message -like 'Invalid config unused:*') "Bad config was accepted: $bad"
    }
}

Test-Case 'SDK copy: required adb and all DLLs copied with relative directories; no downloads' {
    $state = @{ Copies = New-Object System.Collections.Generic.List[object] }
    $fetchScript = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'tools\fetch-platform-tools.ps1'
    function Test-Path { param($LiteralPath, $PathType); $true }
    function Get-Item { param($LiteralPath); [pscustomobject]@{ FullName = 'C:\mock-sdk\platform-tools' } }
    function New-Item { param($ItemType, $Path) }
    function Get-ChildItem {
        param($LiteralPath, $Filter, [switch]$File, [switch]$Recurse)
        foreach ($relative in @('AdbWinApi.dll', 'AdbWinUsbApi.dll', 'runtime.dll', 'lib\nested.dll')) {
            [pscustomobject]@{ FullName = "C:\mock-sdk\platform-tools\$relative" }
        }
    }
    function Copy-Item {
        param($LiteralPath, $Destination)
        $state.Copies.Add([pscustomobject]@{ Source = $LiteralPath; Target = $Destination })
    }
    & $fetchScript -SdkPath 'C:\mock-sdk'
    Assert-Equal $state.Copies.Count 5
    Assert-Equal $state.Copies[0].Source 'C:\mock-sdk\platform-tools\adb.exe'
    Assert-True ($state.Copies[0].Target.EndsWith('\phonectl\vendor\platform-tools'))
    Assert-True ($state.Copies[4].Target.EndsWith('\vendor\platform-tools\lib\nested.dll'))
}

Test-Case 'SDK copy: incomplete SDK fails before creating destination' {
    $fetchScript = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'tools\fetch-platform-tools.ps1'
    function Test-Path { param($LiteralPath, $PathType); -not $LiteralPath.EndsWith('AdbWinUsbApi.dll') }
    function Get-Item { param($LiteralPath); [pscustomobject]@{ FullName = 'C:\mock-sdk\platform-tools' } }
    function New-Item { throw 'Must validate SDK before creating destination' }
    function Copy-Item { throw 'Must not copy an incomplete SDK' }
    $message = ''
    try { & $fetchScript -SdkPath 'C:\mock-sdk' } catch { $message = $_.Exception.Message }
    Assert-True ($message -like 'Incomplete SDK platform-tools: missing AdbWinUsbApi.dll*')
}

Test-Case 'native stub: missing jar exits without looking up ADB or starting processes' {
    function Test-Path { param($LiteralPath, $PathType); $false }
    function Resolve-LauncherExecutable { throw 'Must not resolve tools when server is missing' }
    Assert-Equal (Invoke-PhoneCtl 'unused' 'native' @()) 1
}

Test-Case 'missing scrcpy exits without starting ADB' {
    function Resolve-LauncherExecutable {
        param($Candidates, $Name)
        if ($Name -eq 'adb.exe') { 'fake-adb' }
    }
    function Invoke-Adb { throw 'Must not start ADB without scrcpy' }
    Assert-Equal (Invoke-PhoneCtl 'unused' 'scrcpy' @()) 1
}

Test-Case 'flow: same ADB environment, scrcpy args, nonzero retries and capped backoff' {
    $state = @{ Sessions = 0; Starts = 0; Delays = New-Object System.Collections.Generic.List[int] }
    $previousAdb = $env:ADB
    function Resolve-LauncherExecutable { param($Candidates, $Name); "resolved:$Name" }
    function Read-PhoneSerial { param($ConfigPath); 'PHONE123' }
    function Invoke-Adb {
        param($AdbPath, $Arguments)
        Assert-Equal $AdbPath 'resolved:adb.exe'
        Assert-Equal $Arguments[0] 'start-server'
        $state.Starts++
        New-AdbResult
    }
    function Wait-AdbPhones {
        param($AdbPath, $Serial)
        [pscustomobject]@{ Id = '192.168.1.42:37123'; Serial = 'PHONE123' }
    }
    function Invoke-LauncherProcess {
        param($FilePath, $Arguments, $TimeoutSeconds)
        Assert-Equal $env:ADB 'resolved:adb.exe'
        Assert-Equal $FilePath 'resolved:scrcpy.exe'
        Assert-Equal ($Arguments -join '|') '-s|192.168.1.42:37123|-S|-w|--window-title|My phone|--no-audio'
        Assert-Equal $TimeoutSeconds 0
        $state.Sessions++
        if ($state.Sessions -le 6) { return New-AdbResult '' 1 }
        New-AdbResult
    }
    function Start-Sleep { param($Seconds); $state.Delays.Add($Seconds) }
    Assert-Equal (Invoke-PhoneCtl 'unused' 'scrcpy' @('--window-title', 'My phone', '--no-audio')) 0
    Assert-Equal $state.Starts 7
    Assert-Equal ($state.Delays -join ',') '2,4,8,16,30,30'
    Assert-Equal $env:ADB $previousAdb
}

Test-Case 'flow: unavailable device uses mDNS fallback and preserves selection on retry' {
    $state = @{ ConfigReads = 0; Saved = ''; Prompts = 0; Waits = 0; MdnsCalls = 0; Sessions = 0 }
    function Resolve-LauncherExecutable { param($Candidates, $Name); "resolved:$Name" }
    function Read-PhoneSerial { param($ConfigPath); $state.ConfigReads++; '' }
    function Save-PhoneSerial { param($ConfigPath, $Serial); $state.Saved = $Serial }
    function Read-Host { param($Prompt); $state.Prompts++; '2' }
    function Invoke-Adb { param($AdbPath, $Arguments); New-AdbResult }
    function Wait-AdbPhones {
        param($AdbPath, $Serial)
        $state.Waits++
        if ($state.Waits -gt 1) {
            Assert-Equal $Serial 'SECOND'
            [pscustomobject]@{ Id = 'second'; Serial = 'SECOND' }
        }
    }
    function Connect-AdbMdnsPhone {
        param($AdbPath, $Serial)
        $state.MdnsCalls++
        [pscustomobject]@{ Id = 'first'; Serial = 'FIRST' }
        [pscustomobject]@{ Id = 'second'; Serial = 'SECOND' }
    }
    function Invoke-LauncherProcess {
        param($FilePath, $Arguments, $TimeoutSeconds)
        $state.Sessions++
        New-AdbResult '' ([int]($state.Sessions -eq 1))
    }
    function Start-Sleep { param($Seconds) }
    Assert-Equal (Invoke-PhoneCtl 'unused' 'scrcpy' @()) 0
    Assert-Equal $state.MdnsCalls 1
    Assert-Equal $state.Saved 'SECOND'
    Assert-Equal $state.Prompts 1
    Assert-Equal $state.ConfigReads 1
}

Test-Case 'process runner: captures both streams, preserves exit code' {
    $exe = Join-Path $PSHOME 'powershell.exe'
    $command = '[Console]::Out.Write("output with spaces"); [Console]::Error.Write("failure detail"); exit 7'
    $result = Invoke-LauncherProcess $exe @('-NoProfile', '-NonInteractive', '-Command', $command) -CaptureOutput
    Assert-Equal $result.ExitCode 7
    Assert-Equal $result.Output 'output with spaces'
    Assert-Equal $result.Error 'failure detail'
}

Test-Case 'process runner: bounded timeout kills a hung child' {
    $exe = Join-Path $PSHOME 'powershell.exe'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-LauncherProcess $exe @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 20') -TimeoutSeconds 1 -CaptureOutput
    Assert-Equal $result.ExitCode 124
    Assert-True ($timer.Elapsed.TotalSeconds -lt 10) 'Timeout did not bound the child process'
}

Test-Case 'cancellation: stopping the pipeline cleans up the owned child process' {
    $runspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $pipeline = [powershell]::Create()
    $shared = [hashtable]::Synchronized(@{ ChildPid = 0 })
    try {
        $runspace.Open()
        $runspace.SessionStateProxy.SetVariable('shared', $shared)
        $pipeline.Runspace = $runspace
        $script = {
            param($LauncherPath, $PowerShellPath)
            . $LauncherPath
            $originalStart = ${function:New-LauncherProcess}
            function New-LauncherProcess {
                param($FilePath, $Arguments, [switch]$CaptureOutput)
                $process = & $originalStart @PSBoundParameters
                $shared.ChildPid = $process.Id
                return $process
            }
            Invoke-LauncherProcess $PowerShellPath @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 20') -TimeoutSeconds 0 -CaptureOutput
        }
        $null = $pipeline.AddScript($script.ToString()).AddArgument((Join-Path (Split-Path -Parent $PSScriptRoot) 'phonectl.ps1')).AddArgument((Join-Path $PSHOME 'powershell.exe'))
        $async = $pipeline.BeginInvoke()
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while ($shared.ChildPid -eq 0 -and -not $async.IsCompleted -and $timer.Elapsed.TotalSeconds -lt 5) {
            Start-Sleep -Milliseconds 20
        }
        Assert-True ($shared.ChildPid -gt 0) 'Worker did not launch a child'
        $pipeline.Stop()
        $child = Get-Process -Id $shared.ChildPid -ErrorAction SilentlyContinue
        Assert-True ($null -eq $child) 'Cancelled pipeline left an orphan process'
    } finally {
        $pipeline.Dispose()
        $runspace.Dispose()
        # If an assertion fails, still stop only the exact process this test created.
        if ($shared.ChildPid -gt 0) {
            $child = Get-Process -Id $shared.ChildPid -ErrorAction SilentlyContinue
            if ($child) { $child.Kill(); $child.Dispose() }
        }
    }
}

Write-Host ("Tests: {0} passed, {1} failed" -f $script:passed, $script:failed)
if ($script:failed -gt 0) { exit 1 }
exit 0
