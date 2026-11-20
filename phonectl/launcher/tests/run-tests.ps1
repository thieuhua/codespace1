#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'phonectl.ps1')
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'install.ps1')
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
    $state.Content = '{"scrcpyArgs":["--no-audio"]}'
    Assert-Equal (Read-PhoneSerial 'unused') ''
    $state.Content = '{}'
    Assert-Equal (Read-PhoneSerial 'unused') ''
    foreach ($bad in @('{bad', '{"serial":1}', '{"serial":" "}', 'null', '[]', '[{}]', '1', 'true', '"text"', '{"scrcpyArgs":"--no-audio"}', '{"scrcpyArgs":[1]}')) {
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
    function Read-PhoneCtlConfig { param($ConfigPath); [pscustomobject]@{ serial = 'PHONE123'; scrcpyArgs = @('--max-fps', '30') } }
    function Invoke-Adb {
        param($AdbPath, $Arguments)
        Assert-Equal $AdbPath 'resolved:adb.exe'
        if ($Arguments[0] -eq '-s') {
            Assert-Equal ($Arguments -join '|') '-s|192.168.1.42:37123|shell|getprop|ro.product.model'
            return New-AdbResult "Fixture Phone`r`n"
        }
        Assert-Equal $Arguments[0] 'start-server'
        $state.Starts++
        New-AdbResult
    }
    function Wait-AdbPhones {
        param($AdbPath, $Serial)
        [pscustomobject]@{ Id = '192.168.1.42:37123'; Serial = 'PHONE123' }
    }
    function Invoke-LauncherProcess {
        param($FilePath, $Arguments, $TimeoutSeconds, [switch]$LogOutput)
        Assert-Equal $env:ADB 'resolved:adb.exe'
        Assert-Equal $FilePath 'resolved:scrcpy.exe'
        Assert-Equal ($Arguments -join '|') '-s|192.168.1.42:37123|-S|-w|--window-title|Fixture Phone|--max-fps|30|--window-title|My phone|--no-audio'
        Assert-True $LogOutput
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
    function Read-PhoneCtlConfig { param($ConfigPath); $state.ConfigReads++; [pscustomobject]@{} }
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
        param($FilePath, $Arguments, $TimeoutSeconds, [switch]$LogOutput)
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

Test-Case 'pairing parser: service isolation, duplicate endpoints, IPv6 and invalid input' {
    $text = Get-Content (Join-Path $fixtures 'pairing.txt') -Raw
    $services = @(ConvertFrom-AdbMdnsServices $text -Service pairing)
    Assert-Equal $services.Count 3
    Assert-Equal $services[0].Serial 'PHONE123'
    Assert-Equal $services[0].Address '192.168.1.42:41000'
    Assert-Equal $services[1].Address '[fe80::2%12]:42000'
    Assert-Equal $services[2].Serial $null
    Assert-Equal @(ConvertFrom-AdbMdnsServices $text).Count 1
    Assert-Equal @(ConvertFrom-AdbMdnsServices '' -Service pairing).Count 0
    foreach ($endpoint in @('10.0.0.1:1', '[::1]:65535')) { Assert-True (Test-AdbEndpoint $endpoint) }
    foreach ($endpoint in @('10.0.0.1:0', '10.0.0.1:65536', '999.1.1.1:1234', 'host:1234', '10.0.0.1:12 extra', '')) {
        Assert-Equal (Test-AdbEndpoint $endpoint) $false
    }
}

Test-Case 'config merge: preserves fields, does not mutate source, config args precede CLI args' {
    $config = Get-Content (Join-Path $fixtures 'config.json') -Raw | ConvertFrom-Json
    $merged = Merge-PhoneCtlConfig $config -Serial 'SECOND'
    Assert-Equal $merged.serial 'SECOND'
    Assert-Equal $config.serial ' PHONE123 '
    Assert-Equal $merged.futureSetting.enabled $true
    Assert-Equal (@(Merge-PhoneCtlScrcpyArgs $merged @('--max-size', '1920')) -join '|') '--no-audio|--max-size|1280|--max-size|1920'
    Assert-Equal @(Merge-PhoneCtlScrcpyArgs $null).Count 0
    Assert-Equal @(Merge-PhoneCtlScrcpyArgs ([pscustomobject]@{ scrcpyArgs = @() })).Count 0
    Assert-Equal (@(Merge-PhoneCtlScrcpyArgs ([pscustomobject]@{ scrcpyArgs = @('--no-audio') })) -join '|') '--no-audio'
}

Test-Case 'saving serial preserves scrcpyArgs and unknown config fields' {
    $state = @{ Written = '' }
    $content = Get-Content (Join-Path $fixtures 'config.json') -Raw
    function Test-Path { param($LiteralPath, $PathType); $true }
    function Get-Content { param($LiteralPath, [switch]$Raw, $Encoding); $content }
    function Set-Content { param($LiteralPath, $Encoding, [Parameter(ValueFromPipeline)]$Value); process { $state.Written = $Value } }
    Save-PhoneSerial 'C:\unused\config.json' 'SECOND'
    $saved = $state.Written | ConvertFrom-Json
    Assert-Equal $saved.serial 'SECOND'
    Assert-Equal ($saved.scrcpyArgs -join '|') '--no-audio|--max-size|1280'
    Assert-Equal $saved.futureSetting.enabled $true
}

Test-Case 'executable resolution: falls back to saved registry PATH without changing process PATH' {
    $dirs = @(@('User', 'Machine') | ForEach-Object { [Environment]::GetEnvironmentVariable('Path', $_) }) -join ';'
    $directory = @($dirs -split ';' | Where-Object { $_ })[0]
    $expected = Join-Path ([Environment]::ExpandEnvironmentVariables($directory)) 'scrcpy.exe'
    $oldPath = $env:PATH
    function Get-Command { param($Name, $CommandType, $ErrorAction); $null }
    function Test-Path { param($LiteralPath, $PathType); $LiteralPath -eq $expected }
    Assert-Equal (Resolve-LauncherExecutable @('missing') 'scrcpy.exe') $expected
    Assert-Equal $env:PATH $oldPath
}

Test-Case 'pairing: discovered endpoint asks only code and waits for matching auto-connection' {
    $state = @{ Prompts = 0; Pairs = 0 }
    function Read-Host { param($Prompt); $state.Prompts++; Assert-Equal $Prompt '6-digit pairing code'; '012345' }
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        if ($Arguments[0] -eq 'mdns') { return New-AdbResult (Get-Content (Join-Path $fixtures 'pairing.txt') -Raw) }
        Assert-Equal ($Arguments -join '|') 'pair|192.168.1.42:41000|012345'
        Assert-Equal $TimeoutSeconds 30
        $state.Pairs++
        New-AdbResult 'Successfully paired to 192.168.1.42:41000' 0 'native stderr notice'
    }
    function Wait-AdbPhones {
        param($AdbPath, $Serial, $Seconds)
        Assert-Equal $Serial 'PHONE123'
        Assert-Equal $Seconds 30
        [pscustomobject]@{ Id = 'adb-PHONE123-connect._adb-tls-connect._tcp'; Serial = $Serial }
    }
    $phones = @(Pair-InstallPhone 'fake-adb' 'PHONE123')
    Assert-Equal $phones.Count 1
    Assert-Equal $phones[0].Serial 'PHONE123'
    Assert-Equal $state.Prompts 1
    Assert-Equal $state.Pairs 1
}

Test-Case 'pairing: empty mDNS prompts IP:port then code; does not connect to pairing port' {
    $state = @{ Prompts = 0 }
    function Read-Host { param($Prompt); $state.Prompts++; if ($state.Prompts -eq 1) { '10.0.0.8:43210' } else { '123456' } }
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        if ($Arguments[0] -eq 'mdns') { return New-AdbResult 'List of discovered mdns services' }
        Assert-Equal ($Arguments -join '|') 'pair|10.0.0.8:43210|123456'
        New-AdbResult 'Successfully paired to 10.0.0.8:43210'
    }
    function Wait-AdbPhones { param($AdbPath, $Serial, $Seconds); [pscustomobject]@{ Id = '10.0.0.8:54321'; Serial = 'PHONE' } }
    Assert-Equal (@(Pair-InstallPhone 'fake-adb' '')[0].Id) '10.0.0.8:54321'
    Assert-Equal $state.Prompts 2
}

