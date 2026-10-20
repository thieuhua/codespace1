"""Unit tests for Linux account runner contract (no root/VPS changes)."""
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
from security import linux_accounts as accounts


class LinuxAccountTests(TestCase):
    def test_accounts_are_unprivileged_and_distinct(self):
        names = (accounts.READ_ACCOUNT, accounts.SHELL_ACCOUNT, accounts.OPS_ACCOUNT)
        self.assertNotIn("root", names)
        self.assertEqual(len(set(names)), 3)

    def test_shell_routes_to_mcp_shell_only(self):
        expected = accounts.ExecResult(0, "ok")
        with patch.object(accounts, "_run_as_account", return_value=expected) as run:
            with patch.object(Path, "resolve", return_value=Path("/srv/mcp-workspaces/project")):
                actual = accounts.basic_shell("echo hello; whoami", cwd="/srv/mcp-workspaces/project")
        self.assertEqual(actual, expected)
        args = run.call_args.kwargs
        self.assertEqual(args["account"], "mcp-shell")
        self.assertEqual(args["argv"][-1], "echo hello; whoami")
        self.assertNotIn("sudo", args["argv"])

    def test_shell_validates_commands(self):
        for cmd in ("", " ", "bad" + chr(0), "x" * 8193):
            with self.subTest(command=repr(cmd[:20])), self.assertRaises(ValueError):
                accounts.basic_shell(cmd, cwd="/srv/mcp-workspaces")

    def test_shell_cwd_outside_workspace_rejected(self):
        with self.assertRaises(ValueError):
            accounts.basic_shell("pwd", cwd="/etc")

    def test_operator_argv_is_fixed_without_bash(self):
        with patch.object(accounts, "_run_as_account", return_value=accounts.ExecResult(0, "")) as run:
            accounts.run_operator_action("restart-combat-web")
        args = run.call_args.kwargs
        self.assertEqual(args["account"], "mcp-ops")
        self.assertEqual(args["argv"], (
            "/usr/bin/sudo", "-n", "/usr/bin/systemctl", "restart", "combat-web.service"
        ))
        self.assertNotIn("bash", " ".join(args["argv"]))

    def test_operator_cannot_choose_mcp_or_unknown_actions(self):
        for action in ("restart-vps-mcp", "restart-vps-mcp-tunnel", "restart-nginx",
                       "systemctl restart vps-mcp", "", "restart-combat-web; rm -rf /"):
            with self.subTest(action=action), self.assertRaises(PermissionError):
                accounts.run_operator_action(action)

    def test_operator_never_runs_as_root(self):
        with patch.object(accounts, "_run_as_account", return_value=accounts.ExecResult(0, "")) as run:
            accounts.run_operator_action("restart-combat-web")
        self.assertNotEqual(run.call_args.kwargs["account"], "root")

    def test_runner_rejects_unprivileged_supervisor(self):
        with patch.object(accounts.os, "geteuid", return_value=1000):
            with self.assertRaises(PermissionError):
                accounts._run_as_account(
                    account="mcp-shell", argv=("/bin/true",),
                    cwd=Path("/"), timeout_seconds=5
                )

    def test_runner_rejects_root_target_even_from_root(self):
        with patch.object(accounts.os, "geteuid", return_value=0):
            with self.assertRaises(PermissionError):
                accounts._run_as_account(
                    account="root", argv=("/bin/true",),
                    cwd=Path("/"), timeout_seconds=5
                )

    def test_result_format(self):
        result = accounts.ExecResult(7, "oops")
        text = result.as_tool_text()
        self.assertIn("exit=7", text)
        self.assertIn("oops", text)
