#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $root 'build.ps1')
$output = Join-Path $PSScriptRoot 'build'
[void][IO.Directory]::CreateDirectory($output)
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /langversion:5 /main:PhoneCtl.Tests /target:exe "/out:$output\relay-tests.exe" (Join-Path $root 'CertificateFactory.cs') (Join-Path $root 'Relay.cs') (Join-Path $PSScriptRoot 'RelayTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
& (Join-Path $output 'relay-tests.exe') (Join-Path $root 'build\phonectl-relay.exe') $output
if ($LASTEXITCODE -ne 0) { throw 'Relay tests failed.' }