Test-Case 'pairing: multiple unselected services stop before asking code' {
    function Invoke-Adb { param($AdbPath, $Arguments); New-AdbResult (Get-Content (Join-Path $fixtures 'pairing.txt') -Raw) }
    function Read-Host { throw 'Must not prompt for an ambiguous pairing target' }
    $message = ''
    try { $null = Pair-InstallPhone 'fake-adb' '' } catch { $message = $_.Exception.Message }
    Assert-True ($message -like 'Several pairing services found*')
}

Test-Case 'pairing: invalid code stops without sending adb pair' {
    function Invoke-Adb {
        param($AdbPath, $Arguments)
        Assert-Equal $Arguments[0] 'mdns'
        New-AdbResult 'adb-PHONE123-pair _adb-tls-pairing._tcp 10.0.0.1:40000'
    }
    function Read-Host { '12345' }
    $message = ''
    try { $null = Pair-InstallPhone 'fake-adb' '' } catch { $message = $_.Exception.Message }
    Assert-Equal $message 'Pairing code must contain exactly 6 digits.'
}

Test-Case 'pairing: failed adb pair does not wait or save' {
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        if ($Arguments[0] -eq 'mdns') { return New-AdbResult 'adb-PHONE123-pair _adb-tls-pairing._tcp 10.0.0.1:40000' }
        New-AdbResult '' 1 'wrong pairing code'
    }
    function Read-Host { '123456' }
    function Wait-AdbPhones { throw 'Must not wait after pairing failure' }
    $message = ''
    try { $null = Pair-InstallPhone 'fake-adb' '' } catch { $message = $_.Exception.Message }
    Assert-True ($message -like 'ADB pairing failed:*wrong pairing code*')
}

