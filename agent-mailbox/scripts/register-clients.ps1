[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$StateDir,
    [ValidateSet('all', 'codex', 'antigravity')][string]$Client = 'all',
    [switch]$DryRun
)
. (Join-Path $PSScriptRoot 'common.ps1')
$StateDir = Get-MailboxStateDir $StateDir
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$Preview = [bool]($WhatIfPreference -or $DryRun)
if (-not $Preview -and -not (Test-Path -LiteralPath $Python)) { throw 'Run setup.ps1 first.' }
foreach ($principal in @('codex', 'antigravity')) {
    if ($Client -ne 'all' -and $Client -ne $principal) { continue }
    $tokenFile = Join-Path $StateDir ('tokens\' + $principal + '.token')
    if (-not $Preview -and -not (Test-Path -LiteralPath $tokenFile)) { throw "Missing token file for $principal; run setup.ps1." }
    $environmentArgs = @('--env', ('AGENT_MAILBOX_HOME=' + $StateDir), '--env', ('AGENT_MAILBOX_TOKEN_FILE=' + $tokenFile))
    $serverArgs = @($Python, '-I', '-m', 'agent_mailbox', 'serve')
    if ($principal -eq 'codex') {
        # codex-cli 0.164.0: command follows --. No raw token or broad approval bypass.
        Invoke-MailboxCommand 'codex' (@('mcp', 'add') + $environmentArgs + @('agent_mailbox', '--') + $serverArgs) $Preview
    } else {
        # agy requires every CLI flag BEFORE the server name.
        Invoke-MailboxCommand 'agy' (@('mcp', 'add') + $environmentArgs + @('agent_mailbox') + $serverArgs) $Preview
    }
}
