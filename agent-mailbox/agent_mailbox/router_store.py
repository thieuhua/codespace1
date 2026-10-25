"""Router persistence. Offline control and HTTP use the same WAL database."""
from contextlib import contextmanager
import json
import math
import time
import uuid

from .auth import AuthenticatedDatabase, verify, unauthenticated
from .core.database import Database
from .core.errors import GatewayError, invalid, missing
from .core.settings import Settings
from .paths import safe_path, owner_only

MAX_TEXT_BYTES = 65536
MAX_HOLD = 300
BATCH_SIZE = 100
SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS controls (principal TEXT PRIMARY KEY, stopped INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS receives (
 id TEXT PRIMARY KEY, principal TEXT NOT NULL, started REAL NOT NULL, ended REAL,
 held_seconds REAL, hold_seconds REAL NOT NULL, status TEXT, delivered INTEGER NOT NULL DEFAULT 0,
 cancelled INTEGER NOT NULL DEFAULT 0, error TEXT, streak INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS receives_principal ON receives(principal, started);
CREATE TABLE IF NOT EXISTS messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 sender TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, reply_to TEXT,
 sent_at REAL NOT NULL, delivered_at REAL, acked_at REAL, reserved_by TEXT);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient, delivered_at, seq);
CREATE TABLE IF NOT EXISTS sends (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT,
 at REAL NOT NULL, message_id TEXT, replay INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS idempotency (
 sender TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, message_id TEXT NOT NULL,
 PRIMARY KEY(sender,key));
"""


def hold_value(value):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= MAX_HOLD:
        invalid("Hold must be a finite number between 0 and 300 seconds")
    return float(value)


def message(row):
    return {"id": row["id"], "seq": row["seq"], "from": row["sender"], "to": row["recipient"],
            "text": row["text"], "reply_to": row["reply_to"], "sent_at": row["sent_at"]}


class RouterStore(Database):
    def __init__(self, home, initial_hold=50):
        self.home = home
        self.auth_path = safe_path(home / "mailbox.db", file=True)
        self.credentials = AuthenticatedDatabase(Settings(self.auth_path), "")
        if not self.auth_path.is_file():
            raise ValueError("Run admin init and add-principal first")
        self.settings = Settings(safe_path(home / "router.db", file=True), busy_timeout_ms=100)
        self._check_path()
        created = not self.settings.db_path.exists()
        # Protect a new, empty DB before storing any message content.
        if created:
            with self.settings.db_path.open("xb"):
                pass
            try:
                owner_only(self.settings.db_path)
            except BaseException:
                self.settings.db_path.unlink(missing_ok=True)
                raise
        with self.transaction(write=True) as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("Unsupported router schema")
            for statement in SCHEMA.split(";"):
                if statement.strip():
                    conn.execute(statement)
            conn.execute("PRAGMA user_version=1")
            conn.execute("INSERT OR IGNORE INTO settings VALUES ('hold',?)", (str(hold_value(initial_hold)),))
        with self._connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")

    @contextmanager
    def _connection(self):
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def _connect(self):
        self.credentials._check_path()
        if not safe_path(self.auth_path, file=True).is_file():
            unauthenticated()
        conn = super()._connect()
        try:
            # Reuse verify() and its existing token format/hash without copying secrets.
            # BEGIN IMMEDIATE also locks attached DBs. Router SQL only SELECTs
            # these existing credential tables; never changes token records.
            conn.execute("ATTACH DATABASE ? AS credentials", (str(self.auth_path),))
            conn.execute("CREATE TEMP VIEW principals AS SELECT * FROM credentials.principals")
            conn.execute("CREATE TEMP VIEW local_credentials AS SELECT * FROM credentials.local_credentials")
            return conn
        except BaseException:
            conn.close()
            raise

    @contextmanager
    def authorized(self, token=None, principal=None, *, write=False):
        with self.transaction(write=write) as conn:
            if token is not None:
                if verify(conn, token).principal_id != principal:
                    unauthenticated()
            yield conn

    def principals(self, conn):
        return [r[0] for r in conn.execute("SELECT principal_id FROM principals WHERE enabled=1 ORDER BY principal_id")
                if r[0] not in ("operator", "claude", "all")]

    def hold(self):
        with self.transaction() as conn:
            return float(conn.execute("SELECT value FROM settings WHERE key='hold'").fetchone()[0])

    def set_hold(self, value):
        value = hold_value(value)
        with self.transaction(write=True) as conn:
            conn.execute("UPDATE settings SET value=? WHERE key='hold'", (str(value),))
        return {"hold_seconds": value}

    def begin_receive(self, principal, token):
        with self.authorized(token, principal, write=True) as conn:
            hold = float(conn.execute("SELECT value FROM settings WHERE key='hold'").fetchone()[0])
            previous = conn.execute("SELECT * FROM receives WHERE principal=? ORDER BY rowid DESC LIMIT 1", (principal,)).fetchone()
            boot = conn.execute("SELECT value FROM settings WHERE key='boot'").fetchone()
            now = time.time()
            streak = previous["streak"] + 1 if (previous and previous["ended"] is not None and
                     previous["ended"] >= (float(boot[0]) if boot else 0) and
                     previous["status"] in ("mail", "no_mail") and now - previous["ended"] <= 60) else 1
            call_id = uuid.uuid4().hex
            conn.execute("INSERT INTO receives(id,principal,started,hold_seconds,streak) VALUES (?,?,?,?,?)",
                         (call_id, principal, now, hold, streak))
            count = conn.execute("SELECT count(*) FROM receives WHERE principal=?", (principal,)).fetchone()[0]
        return call_id, hold, count

    def snapshot(self, principal, token, call_id):
        with self.authorized(token, principal, write=True) as conn:
            active = conn.execute("SELECT 1 FROM receives WHERE id=? AND principal=? AND ended IS NULL", (call_id, principal)).fetchone()
            if not active:
                invalid("Receive is no longer active")
            stopped = conn.execute("SELECT stopped FROM controls WHERE principal=?", (principal,)).fetchone()
            if stopped and stopped[0]:
                return "stop", []
            rows = conn.execute("""SELECT * FROM messages WHERE recipient=? AND delivered_at IS NULL
                                   AND reserved_by IS NULL ORDER BY seq LIMIT ?""", (principal, BATCH_SIZE)).fetchall()
            if rows:
                conn.executemany("UPDATE messages SET reserved_by=? WHERE id=?", [(call_id, r["id"]) for r in rows])
            return ("mail" if rows else "no_mail"), [message(r) for r in rows]

    def finish_receive(self, call_id, status, *, cancelled=False, error=None, token=None, principal=None):
        with self.authorized(token, principal, write=True) as conn:
            row = conn.execute("SELECT * FROM receives WHERE id=?", (call_id,)).fetchone()
            if not row or row["ended"] is not None:
                return
            now = time.time()
            delivered = 0
            if not cancelled and status == "mail":
                delivered = conn.execute("UPDATE messages SET delivered_at=?,reserved_by=NULL WHERE reserved_by=?",
                                         (now, call_id)).rowcount
            else:
                conn.execute("UPDATE messages SET reserved_by=NULL WHERE reserved_by=?", (call_id,))
            conn.execute("""UPDATE receives SET ended=?,held_seconds=?,status=?,delivered=?,cancelled=?,error=? WHERE id=?""",
                         (now, max(0, now-row["started"]), status, delivered, int(cancelled), error, call_id))

    def recover(self):
        with self.transaction(write=True) as conn:
            now = time.time()
            conn.execute("UPDATE messages SET reserved_by=NULL WHERE delivered_at IS NULL")
            conn.execute("""UPDATE receives SET ended=?,held_seconds=?-started,status='cancelled',cancelled=1,
                         error='SERVER_RESTART' WHERE ended IS NULL""", (now, now))
            conn.execute("DELETE FROM settings WHERE key='shutdown'")
            conn.execute("INSERT OR REPLACE INTO settings VALUES ('boot',?)", (str(now),))

    def send(self, sender, to, text, reply_to=None, key=None, token=None):
        # Also record rejected and replayed send attempts; never store secrets in logs.
        try:
            with self.authorized(token, sender, write=True) as conn:
                if not isinstance(to, str):
                    invalid("Recipient must be a string")
                to = "operator" if to == "claude" else to
                if to != "operator" and to not in self.principals(conn):
                    missing()
                if not isinstance(text, str) or not text or len(text.encode("utf-8")) > MAX_TEXT_BYTES:
                    invalid("Text must contain 1..65536 UTF-8 bytes")
                if key is not None and (not isinstance(key, str) or not 1 <= len(key.encode("utf-8")) <= 256):
                    invalid("Idempotency key must contain 1..256 UTF-8 bytes")
                if reply_to is not None:
                    original = conn.execute("SELECT * FROM messages WHERE id=? AND recipient=? AND delivered_at IS NOT NULL",
                                            (reply_to, sender)).fetchone()
                    if not original or original["sender"] != to:
                        missing()
                payload = json.dumps([to, text, reply_to], ensure_ascii=True)
                old = conn.execute("SELECT * FROM idempotency WHERE sender=? AND key=?", (sender, key)).fetchone() if key else None
                if old and old["payload"] != payload:
                    raise GatewayError("CONFLICT", "Idempotency key already used with another payload")
                if old:
                    row = conn.execute("SELECT * FROM messages WHERE id=?", (old["message_id"],)).fetchone()
                else:
                    mid = uuid.uuid4().hex
                    conn.execute("INSERT INTO messages(id,sender,recipient,text,reply_to,sent_at) VALUES (?,?,?,?,?,?)",
                                 (mid, sender, to, text, reply_to, time.time()))
                    row = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
                    if key:
                        conn.execute("INSERT INTO idempotency VALUES (?,?,?,?)", (sender, key, payload, mid))
                conn.execute("INSERT INTO sends(sender,recipient,at,message_id,replay) VALUES (?,?,?,?,?)",
                             (sender, to, time.time(), row["id"], int(old is not None)))
                return {"message": message(row), "duplicated": old is not None}
        except GatewayError as exc:
            if exc.code == "UNAUTHENTICATED":
                raise
            self.record_send_error(sender, to if isinstance(to, str) else None, exc.code)
            raise

    def record_send_error(self, sender, to, code):
        with self.transaction(write=True) as conn:
            conn.execute("INSERT INTO sends(sender,recipient,at,error) VALUES (?,?,?,?)", (sender, to, time.time(), code))

    def reply(self, principal, token, message_id, text, key=None):
        with self.authorized(token, principal) as conn:
            row = conn.execute("SELECT sender FROM messages WHERE id=? AND recipient=? AND delivered_at IS NOT NULL",
                               (message_id, principal)).fetchone()
            # Route missing targets through send so failed replies are logged.
            to = row[0] if row else ""
        return self.send(principal, to, text, message_id, key, token)

    def ack(self, principal, token, ids):
        if not isinstance(ids, list) or len(ids) > BATCH_SIZE or any(not isinstance(i, str) for i in ids):
            invalid("ACK accepts at most 100 message IDs")
        with self.authorized(token, principal, write=True) as conn:
            for mid in ids:
                row = conn.execute("SELECT 1 FROM messages WHERE id=? AND recipient=? AND delivered_at IS NOT NULL", (mid, principal)).fetchone()
                if not row:
                    missing()
            conn.executemany("UPDATE messages SET acked_at=COALESCE(acked_at,?) WHERE id=?", [(time.time(), mid) for mid in ids])
        return {"acknowledged": list(dict.fromkeys(ids))}

    def control(self, target, stopped):
        with self.transaction(write=True) as conn:
            principals = self.principals(conn)
            targets = principals if target == "all" else [target]
            if any(p not in principals for p in targets):
                missing()
            conn.executemany("INSERT INTO controls VALUES (?,?) ON CONFLICT(principal) DO UPDATE SET stopped=excluded.stopped",
                             [(p, int(stopped)) for p in targets])
        return {"principals": targets, "stopped": stopped}

    def operator_inbox(self, include_all=False):
        with self.transaction(write=True) as conn:
            rows = conn.execute("SELECT * FROM messages WHERE recipient='operator'" +
                                ("" if include_all else " AND delivered_at IS NULL") + " ORDER BY seq").fetchall()
            conn.execute("UPDATE messages SET delivered_at=COALESCE(delivered_at,?) WHERE recipient='operator'", (time.time(),))
        return {"messages": [message(r) for r in rows]}

    def status(self):
        with self.transaction() as conn:
            result = []
            boot = conn.execute("SELECT value FROM settings WHERE key='boot'").fetchone()
            boot = float(boot[0]) if boot else 0
            for identity in conn.execute("SELECT principal_id,enabled FROM principals ORDER BY principal_id").fetchall():
                pid = identity["principal_id"]
                if pid in ("operator", "claude", "all"):
                    continue
                calls = conn.execute("SELECT * FROM receives WHERE principal=? ORDER BY rowid", (pid,)).fetchall()
                last = dict(calls[-1]) if calls else None
                errors = [(r["ended"] or r["started"], r["error"]) for r in calls if r["error"]]
                sent_error = conn.execute("SELECT at,error FROM sends WHERE sender=? AND error IS NOT NULL ORDER BY seq DESC LIMIT 1", (pid,)).fetchone()
                if sent_error:
                    errors.append(tuple(sent_error))
                error = max(errors)[1] if errors else None
                def count(where):
                    return conn.execute("SELECT count(*) FROM messages WHERE " + where, (pid,)).fetchone()[0]
                result.append({"principal_id": pid, "enabled": bool(identity["enabled"]), "waiting": any(r["ended"] is None for r in calls),
                               "last_call": last, "total_receive_calls": len(calls),
                               "consecutive_calls": (last["streak"] if last and (last["ended"] is None or
                                  (last["status"] in ("mail", "no_mail") and last["ended"] >= boot and time.time()-last["ended"] <= 60)) else 0),
                               "mails_in": count("recipient=?"), "mails_out": count("sender=?"),
                               "pending": count("recipient=? AND delivered_at IS NULL"), "last_error": error})
            return {"principals": result}

    def stats(self):
        with self.transaction() as conn:
            calls = [dict(r) for r in conn.execute("SELECT * FROM receives ORDER BY rowid")]
            sends = conn.execute("SELECT count(*) FROM sends").fetchone()[0]
            mails = conn.execute("SELECT count(*) FROM messages").fetchone()[0]
            runtime = conn.execute("SELECT value FROM settings WHERE key='runtime'").fetchone()
        return {**self.status(), "hold_seconds": self.hold(), "receive_calls": calls,
                "total_receive_calls": len(calls), "total_sends": sends, "total_messages": mails,
                "runtime": json.loads(runtime[0]) if runtime else None}

    def routing_log(self, tail):
        if not 1 <= tail <= 10000:
            invalid("Tail must be 1..10000")
        with self.transaction() as conn:
            rows = conn.execute("SELECT * FROM sends ORDER BY seq DESC LIMIT ?", (tail,)).fetchall()
        return {"log": [dict(r) for r in reversed(rows)]}
