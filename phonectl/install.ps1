#requires -Version 5.1
[CmdletBinding()]
param([switch]$Rebuild)

Set-StrictMode -Version 2.0
# Reuse resolution (including registry PATH), process timeouts and device identity checks.
. (Join-Path $PSScriptRoot 'launcher\phonectl.ps1')

function Build-PhoneCtlApk {
    param([string]$ProjectRoot)
    Push-Location (Join-Path $ProjectRoot 'adbkeeper')
    try {
        # PS 5.1 represents native stderr as ErrorRecords. Only the exit code decides failure.
        $ErrorActionPreference = 'Continue'
        & '.\gradlew.bat' assembleDebug 2>&1 | ForEach-Object { Write-Host "$_" }
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw "Gradle assembleDebug failed (exit $code). Check JDK/Android SDK and cached dependencies." }
    } finally { Pop-Location }
}

function Pair-InstallPhone {
    param([string]$AdbPath, [AllowEmptyString()][string]$Serial)
    Write-Host 'On the phone: Developer options > Wireless debugging > Pair device with pairing code.'
    Write-Host 'Keep that dialog open. Allow Wireless debugging on this Wi-Fi network.'
    $result = Invoke-Adb -AdbPath $AdbPath -Arguments @('mdns', 'services')
    $services = @()
    if ($result.ExitCode -eq 0) { $services = @(ConvertFrom-AdbMdnsServices $result.Output -Service pairing) }
    $pairingSerial = $Serial
    if ($services.Count -eq 0) {
        Write-Host 'No pairing mDNS service. Check Private network firewall, AP isolation and VPN.'
        $endpoint = (Read-Host 'Pairing IP:port shown in the phone dialog').Trim()
        if (-not (Test-AdbEndpoint $endpoint)) { throw 'Invalid pairing IP:port.' }
    } else {
        $candidates = @(Select-AdbMdnsCandidates -Services $services -Serial $Serial)
        if ($candidates.Count -ne 1) {
            throw 'Several pairing services found. Close pairing dialogs on other phones and run install.cmd again.'
        }
        $endpoint = $candidates[0].Address
        if (-not $pairingSerial) { $pairingSerial = $candidates[0].Serial }
        Write-Host "Pairing with $endpoint"
    }
    $code = (Read-Host '6-digit pairing code').Trim()
    if ($code -notmatch '^[0-9]{6}$') { throw 'Pairing code must contain exactly 6 digits.' }
    # Do not log this command or its code. stderr stays plain text through Process API.
    $paired = Invoke-Adb -AdbPath $AdbPath -Arguments @('pair', $endpoint, $code) -TimeoutSeconds 30
    if ($paired.ExitCode -ne 0 -or $paired.Output -notmatch '(?i)successfully paired') {
        throw "ADB pairing failed: $($paired.Output) $($paired.Error)"
    }
    Write-Host 'Paired. Close the pairing dialog; keep Wireless debugging on. Waiting for automatic connection...'
    # Pairing and connection ports are different. Let ADB discover _adb-tls-connect;
    # never pass the pairing endpoint to adb connect.
    $phones = @(Wait-AdbPhones -AdbPath $AdbPath -Serial $pairingSerial -Seconds 30)
    if ($phones.Count -eq 0) {
        throw 'Paired, but no phone auto-connected after 30 s. Check adb mdns services (_adb-tls-connect), Private network firewall, AP isolation and VPN; rerun install.cmd.'
    }
    return $phones
}

