#!/usr/bin/env bash
# Owner SSH only:  sudo bash uninstall-oauth.sh [--purge]
# Removes the OAuth front door. Never touches vps-mcp, vps-mcp-dev, vps-mcp-approval or the tunnel.
# Without --purge it keeps the owner credentials and the client/token database for a later reinstall.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Chạy bằng sudo." >&2; exit 1; }

purge=0; [ "${1:-}" = "--purge" ] && purge=1

systemctl disable --now vps-mcp-oauth.service 2>/dev/null || true
rm -f /etc/systemd/system/vps-mcp-oauth.service
systemctl daemon-reload
rm -rf /opt/vps-mcp/oauth

if [ -f /etc/nginx/conf.d/vps-mcp-oauth.conf ]; then
  rm -f /etc/nginx/conf.d/vps-mcp-oauth.conf
  if nginx -t 2>/dev/null; then systemctl reload nginx; echo "Đã gỡ server block nginx và reload."
  else echo "nginx -t lỗi sau khi gỡ: hãy kiểm tra cấu hình nginx thủ công." >&2; fi
fi

if [ "$purge" -eq 1 ]; then
  rm -rf /etc/vps-mcp-oauth /var/lib/vps-mcp-oauth
  getent passwd mcp-oauth >/dev/null && userdel mcp-oauth 2>/dev/null || true
  echo "Đã xóa cả cấu hình, thông tin chủ sở hữu, cơ sở dữ liệu và tài khoản mcp-oauth."
else
  echo "Giữ lại /etc/vps-mcp-oauth và /var/lib/vps-mcp-oauth (dùng --purge để xóa)."
fi
systemctl is-active vps-mcp.service vps-mcp-dev.service vps-mcp-approval.service vps-mcp-tunnel.service || true
