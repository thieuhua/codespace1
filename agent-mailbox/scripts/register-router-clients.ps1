[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$StateDir,
    [string]$CodexTokenFile,
    [string]$AntigravityTokenFile,
    [string]$Url = 'http://127.0.0.1:8766/mcp',
    [ValidateSet('all', 'codex', 'antigravity')][string]$Client = 'all',
    [switch]$DryRun
)
. (Join-Path $PSScriptRoot 'common.ps1')
$StateDir = Get-MailboxStateDir $StateDir
$Preview = [bool]($WhatIfPreference -or $DryRun)
$endpoint = [Uri]$Url
if ($endpoint.Scheme -ne 'http' -or -not $endpoint.IsLoopback -or $endpoint.AbsolutePath -ne '/mcp' -or $endpoint.UserInfo) {
    throw 'Router URL must be an HTTP loopback /mcp endpoint.'
}
if ($Client -eq 'all' -or $Client -eq 'codex') {
    $tokenFile = Get-MailboxTokenFile $CodexTokenFile $StateDir 'codex'
    Invoke-MailboxCommand 'codex' @('mcp', 'add', 'agent_mailbox', '--url', $Url, '--bearer-token-env-var', 'AGENT_MAILBOX_ROUTER_TOKEN') $Preview
    Write-Host "Before launching Codex, set AGENT_MAILBOX_ROUTER_TOKEN from $tokenFile (see README)."
}
if ($Client -eq 'all' -or $Client -eq 'antigravity') {
    $tokenFile = Get-MailboxTokenFile $AntigravityTokenFile $StateDir 'antigravity'
    Invoke-MailboxCommand 'agy' @('mcp', 'add', '--header', 'Authorization: Bearer <redacted>', 'agent_mailbox', $Url) $true
    if (-not $Preview) {
        $token = (Get-Content -LiteralPath $tokenFile -Raw -Encoding UTF8).Trim()
        if ($token -notmatch '^amb1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$') { throw 'Invalid Antigravity token file.' }
        # Do not send the secret through the command-printing helper.
        & agy mcp add --header ("Authorization: Bearer " + $token) agent_mailbox $Url
        if ($LASTEXITCODE -ne 0) { throw "agy registration failed with exit code $LASTEXITCODE" }
        $token = $null
    }
    Write-Host 'Antigravity stores the Authorization header token in plaintext in its config.'
}
