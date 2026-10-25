"""PowerShell 5.1 previews and background lifecycle on TEMP state only."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest

from agent_mailbox.admin import initialize

PROJECT = Path(__file__).resolve().parents[1]


class RouterScriptTests(unittest.TestCase):
    def ps(self, script, *args):
        env = os.environ.copy()
        env["PSExecutionPolicyPreference"] = "Restricted"
        return subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                               "-File", str(PROJECT / "scripts" / script), *map(str, args)],
                              capture_output=True, text=True, timeout=35, env=env)

    def test_preview_scripts_never_read_tokens_or_write_state(self):
        with tempfile.TemporaryDirectory(prefix="router-preview-") as temp:
            home = Path(temp) / "does not exist"
            for mode in ("-WhatIf", "-DryRun"):
                for script in ("router-start.ps1", "router-stop.ps1", "register-router-clients.ps1"):
                    p = self.ps(script, "-StateDir", home, mode)
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertIn("agent_mailbox", p.stdout)
                    if script == "register-router-clients.ps1":
                        self.assertIn("--bearer-token-env-var", p.stdout)
                        self.assertIn("AGENT_MAILBOX_ROUTER_TOKEN", p.stdout)
                        self.assertIn("--header", p.stdout)
                        self.assertIn("<redacted>", p.stdout)
                        self.assertNotIn("--env", p.stdout)
                    self.assertEqual(list(Path(temp).iterdir()), [])
            p = self.ps("register-router-clients.ps1", "-StateDir", home, "-WhatIf", "-Client", "codex")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertNotIn("& 'agy'", p.stdout)
            p = self.ps("register-router-clients.ps1", "-StateDir", home, "-WhatIf", "-Url", "http://evil.example/mcp")
            self.assertNotEqual(p.returncode, 0)
            self.assertFalse(home.exists())

    def test_background_start_stop_on_temp_state_and_ephemeral_port(self):
        with tempfile.TemporaryDirectory(prefix="router-lifecycle-") as temp:
            home = Path(temp) / "state with spaces"
            initialize(home)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            p = self.ps("router-start.ps1", "-StateDir", home, "-Port", port, "-HoldSeconds", ".05")
            self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
            try:
                record = json.loads((home / "router.pid.json").read_text(encoding="utf-8-sig"))
                self.assertEqual(record["state_dir"], str(home))
                self.assertTrue((home / "router.stderr.log").is_file())
                second = self.ps("router-start.ps1", "-StateDir", home, "-Port", port)
                self.assertNotEqual(second.returncode, 0)
                self.assertIn("already running", second.stderr)
            finally:
                stopped = self.ps("router-stop.ps1", "-StateDir", home)
                self.assertEqual(stopped.returncode, 0, stopped.stdout+stopped.stderr)
            again = self.ps("router-stop.ps1", "-StateDir", home)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("already stopped", again.stdout)