Test-Case 'pairing: successful pair without auto-connection gives actionable timeout' {
    function Invoke-Adb {
        param($AdbPath, $Arguments, $TimeoutSeconds)
        if ($Arguments[0] -eq 'mdns') { return New-AdbResult 'adb-PHONE123-pair _adb-tls-pairing._tcp 10.0.0.1:40000' }
        New-AdbResult 'Successfully paired'
    }
    function Read-Host { '123456' }
    function Wait-AdbPhones { param($AdbPath, $Serial, $Seconds) }
    $message = ''
    try { $null = Pair-InstallPhone 'fake-adb' '' } catch { $message = $_.Exception.Message }
    Assert-True ($message -like 'Paired, but no phone auto-connected after 30 s.*')
}

# All installer side effects are replaced at the boundary; never touch a real phone,
# LOCALAPPDATA config, shortcuts or Gradle cache from these orchestration tests.
$installMocks = {
    function Read-PhoneSerial { param($ConfigPath); 'PHONE123' }
    function Test-Path {
        param($LiteralPath, $PathType)
        if ($LiteralPath.EndsWith('adb.exe')) { return $state.Vendor }
        if ($LiteralPath.EndsWith('.apk')) { return $state.Apk }
        if ($LiteralPath.EndsWith('phonectl-relay.exe')) { return $state.Relay }
        if ($LiteralPath.EndsWith('scrcpy-server')) { return $state.Server }
        throw "Unexpected path: $LiteralPath"
    }
    function Resolve-LauncherExecutable { param($Candidates, $Name); if ($state.Scrcpy) { 'fake-scrcpy' } }
    function Build-PhoneCtlApk { param($ProjectRoot); $state.Builds++; $state.Apk = $true }
    function Invoke-Adb {
        param($AdbPath, $Arguments)
        Assert-Equal $Arguments[0] 'start-server'
        New-AdbResult '' 0 '* daemon started successfully *'
    }
    function Wait-AdbPhones { param($AdbPath, $Serial, $Seconds); Assert-Equal $Seconds 10; Assert-Equal $Serial 'PHONE123'; $state.Phones }
    function Pair-InstallPhone { param($AdbPath, $Serial); $state.Pairs++; [pscustomobject]@{ Id = 'paired:43210'; Serial = 'PHONE123' } }
    function Invoke-InstallScript {
        param($ScriptPath, $Arguments)
        if ($ScriptPath.EndsWith('fetch-platform-tools.ps1')) { $state.Fetches++; $state.Vendor = $true; return }
        if ($ScriptPath.EndsWith('relay\build.ps1')) { $state.RelayBuilds++; $state.Relay = $true; return }
        if ($ScriptPath.EndsWith('server\build.ps1')) { $state.ServerBuilds++; $state.Server = $true; return }
        Assert-True ($ScriptPath.EndsWith('setup-phone.ps1'))
        $state.Setups++
        $state.SetupId = $Arguments.Serial
        if ($state.FailSetup) { throw 'mock setup failure' }
    }
    function Save-PhoneSerial {
        param($ConfigPath, $Serial)
        Assert-True ($state.Setups -gt 0)
        $state.Saves++
        Assert-Equal $Serial 'PHONE123'
    }
    function New-PhoneCtlShortcuts { param($ProjectRoot, $ScrcpyPath); Assert-True ($state.Saves -gt 0); $state.Shortcuts++ }
}
function New-InstallTestState {
    @{
        Vendor = $true; Apk = $true; Relay = $true; Server = $true; Scrcpy = $true
        Builds = 0; RelayBuilds = 0; ServerBuilds = 0; Fetches = 0
        Pairs = 0; Setups = 0; Saves = 0; Shortcuts = 0; FailSetup = $false; SetupId = ''
        Phones = @([pscustomobject]@{ Id = 'auto:12345'; Serial = 'PHONE123' })
    }
}

