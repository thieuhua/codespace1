[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$StateDir, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'common.ps1')
$StateDir = Get-MailboxStateDir $StateDir
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$Preview = [bool]($WhatIfPreference -or $DryRun)
# Validate location before creating state or installing; Python enforces it again.
$candidate = $StateDir
while ($candidate) {
    if (Test-Path -LiteralPath (Join-Path $candidate '.git')) { throw 'State must be outside repositories.' }
    $candidate = Split-Path -Parent $candidate
}
if (-not (Test-Path -LiteralPath $Python)) {
    Invoke-MailboxCommand 'py' @('-3.11', '-m', 'venv', (Join-Path $ProjectRoot '.venv')) $Preview
}
Invoke-MailboxCommand $Python @('-m', 'pip', '--isolated', 'install', '--no-cache-dir', '-r', (Join-Path $ProjectRoot 'requirements.txt')) $Preview
Invoke-MailboxCommand $Python @('-m', 'pip', '--isolated', 'install', '--no-cache-dir', 'setuptools>=68', 'wheel') $Preview
Invoke-MailboxCommand $Python @('-m', 'pip', '--isolated', 'install', '--no-cache-dir', '--no-build-isolation', '--no-deps', '-e', $ProjectRoot) $Preview
$prefix = @('-I', '-m', 'agent_mailbox', '--state-dir', $StateDir, 'admin')
Invoke-MailboxCommand $Python ($prefix + @('init')) $Preview
foreach ($principal in @('codex', 'antigravity')) {
    Invoke-MailboxCommand $Python ($prefix + @('add-principal', $principal, '--if-missing')) $Preview
}
Invoke-MailboxCommand $Python ($prefix + @('create-shared-session', '--owner', 'codex', '--participant', 'antigravity', '--mailbox', 'collab')) $Preview
