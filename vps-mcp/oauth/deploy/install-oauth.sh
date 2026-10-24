#!/usr/bin/env bash
# Owner SSH only:  sudo bash install-oauth.sh --public-url https://mcp.example.com
#
# Adds the OAuth front door (127.0.0.1:8770) in front of the existing gateway so Claude custom
# connectors can authenticate. It creates NEW things only (user, directories, venv, one systemd
# unit) and never restarts or edits vps-mcp, vps-mcp-dev, vps-mcp-approval or the tunnel.
# Re-running is safe: it upgrades the code/unit and restarts only vps-mcp-oauth.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Chạy bằng sudo (qua SSH của chủ sở hữu)." >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(cd "$here/.." && pwd)"
app=/opt/vps-mcp/oauth
cfg=/etc/vps-mcp-oauth
unit=/etc/systemd/system/vps-mcp-oauth.service
public_url="${PUBLIC_URL:-}"
reset_owner=0
loopback=""
extra=""

while [ $# -gt 0 ]; do
  case "$1" in
    --public-url) public_url="${2:?thiếu giá trị cho --public-url}"; shift 2 ;;
    --reset-owner) reset_owner=1; shift ;;
    --allow-loopback) loopback=1; shift ;;   # also accept http://localhost:PORT callbacks (Claude Code CLI)
    --extra-redirect) extra="${extra:+$extra,}${2:?thiếu URL}"; shift 2 ;;  # extra OAuth callback URL to allow (repeatable)
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Tham số lạ: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$public_url" ] && [ -f "$cfg/oauth.env" ]; then
  public_url="$(sed -n 's/^OAUTH_PUBLIC_URL=//p' "$cfg/oauth.env")"
fi
if [ -z "$public_url" ]; then
  read -r -p "Địa chỉ công khai của connector (ví dụ https://mcp.example.com): " public_url </dev/tty
