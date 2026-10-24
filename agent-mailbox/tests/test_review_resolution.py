"""Regression evidence for the independent review; only temporary local state."""
import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent_mailbox.__main__ import parser
from agent_mailbox.auth import AUTH_SQL, AuthenticatedDatabase, issue_token, load_token, verify
from agent_mailbox.core.errors import GatewayError
from agent_mailbox.core.identity import Principal
from agent_mailbox.core.mailboxes import MailboxService
from agent_mailbox.core.sessions import SessionService
from agent_mailbox.core.tools import register
from agent_mailbox.paths import owner_only, safe_path, state_home
from agent_mailbox.server import AuthenticatedMCP
from tests.local_support import admin
from tests.support import ServiceCase, retry_storage_busy

PROJECT = Path(__file__).resolve().parents[1]


def powershell(script, *arguments, cwd=None, env=None):
    environment = os.environ.copy() if env is None else env.copy()
    environment.pop("PSModulePath", None)
    environment["PSEXECUTIONPOLICYPREFERENCE"] = "Restricted"
    return subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                           "-NonInteractive", "-File", str(script), *arguments],
                          cwd=cwd, env=environment, capture_output=True, text=True, timeout=30)


def quoted(value):
    return "'" + str(value).replace("'", "''") + "'"


class PathReviewTests(unittest.TestCase):
    def test_resolved_repository_and_explicit_empty_paths_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            repo = root / "repo"
            repo.mkdir()
            (repo / ".git").write_text("gitdir: external")
            # Simulate the alias resolution supplied by Windows subst; use real
            # filesystem metadata on BOTH sides of the resolution boundary.
            with patch.object(Path, "resolve", return_value=repo / "state"):
                with self.assertRaisesRegex(ValueError, "outside repositories"):
                    safe_path(root / "alias" / "state")
            for value in ("", " ", "\t"):
                with self.subTest(value=value), patch.dict(os.environ, {"AGENT_MAILBOX_HOME": str(root)}):
                    with self.assertRaises(ValueError):
                        safe_path(value)
                    with self.assertRaises(ValueError):
                        state_home(value)
                    self.assertEqual(load_token(value, {"AGENT_MAILBOX_TOKEN": "fallback"}), "")

    def test_state_dir_at_every_admin_parser_level(self):
        actions = [("init",), ("add-principal", "A"), ("revoke", "A"), ("disable", "A"),
                   ("list-principals",), ("cleanup",), ("create-shared-session", "--owner", "A")]
        for action in actions:
            for arguments in (["--state-dir", "selected", "admin", *action],
                              ["admin", "--state-dir", "selected", *action],
                              ["admin", *action, "--state-dir", "selected"]):
                with self.subTest(arguments=arguments):
                    self.assertEqual(parser().parse_args(arguments).state_dir, "selected")


