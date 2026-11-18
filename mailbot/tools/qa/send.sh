#!/usr/bin/env bash
# Dùng: tools/qa/send.sh <to> <subject> <body> [extra-header-file]
# Ký DKIM bằng khóa ~/.mailbot/qa và gửi từ VPS (IP khớp SPF của qa.xuanthieu.site) tới MX Cloudflare.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
to="$1"; subject="$2"; body="$3"
eml="$(mktemp --suffix=.eml)"; trap 'rm -f "$eml"' EXIT
node "$here/sign.mjs" "$eml" "$to" "$subject" "$body" >/dev/null
scp -q -o BatchMode=yes "$eml" thieuhua-vps1:/tmp/qa-out.eml
ssh -o BatchMode=yes thieuhua-vps1 python3 - "$to" <<'PY'
import smtplib, ssl, sys
raw = open("/tmp/qa-out.eml", "rb").read()
s = smtplib.SMTP("route1.mx.cloudflare.net", 25, timeout=30, local_hostname="qa.xuanthieu.site")
s.ehlo(); s.starttls(context=ssl.create_default_context()); s.ehlo()
s.sendmail("qa@qa.xuanthieu.site", [sys.argv[1]], raw)
s.quit()
PY
ssh -o BatchMode=yes thieuhua-vps1 'rm -f /tmp/qa-out.eml'
echo "sent: $subject -> $to"
