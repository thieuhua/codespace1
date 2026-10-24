# OAuth cho VPS MCP (Claude custom connector)

Dịch vụ `vps-mcp-oauth` đứng trước gateway (`127.0.0.1:8765`) để Claude trên web/di động kết nối được từ internet. Nó thêm OAuth 2.1 (đăng ký client động, PKCE, refresh token xoay vòng); chủ sở hữu phê duyệt bằng **mật khẩu + TOTP**. **Không sửa** `gateway.py`, `worker.py`, `broker.py`, nên đường Claude Desktop (SSH tunnel) và tunnel OpenAI giữ nguyên.

```
claude.ai ──HTTPS──► nginx/Cloudflare ──► 127.0.0.1:8770 vps-mcp-oauth ──► 127.0.0.1:8765 gateway ──► worker (sandbox)
                          (TLS)            OAuth + kiểm tra token            không có xác thực, chỉ localhost
```

## Cài đặt (SSH vào VPS, chạy bằng sudo)

Điều kiện: một tên miền riêng (ví dụ `mcp.example.com`) trỏ về VPS, chứng chỉ TLS cho tên đó, nginx đang chạy. Nếu dùng Cloudflare, chế độ SSL/TLS phải là **Full** hoặc **Full (strict)**.

```bash
git clone --quiet https://github.com/thieuhua/codespace1.git /tmp/cs1 && cd /tmp/cs1 && git checkout <commit-đã-ghim>
sudo bash vps-mcp/oauth/deploy/install-oauth.sh --public-url https://mcp.example.com
sudo bash vps-mcp/oauth/deploy/front-nginx.sh --host mcp.example.com --issue-cert [--cloudflare]
```

- `install-oauth.sh` chỉ **tạo mới**: user `mcp-oauth`, `/opt/vps-mcp/oauth`, `/etc/vps-mcp-oauth`, một unit systemd. Không restart `vps-mcp*`. Chạy lại an toàn (nâng cấp mã). Script hỏi mật khẩu (≥ 14 ký tự) và in khóa TOTP để thêm vào ứng dụng xác thực.
- `--issue-cert` tự xin chứng chỉ Let's Encrypt (certbot webroot) nếu chưa có chứng chỉ phủ tên miền; cần bản ghi DNS đã trỏ về VPS (Cloudflare: bật proxy cam). Thêm file `vps-mcp-oauth-acme.conf` (cổng 80, chỉ đường ACME) để gia hạn tự động.
- `front-nginx.sh` ghi **một** file `/etc/nginx/conf.d/vps-mcp-oauth.conf`, kiểm tra `nginx -t`, tự hoàn tác nếu lỗi, chỉ `reload`. Không có nginx: proxy `https://<tên miền>` tới `http://127.0.0.1:8770`, giữ nguyên `Host` và đặt `X-Real-IP` là địa chỉ người truy cập.
- Dùng Claude Code CLI với connector này: thêm `--allow-loopback`. Callback khác: `--extra-redirect <url>`.

## Triển khai hiện tại

- Tên miền `mcp.xuanthieu.site`, Cloudflare proxy cam (SSL Full), chứng chỉ Let's Encrypt cấp bằng `--issue-cert`, front-nginx chạy với `--cloudflare`.
- Nếu bật proxy cam trước khi xin chứng chỉ, `--issue-cert` vẫn qua được (đường ACME ở cổng 80 không bị chặn).
- Sau khi cài xong có thể xóa bản clone tạm (`/tmp/cs1`): dịch vụ chạy từ `/opt/vps-mcp/oauth`.

## Thêm connector

claude.ai → Settings → Connectors → Add custom connector → URL `https://mcp.example.com/mcp`. Khi bấm kết nối, trang `/owner/approve` hiện ra: nhập mật khẩu và mã TOTP để phê duyệt.

## Mô hình bảo mật và giới hạn

- Token cấp quyền **toàn bộ 16 tool**: đọc/ghi file, chạy lệnh trong sandbox của repo `codespace1`, git. `mcp-dev` có deploy key GitHub có quyền ghi, nên ai có token có thể push lên repo đó. Không có root; khởi động lại dịch vụ vẫn cần khóa duyệt riêng của broker.
- Chỉ chủ sở hữu duyệt được; mã TOTP dùng một lần. Sai quá 5 lần/15 phút theo địa chỉ hoặc 15 lần toàn cục thì khóa đăng nhập 15 phút (kẻ tấn công có thể gây khóa tạm thời, không ảnh hưởng token đang dùng).
- Access token 1 giờ; refresh token 30 ngày, xoay mỗi lần dùng. Dùng lại refresh token cũ (dấu hiệu bị đánh cắp) thu hồi cả phiên.
- Mã, token chỉ lưu dạng băm SHA-256. DB `0600` thuộc `mcp-oauth`. Chỉ cho phép đăng ký client có callback của Claude (`claude.ai`, `claude.com`).
- Log chỉ ghi tên tool và client, không ghi tham số lệnh.
- Header `Authorization` bị gỡ trước khi chuyển tiếp; chỉ loopback mới được tin `X-Real-IP`.
- Đã thử với claude.ai thật (web và di động): đăng ký client, duyệt owner và gọi tool đều chạy. Nếu một client khác bị từ chối đăng ký, `journalctl -u vps-mcp-oauth` in ra callback thật; thêm bằng `--extra-redirect`.

## Vận hành

```bash
journalctl -u vps-mcp-oauth -f                      # log đăng nhập, tool được gọi
sudo systemctl stop vps-mcp-oauth                   # ngắt ngay
sudo -u mcp-oauth /opt/vps-mcp/oauth/venv/bin/python /opt/vps-mcp/oauth/oauth_proxy.py \
     revoke-all --db /var/lib/vps-mcp-oauth/oauth.db   # thu hồi mọi token
sudo bash vps-mcp/oauth/deploy/install-oauth.sh --reset-owner   # đổi mật khẩu/TOTP
sudo bash vps-mcp/oauth/deploy/uninstall-oauth.sh [--purge]
```

Sự cố thường gặp: `502` = gateway hoặc dịch vụ chưa chạy; trang Cloudflare "challenge" hoặc `403` = tắt Bot Fight/WAF challenge cho tên miền này; callback bị từ chối = xem log ở trên.

## Kiểm thử

```bash
pip install -r requirements.txt
python -m unittest -v test_oauth_proxy      # 42 test: luồng OAuth, tấn công, cấu hình
PYTHONPATH=. python e2e_check.py            # gateway.py thật + client OAuth của SDK
bash -n deploy/*.sh
```
