#Requires -Version 5.1
# Windows port of build_without_gradle.sh: builds build\scrcpy-server (a dex jar).
[CmdletBinding()]
param(
    [string]$AndroidHome = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'E:\Android\Sdk' }),
    [string]$Platform = '36',
    [string]$BuildTools = '36.0.0',
    [string]$VersionName = '5.0.1',
    [switch]$DebugBuild
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serverDir = $PSScriptRoot
$buildDir = Join-Path $serverDir 'build'
$classesDir = Join-Path $buildDir 'classes'
$genDir = Join-Path $buildDir 'gen'
$output = Join-Path $buildDir 'scrcpy-server'
$platformDir = Join-Path $AndroidHome "platforms\android-$Platform"
$toolsDir = Join-Path $AndroidHome "build-tools\$BuildTools"
$androidJar = Join-Path $platformDir 'android.jar'
$frameworkAidl = Join-Path $platformDir 'framework.aidl'
$lambdaJar = Join-Path $toolsDir 'core-lambda-stubs.jar'
foreach ($required in @($androidJar, $frameworkAidl, $lambdaJar, (Join-Path $toolsDir 'aidl.exe'), (Join-Path $toolsDir 'd8.bat'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing: $required" }
}

function Invoke-Tool {
    param([string]$File, [string[]]$Arguments)
    # Native stderr (javac warnings) must not abort the build under ErrorActionPreference=Stop.
    $ErrorActionPreference = 'Continue'
    & $File @Arguments 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^warning: \[options\]' } | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($File)) failed (exit $LASTEXITCODE)" }
}

foreach ($dir in @($classesDir, $genDir)) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } }
if (Test-Path $output) { Remove-Item -Force $output }
New-Item -ItemType Directory -Force (Join-Path $genDir 'com\genymobile\scrcpy'), $classesDir | Out-Null

$debug = if ($DebugBuild) { 'true' } else { 'false' }
@"
package com.genymobile.scrcpy;

public final class BuildConfig {
  public static final boolean DEBUG = $debug;
  public static final String VERSION_NAME = "$VersionName";
}
"@ | Set-Content -Encoding ASCII (Join-Path $genDir 'com\genymobile\scrcpy\BuildConfig.java')

Write-Host 'Generating java from aidl...'
# aidl.exe on Windows only matches the package directory with absolute backslash paths.
$aidlRoot = (Resolve-Path (Join-Path $serverDir 'src\main\aidl')).Path
$aidl = Join-Path $toolsDir 'aidl.exe'
Invoke-Tool $aidl @("-o$genDir", "-I$aidlRoot", (Join-Path $aidlRoot 'android\content\IOnPrimaryClipChangedListener.aidl'))
Invoke-Tool $aidl @("-o$genDir", "-I$aidlRoot", '-p', $frameworkAidl, (Join-Path $aidlRoot 'android\view\IDisplayWindowListener.aidl'))

Write-Host 'Compiling java sources...'
$javaRoot = Join-Path $serverDir 'src\main\java'
$sources = @(Get-ChildItem -Path $javaRoot -Recurse -Filter *.java | ForEach-Object FullName)
$sources += @(Get-ChildItem -Path $genDir -Recurse -Filter *.java | Where-Object { $_.FullName -notlike '*BuildConfig.java' } | ForEach-Object FullName)
$argFile = Join-Path $buildDir 'sources.txt'
# javac @argfile treats backslash as an escape: use forward slashes and quote each path.
$sources | ForEach-Object { '"' + ($_ -replace '\\', '/') + '"' } | Set-Content -Encoding ASCII $argFile
Invoke-Tool 'javac' @('-encoding', 'UTF-8', '-bootclasspath', $androidJar,
    '-cp', "$lambdaJar;$genDir", '-d', $classesDir, '-source', '1.8', '-target', '1.8',
    '-Xlint:-options', "@$argFile")

Write-Host 'Dexing...'
$classes = @(Get-ChildItem -Path $classesDir -Recurse -Filter *.class | ForEach-Object FullName)
$classList = Join-Path $buildDir 'classes.txt'
$classes | Set-Content -Encoding ASCII $classList
$zip = Join-Path $buildDir 'classes.zip'
Invoke-Tool (Join-Path $toolsDir 'd8.bat') @('--classpath', $androidJar, '--min-api', '21', '--output', $zip, "@$classList")
Move-Item -Force $zip $output
Remove-Item -Recurse -Force $classesDir, $genDir, $argFile, $classList
Write-Host "Server generated in $output"
