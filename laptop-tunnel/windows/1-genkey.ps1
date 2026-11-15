# Bước 1 (không cần admin): tạo khóa WireGuard cho laptop, chỉ in public key.
# Private key nằm ở %LOCALAPPDATA%\laptop-tunnel\laptop.key (chỉ user hiện tại đọc được),
# bước 2 sẽ chuyển nó vào cấu hình được bảo vệ rồi xóa bản này.
$ErrorActionPreference = 'Stop'
$wg = 'C:\Program Files\WireGuard\wg.exe'
$dir = Join-Path $env:LOCALAPPDATA 'laptop-tunnel'
$key = Join-Path $dir 'laptop.key'
New-Item -ItemType Directory -Force $dir | Out-Null
if (-not (Test-Path $key)) {
    $priv = & $wg genkey
    [IO.File]::WriteAllText($key, $priv)
}
(Get-Content $key -Raw).Trim() | & $wg pubkey
