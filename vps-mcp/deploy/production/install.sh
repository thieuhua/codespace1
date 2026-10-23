#!/usr/bin/env bash
# Owner SSH only. Never restarts production or touches credentials.
set -euo pipefail
test "$(id -u)" -eq 0 || { echo 'Run with sudo via SSH' >&2; exit 1; }
src="$(cd "$(dirname "$0")/../.." && pwd)"
dest=/opt/vps-mcp
repo=/home/thieuhua/code/codespace1
for user in mcp-gateway mcp-dev; do
  getent passwd "$user" >/dev/null || { echo "Missing service account: $user" >&2; exit 1; }
done
test -d "$repo/.git"
test -f /etc/vps-mcp/protected.json && test -f /etc/vps-mcp/approval-password || {
  echo 'Missing separately managed policy/password' >&2; exit 1;
}
release_id="$(sha256sum "$src/gateway.py" "$src/worker.py" "$src/broker.py" | sha256sum | cut -c1-16)"
release="$dest/releases/$release_id"
mkdir -p "$dest/releases"
if test -e "$release"; then
  for f in gateway.py worker.py broker.py; do cmp -s "$src/$f" "$release/$f"; done
else
  mkdir -p "$release"
  install -m 0644 "$src/gateway.py" "$src/worker.py" "$src/broker.py" "$release/"
  python3 -m venv "$release/venv"
  "$release/venv/bin/pip" install 'mcp==1.30.0'
  chown -R root:root "$release"
  chmod -R go-w "$release"
fi
backup="/var/backups/vps-mcp/source-install-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
for u in vps-mcp.service vps-mcp-dev.service vps-mcp-approval.service; do
  if test -f "/etc/systemd/system/$u"; then cp -a "/etc/systemd/system/$u" "$backup/$u"; fi
  install -m 0644 "$src/deploy/production/$u" "/etc/systemd/system/$u"
done
ln -sfn "$release" "$dest/current.next"
mv -Tf "$dest/current.next" "$dest/current"
systemctl daemon-reload
echo "Release installed: $release"
echo "Backup: $backup"
echo 'Production was NOT restarted. Owner must choose when to switch.'
