"""Approval-token state machine. Not connected to MCP or a privileged executor.

This module is policy-neutral: an approval NEVER grants unrestricted root shell.
Only the separate privileged broker may call approve() and redeem(), after
authenticating the owner and verifying an allowlisted operation respectively.
The agent-facing gateway must never be able to open this database.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import sqlite3
import time
from typing import Callable

PENDING_TTL_SECONDS = 300
KEY_TTL_SECONDS = 90
MAX_COMMAND_BYTES = 8192


@dataclass(frozen=True)
class ExecutionIntent:
    """Exact proposed invocation, including the authenticated caller identity."""

    principal: str
    operation: str
    target: str
    command: str
    cwd: str
    timeout_seconds: int

    def __post_init__(self) -> None:
        for name in ("principal", "operation", "target", "command", "cwd"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip() or "\x00" in value:
                raise ValueError(f"invalid {name}")
        if len(self.command.encode("utf-8")) > MAX_COMMAND_BYTES:
            raise ValueError("command exceeds size limit")
        if type(self.timeout_seconds) is not int or not 1 <= self.timeout_seconds <= 90:
            raise ValueError("invalid timeout")

    def canonical_bytes(self) -> bytes:
        return json.dumps(asdict(self), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def digest(self) -> str:
        return hashlib.sha256(self.canonical_bytes()).hexdigest()


class ApprovalStore:
    """SQLite token lifecycle. Instantiate ONLY in a separately privileged broker.

    create() can be triggered by an agent-facing API. approve()/deny() MUST only
    be invoked after an independently authenticated owner decision. redeem()
    MUST be invoked by the broker immediately before its allowlisted operation.
    """

    def __init__(self, db_path: str | Path, *, clock: Callable[[], float] = time.time):
        self.db_path = str(db_path)
        self.clock = clock
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS approvals (
                    id TEXT PRIMARY KEY,
                    intent_digest TEXT NOT NULL,
                    intent_json TEXT NOT NULL,
                    principal TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'consumed')),
                    requested_at REAL NOT NULL,
                    request_expires_at REAL NOT NULL,
                    approved_by TEXT,
                    token_digest TEXT,
                    key_expires_at REAL,
                    consumed_at REAL
                )
            """)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _transaction(self, fn):
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            result = fn(conn)
            conn.commit()
            return result

    def create(self, intent: ExecutionIntent) -> str:
        request_id = secrets.token_urlsafe(18)
        now = self.clock()
        def op(conn):
            conn.execute(
                """INSERT INTO approvals
                   (id, intent_digest, intent_json, principal, state, requested_at, request_expires_at)
                   VALUES (?, ?, ?, ?, 'pending', ?, ?)""",
                (request_id, intent.digest(), intent.canonical_bytes().decode("utf-8"),
                 intent.principal, now, now + PENDING_TTL_SECONDS),
            )
            return request_id
        return self._transaction(op)

    def get_request(self, request_id: str) -> dict | None:
        """Nonsecret review data. Do not expose approval secrets via this method."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT intent_json, state, requested_at, request_expires_at FROM approvals WHERE id=?",
                (request_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "intent": json.loads(row["intent_json"]),
            "state": row["state"],
            "requested_at": row["requested_at"],
            "request_expires_at": row["request_expires_at"],
        }

    def approve(self, request_id: str, *, verified_approver: str) -> str | None:
        """TRUSTED OWNER-UI/BROKER ENTRY ONLY. Returns one-time key once.

        Never expose as an MCP tool, and never let the agent select the approver.
        """
        if not isinstance(verified_approver, str) or not verified_approver.strip():
            raise ValueError("verified_approver required")
        now = self.clock()
        def op(conn):
            row = conn.execute(
                "SELECT state, request_expires_at FROM approvals WHERE id=?", (request_id,)
            ).fetchone()
            if row is None or row["state"] != "pending" or now >= row["request_expires_at"]:
                return None
            key = secrets.token_urlsafe(32)
            conn.execute(
                """UPDATE approvals SET state='approved', approved_by=?, token_digest=?, key_expires_at=?
                   WHERE id=? AND state='pending'""",
                (verified_approver, hashlib.sha256(key.encode()).hexdigest(), now + KEY_TTL_SECONDS, request_id),
            )
            return key
        return self._transaction(op)

    def deny(self, request_id: str, *, verified_approver: str) -> bool:
        """TRUSTED OWNER-UI/BROKER ENTRY ONLY."""
        if not isinstance(verified_approver, str) or not verified_approver.strip():
            raise ValueError("verified_approver required")
        now = self.clock()
        def op(conn):
            row = conn.execute(
                "SELECT state, request_expires_at FROM approvals WHERE id=?", (request_id,)
            ).fetchone()
            if row is None or row["state"] != "pending" or now >= row["request_expires_at"]:
                return False
            conn.execute(
                "UPDATE approvals SET state='denied', approved_by=? WHERE id=?",
                (verified_approver, request_id),
            )
            return True
        return self._transaction(op)

    def redeem(self, request_id: str, key: str, intent: ExecutionIntent) -> bool:
        """Atomic one-use claim. Broker still MUST independently authorize the operation."""
        if not isinstance(key, str) or len(key) > 256:
            return False
        now = self.clock()
        def op(conn):
            row = conn.execute(
                "SELECT state, intent_digest, principal, token_digest, key_expires_at FROM approvals WHERE id=?",
                (request_id,),
            ).fetchone()
            if (row is None or row["state"] != "approved" or row["key_expires_at"] is None
                    or now >= row["key_expires_at"] or row["principal"] != intent.principal
                    or not hmac.compare_digest(row["intent_digest"], intent.digest())):
                return False
            if not hmac.compare_digest(row["token_digest"], hashlib.sha256(key.encode()).hexdigest()):
                return False
            conn.execute(
                "UPDATE approvals SET state='consumed', consumed_at=? WHERE id=? AND state='approved'",
                (now, request_id),
            )
            return True
        return self._transaction(op)
