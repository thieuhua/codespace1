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
**Cổng ngoài dải này không đi qua tunnel** (VPS không DNAT, ufw và tường lửa Windows chặn), client sẽ timeout.
Ví dụ: MQTT TLS của dự án IoT dùng `20083`.
Từ bất kỳ đâu: `laptop.xuanthieu.site:<cổng>`. Không cần sudo hay sửa VPS.

- Docker: `docker run -p 20080:80 ...` là đủ.
- Lưu ý: dịch vụ thấy IP nguồn là `10.89.0.1` (do SNAT), không thấy IP thật của client.
- Lần đầu chạy một app, nếu Windows hỏi tường lửa và bạn bấm *Block*, Windows tạo luật chặn đè luật cho phép; xóa luật chặn đó trong *Windows Defender Firewall*.
- Trạng thái hầm: `wg show` (PowerShell admin) hoặc mở ứng dụng WireGuard, tunnel `wg-lap`.

## HTTPS subdomain cho dịch vụ web

```
Trình duyệt ──► https://<tên>.xuanthieu.site (Cloudflare proxy, DNS wildcard * → VPS)
                  │ nginx VPS: chứng chỉ Origin CA *.xuanthieu.site, ánh xạ tên → cổng (apps.map)
                  ▼ hầm wg-lap
               Laptop 10.89.0.2:<cổng 20000-20099>
```

Từ Windows, không cần sudo:

```powershell
ssh thieuhua-vps1 lap-web add app 20080   # https://app.xuanthieu.site -> laptop:20080
ssh thieuhua-vps1 lap-web list
ssh thieuhua-vps1 lap-web rm app
```

- `lap-web` sửa `/etc/nginx/laptop-apps/apps.map`; unit `laptop-apps-reload.path` tự chạy `nginx -t` rồi reload.
- Tên đã có site riêng (`blindnav`, `mcp`, `simulator`...) hoặc dành riêng (`www`, `file`, `laptop`) bị từ chối;
  tên chưa đăng ký trả 404. HTTP tự chuyển sang HTTPS. Hỗ trợ WebSocket, upload tối đa 100 MB.
- Dịch vụ nhận `X-Forwarded-For`/`X-Real-IP` là IP thật của người truy cập (nginx lấy từ `CF-Connecting-IP`).
- Cài một lần: `sudo bash setup-web.sh` (cần `tls/wildcard.{key,crt}` + `lap-web` trong `~/laptop-tunnel`).
  Khóa riêng được tạo trên VPS (`openssl`), Cloudflare chỉ nhận CSR; chứng chỉ hết hạn 2041-11-10.
- 504 = dịch vụ trên laptop chưa chạy hoặc laptop/hầm đang tắt.

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
`https://demo.xuanthieu.site` → laptop:20000 trả 200 qua Cloudflare, chứng chỉ hợp lệ; HTTP → 301 HTTPS;
tên chưa đăng ký → 404; các site cũ (blindnav, simulator) giữ nguyên chứng chỉ và phản hồi.

```powershell
python windows/test-echo.py          # mở TCP 20000 + UDP 20001 trên laptop
python windows/test-echo.py --client laptop.xuanthieu.site   # đi vòng qua Internet → VPS → hầm
```

## Gỡ bỏ

- HTTPS subdomain: `sudo bash ~/laptop-tunnel/setup-web.sh --uninstall`, xóa bản ghi DNS `*`.
- VPS: `sudo bash ~/laptop-tunnel/setup-vps.sh --uninstall`
- Windows (admin): `windows/2-install.ps1 -Uninstall`
- Xóa bản ghi DNS `laptop` trên Cloudflare.
