# Bước 2 (cần admin / UAC): ghi cấu hình WireGuard, cài tunnel service, mở tường lửa.
#   powershell -ExecutionPolicy Bypass -File 2-install.ps1 -ServerPublicKey <key> -KeyFile <path>
# Gỡ: 2-install.ps1 -Uninstall
param(
    [string]$ServerPublicKey,
    [string]$KeyFile,
    [string]$Endpoint = '103.195.237.148:51821',
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$name    = 'wg-lap'
$dir     = 'C:\ProgramData\laptop-tunnel'
$conf    = Join-Path $dir "$name.conf"
$log     = Join-Path $env:LOCALAPPDATA 'laptop-tunnel\install.log'  # log không chứa khóa, user đọc được
$wgui    = 'C:\Program Files\WireGuard\wireguard.exe'
$fwGroup = 'laptop-tunnel'

New-Item -ItemType Directory -Force $dir | Out-Null
Start-Transcript -Path $log -Force | Out-Null
try {
    if ($Uninstall) {
        & $wgui /uninstalltunnelservice $name
        Get-NetFirewallRule -Group $fwGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        Remove-Item $conf -Force -ErrorAction SilentlyContinue
        'Đã gỡ.'; return
    }
    if ($ServerPublicKey -notmatch '^[A-Za-z0-9+/]{43}=$') { throw 'ServerPublicKey không hợp lệ' }
    $priv = (Get-Content $KeyFile -Raw).Trim()

    # Thư mục chỉ SYSTEM + Administrators truy cập
    icacls $dir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

    @"
[Interface]
PrivateKey = $priv
Address = 10.89.0.2/24

[Peer]
PublicKey = $ServerPublicKey
Endpoint = $Endpoint
AllowedIPs = 10.89.0.1/32
PersistentKeepalive = 25
"@ | Set-Content -Path $conf -Encoding ascii

    if (Get-Service "WireGuardTunnel`$$name" -ErrorAction SilentlyContinue) {
        & $wgui /uninstalltunnelservice $name; Start-Sleep 3
    }
    & $wgui /installtunnelservice $conf
    Start-Sleep 3

    # Chỉ cho VPS (10.89.0.1, đã SNAT) vào dải cổng 20000-20099
    Get-NetFirewallRule -Group $fwGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    foreach ($p in 'TCP','UDP') {
        New-NetFirewallRule -DisplayName "laptop-tunnel $p 20000-20099" -Group $fwGroup `
            -Direction Inbound -Action Allow -Protocol $p -LocalPort '20000-20099' `
            -RemoteAddress '10.89.0.1' -Profile Any | Out-Null
    }
    # Cho phép ping từ VPS qua hầm (để kiểm tra)
    New-NetFirewallRule -DisplayName 'laptop-tunnel ICMP' -Group $fwGroup -Direction Inbound `
        -Action Allow -Protocol ICMPv4 -IcmpType 8 -RemoteAddress '10.89.0.1' -Profile Any | Out-Null

    Remove-Item $KeyFile -Force
    Get-Service "WireGuardTunnel`$$name" | Format-Table Name, Status, StartType
    'XONG'
} catch {
    "LỖI: $_"
} finally {
    Stop-Transcript | Out-Null
}