Test-Case 'installer: rerun reuses ADB/APK/connection and refreshes setup and shortcuts' {
    $state = New-InstallTestState
    . $installMocks
    Assert-Equal (Invoke-PhoneCtlInstall $PSScriptRoot) 0
    Assert-Equal (Invoke-PhoneCtlInstall $PSScriptRoot) 0
    Assert-Equal $state.Fetches 0
    Assert-Equal $state.Builds 0
    Assert-Equal $state.RelayBuilds 0
    Assert-Equal $state.ServerBuilds 0
    Assert-Equal $state.Pairs 0
    Assert-Equal $state.Setups 2
    Assert-Equal $state.Saves 2
    Assert-Equal $state.Shortcuts 2
    Assert-Equal $state.SetupId 'auto:12345'
}

Test-Case 'installer: missing vendor and APK fetch/build once; -Rebuild forces build' {
    $state = New-InstallTestState
    $state.Vendor = $false; $state.Apk = $false; $state.Relay = $false; $state.Server = $false
    . $installMocks
    Assert-Equal (Invoke-PhoneCtlInstall $PSScriptRoot) 0
    Assert-Equal (Invoke-PhoneCtlInstall $PSScriptRoot -Rebuild) 0
    Assert-Equal $state.Fetches 1
    Assert-Equal $state.Builds 2
    Assert-Equal $state.RelayBuilds 2
    Assert-Equal $state.ServerBuilds 2
}

Test-Case 'installer: no device triggers pairing then setup with connected transport id' {
    $state = New-InstallTestState
    $state.Phones = @()
    . $installMocks
    Assert-Equal (Invoke-PhoneCtlInstall $PSScriptRoot) 0
    Assert-Equal $state.Pairs 1
    Assert-Equal $state.SetupId 'paired:43210'
}

Test-Case 'installer: missing scrcpy stops before build, ADB, config or shortcuts' {
    $state = New-InstallTestState
    $state.Scrcpy = $false; $state.Apk = $false
    . $installMocks
    function Invoke-Adb { throw 'Must not start ADB without scrcpy' }
    Assert-Equal (Invoke-PhoneCtlInstall $PSScriptRoot) 1
    Assert-Equal $state.Builds 0
    Assert-Equal $state.Setups 0
    Assert-Equal $state.Saves 0
    Assert-Equal $state.Shortcuts 0
}

Test-Case 'installer: setup failure does not save serial or create shortcuts' {
    $state = New-InstallTestState
    $state.FailSetup = $true
    . $installMocks
    $message = ''
    try { $null = Invoke-PhoneCtlInstall $PSScriptRoot } catch { $message = $_.Exception.Message }
    Assert-Equal $message 'mock setup failure'
    Assert-Equal $state.Saves 0
    Assert-Equal $state.Shortcuts 0
}

Test-Case 'log: timestamps, append, native stderr and retention within one MiB' {
    $directory = Join-Path $PSScriptRoot ('.test-log-' + [guid]::NewGuid().ToString('N'))
    $oldLogPath = $script:LauncherLogPath
    try {
        [void][IO.Directory]::CreateDirectory($directory)
        $script:LauncherLogPath = Join-Path $directory 'launcher.log'
        Write-LauncherLog 'first launch'
        Write-LauncherLog 'second launch'
        $text = [IO.File]::ReadAllText($script:LauncherLogPath)
        Assert-True ($text -match '\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] first launch')
        Assert-True ($text -match 'second launch')
        $exe = Join-Path $PSHOME 'powershell.exe'
        $result = Invoke-LauncherProcess $exe @('-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.WriteLine("native output"); [Console]::Error.WriteLine("native error"); exit 7') -LogOutput
        Assert-Equal $result.ExitCode 7
        $text = [IO.File]::ReadAllText($script:LauncherLogPath)
        Assert-True ($text -match 'scrcpy stdout: native output')
        Assert-True ($text -match 'scrcpy stderr: native error')
        [IO.File]::WriteAllText($script:LauncherLogPath, ((('old line' + [Environment]::NewLine) * 120000)))
        Write-LauncherLog 'newest retained line'
        Assert-True ((Get-Item -LiteralPath $script:LauncherLogPath).Length -le 1MB)
        Assert-True ([IO.File]::ReadAllText($script:LauncherLogPath).EndsWith('newest retained line' + [Environment]::NewLine))
    } finally {
        $script:LauncherLogPath = $oldLogPath
        if (Test-Path -LiteralPath $directory) {
            Remove-Item -LiteralPath (Join-Path $directory 'launcher.log') -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $directory
        }
    }
}

