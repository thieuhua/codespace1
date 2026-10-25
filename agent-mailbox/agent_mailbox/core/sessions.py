"""Logical sessions, independent of transport connections."""
import time
from .common import ServiceBase, opaque_id, timestamp, bounded_int, bounded_text, cursor, offset
from .errors import exhausted


class SessionService(ServiceBase):
    def __init__(self, database, *, clock=time.time):
        self.database, self.settings, self.clock = database, database.settings, clock

    def _view(self, row):
        status = row["status"]
        if status == "active" and row["expires_at"] <= self.clock():
            status = "expired"
        return {"schema_version": 1, "session_id": row["session_id"], "name": row["name"],
                "status": status, "created_at": timestamp(row["created_at"]),
                "expires_at": timestamp(row["expires_at"]), "last_seen": timestamp(row["last_seen"])}

    def open(self, name="", ttl_seconds=None, idempotency_key=None):
        bounded_text(name, 256, "name")
        ttl = bounded_int(self.settings.default_ttl if ttl_seconds is None else ttl_seconds,
                          1, self.settings.max_ttl, "ttl_seconds")
        payload = {"name": name, "ttl_seconds": ttl}
        with self.database.transaction(write=True) as db:
            pid = self.principal(db)
            old = self.replay(db, pid, "sessions", "open", idempotency_key, payload)
            if old:
                return old
            if db.execute("SELECT COUNT(*) FROM logical_sessions WHERE owner=?", (pid,)).fetchone()[0] >= self.settings.max_sessions:
                exhausted("Session quota reached")
            self.rate(db, pid)
            sid, now = opaque_id(), self.clock()
            db.execute("""INSERT INTO logical_sessions(session_id,owner,name,status,created_at,expires_at,last_seen)
                          VALUES (?,?,?,'active',?,?,?)""", (sid, pid, name, now, now + ttl, now))
            db.execute("INSERT INTO session_acl VALUES (?,?)", (sid, pid))
            result = self._view(self.session(db, pid, sid))
            self.remember(db, pid, "sessions", "open", idempotency_key, payload, result, sid)
            self.audit(db, pid, sid, "session_open", sid)
            return result

    def get(self, session_id):
        # Resume is get: stable ID and history, with an updated last_seen.
        with self.database.transaction(write=True) as db:
            pid = self.principal(db)
            self.session(db, pid, session_id)
            self.rate(db, pid)
            db.execute("UPDATE logical_sessions SET last_seen=? WHERE session_id=?", (self.clock(), session_id))
            return self._view(self.session(db, pid, session_id))

    def list(self, after_cursor=None, limit=20):
        bounded_int(limit, 1, 100, "limit")
        with self.database.transaction() as db:
            pid = self.principal(db)
            scope = f"sessions:{pid}"
            start = offset(after_cursor, scope)
            rows = db.execute("""SELECT s.* FROM logical_sessions s JOIN session_acl a USING(session_id)
                                 WHERE a.principal_id=? AND s.ordinal>? ORDER BY s.ordinal LIMIT ?""",
                              (pid, start, limit + 1)).fetchall()
            return {"schema_version": 1, "sessions": [self._view(r) for r in rows[:limit]],
                    "next_cursor": cursor(scope, rows[limit - 1]["ordinal"]) if len(rows) > limit else None}

    def renew(self, session_id, ttl_seconds=None):
        ttl = bounded_int(self.settings.default_ttl if ttl_seconds is None else ttl_seconds,
                          1, self.settings.max_ttl, "ttl_seconds")
        with self.database.transaction(write=True) as db:
            pid = self.principal(db)
            self.session(db, pid, session_id, active=True, owner=True)
            self.rate(db, pid)
            now = self.clock()
            db.execute("UPDATE logical_sessions SET expires_at=?,last_seen=? WHERE session_id=?", (now + ttl, now, session_id))
            self.audit(db, pid, session_id, "session_renew", session_id)
            return self._view(self.session(db, pid, session_id))

    def close(self, session_id):
        with self.database.transaction(write=True) as db:
            pid = self.principal(db)
            row = self.session(db, pid, session_id, owner=True)
            if row["status"] != "closed":
                self.rate(db, pid)
                db.execute("UPDATE logical_sessions SET status='closed',closed_at=? WHERE session_id=?", (self.clock(), session_id))
                self.audit(db, pid, session_id, "session_close", session_id)
            return self._view(self.session(db, pid, session_id))

    def activity(self, session_id, after_cursor=None, limit=20):
        """Paginated metadata only; no payloads, command output or credentials."""
        bounded_int(limit, 1, 100, "limit")
        with self.database.transaction() as db:
            pid = self.principal(db)
            self.session(db, pid, session_id)
            scope = f"activity:{session_id}"
            start = offset(after_cursor, scope)
            rows = db.execute("""SELECT * FROM audit WHERE session_id=? AND event_id>?
                                 ORDER BY event_id LIMIT ?""", (session_id, start, limit + 1)).fetchall()
            return {"schema_version": 1,
                    "events": [{"operation": r["operation"], "resource_id": r["resource_id"],
                                "at": timestamp(r["at"])} for r in rows[:limit]],
                    "next_cursor": cursor(scope, rows[min(limit, len(rows)) - 1]["event_id"]) if rows else cursor(scope, start),
                    "has_more": len(rows) > limit}