function New-PhoneCtlShortcuts {
    param(
        [string]$ProjectRoot, [string]$ScrcpyPath,
        [string[]]$ShortcutDirectories = @(
            [Environment]::GetFolderPath('DesktopDirectory'),
            [Environment]::GetFolderPath('Programs')
        )
    )
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($directory in $ShortcutDirectories) {
            if (-not $directory) { throw 'Desktop or Start Menu folder is unavailable.' }
            [void][System.IO.Directory]::CreateDirectory($directory)
            $shortcut = $null
            try {
                $shortcut = $shell.CreateShortcut((Join-Path $directory 'phonectl.lnk'))
                $shortcut.TargetPath = Join-Path $ProjectRoot 'launcher\phonectl.cmd'
                $shortcut.WorkingDirectory = $ProjectRoot
                $shortcut.WindowStyle = 7 # Minimized, without activating the console.
                if ($ScrcpyPath) { $shortcut.IconLocation = "$ScrcpyPath,0" }
                $shortcut.Description = 'phonectl - Android remote control'
                $shortcut.Save()
            } finally {
                if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
            }
        }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Invoke-InstallScript {
    param([string]$ScriptPath, [hashtable]$Arguments = @{})
    & $ScriptPath @Arguments
}

function Invoke-PhoneCtlInstall {
    param([string]$ProjectRoot, [switch]$Rebuild)
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
    $configPath = Join-Path $env:LOCALAPPDATA 'phonectl\config.json'
    $serial = Read-PhoneSerial $configPath
    $adbPath = Join-Path $ProjectRoot 'vendor\platform-tools\adb.exe'
    if (-not (Test-Path -LiteralPath $adbPath -PathType Leaf)) {
        Invoke-InstallScript -ScriptPath (Join-Path $ProjectRoot 'tools\fetch-platform-tools.ps1')
    }
    if (-not (Test-Path -LiteralPath $adbPath -PathType Leaf)) { throw 'Vendor adb.exe is still missing after fetch-platform-tools.ps1.' }
    $scrcpyPath = Resolve-LauncherExecutable -Candidates @((Join-Path $ProjectRoot 'vendor\scrcpy\scrcpy.exe')) -Name 'scrcpy.exe'
    if (-not $scrcpyPath) {
        Write-Host 'Install scrcpy, then run install.cmd again: winget install Genymobile.scrcpy'
        return 1
    }
    $apkPath = Join-Path $ProjectRoot 'adbkeeper\app\build\outputs\apk\debug\app-debug.apk'
    if ($Rebuild -or -not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
        Build-PhoneCtlApk -ProjectRoot $ProjectRoot
    }
    if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) { throw "APK not found after build: $apkPath" }
    $started = Invoke-Adb -AdbPath $adbPath -Arguments @('start-server')
    if ($started.ExitCode -ne 0) { throw "adb start-server failed: $($started.Output) $($started.Error)" }
    $phones = @(Wait-AdbPhones -AdbPath $adbPath -Serial $serial -Seconds 10)
    if ($phones.Count -eq 0) { $phones = @(Pair-InstallPhone -AdbPath $adbPath -Serial $serial) }
    # Do not save selection until installation succeeds.
    if ($phones.Count -ne 1) { throw 'Several phones connected. Disconnect other phones and run install.cmd again.' }
    $phone = $phones[0]
    Invoke-InstallScript -ScriptPath (Join-Path $ProjectRoot 'tools\setup-phone.ps1') -Arguments @{ Serial = $phone.Id }
    Save-PhoneSerial -ConfigPath $configPath -Serial $phone.Serial
    New-PhoneCtlShortcuts -ProjectRoot $ProjectRoot -ScrcpyPath $scrcpyPath
    Write-Host 'Installed. For daily use, click phonectl on Desktop or Start Menu.'
    Write-Host 'Manual phone checklist:'
    Write-Host '[ ] Xiaomi: enable Developer options > USB debugging (Security settings).'
    Write-Host '[ ] Enable Autostart for adbkeeper.'
    Write-Host '[ ] Battery settings for adbkeeper: No restrictions.'
    Write-Host '[ ] Keep Wireless debugging on and allow this Wi-Fi network.'
    return 0
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    try { exit (Invoke-PhoneCtlInstall -ProjectRoot $PSScriptRoot -Rebuild:$Rebuild) }
    catch { Write-Host "phonectl install: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
}
