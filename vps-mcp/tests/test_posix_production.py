"""POSIX production worker/broker in temporary fixtures, without root/services."""
from contextlib import ExitStack
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tests.protocol_support import make_gateway

HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location("isolated_" + name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(os.name == "posix", "Production Unix IPC/process behavior runs on Linux CI")
class PosixWorkerTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="mcp-")))
        self.repo = root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.stack.enter_context(patch.dict(os.environ, MCP_REPOS='{"fixture":' + __import__('json').dumps(str(self.repo)) + '}',
                                           MCP_JOB_DIR=str(root / "jobs"), MCP_GATEWAY_UID=str(os.getuid())))
        self.worker = load("worker")
        self.server = self.worker.Server(str(root / "worker.sock"), self.worker.Handler)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        def close():
            for job in self.worker.jobs.values():
                self.worker.kill_job(job["proc"])
            self.server.shutdown()
            self.server.server_close()
            thread.join(2)
        self.addCleanup(close)
        self.gateway = make_gateway()
        self.gateway.WORKER_SOCKET = str(root / "worker.sock")

    def test_real_unix_file_git_dispatch_and_errors(self):
        g = self.gateway
        self.assertEqual(g.projects(), {"fixture": str(self.repo)})
        self.assertEqual(g.list_files(), ["fixture/"])
        folder = str(self.repo / "sub")
        self.assertEqual(g.mkdir(folder), folder)
        first, second = str(self.repo / "a.txt"), str(self.repo / "b.txt")
        self.assertEqual(g.write_file(first, "hello UTF-8 ề"), first)
        self.assertEqual(g.read_file(first), "hello UTF-8 ề")
        self.assertEqual(g.rename(first, second), second)
        self.assertIn("b.txt", g.list_files(str(self.repo)))
        self.assertIn("exit=0", g.git_status(str(self.repo)))
        self.assertEqual(g.remove(second), second)
        self.assertEqual(g.remove(folder), folder)
        for method, args in ((g.read_file, ("/etc/passwd",)), (g.remove, (str(self.repo),)),
                             (g.run_shell, ("echo bad", "/", 1))):
            with self.assertRaisesRegex(RuntimeError, "PermissionError"):
                method(*args)

    def test_real_shell_exit_timeout_and_truncation(self):
        g, path = self.gateway, str(self.repo)
        self.assertIn("shell-ok", g.run_shell("printf 'shell-ok\\n'", path))
        self.assertIn("exit=7", g.run_shell("exit 7", path))
        self.assertIn("timed_out=true", g.run_shell("sleep 5", path, 1))
        self.assertIn("truncated=true", g.run_shell("printf '%70000s' x", path))
        with self.assertRaisesRegex(RuntimeError, "Timeout must be 1..90"):
            g.run_shell("true", path, 91)
        (self.repo / "test_fixture.py").write_text("import unittest\nclass T(unittest.TestCase):\n def test_ok(self): self.assertTrue(True)\n")
        self.assertIn("exit=0", g.run_tests(path, "unittest"))

    def test_real_jobs_log_pagination_status_and_stop(self):
        g = self.gateway
        job = g.start_job("printf 'job-output'; sleep 30", str(self.repo))
        jid = job["job_id"]
        self.assertEqual(job["status"], "running")
        for _ in range(100):
            page = g.read_job_log(jid, 0, 3)
            if page["total_bytes"]:
                break
            time.sleep(0.01)
        self.assertEqual(page["data"], "job")
        self.assertEqual(g.read_job_log(jid, page["next_offset"])["data"], "-output")
        self.assertEqual(g.job_status(jid)["status"], "running")
        self.assertEqual(g.stop_job(jid)["status"], "finished")
        with self.assertRaisesRegex(RuntimeError, "Invalid log range"):
            g.read_job_log(jid, -1)
        with self.assertRaisesRegex(RuntimeError, "Unknown job ID"):
            g.job_status("missing")

    def test_unix_peer_credential_rejects_unexpected_uid(self):
        with patch.dict(os.environ, MCP_GATEWAY_UID=str(os.getuid() + 1)):
            with self.assertRaises((RuntimeError, ConnectionResetError)):
                self.gateway.projects()


@unittest.skipUnless(os.name == "posix", "Production broker imports POSIX account APIs")
class PosixBrokerTests(unittest.TestCase):
    def setUp(self):
        # Import account lookup is a synthetic fixture. Never open real policy/password.
        with patch("pwd.getpwnam", return_value=SimpleNamespace(pw_uid=os.getuid())):
            self.broker = load("broker")

    def test_approval_one_time_key_consumed_before_execution(self):
        b = self.broker
        with patch.object(b, "allowed_units", return_value=["fixture.service"]), patch.object(b, "service_fingerprint", return_value="test-fingerprint"):
            record = b.do_request("restart_service", {"unit": "fixture.service"})
            rid = record["request_id"]
            with self.assertRaises(PermissionError):
                b.execute(rid, "invalid")
            key = b.admin_approve(rid)["one_time_key"]
            with self.assertRaises(PermissionError):
                b.execute(rid, "invalid")
            def fake_systemctl(argv, **kwargs):
                self.assertEqual(b.pending[rid]["status"], "consumed")
                self.assertIsNone(b.pending[rid]["keyhash"])
                self.assertEqual(argv, ["/usr/bin/systemctl", "restart", "--", "fixture.service"])
                return SimpleNamespace(returncode=0, stdout="test-only", stderr="")
            with patch.object(b.subprocess, "run", side_effect=fake_systemctl) as run:
                self.assertEqual(b.execute(rid, key)["status"], "finished")
                with self.assertRaises(PermissionError):
                    b.execute(rid, key)
                self.assertEqual(run.call_count, 1)

    def test_changed_service_or_policy_never_executes(self):
        b = self.broker
        with patch.object(b, "allowed_units", return_value=["fixture.service"]), patch.object(b, "service_fingerprint", return_value="original"):
            rid = b.do_request("restart_service", {"unit": "fixture.service"})["request_id"]
            key = b.admin_approve(rid)["one_time_key"]
        with patch.object(b, "allowed_units", return_value=["fixture.service"]), patch.object(b, "service_fingerprint", return_value="changed"), patch.object(b.subprocess, "run", side_effect=AssertionError("must not execute")):
            with self.assertRaisesRegex(PermissionError, "definition changed"):
                b.execute(rid, key)
            self.assertEqual(b.pending[rid]["status"], "consumed")

    def test_policy_rejects_mcp_tunnel_and_development_services(self):
        b = self.broker
        for unit in ("vps-mcp.service", "other-tunnel.service", "invalid unit.service"):
            with patch.object(Path, "read_text", return_value=__import__('json').dumps({"restart_services": [unit]})):
                with self.assertRaises(RuntimeError):
                    b.allowed_units()
        for output in ("Names=alias vps-mcp.service", "ExecStart=/home/thieuhua/code/codespace1/test", "PartOf=tunnel.service"):
            with patch.object(b.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=output)):
                with self.assertRaises(PermissionError):
                    b.service_fingerprint("fixture.service")
