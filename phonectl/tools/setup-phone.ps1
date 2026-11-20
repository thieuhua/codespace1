#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Serial
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$apkPath = Join-Path $projectRoot 'adbkeeper\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
    throw "APK not found: $apkPath. Run .\gradlew.bat assembleDebug in adbkeeper first."
}

$adbPath = $null
$candidates = @(
    (Join-Path $projectRoot 'vendor\platform-tools\adb.exe'),
    'E:\Android\Sdk\platform-tools\adb.exe'
)
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $adbPath = $candidate
        break
    }
}
if (-not $adbPath) {
    $command = Get-Command adb.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) { $adbPath = $command.Source }
}
if (-not $adbPath) { throw 'adb.exe not found in vendor/platform-tools, Android SDK, or PATH.' }

$deviceArgs = @()
if (-not [string]::IsNullOrWhiteSpace($Serial)) { $deviceArgs = @('-s', $Serial) }

function Invoke-Adb {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $output = & $adbPath @deviceArgs @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $message = $output -join [Environment]::NewLine
    if ($exitCode -ne 0 -or $message -match '(?m)^(Error:|Error type \d|Exception occurred)') {
        throw "adb $($Arguments -join ' ') failed (exit $exitCode):`n$message"
    }
    $output
}

$package = 'com.phonectl.adbkeeper'
Invoke-Adb -Arguments @('get-state') | Out-Host
Invoke-Adb -Arguments @('install', '-r', $apkPath) | Out-Host
Invoke-Adb -Arguments @('shell', 'pm', 'grant', $package, 'android.permission.WRITE_SECURE_SETTINGS') | Out-Host
$sdkLevel = [int]((Invoke-Adb -Arguments @('shell', 'getprop', 'ro.build.version.sdk')) -join '').Trim()
if ($sdkLevel -ge 33) {
    Invoke-Adb -Arguments @('shell', 'pm', 'grant', $package, 'android.permission.POST_NOTIFICATIONS') | Out-Host
}
Invoke-Adb -Arguments @('shell', 'cmd', 'deviceidle', 'whitelist', "+$package") | Out-Host
Invoke-Adb -Arguments @('shell', 'am', 'start-foreground-service', '-n', "$package/.KeeperService") | Out-Host
# Allow onStartCommand to apply the setting before reading it back.
Start-Sleep -Seconds 1
$enabled = (Invoke-Adb -Arguments @('shell', 'settings', 'get', 'global', 'adb_wifi_enabled')) -join ''
Write-Host "adb_wifi_enabled=$($enabled.Trim())"
if ($enabled.Trim() -ne '1') {
    throw 'Wireless debugging is not enabled. Check adb logcat -s adbkeeper and ROM autostart settings.'
}
