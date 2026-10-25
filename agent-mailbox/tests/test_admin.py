"""Offline subprocess CLI, safe files/ACLs and registration script previews."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent_mailbox.__main__ import parser
from agent_mailbox.auth import load_token
from agent_mailbox.paths import safe_path, state_home, owner_only, restricted_windows_token
from tests.local_support import run_async, call, client
import asyncio

PROJECT = Path(__file__).resolve().parents[1]


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-mailbox-admin-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "state with spaces"

    def cli(self, *args, success=True):
        result = subprocess.run([sys.executable, "-I", "-m", "agent_mailbox", "--state-dir", str(self.home), "admin", *args],
                                cwd=self.temp.name, capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return json.loads(result.stdout) if success else result

    def test_admin_roundtrip_tokens_acl_idempotency_rotation_and_revoke(self):
        self.assertTrue(self.cli("init")["initialized"])
        self.assertTrue(self.cli("init")["initialized"])
        created = self.cli("add-principal", "codex", "--label", "Codex CLI")
        self.assertNotIn("token", created)
        token_path = Path(created["token_file"])
        secret = token_path.read_text().strip()
        self.assertTrue(secret.startswith("amb1."))
        self.assertFalse(self.cli("add-principal", "codex", "--if-missing")["created"])
        self.assertEqual(token_path.read_text().strip(), secret)
        self.cli("add-principal", "antigravity")
        first = self.cli("create-shared-session", "--owner", "codex", "--participant", "antigravity")
        second = self.cli("create-shared-session", "--owner", "codex", "--participant", "antigravity")
        self.assertEqual(first["session"]["session_id"], second["session"]["session_id"])
        self.assertEqual(first["mailbox"], second["mailbox"])
        listed = self.cli("list-principals")
        self.assertEqual([r["principal_id"] for r in listed["principals"]], ["antigravity", "codex"])
        self.assertEqual({r["principal_id"]: r["label"] for r in listed["principals"]}["codex"], "Codex CLI")
        self.assertNotIn(secret, json.dumps(listed))
        self.assertNotIn(secret.encode(), (self.home / "mailbox.db").read_bytes())
        # Inspect actual Windows ACL, not chmod's synthetic Windows permission bits.
        if os.name == "nt":
            env = os.environ.copy()
            env.pop("PSModulePath", None)
            env["AGENT_MAILBOX_TEST_PATH"] = str(token_path)
            script = r"""
