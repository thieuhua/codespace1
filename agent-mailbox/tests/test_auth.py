"""Credential-only checks and transaction authorization before mailbox SQL."""
import hmac
import secrets
import sqlite3
from types import SimpleNamespace
from unittest.mock import patch

from agent_mailbox.auth import AUTH_SQL, AuthenticatedDatabase, issue_token, verify
from agent_mailbox.core.identity import Principal
from agent_mailbox.core.sessions import SessionService
from agent_mailbox.paths import owner_only, private_directory
from tests.support import ServiceCase


class AuthTests(ServiceCase):
    def setUp(self):
        super().setUp()
        self.token = f"amb1.{secrets.token_hex(16)}.{secrets.token_urlsafe(32)}"
        self.salt = secrets.token_bytes(32)
        with self.db.transaction(write=True) as conn:
            conn.execute(AUTH_SQL)
            conn.execute("INSERT INTO local_credentials VALUES (?,?,?,?,0,0)",
                         (self.token.split(".")[1], "A", self.salt,
                          hmac.digest(self.salt, self.token.encode(), "sha256")))

    def test_custom_token_path_does_not_change_existing_parent_permissions(self):
        import os
        from pathlib import Path
        parent = Path(self.temp.name)

        def permissions():
            if os.name != "nt":
                return parent.stat().st_mode
            import win32security
            flags = win32security.DACL_SECURITY_INFORMATION
            descriptor = win32security.GetFileSecurity(str(parent), flags)
            return win32security.ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, flags)

        before = permissions()
        token_path = parent / "custom.token"
        with patch("agent_mailbox.auth.owner_only", wraps=owner_only) as protected, \
                patch("agent_mailbox.auth.private_directory", wraps=private_directory) as directory:
            token = issue_token(self.db, "B", token_path)
        self.assertEqual(token_path.read_text().strip(), token)
        self.assertEqual(permissions(), before)
        protected.assert_called_once_with(token_path.resolve())
        directory.assert_not_called()

    def test_constant_time_digest_comparison_even_for_unknown_id(self):
        with self.db.transaction() as conn:
            with patch("agent_mailbox.auth.hmac.compare_digest", wraps=hmac.compare_digest) as compare:
                self.assertEqual(verify(conn, self.token), Principal("A"))
                compare.assert_called_once()
                self.assertEqual([len(v) for v in compare.call_args.args], [32, 32])
            unknown = f"amb1.{secrets.token_hex(16)}.{secrets.token_urlsafe(32)}"
            with patch("agent_mailbox.auth.hmac.compare_digest", wraps=hmac.compare_digest) as compare:
                self.assert_code("UNAUTHENTICATED", verify, conn, unknown)
                compare.assert_called_once()
            for token in ("", "A", self.token + "extra", self.token.replace("amb1", "amb2")):
                self.assert_code("UNAUTHENTICATED", verify, conn, token)

    def test_authentication_never_reads_mailbox_tables_and_revocation_is_atomic(self):
        runtime = AuthenticatedDatabase(self.settings, self.token)
        self.assertEqual(runtime.authenticate(), Principal("A"))
        forbidden = {"logical_sessions", "session_acl", "mailboxes", "messages", "deliveries"}
        attempted = []
        original = runtime._connect

        def connect():
            conn = original()

            def authorizer(action, table, *_):
                if action in (sqlite3.SQLITE_READ, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE) and table in forbidden:
                    attempted.append(table)
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            conn.set_authorizer(authorizer)
            return conn

        with self.db.transaction(write=True) as conn:
            conn.execute("UPDATE local_credentials SET revoked=1")
        with patch.object(runtime, "_connect", side_effect=connect):
            self.assert_code("UNAUTHENTICATED", runtime.authenticate)
            # Even a forged trusted Python context cannot bypass transaction auth.
            with self.as_user():
                self.assert_code("UNAUTHENTICATED", SessionService(runtime).list)
        self.assertEqual(attempted, [])

    def test_process_cannot_rebind_to_another_principal_and_disabled_rechecked(self):
        runtime = AuthenticatedDatabase(self.settings, self.token)
        self.assertEqual(SessionService(runtime).list()["sessions"], [])
        self.assertEqual(runtime.bound_principal, Principal("A"))
        self.assertEqual(runtime.authenticate(), Principal("A"))
        self.admin.disable("A")
        self.assert_code("UNAUTHENTICATED", runtime.authenticate)
        with self.db.transaction(write=True) as conn:
            conn.execute("UPDATE local_credentials SET principal_id='B'")
        self.assert_code("UNAUTHENTICATED", runtime.authenticate)
        self.assert_code("UNAUTHENTICATED", SessionService(runtime).list)

    def test_acl_failure_is_not_silently_ignored_for_normal_windows_token(self):
        import os
        if os.name != "nt":
            # POSIX has a real mode assertion in admin tests; verify chmod failure.
            with patch("pathlib.Path.chmod", side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    owner_only(self.settings.db_path)
            return
        with patch("agent_mailbox.paths.subprocess.run", return_value=SimpleNamespace(returncode=1)), \
                patch("agent_mailbox.paths.restricted_windows_token", return_value=False):
            with self.assertRaisesRegex(OSError, "owner-only Windows ACL"):
                owner_only(self.settings.db_path)
