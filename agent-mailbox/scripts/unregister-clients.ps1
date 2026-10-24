[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('all', 'codex', 'antigravity')][string]$Client = 'all',
    [switch]$DryRun
)
. (Join-Path $PSScriptRoot 'common.ps1')
$Preview = [bool]($WhatIfPreference -or $DryRun)
if ($Client -eq 'all' -or $Client -eq 'codex') {
    Invoke-MailboxCommand 'codex' @('mcp', 'remove', 'agent_mailbox') $Preview
}
if ($Client -eq 'all' -or $Client -eq 'antigravity') {
    Invoke-MailboxCommand 'agy' @('mcp', 'remove', 'agent_mailbox') $Preview
}
