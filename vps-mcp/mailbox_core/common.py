import base64
import binascii
from datetime import datetime, timezone
import hashlib
import json
import math
import uuid
from .errors import GatewayError, invalid, missing, exhausted
from .identity import current_principal


def opaque_id():
    return uuid.uuid4().hex


def timestamp(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def bounded_int(value, low, high, name):
    if type(value) is not int or not low <= value <= high:
        invalid(f"{name} must be an integer in {low}..{high}")
    return value


def bounded_text(value, size, name, *, optional=False):
    if optional and value is None:
        return value
    if not isinstance(value, str):
        invalid(f"Invalid {name}")
    try:
        valid = len(value.encode("utf-8")) <= size and "\x00" not in value
    except UnicodeEncodeError:
        valid = False
    if not valid:
        invalid(f"Invalid {name}")
    return value


def cursor(scope, offset):
    return base64.urlsafe_b64encode(json.dumps([scope, offset], separators=(",", ":")).encode()).decode()


def offset(token, scope):
    if token is None:
        return 0
    try:
        if not isinstance(token, str) or len(token) > 512:
            invalid("Invalid cursor")
        decoded = json.loads(base64.b64decode(token, altchars=b"-_", validate=True))
        if (not isinstance(decoded, list) or len(decoded) != 2 or decoded[0] != scope
                or type(decoded[1]) is not int or not 0 <= decoded[1] <= 2**63 - 1
                or cursor(scope, decoded[1]) != token):
            invalid("Invalid cursor")
        return decoded[1]
    except (ValueError, TypeError, binascii.Error, UnicodeDecodeError):
        invalid("Invalid cursor")


class ServiceBase:
    def principal(self, db):
        pid = current_principal().principal_id
        row = db.execute("SELECT enabled FROM principals WHERE principal_id=?", (pid,)).fetchone()
        if row is None or not row[0]:
            raise GatewayError("UNAUTHENTICATED", "Trusted principal is not provisioned")
        return pid

    def session(self, db, pid, sid, *, active=False, owner=False):
        bounded_text(sid, 128, "session_id")
        row = db.execute("""SELECT s.* FROM logical_sessions s JOIN session_acl a USING(session_id)
                            WHERE s.session_id=? AND a.principal_id=?""", (sid, pid)).fetchone()
        if row is None:
            missing()
        if owner and row["owner"] != pid:
            raise GatewayError("FORBIDDEN", "Owner required")
        if active:
            if row["status"] == "closed":
                raise GatewayError("CONFLICT", "Session is closed")
            if row["expires_at"] <= self.clock():
                raise GatewayError("EXPIRED", "Session expired")
        return row

    def rate(self, db, pid):
        window = math.floor(self.clock() / 60)
        row = db.execute("SELECT window,count FROM rate_limits WHERE principal_id=?", (pid,)).fetchone()
        count = row["count"] if row and row["window"] == window else 0
        if count >= self.settings.writes_per_minute:
            exhausted("Write rate exceeded; retry next minute")
        db.execute("INSERT OR REPLACE INTO rate_limits VALUES (?,?,?)", (pid, window, count + 1))

    def audit(self, db, pid, sid, operation, rid):
        db.execute("INSERT INTO audit(principal_id,session_id,operation,resource_id,at) VALUES (?,?,?,?,?)",
                   (pid, sid, operation, rid, self.clock()))
        db.execute("DELETE FROM audit WHERE event_id <= (SELECT COALESCE(MAX(event_id),0)-? FROM audit)",
                   (self.settings.max_audit,))

    def replay(self, db, pid, scope, operation, key, payload):
        if key is None:
            return None
        bounded_text(key, 128, "idempotency_key")
        if not key:
            invalid("Empty idempotency_key")
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=True,
                                           separators=(",", ":")).encode()).hexdigest()
        row = db.execute("""SELECT payload_hash,result_json FROM idempotency_keys
                            WHERE principal_id=? AND scope=? AND operation=? AND key=?""",
                         (pid, scope, operation, key)).fetchone()
        if row:
            if row["payload_hash"] != digest:
                raise GatewayError("CONFLICT", "Idempotency payload differs")
            return json.loads(row["result_json"])
        return None

    def remember(self, db, pid, scope, operation, key, payload, result, sid):
        if key is not None:
            if db.execute("SELECT COUNT(*) FROM idempotency_keys WHERE principal_id=?", (pid,)).fetchone()[0] >= self.settings.max_keys:
                exhausted("Idempotency storage full; archive an old session")
            digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=True,
                                               separators=(",", ":")).encode()).hexdigest()
            db.execute("INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?,?)",
                       (pid, scope, operation, key, digest, json.dumps(result), sid))
