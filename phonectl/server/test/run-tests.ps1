#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$testDir = $PSScriptRoot
$serverDir = Split-Path -Parent $testDir
$outDir = Join-Path $testDir 'build'
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force $outDir | Out-Null

try {
    $policyJava = Join-Path $serverDir 'src\main\java\com\genymobile\scrcpy\video\CongestionPolicy.java'
    $testJava = Join-Path $testDir 'CongestionPolicyTest.java'

    & javac -encoding UTF-8 -d $outDir $policyJava $testJava
    if ($LASTEXITCODE -ne 0) { throw "javac failed (exit $LASTEXITCODE)" }

    & java -cp $outDir com.genymobile.scrcpy.video.CongestionPolicyTest
    if ($LASTEXITCODE -ne 0) { throw "CongestionPolicyTest failed (exit $LASTEXITCODE)" }
} finally {
    if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
}