Test-Case 'mutex: second process prints already running and exits zero without ADB' {
    $previousMutex = $env:PHONECTL_MUTEX
    $mutexName = 'Local\phonectl-test-' + [guid]::NewGuid().ToString('N')
    $mutex = New-Object Threading.Mutex($false, $mutexName)
    $owned = $false
    try {
        $env:PHONECTL_MUTEX = $mutexName
        try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
        Assert-True $owned 'Failed to acquire isolated test mutex'
        $exe = Join-Path $PSHOME 'powershell.exe'
        $launcherPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'phonectl.ps1'
        $result = Invoke-LauncherProcess $exe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $launcherPath) -CaptureOutput
        Assert-Equal $result.ExitCode 0
        Assert-True ($result.Output -match 'already running')
    } finally {
        $env:PHONECTL_MUTEX = $previousMutex
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

Test-Case 'mutex: release on session exception allows a fresh launch; log appends' {
    $directory = Join-Path $PSScriptRoot ('.test-launch-' + [guid]::NewGuid().ToString('N'))
    $previousLocal = $env:LOCALAPPDATA
    $previousMutex = $env:PHONECTL_MUTEX
    $state = @{ Calls = 0 }
    function Invoke-PhoneCtl {
        param($ProjectRoot, $Mode, $ScrcpyArgs)
        $state.Calls++
        if ($state.Calls -eq 1) { throw 'mock session exception' }
        return 0
    }
    try {
        $env:LOCALAPPDATA = $directory
        $env:PHONECTL_MUTEX = 'Local\phonectl-test-' + [guid]::NewGuid().ToString('N')
        $message = ''
        try { $null = Invoke-PhoneCtlLauncher 'unused' 'scrcpy' @() } catch { $message = $_.Exception.Message }
        Assert-Equal $message 'mock session exception'
        Assert-Equal (Invoke-PhoneCtlLauncher 'unused' 'scrcpy' @()) 0
        Assert-Equal $state.Calls 2
        $log = [IO.File]::ReadAllText((Join-Path $directory 'phonectl\launcher.log'))
        Assert-Equal ([regex]::Matches($log, 'Launcher started\.').Count) 2
        Assert-True ($log -match 'ERROR: mock session exception')
    } finally {
        $env:PHONECTL_MUTEX = $previousMutex
        $env:LOCALAPPDATA = $previousLocal
        if (Test-Path -LiteralPath $directory) {
            $logDirectory = Join-Path $directory 'phonectl'
            Remove-Item -LiteralPath (Join-Path $logDirectory 'launcher.log') -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $logDirectory
            Remove-Item -LiteralPath $directory
        }
    }
}

Test-Case 'build: native stderr is harmless on success; nonzero fails and restores working directory' {
    $directory = Join-Path $PSScriptRoot ('.test build ' + [guid]::NewGuid().ToString('N'))
    $buildDirectory = Join-Path $directory 'adbkeeper'
    $wrapper = Join-Path $buildDirectory 'gradlew.bat'
    $previousDirectory = (Get-Location).Path
    try {
        [void][IO.Directory]::CreateDirectory($buildDirectory)
        [IO.File]::WriteAllText($wrapper, "@echo off`r`necho harmless native stderr 1>&2`r`nexit /b 0`r`n")
        Build-PhoneCtlApk $directory
        Assert-Equal (Get-Location).Path $previousDirectory
        [IO.File]::WriteAllText($wrapper, "@echo off`r`necho simulated build failure 1>&2`r`nexit /b 7`r`n")
        $message = ''
        try { Build-PhoneCtlApk $directory } catch { $message = $_.Exception.Message }
        Assert-True ($message -like 'Gradle assembleDebug failed (exit 7).*')
        Assert-Equal (Get-Location).Path $previousDirectory
    } finally {
        if (Test-Path -LiteralPath $wrapper) { Remove-Item -LiteralPath $wrapper }
        if (Test-Path -LiteralPath $buildDirectory) { Remove-Item -LiteralPath $buildDirectory }
        if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory }
    }
}

