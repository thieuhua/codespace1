"""Trusted offline CLI operations, never registered as MCP tools."""
import hashlib
import re

from .auth import AUTH_SQL, issue_token, load_token, verify
from .core.admin import Provisioner
from .core.database import Database
from .core.errors import GatewayError
from .core.identity import Principal, trusted_identity
from .core.mailboxes import MailboxService
from .core.sessions import SessionService
from .core.settings import Settings
from .paths import owner_only, private_directory, safe_path


def initialize(home):
    private_directory(home)
    private_directory(home / "tokens")
    database = Database(Settings(home / "mailbox.db"))
    with database.transaction(write=True) as conn:
        conn.execute(AUTH_SQL)
    return database


def run(args, home):
    database = initialize(home)
    provisioner = Provisioner(database)
    if args.action == "init":
        owner_only(database.settings.db_path)
        return {"state_dir": str(home), "initialized": True}
    if args.action == "add-principal":
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.id):
            raise ValueError("Principal ID must be 1..128 ASCII letters, digits, dots, underscores or hyphens")
        raw_path = args.token_file if args.token_file is not None else home / "tokens" / f"{args.id}.token"
        path = safe_path(raw_path, file=True)
        with database.transaction() as conn:
            principal_row = conn.execute("SELECT label,enabled FROM principals WHERE principal_id=?", (args.id,)).fetchone()
            if principal_row and not principal_row["enabled"]:
                raise ValueError("Principal is disabled")
            existing = conn.execute("SELECT 1 FROM local_credentials WHERE principal_id=?", (args.id,)).fetchone()
            if existing and args.if_missing:
                identity = verify(conn, load_token(str(path), {}))
                if identity.principal_id != args.id:
                    raise ValueError("Existing token file belongs to a different principal")
                owner_only(path)
                return {"principal_id": args.id, "token_file": str(path), "created": False}
            if existing and not args.rotate:
                raise ValueError("Principal already has a credential; use --if-missing or --rotate with a new token file")
        if path.exists():
            raise ValueError("Token file already exists; choose a new path when rotating")
        label = args.label or (principal_row["label"] if principal_row else args.id)
        provisioner.principal(args.id, label)
        token = issue_token(database, args.id, path, rotate=args.rotate)
        result = {"principal_id": args.id, "token_file": str(path), "created": True}
        if args.print_token:
            result["token"] = token
        return result
    if args.action in ("revoke", "disable"):
        with database.transaction(write=True) as conn:
            cursor = conn.execute("UPDATE local_credentials SET revoked=1 WHERE principal_id=?", (args.id,))
            if not cursor.rowcount:
                raise ValueError("Principal not found")
        if args.action == "disable":
            provisioner.disable(args.id)
        return {"principal_id": args.id, "revoked": True, "disabled": args.action == "disable"}
    if args.action == "list-principals":
        with database.transaction() as conn:
            rows = conn.execute("""SELECT p.principal_id,p.label,p.enabled,COALESCE(c.revoked,1) AS revoked
                                   FROM principals p LEFT JOIN local_credentials c USING(principal_id)
                                   ORDER BY p.principal_id""").fetchall()
        return {"principals": [dict(row) for row in rows]}
    if args.action == "cleanup":
        result = provisioner.cleanup()
        database.checkpoint()
        return result
    if args.action == "create-shared-session":
        # Validate all identities before creating resources; no credentials needed offline.
        with database.transaction() as conn:
            for pid in {args.owner, *args.participant}:
                row = conn.execute("SELECT enabled FROM principals WHERE principal_id=?", (pid,)).fetchone()
                if not row or not row[0]:
                    raise ValueError("Owner/participants must be provisioned and enabled")
        sessions, mailboxes = SessionService(database), MailboxService(database)
        with trusted_identity(Principal(args.owner)):
            # Find an existing active named session to make setup safe after TTL/cleanup.
            with database.transaction() as conn:
                row = conn.execute("""SELECT session_id FROM logical_sessions WHERE owner=? AND name=?
                                      AND status='active' ORDER BY ordinal DESC LIMIT 1""",
                                   (args.owner, args.name)).fetchone()
            if row:
                try:
                    session = sessions.renew(row[0], args.ttl_seconds)
                except GatewayError as exc:
                    if exc.code not in ("EXPIRED", "CONFLICT"):
                        raise
                    session = None
            else:
                session = None
            if session is None:
                session = sessions.open(args.name, args.ttl_seconds)
            sid = session["session_id"]
            for pid in args.participant:
                provisioner.grant(sid, pid)
            box = mailboxes.create(sid, args.mailbox,
                                   idempotency_key="admin-" + hashlib.sha256(args.mailbox.encode()).hexdigest())
        return {"session": session, "mailbox": box, "participants": sorted(set(args.participant))}
    raise ValueError("Unknown admin action")
