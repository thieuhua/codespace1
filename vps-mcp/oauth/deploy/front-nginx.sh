#!/usr/bin/env bash
# Owner SSH only:  sudo bash front-nginx.sh --host mcp.example.com [--cloudflare] [--issue-cert [--email you@x]] [--cert F --key F]
#
# Publishes the OAuth front door (127.0.0.1:8770) through the nginx already on this VPS by writing ONE
# new file, /etc/nginx/conf.d/vps-mcp-oauth.conf, with its own server_name. Existing sites are not edited.
# The change is validated with `nginx -t` first and rolled back on failure; nginx is reloaded, not restarted.
#
# Cloudflare: set SSL/TLS mode to "Full" or "Full (strict)" (not "Flexible"), and pass --cloudflare so the
# real visitor address (CF-Connecting-IP) is used for login throttling.
# --issue-cert: when no certificate covers the host, get one from Let's Encrypt (certbot --webroot). It adds
# /etc/nginx/conf.d/vps-mcp-oauth-acme.conf (port 80, ACME path only, kept so renewals keep working). The DNS
# record for the host must already exist (proxied through Cloudflare is fine) and reach this VPS.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Chạy bằng sudo (qua SSH của chủ sở hữu)." >&2; exit 1; }

host=""; cert=""; key=""; realip='$remote_addr'; issue=0; email=""
conf=/etc/nginx/conf.d/vps-mcp-oauth.conf

while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="${2:?thiếu tên miền}"; shift 2 ;;
    --cert) cert="${2:?thiếu đường dẫn}"; shift 2 ;;
    --key) key="${2:?thiếu đường dẫn}"; shift 2 ;;
    --cloudflare) realip='$http_cf_connecting_ip'; shift ;;
    --issue-cert) issue=1; shift ;;
    --email) email="${2:?thiếu email}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Tham số lạ: $1" >&2; exit 1 ;;
  esac
done
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "Cần --host mcp.example.com" >&2; exit 1; }

if ! command -v nginx >/dev/null; then
  cat >&2 <<EOF
Không thấy nginx trên máy này. Hãy cho $host trỏ tới http://127.0.0.1:8770 bằng cách bạn đang dùng:
  Caddy:        $host { reverse_proxy 127.0.0.1:8770 }
  cloudflared:  ingress: [{hostname: $host, service: http://127.0.0.1:8770}, {service: http_status:404}]
Lưu ý: proxy phải giữ nguyên Host và đặt X-Real-IP = địa chỉ người truy cập.
EOF
  exit 2
fi

# --- tìm chứng chỉ TLS phủ được tên miền ---
covers() {  # $1=host $2=danh sách SAN
  local san
  for san in $2; do
    san="${san#DNS:}"; san="${san%,}"
    [[ "$san" == "$1" ]] && return 0
    [[ "$san" == \*.* && "${1#*.}" == "${san#*.}" ]] && return 0
  done
  return 1
}
find_cert() {
  local f sans
  for f in /etc/letsencrypt/live/*/fullchain.pem /etc/ssl/cloudflare/*.pem /etc/nginx/ssl/*.crt /etc/nginx/ssl/*.pem; do
    [ -f "$f" ] || continue
    sans="$(openssl x509 -in "$f" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d '\n' || true)"
    if covers "$host" "$sans"; then
      cert="$f"
      key="${f%fullchain.pem}privkey.pem"; [ -f "$key" ] || key="${f%.*}.key"
      return 0
    fi
  done
  return 1
}

issue_cert() {
  local webroot=/var/www/vps-mcp-acme acme=/etc/nginx/conf.d/vps-mcp-oauth-acme.conf err
  command -v certbot >/dev/null || { echo "Cài certbot..."; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot >/dev/null; }
  mkdir -p "$webroot"
  cat >"$acme" <<ACME
# Managed by vps-mcp/oauth/deploy/front-nginx.sh -- answers Let's Encrypt HTTP-01 for $host (renewals need it too).
server {
    listen 80;
    server_name $host;
    location /.well-known/acme-challenge/ { root $webroot; }
    location / { return 404; }
}
ACME
  err="$(mktemp)"
  if ! nginx -t 2>"$err"; then
    cat "$err" >&2; rm -f "$err" "$acme"
    echo "nginx -t thất bại với block ACME: đã gỡ block, chưa reload." >&2; exit 1
  fi
  rm -f "$err"
  systemctl reload nginx
  local contact=(--register-unsafely-without-email); [ -n "$email" ] && contact=(--email "$email")
  certbot certonly --webroot -w "$webroot" -d "$host" --non-interactive --agree-tos "${contact[@]}" || {
    cat >&2 <<HELP
certbot thất bại. Kiểm tra: (1) bản ghi DNS của $host đã có và trỏ về VPS này (Cloudflare: bật proxy cam);
(2) cổng 80 tới được nginx (Cloudflare chỉ cần "Always Use HTTPS" không chặn đường /.well-known/acme-challenge/).
HELP
    exit 1
  }
}

if [ -z "$cert" ]; then
  find_cert || { [ "$issue" -eq 1 ] && issue_cert && find_cert; } || true
fi
[ -n "$cert" ] && [ -n "$key" ] && [ -f "$cert" ] && [ -f "$key" ] || {
  cat >&2 <<EOF
Không tìm thấy chứng chỉ TLS phủ $host. Hãy chọn một trong ba:
  - chạy lại với --issue-cert           (tự xin chứng chỉ Let's Encrypt; cần DNS của $host đã trỏ về VPS)
  - truyền --cert /đường/dẫn/fullchain.pem --key /đường/dẫn/privkey.pem  (ví dụ Cloudflare Origin Certificate)
  - tự chạy certbot rồi chạy lại script này
EOF
  exit 1
}
echo "Dùng chứng chỉ: $cert"

if [ ! -f "$conf" ]; then
  current="$(nginx -T 2>/dev/null || true)"
  if grep -Eq "^[[:space:]]*server_name[[:space:]].*(^|[[:space:]])${host//./\\.}[[:space:];]" <<<"$current"; then
    echo "CẢNH BÁO: một server block khác đã dùng server_name $host. Hãy dùng tên miền riêng cho connector." >&2
  fi
fi

listen6=""
[ -e /proc/net/if_inet6 ] && listen6="listen [::]:443 ssl;"   # VPS without IPv6 would fail `nginx -t`

backup=""
if [ -f "$conf" ]; then backup="$(mktemp)"; cp -a "$conf" "$backup"; fi
cat >"$conf" <<EOF
# Managed by vps-mcp/oauth/deploy/front-nginx.sh -- OAuth front door for Claude custom connectors.
server {
    listen 443 ssl;
    $listen6
    server_name $host;

    ssl_certificate     $cert;
    ssl_certificate_key $key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    server_tokens off;
    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:8770;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP $realip;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 130s;
        proxy_send_timeout 130s;
    }
}
EOF

errfile="$(mktemp)"
if ! nginx -t 2>"$errfile"; then
  cat "$errfile" >&2; rm -f "$errfile"
  if [ -n "$backup" ]; then cp -a "$backup" "$conf"; else rm -f "$conf"; fi
  echo "nginx -t thất bại: đã khôi phục cấu hình cũ, chưa reload." >&2
  exit 1
fi
rm -f "$errfile" ${backup:+"$backup"}
systemctl reload nginx
echo "Đã reload nginx. Kiểm tra từ máy khác:  curl -s https://$host/.well-known/oauth-protected-resource/mcp"
echo "Nếu DNS chưa có: tạo bản ghi A/AAAA cho $host trỏ về IP của VPS (bật proxy cam nếu dùng Cloudflare)."