Test-Case 'shortcuts: real WScript links use minimized cmd, icon and update in place in isolated folders' {
    $directory = Join-Path $PSScriptRoot ('.test-shortcuts-' + [guid]::NewGuid().ToString('N'))
    $folders = @((Join-Path $directory 'Desktop'), (Join-Path $directory 'Programs'))
    $projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $iconPath = Join-Path $PSHOME 'powershell.exe'
    $shell = $null
    try {
        New-PhoneCtlShortcuts -ProjectRoot $projectRoot -ScrcpyPath $iconPath -ShortcutDirectories $folders
        New-PhoneCtlShortcuts -ProjectRoot $projectRoot -ScrcpyPath $iconPath -ShortcutDirectories $folders
        $shell = New-Object -ComObject WScript.Shell
        foreach ($folder in $folders) {
            Assert-Equal @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk').Count 1
            $shortcut = $shell.CreateShortcut((Join-Path $folder 'phonectl.lnk'))
            try {
                Assert-Equal $shortcut.TargetPath (Join-Path $projectRoot 'launcher\phonectl.cmd')
                Assert-Equal $shortcut.WorkingDirectory $projectRoot
                Assert-Equal $shortcut.WindowStyle 7
                Assert-Equal $shortcut.IconLocation "$iconPath,0"
            } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        }
    } finally {
        if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
        foreach ($folder in $folders) {
            $link = Join-Path $folder 'phonectl.lnk'
            if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link }
            if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder }
        }
        if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory }
    }
}

Test-Case 'transport config: default lan, explicit lan/adb and invalid values rejected' {
    Assert-Equal (Merge-PhoneCtlConfig $null).transport 'lan'
    Assert-Equal (Get-PhoneCtlTransport $null) 'lan'
    Assert-Equal (Get-PhoneCtlTransport ([pscustomobject]@{})) 'lan'
    Assert-Equal (Get-PhoneCtlTransport ([pscustomobject]@{ transport = 'lan' })) 'lan'
    Assert-Equal (Get-PhoneCtlTransport ([pscustomobject]@{ transport = 'adb' })) 'adb'
    foreach ($bad in @('{"transport":"usb"}', '{"transport":"LAN"}', '{"transport":""}', '{"transport":1}', '{"transport":null}', '{"transport":[]}')) {
        $state = @{ Content = $bad }
        function Test-Path { param($LiteralPath); $true }
        function Get-Content { param($LiteralPath, [switch]$Raw, $Encoding); $state.Content }
        $message = ''
        try { $null = Read-PhoneCtlConfig 'unused' } catch { $message = $_.Exception.Message }
        Assert-True ($message -like 'Invalid config unused:*') "Bad transport was accepted: $bad"
    }
}

Test-Case 'wlan0, scrcpy version, relay READY parsers and random port helper' {
    $wlanText = Get-Content (Join-Path $fixtures 'wlan0.txt') -Raw
    Assert-Equal (ConvertFrom-AdbWlanAddress $wlanText) '192.168.1.42'
    Assert-Equal (ConvertFrom-AdbWlanAddress "    inet 10.20.30.40/16 scope global wlan0`r`n") '10.20.30.40'
    Assert-Equal (ConvertFrom-AdbWlanAddress '    inet 127.0.0.1/8 scope host lo') $null
    Assert-Equal (ConvertFrom-AdbWlanAddress '    inet 0.0.0.0/0 wlan0') $null
    Assert-Equal (ConvertFrom-AdbWlanAddress '    inet 999.1.1.1/24 wlan0') $null
    Assert-Equal (ConvertFrom-AdbWlanAddress '') $null

    $versionText = Get-Content (Join-Path $fixtures 'scrcpy-version.txt') -Raw
    Assert-Equal (ConvertFrom-ScrcpyVersion $versionText) '5.0.1'
    Assert-True (Test-ScrcpyForkCompatible $versionText)
    Assert-Equal (Test-ScrcpyForkCompatible 'scrcpy 3.1 <https://github.com/Genymobile/scrcpy>') $false
    Assert-Equal (Test-ScrcpyForkCompatible 'scrcpy 5.0.10') $false
    Assert-Equal (Test-ScrcpyForkCompatible 'scrcpy 5.0.1-dev') $false
    Assert-Equal (Test-ScrcpyForkCompatible '') $false

    Assert-Equal (ConvertFrom-RelayReadyLine 'READY 54321') 54321
    Assert-Equal (ConvertFrom-RelayReadyLine "  READY 20000 `r`n") 20000
    Assert-Equal (ConvertFrom-RelayReadyLine 'READY 0') $null
    Assert-Equal (ConvertFrom-RelayReadyLine 'READY 65536') $null
    Assert-Equal (ConvertFrom-RelayReadyLine 'FAILED 12345') $null
    Assert-Equal (ConvertFrom-RelayReadyLine '') $null

    for ($i = 0; $i -lt 20; $i++) {
        $port = Get-RandomLanPort
        Assert-True ($port -ge 20000 -and $port -le 60999) "Port out of range: $port"
    }
    Assert-Equal (Get-LaptopLanAddress '127.0.0.1') '127.0.0.1'
    $threw = $false
    try { $null = Get-LaptopLanAddress 'not-an-ip' } catch { $threw = $true }
    Assert-True $threw
}