class TransactionReviewTests(ServiceCase):
    def setUp(self):
        super().setUp()
        with self.db.transaction(write=True) as conn:
            conn.execute(AUTH_SQL)
        self.token = issue_token(self.db, "A", Path(self.temp.name) / "A.token")
        self.runtime = AuthenticatedDatabase(self.settings, self.token)

    def test_first_direct_transaction_binds_before_any_authenticate(self):
        sessions = SessionService(self.runtime)
        self.assertEqual(sessions.list()["sessions"], [])
        self.assertEqual(self.runtime.bound_principal, Principal("A"))
        with self.db.transaction(write=True) as conn:
            conn.execute("UPDATE local_credentials SET principal_id='B'")
        self.assert_code("UNAUTHENTICATED", sessions.list)
        self.assert_code("UNAUTHENTICATED", self.runtime.authenticate)

    def test_authenticate_verifies_once(self):
        with patch("agent_mailbox.auth.verify", wraps=verify) as checked:
            self.assertEqual(self.runtime.authenticate(), Principal("A"))
        self.assertEqual(checked.call_count, 1)

    def test_sidecar_permission_denial_is_retryable_before_sql_and_during_dispatch(self):
        original = Path.lstat
        for suffix in ("-wal", "-shm"):
            target = Path(str(self.settings.db_path) + suffix)

            def denied(path, *args, **kwargs):
                if path == target:
                    raise PermissionError(5, "simulated NTFS delete pending")
                return original(path, *args, **kwargs)

            with self.subTest(suffix=suffix), patch.object(Path, "lstat", denied), \
                    patch("sqlite3.connect", side_effect=AssertionError("Unchecked storage was opened")):
                self.assert_code("RESOURCE_EXHAUSTED", self.runtime.authenticate)
                self.assert_code("RESOURCE_EXHAUSTED", SessionService(self.runtime).list)

        attempts = []

        def once(path, *args, **kwargs):
            if path == target and not attempts:
                attempts.append(path)
                raise PermissionError(5, "simulated NTFS delete pending")
            return original(path, *args, **kwargs)

        with patch.object(Path, "lstat", once):
            principal, retries = retry_storage_busy(self.runtime.authenticate)
        self.assertEqual((principal, retries), (Principal("A"), 1))

        server = AuthenticatedMCP(self.runtime)
        register(server, services=(SessionService(self.runtime), MailboxService(self.runtime)))
        checks = []

        def after_auth(path, *args, **kwargs):
            if path == target:
                checks.append(path)
                if len(checks) == 2:
                    raise PermissionError(5, "simulated NTFS delete pending")
            return original(path, *args, **kwargs)

        with patch.object(Path, "lstat", after_auth):
            result = asyncio.run(server.call_tool("session_list", {}))
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent["error"]["code"], "RESOURCE_EXHAUSTED")
        self.assertEqual(json.loads(result.content[0].text), result.structuredContent)
        with patch.object(Path, "lstat", denied):
            result = asyncio.run(server.call_tool("session_list", {}))
        self.assertEqual(result.structuredContent["error"]["code"], "RESOURCE_EXHAUSTED")
        self.assertEqual(SessionService(self.runtime).list()["sessions"], [])

    def test_sidecar_links_still_rejected_after_permission_denial(self):
        source = Path(self.temp.name) / "other-file"
        source.write_text("must not open")
        for suffix in ("-wal", "-shm"):
            link = Path(str(self.settings.db_path) + suffix)
            os.link(source, link)
            try:
                with self.assertRaisesRegex(ValueError, "must not be linked"):
                    SessionService(self.runtime).list()
            finally:
                link.unlink()
        self.assertEqual(self.runtime.authenticate(), Principal("A"))


class SessionReviewTests(ServiceCase):
    def test_get_refresh_consumes_participant_quota_and_rolls_back_when_exhausted(self):
        with self.as_user():
            active = self.sessions.open()["session_id"]
            closed = self.sessions.open()["session_id"]
            self.sessions.close(closed)
            expired = self.sessions.open(ttl_seconds=1)["session_id"]
        for sid in (active, closed, expired):
            self.admin.grant(sid, "B")
        limited = SessionService(replace_database(self.db, writes_per_minute=1), clock=lambda: self.now[0])
        self.now[0] += 2
        for sid, status in ((active, "active"), (closed, "closed"), (expired, "expired")):
            with self.as_user("B"):
                self.now[0] += 60
                self.assertEqual(limited.get(sid)["status"], status)
                with self.db.transaction() as conn:
                    seen = conn.execute("SELECT last_seen FROM logical_sessions WHERE session_id=?", (sid,)).fetchone()[0]
                self.now[0] += 1
                self.assert_code("RESOURCE_EXHAUSTED", limited.get, sid)
                self.assertEqual(len(limited.list()["sessions"]), 3)
                with self.db.transaction() as conn:
                    self.assertEqual(conn.execute("SELECT last_seen FROM logical_sessions WHERE session_id=?", (sid,)).fetchone()[0], seen)
            with self.as_user("C"):
                self.assert_code("NOT_FOUND", limited.get, sid)
        with self.db.transaction() as conn:
            self.assertIsNone(conn.execute("SELECT * FROM rate_limits WHERE principal_id='C'").fetchone())


def replace_database(database, **settings):
    from agent_mailbox.core.database import Database
    return Database(replace(database.settings, **settings))


class AdminReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-mailbox-review-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "state with spaces"

    def test_rejected_provisioning_preserves_principals_credentials_and_labels(self):
        admin(self.home, "add-principal", "A", "--label", "Custom label")
        path = self.home / "tokens" / "A.token"
        token = path.read_bytes()
        for args in (("add-principal", "new", "--token-file", str(path)),
                     ("add-principal", "A", "--rotate", "--label", "Changed"),
                     ("add-principal", "new", "--token-file", "")):
            with self.subTest(args=args), self.assertRaises(ValueError):
                admin(self.home, *args)
        rows = admin(self.home, "list-principals")["principals"]
        self.assertEqual([(r["principal_id"], r["label"]) for r in rows], [("A", "Custom label")])
        admin(self.home, "disable", "A")
        new_path = self.root / "disabled.token"
        with self.assertRaisesRegex(ValueError, "disabled"):
            admin(self.home, "add-principal", "A", "--rotate", "--token-file", str(new_path))
        self.assertFalse(new_path.exists())
        self.assertEqual(path.read_bytes(), token)
        rows = admin(self.home, "list-principals")["principals"]
        self.assertEqual((rows[0]["enabled"], rows[0]["revoked"]), (0, 1))

    def test_init_and_if_missing_reapply_file_protection(self):
        token_file = self.root / "custom.token"
        admin(self.home, "add-principal", "A", "--token-file", str(token_file))
        database_file = self.home / "mailbox.db"
        if os.name != "nt":
            token_file.chmod(0o644)
            database_file.chmod(0o644)
        with patch("agent_mailbox.admin.owner_only", wraps=owner_only) as protected:
            admin(self.home, "init")
            result = admin(self.home, "add-principal", "A", "--if-missing", "--token-file", str(token_file))
        self.assertFalse(result["created"])
        self.assertEqual([call.args[0] for call in protected.call_args_list], [database_file, token_file])
        if os.name != "nt":
            self.assertEqual(token_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(database_file.stat().st_mode & 0o777, 0o600)

    def test_rotated_tokens_flow_through_setup_and_registration_previews(self):
        originals, selected = {}, {}
        for pid in ("codex", "antigravity"):
            originals[pid] = Path(admin(self.home, "add-principal", pid)["token_file"])
            selected[pid] = self.root / (pid + " rotated.token")
            admin(self.home, "add-principal", pid, "--rotate", "--token-file", str(selected[pid]))
            with self.assertRaises(GatewayError) as error:
                admin(self.home, "add-principal", pid, "--if-missing")
            self.assertEqual(error.exception.code, "UNAUTHENTICATED")
        before = {pid: path.read_bytes() for pid, path in selected.items()}
        for name in ("setup.ps1", "register-clients.ps1"):
            result = powershell(PROJECT / "scripts" / name, "-WhatIf",
                                "-StateDir", str(self.home) + os.sep,
                                "-CodexTokenFile", selected["codex"].name,
                                "-AntigravityTokenFile", selected["antigravity"].name, cwd=self.root)
            self.assertEqual(result.returncode, 0, result.stderr)
            for pid, path in selected.items():
                self.assertIn(str(path), result.stdout)
                self.assertNotIn(str(originals[pid]), result.stdout)
                self.assertNotIn(before[pid].decode().strip(), result.stdout)
            if name == "setup.ps1":
                # Execute only the preview's Python admin commands in TEMP.
                # Never run setup, pip, registration, or a real client CLI.
                for line in result.stdout.splitlines():
                    argv = [value.replace("''", "'") for value in re.findall(r"'((?:[^']|'')*)'", line)]
                    if "admin" in argv:
                        self.assertEqual(argv[0], str(PROJECT / ".venv" / "Scripts" / "python.exe"))
                        applied = subprocess.run(argv, cwd=self.root, capture_output=True, text=True, timeout=40)
                        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual({pid: path.read_bytes() for pid, path in selected.items()}, before)
        from agent_mailbox.core.database import Database
        from agent_mailbox.core.settings import Settings
        db = Database(Settings(self.home / "mailbox.db"))
        with db.transaction() as conn:
            for pid in selected:
                self.assertEqual(verify(conn, load_token(str(selected[pid]), {})), Principal(pid))
                with self.assertRaises(GatewayError) as error:
                    verify(conn, load_token(str(originals[pid]), {}))
                self.assertEqual(error.exception.code, "UNAUTHENTICATED")

    def test_expired_shared_session_replaced_without_refreshing_history(self):
        admin(self.home, "add-principal", "A")
        first = admin(self.home, "create-shared-session", "--owner", "A")
        sid = first["session"]["session_id"]
        from agent_mailbox.admin import initialize
        db = initialize(self.home)
        with db.transaction(write=True) as conn:
            conn.execute("UPDATE logical_sessions SET expires_at=0,last_seen=123 WHERE session_id=?", (sid,))
        second = admin(self.home, "create-shared-session", "--owner", "A")
        self.assertNotEqual(second["session"]["session_id"], sid)
        with db.transaction() as conn:
            self.assertEqual(conn.execute("SELECT last_seen FROM logical_sessions WHERE session_id=?", (sid,)).fetchone()[0], 123)

    def test_shared_session_handles_expiry_and_close_races_but_preserves_other_errors(self):
        admin(self.home, "add-principal", "A")
        first = admin(self.home, "create-shared-session", "--owner", "A")
        renew = SessionService.renew

        for race in ("expiry", "close"):
            def change_then_renew(service, sid, ttl):
                if race == "close":
                    service.close(sid)
                else:
                    with service.database.transaction(write=True) as conn:
                        conn.execute("UPDATE logical_sessions SET expires_at=0 WHERE session_id=?", (sid,))
                return renew(service, sid, ttl)

            with self.subTest(race=race), patch.object(SessionService, "renew", change_then_renew):
                second = admin(self.home, "create-shared-session", "--owner", "A")
            self.assertNotEqual(first["session"]["session_id"], second["session"]["session_id"])
            first = second
        with patch.object(SessionService, "renew", side_effect=GatewayError("RESOURCE_EXHAUSTED", "quota")):
            with self.assertRaises(GatewayError) as error:
                admin(self.home, "create-shared-session", "--owner", "A")
        self.assertEqual(error.exception.code, "RESOURCE_EXHAUSTED")


class PowerShellReviewTests(unittest.TestCase):
    def test_relative_state_native_argv_and_powershell_shim_forwarding(self):
        with tempfile.TemporaryDirectory(prefix="mailbox argv ") as folder:
            root = Path(folder)
            work = root / "work"
            work.mkdir()
            (root / "capture.py").write_text("import json,sys; print(json.dumps(sys.argv[1:]))")
            (root / "mailbox-review.cmd").write_text('@"' + sys.executable + '" "%~dp0capture.py" %*\n')
            env = os.environ.copy()
            env["PATH"] = str(root) + os.pathsep + env["PATH"]
            script = ". " + quoted(PROJECT / "scripts" / "common.ps1") + "; Set-Location " + quoted(work) + r"""
$state = Get-MailboxStateDir '..\state with spaces\'
Invoke-MailboxCommand 'mailbox-review' @('mcp','add',('AGENT_MAILBOX_HOME=' + $state),'--','-I','-m','agent_mailbox') $false
"""
            harness = root / "invoke helpers.ps1"
            harness.write_text(script, encoding="utf-8")
            result = powershell(harness, cwd=root, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            argv = json.loads(result.stdout.splitlines()[-1])
            self.assertEqual(argv, ["mcp", "add", "AGENT_MAILBOX_HOME=" + str(root / "state with spaces"), "--", "-I", "-m", "agent_mailbox"])
            # Same $args forwarding as the installed npm codex.ps1 shim;
            # run only our temporary capture executable, never the real CLI.
            shim = root / "mailbox-review.ps1"
            shim.write_text("& " + quoted(sys.executable) + " " + quoted(root / "capture.py")
                            + " $args\nexit $LASTEXITCODE\n")
            result = powershell(harness, cwd=root, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout.splitlines()[-1]), argv)
            (root / "mailbox-review.cmd").unlink()
            result = powershell(harness, cwd=root, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout.splitlines()[-1]), argv)

    def test_client_selection_and_dryrun_have_no_cli_side_effects(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            marker = root / "called"
            for executable in ("codex", "agy"):
                (root / (executable + ".cmd")).write_text('@echo invoked>"' + str(marker) + '"\n')
            env = os.environ.copy()
            env["PATH"] = str(root) + os.pathsep + env["PATH"]
            for mode in ("-WhatIf", "-DryRun"):
                for client, command, other in (("codex", "codex", "agy"), ("antigravity", "agy", "codex")):
                    result = powershell(PROJECT / "scripts" / "register-clients.ps1", mode,
                                        "-Client", client, "-StateDir", str(root / "absent state"), env=env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(quoted(command), result.stdout)
                    self.assertNotIn(quoted(other), result.stdout)
            self.assertFalse(marker.exists())
            self.assertFalse((root / "absent state").exists())
