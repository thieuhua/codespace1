[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$StateDir,
    [string]$BindHost = '127.0.0.1',
    [ValidateRange(1, 65535)][int]$Port = 8766,
    [ValidateRange(0, 300)][double]$HoldSeconds = 50,
    [switch]$AllowNonLoopback,
    [switch]$DryRun
)
. (Join-Path $PSScriptRoot 'common.ps1')
$StateDir = Get-MailboxStateDir $StateDir
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$Preview = [bool]($WhatIfPreference -or $DryRun)
$argv = @('-I', '-m', 'agent_mailbox', '--state-dir', $StateDir, 'router', 'serve', '--host', $BindHost,
          '--port', [string]$Port, '--hold-seconds', $HoldSeconds.ToString([Globalization.CultureInfo]::InvariantCulture))
if ($AllowNonLoopback) { $argv += '--allow-non-loopback' }
if ($Preview) {
    Invoke-MailboxCommand $Python $argv $true
    Write-Host "Background PID/logs: $StateDir\router.pid.json, router.stdout.log, router.stderr.log"
    return
}
if (-not (Test-Path -LiteralPath $Python)) { throw 'Run setup.ps1 first.' }
# Python validates repository exclusion, links, state and bind before any writes.
& $Python -I -c 'import sys; from agent_mailbox.paths import state_home,safe_path; from agent_mailbox.router import validate_bind; h=state_home(sys.argv[1]); validate_bind(sys.argv[2],sys.argv[3]==''True''); assert (h/''mailbox.db'').is_file(); [safe_path(h/n,file=True) for n in (''router.pid.json'',''router.stdout.log'',''router.stderr.log'')]' $StateDir $BindHost ([string][bool]$AllowNonLoopback)
if ($LASTEXITCODE -ne 0) { throw 'Invalid state or binding.' }
$PidFile = Join-Path $StateDir 'router.pid.json'
if (Test-Path -LiteralPath $PidFile) {
    $old = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
    $existing = Get-Process -Id $old.pid -ErrorAction SilentlyContinue
    if ($existing -and $existing.StartTime.ToUniversalTime().ToString('o') -eq $old.started) { throw 'Router is already running.' }
}
# Explicit stdio handles + close_fds prevent a background process retaining the
# caller's capture pipes. CREATE_NO_WINDOW hides the helper/server on Windows.
# Python Popen also preserves argv without Start-Process's string re-joining or
# PS 5.1's duplicate inherited execution-policy environment-key failure.
$launched = & $Python -I -c 'import subprocess,sys; from pathlib import Path; h=Path(sys.argv[1]); p=subprocess.Popen(sys.argv[2:],cwd=h,stdin=subprocess.DEVNULL,stdout=open(h/''router.stdout.log'',''w''),stderr=open(h/''router.stderr.log'',''w''),close_fds=True,creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP); print(p.pid)' $StateDir $Python @argv
if ($LASTEXITCODE -ne 0) { throw 'Unable to launch background router.' }
$process = Get-Process -Id ([int]$launched)
@{pid=$process.Id; started=$process.StartTime.ToUniversalTime().ToString('o'); python=$Python; state_dir=$StateDir} |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $PidFile -Encoding UTF8
Start-Sleep -Milliseconds 1200
$process.Refresh()
if ($process.HasExited) { throw 'Router failed to start; inspect router.stderr.log.' }
Write-Host "Router PID $($process.Id): http://${BindHost}:$Port/mcp; logs in $StateDir"
