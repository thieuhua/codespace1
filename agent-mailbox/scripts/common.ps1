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
    return [System.IO.Path]::GetFullPath($Value)
}

function Invoke-MailboxCommand([string]$Executable, [string[]]$Arguments, [bool]$Preview) {
    $quoted = @($Executable) + $Arguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
    Write-Host ('& ' + ($quoted -join ' '))
    if (-not $Preview) {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE" }
    }
}
