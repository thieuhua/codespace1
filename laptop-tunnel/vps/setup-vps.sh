#!/usr/bin/env bash
# Thiết lập đường hầm WireGuard VPS <-> laptop và chuyển tiếp dải cổng TCP/UDP.
# Chạy MỘT lần với sudo:   sudo bash setup-vps.sh <laptop_public_key>
# Gỡ bỏ:                    sudo bash setup-vps.sh --uninstall
# Idempotent: chạy lại an toàn (giữ nguyên khóa server đã có).
# Không đụng tới interface wg0 hiện có.
set -euo pipefail

IFACE=wg-lap
SERVER_IP=10.89.0.1
LAPTOP_IP=10.89.0.2
WG_PORT=51821
PORT_START=20000
PORT_END=20099
OWNER_HOME=/home/thieuhua
OUT_DIR="$OWNER_HOME/laptop-tunnel"

[[ $EUID -eq 0 ]] || { echo "Cần chạy bằng sudo." >&2; exit 1; }
WAN_IF=$(ip -4 route show default | awk '{print $5; exit}')
UFW_ACTIVE=0
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then UFW_ACTIVE=1; fi

ufw_rules() {  # $1 = "" (thêm) hoặc "delete"
  local d=$1
  ufw $d allow "$WG_PORT/udp" comment 'laptop-tunnel wg' || true
  for proto in tcp udp; do
    ufw $d route allow in on "$WAN_IF" out on "$IFACE" to "$LAPTOP_IP" \
      port "$PORT_START:$PORT_END" proto "$proto" comment "laptop-tunnel $proto" || true
  done
}

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl disable --now "wg-quick@$IFACE" || true
  [[ $UFW_ACTIVE -eq 1 ]] && ufw_rules delete
  rm -f "/etc/wireguard/$IFACE.conf" "/etc/wireguard/$IFACE.nft" "/etc/wireguard/$IFACE.key" \
        /etc/sysctl.d/99-laptop-tunnel.conf
  echo "Đã gỡ $IFACE."; exit 0
fi

LAPTOP_PUB="${1:?Thiếu public key của laptop}"
[[ "$LAPTOP_PUB" =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]] || { echo "Public key không hợp lệ." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
command -v wg  >/dev/null || apt-get install -y wireguard-tools
command -v nft >/dev/null || apt-get install -y nftables

install -d -m 700 /etc/wireguard
umask 077
[[ -s /etc/wireguard/$IFACE.key ]] || wg genkey > "/etc/wireguard/$IFACE.key"
SERVER_PUB=$(wg pubkey < "/etc/wireguard/$IFACE.key")

# NAT: dải cổng công khai trên WAN -> laptop (giữ nguyên số cổng); SNAT để gói trả về đi qua hầm.
cat > "/etc/wireguard/$IFACE.nft" <<EOF
table inet laptop_tunnel
delete table inet laptop_tunnel
table inet laptop_tunnel {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "$WAN_IF" meta l4proto { tcp, udp } th dport $PORT_START-$PORT_END dnat ip to $LAPTOP_IP
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "$IFACE" ip daddr $LAPTOP_IP masquerade
  }
}
EOF

cat > "/etc/wireguard/$IFACE.conf" <<EOF
# Quản lý bởi laptop-tunnel/vps/setup-vps.sh
[Interface]
Address = $SERVER_IP/24
ListenPort = $WG_PORT
PostUp = wg set %i private-key /etc/wireguard/$IFACE.key; nft -f /etc/wireguard/$IFACE.nft
PostDown = nft delete table inet laptop_tunnel

[Peer]
# laptop Windows
PublicKey = $LAPTOP_PUB
AllowedIPs = $LAPTOP_IP/32
EOF

echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-laptop-tunnel.conf
sysctl -q -p /etc/sysctl.d/99-laptop-tunnel.conf

if [[ $UFW_ACTIVE -eq 1 ]]; then ufw_rules ""; else echo "ufw không bật: bỏ qua luật ufw."; fi

systemctl enable "wg-quick@$IFACE" >/dev/null
systemctl restart "wg-quick@$IFACE"

umask 022
install -d -o thieuhua -g thieuhua "$OUT_DIR"
echo "$SERVER_PUB" > "$OUT_DIR/server.pub"
{
  echo "WAN_IF=$WAN_IF UFW_ACTIVE=$UFW_ACTIVE"
  wg show "$IFACE" | grep -v 'private key'
  nft list table inet laptop_tunnel
  [[ $UFW_ACTIVE -eq 1 ]] && ufw status verbose
  iptables -S FORWARD 2>/dev/null | head -3
} > "$OUT_DIR/setup-status.txt" 2>&1 || true
chown thieuhua:thieuhua "$OUT_DIR"/*

echo
echo "XONG. Server public key: $SERVER_PUB"
echo "Trạng thái ghi tại $OUT_DIR/setup-status.txt"