$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:AGENT_MAILBOX_TEST_PATH
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entries=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })
@{protected=$acl.AreAccessRulesProtected; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current=$sid; entries=$entries} | ConvertTo-Json -Compress
"""
            result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                                     "-NonInteractive", "-Command", script],
                                    env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            acl = json.loads(result.stdout)
            self.assertEqual(acl["owner"], acl["current"])
            if restricted_windows_token():
                # This environment cannot apply DACLs. Require a visible failure
                # report; the unrestricted branch still requires exact owner-only.
                with self.assertWarnsRegex(RuntimeWarning, "inherited ACLs remain"):
                    self.assertFalse(owner_only(token_path))
            else:
                self.assertTrue(acl["protected"])
                self.assertEqual(acl["entries"], [acl["current"]])
        else:
            self.assertEqual(token_path.stat().st_mode & 0o777, 0o600)
        rotation_path = self.home / "tokens" / "codex-rotated.token"
        rotated = self.cli("add-principal", "codex", "--rotate", "--token-file", str(rotation_path), "--print-token")
        self.assertEqual(rotated["token"], rotation_path.read_text().strip())
        self.assertNotEqual(secret, rotated["token"])
        self.assertEqual({r["principal_id"]: r["label"] for r in self.cli("list-principals")["principals"]}["codex"], "Codex CLI")

        async def scenario():
            async with client(self.home, token_path) as old:
                await call(self, old, "whoami", error="UNAUTHENTICATED")
            async with client(self.home, rotation_path) as new:
                self.assertEqual((await call(self, new, "whoami"))["principal_id"], "codex")
                self.cli("revoke", "codex")
                await call(self, new, "whoami", error="UNAUTHENTICATED")
        run_async(scenario())
        self.cli("add-principal", "codex", "--if-missing", "--token-file", str(rotation_path), success=False)
        self.cli("cleanup")

    def test_owner_only_spaced_file_and_directory(self):
        directory = self.home
        directory.mkdir()
        token_file = Path(self.temp.name) / "token with spaces.token"
        token_file.write_text("temporary test data", encoding="utf-8")
        restricted = os.name == "nt" and restricted_windows_token()
        if os.name == "nt" and not restricted:
            import ntsecuritycon
            import win32api
            import win32con
            import win32security
            token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
            try:
                current_sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
            finally:
                token.Close()
        for target in (directory, token_file):
            with self.subTest(path=target):
                if restricted:
                    with self.assertWarnsRegex(RuntimeWarning, "inherited ACLs remain"):
                        self.assertFalse(owner_only(target))
                    continue
                self.assertTrue(owner_only(target))
                if os.name == "nt":
                    # Conditional on an unrestricted token: the sandbox cannot
                    # apply these DACLs. Read actual DACLs using a separate API.
                    descriptor = win32security.GetFileSecurity(
                        str(target), win32security.DACL_SECURITY_INFORMATION)
                    control, _ = descriptor.GetSecurityDescriptorControl()
                    self.assertTrue(control & win32security.SE_DACL_PROTECTED)
                    dacl = descriptor.GetSecurityDescriptorDacl()
                    self.assertIsNotNone(dacl)
                    self.assertEqual(dacl.GetAceCount(), 1)
                    (ace_type, flags), mask, sid = dacl.GetAce(0)
                    self.assertEqual(ace_type, win32security.ACCESS_ALLOWED_ACE_TYPE)
                    self.assertEqual(win32security.ConvertSidToStringSid(sid),
                                     win32security.ConvertSidToStringSid(current_sid))
                    self.assertEqual(mask, ntsecuritycon.FILE_ALL_ACCESS)
                    inheritance = (win32security.OBJECT_INHERIT_ACE | win32security.CONTAINER_INHERIT_ACE
                                   if target.is_dir() else 0)
                    self.assertEqual(flags, inheritance)
                else:
                    self.assertEqual(target.stat().st_mode & 0o777, 0o700 if target.is_dir() else 0o600)

    def test_token_file_precedence_bom_missing_oversized_and_no_repo_state(self):
        path = Path(self.temp.name) / "secret.token"
        path.write_text("file-secret\n", encoding="utf-8-sig")
        env = {"AGENT_MAILBOX_TOKEN_FILE": str(path), "AGENT_MAILBOX_TOKEN": "env-secret"}
        self.assertEqual(load_token(environ=env), "file-secret")
        self.assertEqual(load_token(str(path) + "-missing", env), "")
        path.write_text("x" * 5000, encoding="ascii")
        self.assertEqual(len(load_token(str(path), env)), 4097)
        self.assertEqual(load_token(environ={"AGENT_MAILBOX_TOKEN": "env-secret"}), "env-secret")
        with patch.dict(os.environ, {"LOCALAPPDATA": self.temp.name}, clear=True):
            self.assertEqual(state_home(), Path(self.temp.name) / "agent-mailbox")
            with patch.dict(os.environ, {"AGENT_MAILBOX_HOME": str(self.home)}):
                self.assertEqual(state_home(), self.home)
                self.assertEqual(state_home(Path(self.temp.name) / "override"), Path(self.temp.name) / "override")
        self.assertEqual(parser().parse_args(["admin", "init", "--state-dir", str(self.home)]).state_dir, str(self.home))
        with self.assertRaises(ValueError):
            safe_path("")
        with self.assertRaises(ValueError):
            safe_path(PROJECT / "secret.token", file=True)
        repo = Path(self.temp.name) / "fake-repo"
        repo.mkdir()
        (repo / ".git").write_text("gitdir: elsewhere")
        with self.assertRaises(ValueError):
            state_home(repo / "state")
        hardlink = Path(self.temp.name) / "linked.token"
        os.link(path, hardlink)
        with self.assertRaises(ValueError):
            safe_path(hardlink, file=True)

    def test_registration_dry_run_and_powershell_51_syntax(self):
        # Only preview invocations; never run registration against any client config.
        scripts = PROJECT / "scripts"
        env = os.environ.copy()
        env.pop("PSModulePath", None)
        # Prove the command-line override works even when the inherited process
        # policy is Restricted; never change user/machine policy.
        env["PSEXECUTIONPOLICYPREFERENCE"] = "Restricted"
        for name in ("setup.ps1", "register-clients.ps1", "unregister-clients.ps1"):
            cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                   "-NonInteractive", "-File", str(scripts / name), "-WhatIf"]
            if name != "unregister-clients.ps1":
                cmd += ["-StateDir", str(self.home)]
            result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("agent_mailbox", result.stdout)
            if name == "register-clients.ps1":
                self.assertIn("AGENT_MAILBOX_TOKEN_FILE=", result.stdout)
                self.assertNotIn("AGENT_MAILBOX_TOKEN=", result.stdout)
                codex = next(line for line in result.stdout.splitlines() if "'codex'" in line)
                self.assertLess(codex.index("'--env'"), codex.index("'agent_mailbox'"))
                self.assertLess(codex.index("'agent_mailbox'"), codex.index("'--'"))
                agy = next(line for line in result.stdout.splitlines() if "'agy'" in line)
                self.assertLess(agy.index("'--env'"), agy.index("'agent_mailbox'"))
                self.assertNotIn("'--'", agy)
                self.assertIn(str(PROJECT / ".venv" / "Scripts" / "python.exe"), result.stdout)
        self.assertFalse(self.home.exists())
