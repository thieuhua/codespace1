#requires -Version 5.1
[CmdletBinding()]
param([string]$SdkPath)

$ErrorActionPreference = 'Stop'
$roots = @('E:\Android\Sdk', $env:ANDROID_HOME)
if ($SdkPath) { $roots = @($SdkPath) }
$source = $null
foreach ($root in $roots) {
    if (-not $root) { continue }
    $candidate = Join-Path $root 'platform-tools'
    if (Test-Path -LiteralPath (Join-Path $candidate 'adb.exe') -PathType Leaf) {
        $source = (Get-Item -LiteralPath $candidate).FullName
        break
    }
}
if (-not $source) { throw 'SDK platform-tools not found. Use -SdkPath <Android SDK root>. No downloads are performed.' }
foreach ($required in @('adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) {
        throw "Incomplete SDK platform-tools: missing $required in $source"
    }
}
$destination = Join-Path (Split-Path -Parent $PSScriptRoot) 'vendor\platform-tools'
if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $destination)
}
Copy-Item -LiteralPath (Join-Path $source 'adb.exe') -Destination $destination
# Include runtime DLLs shipped by this SDK, preserving any subdirectories.
foreach ($dll in @(Get-ChildItem -LiteralPath $source -Filter '*.dll' -File -Recurse)) {
    $relative = $dll.FullName.Substring($source.Length).TrimStart('\')
    $target = Join-Path $destination $relative
    $targetDirectory = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $targetDirectory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $targetDirectory)
    }
    Copy-Item -LiteralPath $dll.FullName -Destination $target
}
Write-Host "Copied SDK adb and DLLs from $source to $destination"
