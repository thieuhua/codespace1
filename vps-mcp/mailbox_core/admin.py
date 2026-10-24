"""Trusted offline provisioning API. NOT an MCP tool or model-callable API."""
import time
from .common import bounded_text
from .errors import missing, GatewayError


class Provisioner:
    def __init__(self, database):
        self.database = database

    def principal(self, principal_id, label):
        bounded_text(principal_id, 128, "principal_id")
        bounded_text(label, 128, "label")
        if not principal_id or not label:
            raise ValueError("nonempty provisioned identity/label required")
        with self.database.transaction(write=True) as db:
            db.execute("""INSERT INTO principals(principal_id,label) VALUES (?,?)
                          ON CONFLICT(principal_id) DO UPDATE SET label=excluded.label""", (principal_id, label))

    def grant(self, session_id, principal_id):
        # Scope: all current and future mailboxes in exactly this session.
        with self.database.transaction(write=True) as db:
            if not db.execute("SELECT 1 FROM logical_sessions WHERE session_id=?", (session_id,)).fetchone():
                missing()
            db.execute("INSERT OR IGNORE INTO session_acl VALUES (?,?)", (session_id, principal_id))

    def revoke(self, session_id, principal_id):
        with self.database.transaction(write=True) as db:
            row = db.execute("SELECT owner FROM logical_sessions WHERE session_id=?", (session_id,)).fetchone()
            if row and row[0] == principal_id:
                raise ValueError("cannot revoke owner; disable principal instead")
            db.execute("DELETE FROM session_acl WHERE session_id=? AND principal_id=?", (session_id, principal_id))

    def disable(self, principal_id):
        with self.database.transaction(write=True) as db:
            db.execute("UPDATE principals SET enabled=0 WHERE principal_id=?", (principal_id,))

    def cleanup(self, *, now=None):
        """Explicit retention sweep. Keeps idempotency tombstones until session deletion."""
        cutoff = (time.time() if now is None else now) - self.database.settings.retention_seconds
        with self.database.transaction(write=True) as db:
            messages = db.execute("DELETE FROM messages WHERE sent_at<=?", (cutoff,)).rowcount
            sessions = db.execute("""DELETE FROM logical_sessions
                                     WHERE (status='closed' AND closed_at<=?)
                                        OR (status='active' AND expires_at<=?)""", (cutoff, cutoff)).rowcount
            return {"messages_deleted": messages, "sessions_deleted": sessions}
