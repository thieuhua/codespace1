#requires -Version 5.1
[CmdletBinding()]
param([string]$OutputDir)
$ErrorActionPreference = 'Stop'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw "Missing compiler: $compiler" }
# $PSScriptRoot is empty inside param() defaults on Windows PowerShell 5.1.
$output = if ($OutputDir) { $OutputDir } else { Join-Path $PSScriptRoot 'build' }
[void][IO.Directory]::CreateDirectory($output)
& $compiler /nologo /langversion:5 /optimize+ /target:exe "/out:$output\phonectl-relay.exe" (Join-Path $PSScriptRoot 'CertificateFactory.cs') (Join-Path $PSScriptRoot 'Relay.cs')
if ($LASTEXITCODE -ne 0) { throw "Relay compilation failed (exit $LASTEXITCODE)." }
