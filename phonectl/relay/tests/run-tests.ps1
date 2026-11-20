#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $PSScriptRoot 'build'
# Build a private copy: the real relay\build\phonectl-relay.exe may be running in a live session.
& (Join-Path $root 'build.ps1') -OutputDir $output
[void][IO.Directory]::CreateDirectory($output)
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /langversion:5 /main:PhoneCtl.Tests /target:exe "/out:$output\relay-tests.exe" (Join-Path $root 'CertificateFactory.cs') (Join-Path $root 'Relay.cs') (Join-Path $PSScriptRoot 'RelayTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
& (Join-Path $output 'relay-tests.exe') (Join-Path $output 'phonectl-relay.exe') $output
if ($LASTEXITCODE -ne 0) { throw 'Relay tests failed.' }