fi
public_url="${public_url%/}"
[[ "$public_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || {
  echo "OAUTH public URL phải có dạng https://ten-mien (không có đường dẫn): '$public_url'" >&2; exit 1; }

echo "== 1/7 Kiểm tra điều kiện"
command -v python3 >/dev/null || { echo "Thiếu python3" >&2; exit 1; }
python3 - <<'PY' || { echo "Cần Python >= 3.11 và gói python3-venv (apt install python3-venv)" >&2; exit 1; }
import sys, venv, ensurepip
sys.exit(0 if sys.version_info >= (3, 11) else 1)
PY
probe='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"installer","version":"0"}}}'
reply="$(curl -fsS -m 8 -X POST http://127.0.0.1:8765/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d "$probe" || true)"
grep -q 'vps-operations' <<<"$reply" \
  || { echo "Gateway không trả lời ở 127.0.0.1:8765 (systemctl status vps-mcp)." >&2; exit 1; }
if ss -tln | grep -qE '127\.0\.0\.1:8770[[:space:]]' && ! systemctl is-active --quiet vps-mcp-oauth; then
  echo "Cổng 8770 đang bị dịch vụ khác giữ." >&2; exit 1
fi
echo "   gateway OK, public URL: $public_url"

echo "== 2/7 Tài khoản dịch vụ"
getent passwd mcp-oauth >/dev/null || \
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin mcp-oauth

echo "== 3/7 Cài mã nguồn (root sở hữu, dịch vụ không ghi được)"
install -d -m 0755 -o root -g root /opt/vps-mcp "$app"
install -m 0644 -o root -g root "$src/oauth_proxy.py" "$app/oauth_proxy.py"
install -m 0644 -o root -g root "$src/requirements.txt" "$app/requirements.txt"
[ -x "$app/venv/bin/python" ] || python3 -m venv "$app/venv"
"$app/venv/bin/pip" install --quiet --disable-pip-version-check -r "$app/requirements.txt"
chown -R root:root "$app"; chmod -R go-w "$app"
"$app/venv/bin/python" -c 'import mcp, starlette, uvicorn; print("   thư viện OK")'

echo "== 4/7 Cấu hình"
install -d -m 0750 -o root -g mcp-oauth "$cfg"
if [ -f "$cfg/oauth.env" ]; then   # a re-run keeps earlier customisations unless a flag overrides them
  cp -a "$cfg/oauth.env" "$cfg/oauth.env.bak"
  [ -n "$loopback" ] || loopback="$(sed -n 's/^OAUTH_ALLOW_LOOPBACK=//p' "$cfg/oauth.env")"
  [ -n "$extra" ] || extra="$(sed -n 's/^OAUTH_EXTRA_REDIRECT_URIS=//p' "$cfg/oauth.env")"
fi
loopback="${loopback:-0}"
[[ "$extra" =~ ^[A-Za-z0-9:/._?=\&%,-]*$ ]] || { echo "--extra-redirect chứa ký tự không hợp lệ" >&2; exit 1; }
umask 027
cat >"$cfg/oauth.env" <<EOF
OAUTH_PUBLIC_URL=$public_url
OAUTH_UPSTREAM=http://127.0.0.1:8765/mcp
OAUTH_LISTEN_HOST=127.0.0.1
OAUTH_LISTEN_PORT=8770
OAUTH_DB=/var/lib/vps-mcp-oauth/oauth.db
OAUTH_OWNER_FILE=$cfg/owner.json
OAUTH_ALLOW_LOOPBACK=$loopback
OAUTH_EXTRA_REDIRECT_URIS=$extra
OAUTH_CLIENT_IP_HEADER=x-real-ip
EOF
chown root:mcp-oauth "$cfg/oauth.env"; chmod 0640 "$cfg/oauth.env"
umask 022

echo "== 5/7 Thông tin đăng nhập chủ sở hữu (mật khẩu + TOTP)"
if [ ! -f "$cfg/owner.json" ] || [ "$reset_owner" -eq 1 ]; then
  [ -t 0 ] || { echo "Cần terminal tương tác để nhập mật khẩu (đừng chạy qua pipe)." >&2; exit 1; }
  force=(); [ "$reset_owner" -eq 1 ] && force=(--force)
  "$app/venv/bin/python" "$app/oauth_proxy.py" init-owner --file "$cfg/owner.json" --group mcp-oauth ${force[@]+"${force[@]}"}
  echo
  read -r -p "Đã thêm khóa TOTP vào ứng dụng xác thực? Nhấn Enter để tiếp tục... " _ </dev/tty
else
  echo "   giữ nguyên $cfg/owner.json (dùng --reset-owner để đổi)"
fi

echo "== 6/7 Dịch vụ systemd (chỉ vps-mcp-oauth)"
backup=/var/backups/vps-mcp; mkdir -p "$backup"
[ -f "$unit" ] && cp -a "$unit" "$backup/vps-mcp-oauth.service.$(date -u +%Y%m%dT%H%M%SZ)"
install -m 0644 -o root -g root "$here/vps-mcp-oauth.service" "$unit"
systemctl daemon-reload
systemctl enable vps-mcp-oauth.service >/dev/null
systemctl restart vps-mcp-oauth.service

echo "== 7/7 Tự kiểm tra qua localhost"
host="${public_url#https://}"; host="${host%%:*}"
fail() { echo "   THẤT BẠI: $1" >&2; journalctl -u vps-mcp-oauth -n 25 --no-pager >&2 || true; exit 1; }
for _ in $(seq 1 30); do curl -fsS -m 2 -H "Host: $host" http://127.0.0.1:8770/healthz >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS -m 5 -H "Host: $host" http://127.0.0.1:8770/healthz >/dev/null || fail "dịch vụ không lên"
meta="$(curl -fsS -m 5 -H "Host: $host" http://127.0.0.1:8770/.well-known/oauth-protected-resource/mcp || true)"
grep -q "$public_url/mcp" <<<"$meta" || fail "metadata không trả về $public_url/mcp"
code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: $host" -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8770/mcp)"
[ "$code" = 401 ] || fail "/mcp không bắt buộc đăng nhập (HTTP $code)"
code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: evil.example" http://127.0.0.1:8770/healthz)"
[ "$code" = 400 ] || fail "Host lạ không bị chặn (HTTP $code)"
echo "   OK: metadata đúng, /mcp trả 401 khi chưa đăng nhập, Host lạ bị chặn"

cat <<EOF

HOÀN TẤT (không dịch vụ cũ nào bị restart).

Bước tiếp theo:
  1. Cho $public_url trỏ tới nginx của VPS:   sudo bash $here/front-nginx.sh --host $host --issue-cert [--cloudflare]
     (hoặc dùng Caddy / Cloudflare Tunnel: proxy tới http://127.0.0.1:8770, xem README)
  2. Thử từ ngoài:   curl -s $public_url/.well-known/oauth-protected-resource/mcp
  3. claude.ai -> Settings -> Connectors -> Add custom connector -> URL: $public_url/mcp

Giám sát:   journalctl -u vps-mcp-oauth -f
Khẩn cấp:   sudo systemctl stop vps-mcp-oauth     (ngắt ngay), hoặc
            sudo -u mcp-oauth $app/venv/bin/python $app/oauth_proxy.py revoke-all --db /var/lib/vps-mcp-oauth/oauth.db
Gỡ cài đặt: sudo bash $here/uninstall-oauth.sh
EOF
