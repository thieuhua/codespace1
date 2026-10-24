# Shared helpers; compatible with Windows PowerShell 5.1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Get-MailboxStateDir([string]$Value) {
    if (-not $Value) { $Value = $env:AGENT_MAILBOX_HOME }
    if (-not $Value) {
        if (-not $env:LOCALAPPDATA) { throw 'Specify -StateDir or AGENT_MAILBOX_HOME.' }
        $Value = Join-Path $env:LOCALAPPDATA 'agent-mailbox'
    }
    if (-not [System.IO.Path]::IsPathRooted($Value)) {
        $Value = Join-Path (Get-Location).ProviderPath $Value
    }
    $full = [System.IO.Path]::GetFullPath($Value)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) {
        $full = $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    }
    return $full
}

function Invoke-MailboxCommand([string]$Executable, [string[]]$Arguments, [bool]$Preview) {
    $quoted = @($Executable) + $Arguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
    Write-Host ('& ' + ($quoted -join ' '))
    if (-not $Preview) {
        $app = Get-Command $Executable -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $target = if ($app) { $app.Source } else { $Executable }
        & $target @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE" }
    }
}
