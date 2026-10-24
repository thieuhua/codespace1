"""Offline token issuance and per-transaction credential verification."""
from contextlib import contextmanager
import hmac
import os
import re
import secrets
import sqlite3
import time

from .core.database import Database
from .core.errors import GatewayError
from .core.identity import Principal, trusted_identity
from .paths import safe_path, private_directory, owner_only

AUTH_SQL = """CREATE TABLE IF NOT EXISTS local_credentials (
    token_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id),
    salt BLOB NOT NULL, digest BLOB NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL
)"""
TOKEN_PATTERN = re.compile(r"amb1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})\Z")


def unauthenticated():
    raise GatewayError("UNAUTHENTICATED", "Valid local authentication required")


def load_token(token_file=None, environ=None):
    env = os.environ if environ is None else environ
    filename = token_file if token_file is not None else env.get("AGENT_MAILBOX_TOKEN_FILE")
    # An explicitly selected unreadable/invalid file must never fall back to env.
    if filename is not None:
        try:
            path = safe_path(filename, file=True)
            with path.open("r", encoding="utf-8-sig") as stream:
                return stream.read(4097).strip()
        except (OSError, ValueError, UnicodeError):
            return ""
    return env.get("AGENT_MAILBOX_TOKEN", "").strip()


def verify(conn, token):
    match = TOKEN_PATTERN.fullmatch(token) if isinstance(token, str) else None
    if not match:
        unauthenticated()
    try:
        row = conn.execute("""SELECT c.*,p.enabled FROM local_credentials c
                             JOIN principals p USING(principal_id) WHERE token_id=?""",
                           (match[1],)).fetchone()
    except sqlite3.Error:
        unauthenticated()
    salt = bytes(row["salt"]) if row else bytes(32)
    expected = bytes(row["digest"]) if row else bytes(32)
    actual = hmac.digest(salt, token.encode("ascii"), "sha256")
    valid = hmac.compare_digest(actual, expected)
    if not valid or row is None or row["revoked"] or not row["enabled"]:
        unauthenticated()
    return Principal(row["principal_id"])


def issue_token(database, principal_id, path, *, rotate=False):
    path = safe_path(path, file=True)
    # Do not change an existing external parent directory's ACL just because
    # the operator selected a custom token-file path within it.
    if not path.parent.exists():
        private_directory(path.parent)
    if path.exists():
        raise ValueError("Token file already exists; choose a new path when rotating")
    token = f"amb1.{secrets.token_hex(16)}.{secrets.token_urlsafe(32)}"
    salt = secrets.token_bytes(32)
    digest = hmac.digest(salt, token.encode("ascii"), "sha256")
    # Exclusive creation inside a private directory; protect the empty file first.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="ascii", newline="\n") as stream:
            owner_only(path)
            stream.write(token + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        with database.transaction(write=True) as conn:
            if rotate:
                conn.execute("DELETE FROM local_credentials WHERE principal_id=?", (principal_id,))
            conn.execute("INSERT INTO local_credentials VALUES (?,?,?,?,0,?)",
                         (token.split(".")[1], principal_id, salt, digest, time.time()))
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return token


class AuthenticatedDatabase(Database):
    """Never initialize storage from a server; authorize before yielding each txn.

    The check shares the mailbox transaction's SQLite snapshot. Long-poll snapshots
    therefore recheck token revocation and disabled state before reading history.
    """
    def __init__(self, settings, token):
        self.settings, self.token = settings, token
        self.bound_principal = None

    def _connect(self):
        if not self.token or not self.settings.db_path.is_file():
            unauthenticated()
        return super()._connect()

    @contextmanager
    def transaction(self, *, write=False):
        with super().transaction(write=write) as conn:
            principal = verify(conn, self.token)
            if self.bound_principal is not None and self.bound_principal != principal:
                unauthenticated()
            with trusted_identity(principal):
                yield conn

    def authenticate(self):
        if not TOKEN_PATTERN.fullmatch(self.token):
            unauthenticated()
        try:
            with self.transaction() as conn:
                principal = verify(conn, self.token)
                self.bound_principal = principal
                return principal
        except (OSError, ValueError, sqlite3.Error):
            unauthenticated()