Test-Case 'LAN session flow: wlan0 IP, UDP peer, relay start/stop, session push+chmod+delete and SCRCPY_SERVER_PATH' {
    $tempDir = Join-Path $PSScriptRoot ('.test-lan-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($tempDir)
    $sessionFile = Join-Path $tempDir 'session-temp'
    $previousServer = $env:SCRCPY_SERVER_PATH
    $state = @{
        AdbCalls = New-Object System.Collections.Generic.List[string]
        ScrcpyCalls = New-Object System.Collections.Generic.List[string]
        ServerEnvDuringScrcpy = ''
        SessionExistedDuringPush = $false
        SessionExistedDuringScrcpy = $true
        RelayStarted = 0
        RelayStopped = 0
    }
    try {
        function Resolve-LauncherExecutable { param($Candidates, $Name); "resolved:$Name" }
        function Read-PhoneCtlConfig { param($ConfigPath); [pscustomobject]@{ serial = 'PHONE123'; transport = 'lan'; scrcpyArgs = @('--max-fps', '60') } }
        function Test-Path {
            param($LiteralPath, $PathType)
            if ($LiteralPath -eq 'C:\proj\server\build\scrcpy-server') { return $true }
            if ($LiteralPath -eq $sessionFile) { return [IO.File]::Exists($sessionFile) }
            return [IO.File]::Exists($LiteralPath) -or [IO.Directory]::Exists($LiteralPath)
        }
        function Invoke-Adb {
            param($AdbPath, $Arguments, $TimeoutSeconds)
            $joined = $Arguments -join '|'
            $state.AdbCalls.Add($joined)
            if ($Arguments[0] -eq 'start-server') { return New-AdbResult }
            if ($joined -eq '-s|192.168.1.42:37123|shell|getprop|ro.product.model') { return New-AdbResult "Pixel 8`r`n" }
            if ($joined -eq '-s|192.168.1.42:37123|shell|ip|-4|addr|show|wlan0') { return New-AdbResult (Get-Content (Join-Path $fixtures 'wlan0.txt') -Raw) }
            if ($Arguments[2] -eq 'push') {
                Assert-Equal $Arguments[3] $sessionFile
                Assert-Equal $Arguments[4] '/data/local/tmp/phonectl-session'
                $state.SessionExistedDuringPush = [IO.File]::Exists($sessionFile)
                return New-AdbResult
            }
            if ($joined -eq '-s|192.168.1.42:37123|shell|chmod|600|/data/local/tmp/phonectl-session') { return New-AdbResult }
            throw "Unexpected ADB command: $joined"
        }
        function Wait-AdbPhones { param($AdbPath, $Serial); [pscustomobject]@{ Id = '192.168.1.42:37123'; Serial = 'PHONE123' } }
        function Get-LaptopLanAddress { param($PhoneAddress); Assert-Equal $PhoneAddress '192.168.1.42'; '192.168.1.10' }
        function Get-RandomLanPort { 34567 }
        function New-LanSessionFilePath { $sessionFile }
        function Start-LanRelay {
            param($RelayPath, $PhoneAddress, $PhonePort, $LaptopAddress, $SessionPath)
            Assert-Equal $RelayPath 'C:\proj\relay\build\phonectl-relay.exe'
            Assert-Equal $PhoneAddress '192.168.1.42'
            Assert-Equal $PhonePort 34567
            Assert-Equal $LaptopAddress '192.168.1.10'
            Assert-Equal $SessionPath $sessionFile
            [IO.File]::WriteAllText($SessionPath, 'version=1')
            $state.RelayStarted++
            [pscustomobject]@{ Process = 'mock-relay'; Port = 51234 }
        }
        function Stop-LanRelay {
            param($Relay)
            if ($null -ne $Relay) { $state.RelayStopped++ }
        }
        function Invoke-LauncherProcess {
            param($FilePath, $Arguments, $TimeoutSeconds, [switch]$CaptureOutput, [switch]$LogOutput)
            $joined = $Arguments -join '|'
            $state.ScrcpyCalls.Add($joined)
            if ($joined -eq '--version') {
                return New-AdbResult (Get-Content (Join-Path $fixtures 'scrcpy-version.txt') -Raw)
            }
            $state.ServerEnvDuringScrcpy = $env:SCRCPY_SERVER_PATH
            $state.SessionExistedDuringScrcpy = [IO.File]::Exists($sessionFile)
            Assert-Equal $joined '-s|192.168.1.42:37123|-S|-w|--window-title|Pixel 8|--force-adb-forward|--tunnel-host=127.0.0.1|--tunnel-port=51234|--max-fps|60|--no-audio'
            return New-AdbResult '' 0
        }
        Assert-Equal (Invoke-PhoneCtl 'C:\proj' 'scrcpy' @('--no-audio')) 0
        Assert-True $state.SessionExistedDuringPush 'Session file must exist during adb push'
        Assert-Equal $state.SessionExistedDuringScrcpy $false
        Assert-Equal ([IO.File]::Exists($sessionFile)) $false
        Assert-Equal $state.ServerEnvDuringScrcpy 'C:\proj\server\build\scrcpy-server'
        Assert-Equal $env:SCRCPY_SERVER_PATH $previousServer
        Assert-Equal $state.RelayStarted 1
        Assert-Equal $state.RelayStopped 1
    } finally {
        $env:SCRCPY_SERVER_PATH = $previousServer
        if (Test-Path -LiteralPath $sessionFile) { Remove-Item -LiteralPath $sessionFile -Force }
        if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Force }
    }
}

