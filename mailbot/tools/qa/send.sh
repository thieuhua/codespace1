#!/usr/bin/env bash
# Dùng: QA_OPTS='{"extraHeaders":{"Auto-Submitted":"auto-replied"}}' tools/qa/send.sh <to> <subject> <body>
# Ký DKIM bằng khóa ~/.mailbot/qa và gửi từ VPS (IP khớp SPF của qa.xuanthieu.site) tới MX Cloudflare.
set -euo pipefail
export MSYS_NO_PATHCONV=1  # Git Bash trên Windows không được đổi "/status" thành đường dẫn
here="$(cd "$(dirname "$0")" && pwd)"
to="$1"; subject="$2"; body="$3"
eml="$(mktemp --suffix=.eml)"; trap 'rm -f "$eml"' EXIT
remote="/tmp/mailbot-$(basename "$eml")"
expect_reject="${QA_EXPECT_SENDER_REJECT:-0}"
[[ "$expect_reject" == 0 || "$expect_reject" == 1 ]]
qa_opts='{}'
if [[ -n "${QA_OPTS:-}" ]]; then qa_opts="$QA_OPTS"; fi
QA_OPTS="$qa_opts" node "$here/sign.mjs" "$eml" "$to" "$subject" "$body" >/dev/null
scp -q -o BatchMode=yes "$eml" "thieuhua-vps1:$remote"
mail_from="${QA_MAIL_FROM:-}"  # envelope sender khác header From (để thử SPF không align)
ssh -o BatchMode=yes thieuhua-vps1 python3 - "$remote" "$expect_reject" "$mail_from" <<'PY'
import smtplib, ssl, sys
from email import policy
from email.parser import BytesParser
raw = open(sys.argv[1], "rb").read()
mail = BytesParser(policy=policy.default).parsebytes(raw)
s = smtplib.SMTP("route1.mx.cloudflare.net", 25, timeout=30, local_hostname="qa.xuanthieu.site")
s.ehlo(); s.starttls(context=ssl.create_default_context()); s.ehlo()
try:
    # ssh bỏ mất đối số rỗng nên argv[3] có thể vắng.
    if s.sendmail((sys.argv[3] if len(sys.argv) > 3 else "") or mail['From'].addresses[0].addr_spec, [mail['To'].addresses[0].addr_spec], raw):
        raise RuntimeError("SMTP refused recipient")
except smtplib.SMTPDataError as error:
    # Worker rejects untrusted senders during DATA. Only this exact policy
    # rejection is expected by negative tests, never generic SMTP failures.
    if not (sys.argv[2] == "1" and 500 <= error.smtp_code < 600
            and b"Sender not allowed" in error.smtp_error):
        raise
s.quit()
PY
ssh -o BatchMode=yes thieuhua-vps1 rm -f "$remote"
echo "sent: $subject -> $to"
