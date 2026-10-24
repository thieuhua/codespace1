"""Durable ordered mailboxes with per-principal acknowledgements."""
import asyncio
import math
import threading
import time
from .common import ServiceBase, opaque_id, timestamp, bounded_int, bounded_text, cursor, offset
from .errors import GatewayError, exhausted, invalid, missing
from .async_db import run_db


class MailboxService(ServiceBase):
    def __init__(self, database, *, clock=time.time):
        self.database, self.settings, self.clock = database, database.settings, clock
        self._waiters = 0
        self._waiter_lock = threading.Lock()
        self._stopping = threading.Event()

    def stop_waiters(self):
        """Server shutdown hook: wake polling loops within one poll interval."""
        self._stopping.set()

    def _check_running(self):
        if self._stopping.is_set():
            exhausted("Server shutting down; reconnect later")

    def _mailbox(self, db, pid, mailbox_id, *, active=False, owner=False):
        bounded_text(mailbox_id, 128, "mailbox_id")
        row = db.execute("SELECT * FROM mailboxes WHERE mailbox_id=?", (mailbox_id,)).fetchone()
        if row is None:
            missing()
        session = self.session(db, pid, row["session_id"], active=active, owner=owner)
        return row, session

    def _view(self, row):
        return {"schema_version": 1, "mailbox_id": row["mailbox_id"], "session_id": row["session_id"],
                "name": row["name"], "created_at": timestamp(row["created_at"])}

    def create(self, session_id, name="", idempotency_key=None):
        bounded_text(name, 256, "name")
        payload = {"name": name}
        with self.database.transaction(write=True) as db:
            pid = self.principal(db)
            self.session(db, pid, session_id, active=True, owner=True)
            old = self.replay(db, pid, session_id, "create", idempotency_key, payload)
            if old:
                return old
            if db.execute("SELECT COUNT(*) FROM mailboxes WHERE session_id=?", (session_id,)).fetchone()[0] >= self.settings.max_mailboxes:
                exhausted("Mailbox quota reached")
            self.rate(db, pid)
            mid = opaque_id()
            db.execute("INSERT INTO mailboxes(mailbox_id,session_id,name,created_at) VALUES (?,?,?,?)",
                       (mid, session_id, name, self.clock()))
            result = self._view(self._mailbox(db, pid, mid)[0])
            self.remember(db, pid, session_id, "create", idempotency_key, payload, result, session_id)
            self.audit(db, pid, session_id, "mailbox_create", mid)
            return result

    def list(self, session_id=None, after_cursor=None, limit=20):
        bounded_int(limit, 1, 100, "limit")
        with self.database.transaction() as db:
            pid = self.principal(db)
            if session_id is not None:
                self.session(db, pid, session_id)
            scope = f"mailboxes:{pid}:{session_id or '*'}"
            start = offset(after_cursor, scope)
            rows = db.execute("""SELECT m.* FROM mailboxes m JOIN session_acl a USING(session_id)
                                 WHERE a.principal_id=? AND m.ordinal>?
                                   AND (? IS NULL OR m.session_id=?)
                                 ORDER BY m.ordinal LIMIT ?""",
                              (pid, start, session_id, session_id, limit + 1)).fetchall()
            return {"schema_version": 1, "mailboxes": [self._view(r) for r in rows[:limit]],
                    "next_cursor": cursor(scope, rows[limit - 1]["ordinal"]) if len(rows) > limit else None}

    def _send(self, mailbox_id, text, correlation_id=None, idempotency_key=None, in_reply_to=None):
        bounded_text(text, self.settings.max_text_bytes, "text")
        bounded_text(correlation_id, 128, "correlation_id", optional=True)
        bounded_text(in_reply_to, 128, "in_reply_to", optional=True)
        payload = {"text": text, "correlation_id": correlation_id, "in_reply_to": in_reply_to}
        operation = "reply" if in_reply_to is not None else "send"
        with self.database.transaction(write=True) as db:
            pid = self.principal(db)
            box, _ = self._mailbox(db, pid, mailbox_id, active=True)
            old = self.replay(db, pid, mailbox_id, operation, idempotency_key, payload)
            if old:
                return {**old, "duplicated": True}
            if in_reply_to is not None:
                if not db.execute("SELECT 1 FROM messages WHERE mailbox_id=? AND message_id=? AND sent_at>?",
                                  (mailbox_id, in_reply_to, self.clock() - self.settings.retention_seconds)).fetchone():
                    missing()
            # Retention pruning, sequence assignment and quota checks share one write lock.
            db.execute("DELETE FROM messages WHERE mailbox_id=? AND sent_at<=?",
                       (mailbox_id, self.clock() - self.settings.retention_seconds))
            count, size = db.execute("SELECT COUNT(*),COALESCE(SUM(text_bytes),0) FROM messages WHERE mailbox_id=?", (mailbox_id,)).fetchone()
            encoded_size = len(text.encode("utf-8"))
            if count >= self.settings.max_messages or size + encoded_size > self.settings.max_mailbox_bytes:
                exhausted("Mailbox full; retry after retention cleanup")
            self.rate(db, pid)
            sequence = box["last_sequence"] + 1
            message_id, now = opaque_id(), self.clock()
            db.execute("UPDATE mailboxes SET last_sequence=? WHERE mailbox_id=?", (sequence, mailbox_id))
            db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)",
                       (message_id, mailbox_id, sequence, pid, text, encoded_size, correlation_id, in_reply_to, now))
            result = {"schema_version": 1, "message_id": message_id, "sequence": sequence,
                      "sent_at": timestamp(now), "duplicated": False}
            if in_reply_to is not None:
                result["in_reply_to"] = in_reply_to
            self.remember(db, pid, mailbox_id, operation, idempotency_key, payload, result, box["session_id"])
            self.audit(db, pid, box["session_id"], f"mailbox_{operation}", message_id)
            return result

    def send(self, mailbox_id, text, correlation_id=None, idempotency_key=None):
        return self._send(mailbox_id, text, correlation_id, idempotency_key)

    def reply(self, mailbox_id, in_reply_to, text, idempotency_key=None):
        bounded_text(in_reply_to, 128, "in_reply_to")
        if not in_reply_to:
            invalid("in_reply_to required")
        return self._send(mailbox_id, text, idempotency_key=idempotency_key, in_reply_to=in_reply_to)

    def _message_view(self, row):
        return {"message_id": row["message_id"], "sequence": row["sequence"], "text": row["text"],
                "sender_label": row["label"], "correlation_id": row["correlation_id"],
                "in_reply_to": row["in_reply_to"], "sent_at": timestamp(row["sent_at"]),
                "acknowledged": bool(row["acknowledged"])}

    def _read(self, db, pid, mailbox_id, *, start=0, limit=20, message_id=None):
        return db.execute("""SELECT m.*,p.label, d.message_id IS NOT NULL AS acknowledged
                             FROM messages m JOIN principals p ON p.principal_id=m.sender
                             LEFT JOIN deliveries d ON d.message_id=m.message_id AND d.principal_id=?
                             WHERE m.mailbox_id=? AND m.sequence>? AND m.sent_at>?
                               AND (? IS NULL OR m.message_id=?)
                             ORDER BY m.sequence LIMIT ?""",
                          (pid, mailbox_id, start, self.clock() - self.settings.retention_seconds,
                           message_id, message_id, limit)).fetchall()

    def get_message(self, mailbox_id, message_id):
        bounded_text(message_id, 128, "message_id")
        with self.database.transaction() as db:
            pid = self.principal(db)
            self._mailbox(db, pid, mailbox_id)
            rows = self._read(db, pid, mailbox_id, message_id=message_id, limit=1)
            if not rows:
                missing()
            return {"schema_version": 1, **self._message_view(rows[0])}

    def ack(self, mailbox_id, message_id):
        bounded_text(message_id, 128, "message_id")
        with self.database.transaction(write=True) as db:
            pid = self.principal(db)
            box, _ = self._mailbox(db, pid, mailbox_id)
            rows = self._read(db, pid, mailbox_id, message_id=message_id, limit=1)
            if not rows:
                missing()
            if not rows[0]["acknowledged"]:
                self.rate(db, pid)
                db.execute("INSERT INTO deliveries VALUES (?,?,?)", (message_id, pid, self.clock()))
                self.audit(db, pid, box["session_id"], "mailbox_ack", message_id)
            return {"schema_version": 1, "message_id": message_id, "acknowledged": True}

    def _snapshot(self, mailbox_id, after_cursor, limit, *, require_active=False):
        with self.database.transaction() as db:
            pid = self.principal(db)
            _, session = self._mailbox(db, pid, mailbox_id, active=require_active)
            scope = f"messages:{mailbox_id}"
            start = offset(after_cursor, scope)
            rows = self._read(db, pid, mailbox_id, start=start, limit=limit + 1)
            result = {"schema_version": 1, "messages": [self._message_view(r) for r in rows[:limit]],
                      "next_cursor": cursor(scope, rows[min(limit, len(rows)) - 1]["sequence"]) if rows else cursor(scope, start),
                      "has_more": len(rows) > limit}
            active = session["status"] == "active" and session["expires_at"] > self.clock()
            return result, active

    async def receive(self, mailbox_id, after_cursor=None, limit=20, wait_seconds=0):
        self._check_running()
        bounded_int(limit, 1, 100, "limit")
        if (type(wait_seconds) not in (int, float) or not math.isfinite(wait_seconds)
                or not 0 <= wait_seconds <= self.settings.max_wait_seconds):
            invalid("wait_seconds must be finite and within configured bound")
        result, active = await run_db(self._snapshot, mailbox_id, after_cursor, limit)
        if result["messages"] or not wait_seconds or not active:
            return result
        with self._waiter_lock:
            if self._waiters >= self.settings.max_waiters:
                exhausted("Too many waiting consumers")
            self._waiters += 1
        try:
            deadline = asyncio.get_running_loop().time() + wait_seconds
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    return result
                # No DB connection or transaction survives this cancellation point.
                await asyncio.sleep(min(0.2, remaining))
                self._check_running()
                result, _ = await run_db(self._snapshot, mailbox_id, after_cursor, limit, require_active=True)
                if result["messages"]:
                    return result
        finally:
            with self._waiter_lock:
                self._waiters -= 1