Test-Case 'LAN fallback: version mismatch or missing server warns and uses stock server; transport=adb skips fork' {
    $state = @{ Warnings = New-Object System.Collections.Generic.List[string]; ServerExists = $true; Version = 'scrcpy 3.1'; ConfigTransport = 'lan'; ScrcpyArgsSeen = '' }
    function Resolve-LauncherExecutable { param($Candidates, $Name); "resolved:$Name" }
    function Read-PhoneCtlConfig { param($ConfigPath); [pscustomobject]@{ serial = 'PHONE123'; transport = $state.ConfigTransport } }
    function Test-Path {
        param($LiteralPath, $PathType)
        if ($LiteralPath -eq 'C:\proj\server\build\scrcpy-server') { return $state.ServerExists }
        return $false
    }
    function Write-LauncherMessage {
        param($Message)
        if ($Message -like 'WARNING:*') { $state.Warnings.Add($Message) }
    }
    function Invoke-Adb {
        param($AdbPath, $Arguments)
        if ($Arguments[0] -eq 'start-server') { return New-AdbResult }
        New-AdbResult 'Pixel'
    }
    function Wait-AdbPhones { param($AdbPath, $Serial); [pscustomobject]@{ Id = '192.168.1.42:37123'; Serial = 'PHONE123' } }
    function Start-LanRelay { throw 'Must not start relay on stock server fallback' }
    function Invoke-LauncherProcess {
        param($FilePath, $Arguments, $TimeoutSeconds, [switch]$CaptureOutput, [switch]$LogOutput)
        if (($Arguments -join '|') -eq '--version') { return New-AdbResult $state.Version }
        $state.ScrcpyArgsSeen = ($Arguments -join '|')
        New-AdbResult '' 0
    }
    Assert-Equal (Invoke-PhoneCtl 'C:\proj' 'scrcpy' @()) 0
    Assert-Equal $state.Warnings.Count 1
    Assert-True ($state.Warnings[0] -like '*expected 5.0.1*')
    Assert-Equal $state.ScrcpyArgsSeen '-s|192.168.1.42:37123|-S|-w|--window-title|Pixel'

    $state.Warnings.Clear(); $state.ServerExists = $false; $state.Version = 'scrcpy 5.0.1'
    Assert-Equal (Invoke-PhoneCtl 'C:\proj' 'scrcpy' @()) 0
    Assert-Equal $state.Warnings.Count 1
    Assert-True ($state.Warnings[0] -like '*scrcpy-server not found*')

    $state.Warnings.Clear(); $state.ServerExists = $true; $state.ConfigTransport = 'adb'
    Assert-Equal (Invoke-PhoneCtl 'C:\proj' 'scrcpy' @()) 0
    Assert-Equal $state.Warnings.Count 0
}

Test-Case 'companion relay death stops scrcpy and returns nonzero for reconnect' {
    $exe = Join-Path $PSHOME 'powershell.exe'
    $companion = New-LauncherProcess $exe @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 300; exit 1') -CaptureOutput
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $result = Invoke-LauncherProcess $exe @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 20') -TimeoutSeconds 0 -CaptureOutput -CompanionProcess $companion
        Assert-Equal $result.ExitCode 1
        Assert-True ($timer.Elapsed.TotalSeconds -lt 10) 'Companion process death did not terminate scrcpy'
    } finally {
        Stop-LauncherProcess $companion
    }
}

Write-Host ("Tests: {0} passed, {1} failed" -f $script:passed, $script:failed)
if ($script:failed -gt 0) { exit 1 }
exit 0
