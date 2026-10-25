[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$StateDir, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'common.ps1')
$StateDir = Get-MailboxStateDir $StateDir
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$Preview = [bool]($WhatIfPreference -or $DryRun)
$argv = @('-I', '-m', 'agent_mailbox', '--state-dir', $StateDir, 'router', 'ctl', 'shutdown', '--json')
if ($Preview) { Invoke-MailboxCommand $Python $argv $true; return }
$PidFile = Join-Path $StateDir 'router.pid.json'
if (-not (Test-Path -LiteralPath $PidFile)) { throw 'No router PID file; stop the foreground server with Ctrl+C.' }
$record = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) { Write-Host 'Router is already stopped.'; return }
if ($process.StartTime.ToUniversalTime().ToString('o') -ne $record.started -or $process.Path -ne $record.python) {
    throw 'PID identity changed; refusing to stop another process.'
}
Invoke-MailboxCommand $Python $argv $false
if (-not $process.WaitForExit(15000)) { throw 'Graceful shutdown timed out; inspect logs. No forced termination performed.' }
Write-Host 'Router stopped; pending polls were woken.'
