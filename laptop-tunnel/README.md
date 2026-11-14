# Laptop Tunnel

Đưa dịch vụ TCP/UDP chạy trên laptop Windows ra Internet qua VPS, bằng đường hầm WireGuard.
Không cần DDNS: DNS trỏ cố định về IP tĩnh của VPS, laptop tự nối ra VPS (vượt NAT/CGNAT).

```
Client ──► laptop.xuanthieu.site:20000-20099 (Cloudflare DNS-only → 103.195.237.148)
              │ VPS: nftables DNAT (giữ nguyên số cổng) + SNAT 10.89.0.1
              ▼ WireGuard wg-lap, UDP 51821
           Laptop 10.89.0.2:20000-20099 (Windows hoặc Docker publish cổng)
```

| Thành phần | Giá trị |
| --- | --- |
| Tên miền | `laptop.xuanthieu.site` (A → 103.195.237.148, **DNS only**, mây xám) |
| Interface | `wg-lap` cả hai đầu; VPS `10.89.0.1`, laptop `10.89.0.2` |
| Cổng WireGuard | UDP 51821 trên VPS (`wg0`/51820 có sẵn, không đụng tới) |
| Dải cổng chuyển tiếp | TCP + UDP 20000–20099, 1:1 |

## Dùng hằng ngày

Chạy dịch vụ trên laptop ở một cổng trong 20000–20099, nghe trên `0.0.0.0` (hoặc `10.89.0.2`).
Từ bất kỳ đâu: `laptop.xuanthieu.site:<cổng>`. Không cần sudo hay sửa VPS.

- Docker: `docker run -p 20080:80 ...` là đủ.
- Lưu ý: dịch vụ thấy IP nguồn là `10.89.0.1` (do SNAT), không thấy IP thật của client.
- Lần đầu chạy một app, nếu Windows hỏi tường lửa và bạn bấm *Block*, Windows tạo luật chặn đè luật cho phép; xóa luật chặn đó trong *Windows Defender Firewall*.
- Trạng thái hầm: `wg show` (PowerShell admin) hoặc mở ứng dụng WireGuard, tunnel `wg-lap`.

## Cài đặt (đã thực hiện)

1. `windows/1-genkey.ps1`: tạo khóa laptop (không cần admin), in public key.
2. `vps/setup-vps.sh`: chạy trên VPS bằng `sudo bash setup-vps.sh <laptop_pubkey>`; tạo `wg-lap`, NAT nftables,
   luật ufw, `ip_forward`, bật `wg-quick@wg-lap`. Ghi public key server vào `~/laptop-tunnel/server.pub`.
3. `windows/2-install.ps1 -ServerPublicKey <key> -KeyFile <đường dẫn khóa>` (admin): ghi cấu hình vào
   `C:\ProgramData\laptop-tunnel\wg-lap.conf` (chỉ SYSTEM/Administrators đọc được), cài tunnel service
   tự khởi động, mở tường lửa Windows cho dải cổng chỉ từ `10.89.0.1`.
4. Cloudflare: bản ghi A `laptop` → `103.195.237.148`, DNS only.

## Kiểm thử

Đã kiểm thử 2026-11-14: TCP 20000 và UDP 20001 qua `laptop.xuanthieu.site` trả echo đúng,
server thấy nguồn `10.89.0.1`; ping hai chiều qua hầm ~50 ms.

```powershell
python windows/test-echo.py          # mở TCP 20000 + UDP 20001 trên laptop
python windows/test-echo.py --client laptop.xuanthieu.site   # đi vòng qua Internet → VPS → hầm
```

## Gỡ bỏ

- VPS: `sudo bash ~/laptop-tunnel/setup-vps.sh --uninstall`
- Windows (admin): `windows/2-install.ps1 -Uninstall`
- Xóa bản ghi DNS `laptop` trên Cloudflare.
