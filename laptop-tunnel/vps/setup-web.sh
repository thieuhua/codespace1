#!/usr/bin/env bash
# HTTPS subdomain cho dịch vụ web trên laptop: <tên>.xuanthieu.site -> 10.89.0.2:<cổng>.
# Cloudflare (proxy cam) -> nginx trên VPS (chứng chỉ Origin CA *.xuanthieu.site) -> hầm wg-lap.
# Chạy MỘT lần:  sudo bash setup-web.sh        Gỡ: sudo bash setup-web.sh --uninstall
# Yêu cầu trước: ~/laptop-tunnel/tls/wildcard.{key,crt} và ~/laptop-tunnel/lap-web.
# Sau khi cài, thêm/xóa subdomain bằng `lap-web` (không cần sudo).
set -euo pipefail

OWNER=thieuhua
SRC=/home/$OWNER/laptop-tunnel
DIR=/etc/nginx/laptop-apps
SITE=/etc/nginx/sites-available/laptop-apps
UNIT=laptop-apps-reload

[[ $EUID -eq 0 ]] || { echo "Cần chạy bằng sudo." >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl disable --now "$UNIT.path" || true
  rm -f "/etc/systemd/system/$UNIT.path" "/etc/systemd/system/$UNIT.service" \
        /etc/nginx/sites-enabled/laptop-apps "$SITE" /usr/local/bin/lap-web
  rm -rf "$DIR"
  systemctl daemon-reload
  nginx -t && systemctl reload nginx
  echo "Đã gỡ laptop-apps."; exit 0
fi

install -d -m 755 "$DIR"
if [[ -s $SRC/tls/wildcard.key ]]; then
  install -m 600 -o root -g root "$SRC/tls/wildcard.key" "$DIR/wildcard.key"
  shred -u "$SRC/tls/wildcard.key"
fi
[[ -s $DIR/wildcard.key ]] || { echo "Thiếu khóa $DIR/wildcard.key" >&2; exit 1; }
install -m 644 -o root -g root "$SRC/tls/wildcard.crt" "$DIR/wildcard.crt"
[[ -f $DIR/apps.map ]] || : > "$DIR/apps.map"
chown "$OWNER:$OWNER" "$DIR/apps.map"; chmod 644 "$DIR/apps.map"
install -m 755 -o root -g root "$SRC/lap-web" /usr/local/bin/lap-web

cat > "$SITE" <<'EOF'
# Quản lý bởi laptop-tunnel/vps/setup-web.sh. Ánh xạ tên -> cổng nằm ở apps.map (sửa bằng lap-web).
# Tên cụ thể của site khác (blindnav, mcp, simulator...) luôn ưu tiên hơn wildcard này.
map $host $laptop_app_port {
    hostnames;
    default "";
    include /etc/nginx/laptop-apps/apps.map;
}
map $http_upgrade $laptop_conn_upgrade {
    default upgrade;
    ""      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name *.xuanthieu.site;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name *.xuanthieu.site;

    ssl_certificate     /etc/nginx/laptop-apps/wildcard.crt;
    ssl_certificate_key /etc/nginx/laptop-apps/wildcard.key;

    client_max_body_size 100m;

    # Chỉ chuyển tới dải cổng của hầm; tên chưa đăng ký -> 404
    if ($laptop_app_port !~ "^200[0-9][0-9]$") { return 404; }

    location / {
        proxy_pass http://10.89.0.2:$laptop_app_port;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $laptop_conn_upgrade;
        proxy_connect_timeout 5s;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
EOF
ln -sf "$SITE" /etc/nginx/sites-enabled/laptop-apps

cat > "/etc/systemd/system/$UNIT.path" <<EOF
[Unit]
Description=Reload nginx when laptop apps map changes

[Path]
PathModified=$DIR/apps.map

[Install]
WantedBy=multi-user.target
EOF
cat > "/etc/systemd/system/$UNIT.service" <<'EOF'
[Unit]
Description=Validate and reload nginx for laptop apps

[Service]
Type=oneshot
ExecStart=/usr/sbin/nginx -t -q
ExecStart=/bin/systemctl reload nginx
EOF
systemctl daemon-reload

nginx -t
systemctl reload nginx
systemctl enable --now "$UNIT.path"

echo
echo "XONG. Dùng: lap-web add <tên> <cổng 20000-20099>  ->  https://<tên>.xuanthieu.site"
