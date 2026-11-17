# Cài mailbot agent thành Scheduled Task chạy ẩn khi đăng nhập (user hiện tại, không cần admin).
#   powershell -ExecutionPolicy Bypass -File install-agent.ps1            # cài và chạy ngay
#   powershell -ExecutionPolicy Bypass -File install-agent.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$TaskName = 'mailbot-agent'

function Stop-Agent {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    # Task Scheduler chỉ dừng conhost; dừng luôn node đang chạy mailbot-agent.mjs.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*mailbot-agent.mjs*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
    Stop-Agent
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Removed $TaskName"
    return
}

$node = (Get-Command node.exe).Source
$script = Join-Path $PSScriptRoot 'mailbot-agent.mjs'
if (-not (Test-Path (Join-Path $env:USERPROFILE '.mailbot\agent.json'))) {
    throw 'Missing ~/.mailbot/agent.json'
}

# conhost --headless: chạy tiến trình console không hiện cửa sổ.
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
    -Argument "--headless `"$node`" `"$script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Stop-Agent
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started $TaskName (log: ~/.mailbot/agent.log)"
