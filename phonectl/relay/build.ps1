#requires -Version 5.1
[CmdletBinding()]
param([string]$OutputDir = (Join-Path $PSScriptRoot 'build'))
$ErrorActionPreference = 'Stop'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw "Missing compiler: $compiler" }
$output = $OutputDir
[void][IO.Directory]::CreateDirectory($output)
& $compiler /nologo /langversion:5 /optimize+ /target:exe "/out:$output\phonectl-relay.exe" (Join-Path $PSScriptRoot 'CertificateFactory.cs') (Join-Path $PSScriptRoot 'Relay.cs')
if ($LASTEXITCODE -ne 0) { throw "Relay compilation failed (exit $LASTEXITCODE)." }
