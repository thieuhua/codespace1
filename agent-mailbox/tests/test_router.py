"""Real HTTP subprocess + MCP 1.30 SDK; only TEMP state and ephemeral ports."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import ClientNotification, CancelledNotification, CancelledNotificationParams

from agent_mailbox.admin import initialize
from agent_mailbox.core.admin import Provisioner
from agent_mailbox.auth import issue_token
from agent_mailbox.router import validate_bind
from agent_mailbox.router_store import RouterStore
from tests.local_support import run_async, call


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-mailbox-router-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "state with spaces"
        self.database = initialize(self.home)
        provisioner = Provisioner(self.database)
        self.tokens = {}
        for pid in ("codex", "antigravity", "other"):
            provisioner.principal(pid, pid)
            self.tokens[pid] = issue_token(self.database, pid, self.home / "tokens" / f"{pid}.token")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.assertNotIn(self.port, (8765, 8766))
        self.url = f"http://127.0.0.1:{self.port}/mcp"
        self.log = (Path(self.temp.name) / "server.log").open("w+", encoding="utf-8")
        self.addCleanup(self.log.close)
        self.proc = subprocess.Popen(self.command("serve", "--port", str(self.port), "--hold-seconds", "2"),
                                     cwd=self.temp.name, stdout=self.log, stderr=self.log)
        self.addCleanup(self.shutdown)
        deadline = time.monotonic()+15
        while time.monotonic() < deadline:
            self.assertIsNone(self.proc.poll(), self.logs())
            try:
                if httpx.post(self.url, timeout=.3).status_code == 401:
                    break
            except httpx.TransportError:
                pass
            time.sleep(.03)
        else:
            self.fail("Server did not start: " + self.logs())
        self.store = RouterStore(self.home)

    def command(self, *args):
        return [sys.executable, "-I", "-m", "agent_mailbox", "--state-dir", str(self.home), "router", *args]

    def logs(self):
        self.log.flush()
        return Path(self.log.name).read_text(encoding="utf-8")

    def shutdown(self):
        if self.proc.poll() is None:
            try:
                self.ctl("shutdown")
                self.proc.wait(10)
            except BaseException:
                self.proc.kill()
                self.proc.wait(5)
                raise
        self.assertEqual(self.proc.returncode, 0, self.logs())

    def ctl(self, *args):
        p = subprocess.run(self.command("ctl", *args, "--json"), cwd=self.temp.name,
                           capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    async def control(self, *args):
        return await asyncio.to_thread(self.ctl, *args)

    @asynccontextmanager
    async def client(self, pid="codex", terminate=True):
        async with httpx.AsyncClient(headers={"Authorization": "Bearer " + self.tokens[pid]}, timeout=httpx.Timeout(10, read=30)) as http:
            async with streamable_http_client(self.url, http_client=http, terminate_on_close=terminate) as (r, w, sid):
                async with ClientSession(r, w) as session:
                    await session.initialize()
                    session.router_test_session_id = sid
                    yield session

    async def waiting(self, principal="codex", expected=True):
        async with asyncio.timeout(5):
            while True:
                rows = self.store.status()["principals"]
                if next(r for r in rows if r["principal_id"] == principal)["waiting"] == expected:
                    return
                await asyncio.sleep(.02)

    def test_empty_hold_and_instructions(self):
        async def scenario():
            async with self.client() as c:
                schema = (await c.list_tools()).tools
                self.assertEqual({t.name for t in schema}, {"whoami", "mailbox_receive", "mailbox_send", "mailbox_reply", "mailbox_ack"})
                self.assertEqual((await call(self, c, "whoami"))["principal_id"], "codex")
                start = time.monotonic()
                page = await call(self, c, "mailbox_receive")
                elapsed = time.monotonic()-start
                self.assertGreaterEqual(elapsed, 1.85)
                self.assertLess(elapsed, 3)
                self.assertEqual(page["status"], "no_mail")
                self.assertEqual(page["messages"], [])
                self.assertIn("Do not end your turn", page["instruction"])
                self.assertEqual(page["poll_count"], 1)
                self.assertIsInstance(page["server_time"], float)
        run_async(scenario())

    def test_operator_cross_process_wake_and_instrumentation(self):
        async def scenario():
            async with self.client() as c:
                pending = asyncio.create_task(call(self, c, "mailbox_receive"))
                await self.waiting()
                start = time.monotonic()
                sent = await self.control("send", "--to", "codex", "wake from offline operator")
                page = await asyncio.wait_for(pending, 1)
                latency = time.monotonic()-start
                self.assertLess(latency, 1)
                self.assertEqual(page["messages"][0], sent["sent"][0]["message"])
                self.assertEqual(page["status"], "mail")
                print(f"ROUTER_CROSS_PROCESS_WAKE seconds={latency:.3f}")
                await call(self, c, "mailbox_receive", {"wait_seconds": 0})
            stats = await self.control("stats")
            self.assertEqual(stats["total_receive_calls"], 2)
            self.assertEqual(stats["total_sends"], 1)
            self.assertEqual([r["delivered"] for r in stats["receive_calls"]], [1, 0])
            self.assertEqual([r["status"] for r in stats["receive_calls"]], ["mail", "no_mail"])
            self.assertTrue(all(r["ended"] and not r["cancelled"] and r["held_seconds"] >= 0 for r in stats["receive_calls"]))
            self.assertEqual(next(p for p in stats["principals"] if p["principal_id"] == "codex")["consecutive_calls"], 2)
            self.assertEqual(len((await self.control("log", "--tail", "1"))["log"]), 1)
        run_async(scenario())

    def test_agent_routing_reply_operator_ack_idempotency_and_isolation(self):
        async def scenario():
            async with self.client() as c, self.client("antigravity") as a:
                payload = {"to": "antigravity", "text": "PING ✓", "idempotency_key": "one"}
                sent = await call(self, c, "mailbox_send", payload)
                replay = await call(self, c, "mailbox_send", payload)
                self.assertTrue(replay["duplicated"])
                self.assertEqual(sent["message"], replay["message"])
                await call(self, c, "mailbox_send", {**payload, "text": "different"}, "CONFLICT")
                await call(self, c, "mailbox_send", {"to": "unknown", "text": "x"}, "NOT_FOUND")
                await call(self, c, "mailbox_send", {"to": "antigravity", "text": "é"*32769}, "INVALID_ARGUMENT")
                # Forged identity does not change the bound inbox, even as an extra argument.
                page = await call(self, c, "mailbox_receive", {"wait_seconds": 0, "principal_id": "antigravity"})
                self.assertEqual(page["messages"], [])
                mid = sent["message"]["id"]
                await call(self, c, "mailbox_reply", {"message_id": mid, "text": "steal"}, "NOT_FOUND")
                await call(self, c, "mailbox_ack", {"message_ids": [mid]}, "NOT_FOUND")
                page = await call(self, a, "mailbox_receive")
                self.assertEqual([m["id"] for m in page["messages"]], [mid])
                self.assertEqual(set(page["messages"][0]), {"id", "seq", "from", "to", "text", "reply_to", "sent_at"})
                for _ in range(2):
                    await call(self, a, "mailbox_ack", {"message_ids": [mid]})
                reply = await call(self, a, "mailbox_reply", {"message_id": mid, "text": "PONG"})
                page = await call(self, c, "mailbox_receive")
                self.assertEqual(page["messages"], [reply["message"]])
                self.assertEqual(page["messages"][0]["reply_to"], mid)
                await call(self, a, "mailbox_send", {"to": "claude", "text": "report"})
                report = await self.control("inbox", "--wait", "1")
                self.assertEqual(report["messages"][0]["to"], "operator")
                self.assertEqual((await self.control("inbox"))["messages"], [])
                self.assertEqual(len((await self.control("inbox", "--all"))["messages"]), 1)
                operator = (await self.control("send", "--to", "antigravity", "command"))["sent"][0]["message"]
                await call(self, a, "mailbox_receive")
                await call(self, a, "mailbox_reply", {"message_id": operator["id"], "text": "completed"})
                self.assertEqual((await self.control("inbox"))["messages"][0]["reply_to"], operator["id"])
        run_async(scenario())

    def test_auth_fail_closed_each_request_and_revocation_during_wait(self):
        async def scenario():
            async with httpx.AsyncClient() as http:
                token = self.tokens["codex"]
                for value in (None, "invalid", token[:-1]+("B" if token[-1] != "B" else "A")):
                    headers = {} if value is None else {"Authorization": "Bearer "+value}
                    response = await http.post(self.url, headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                    self.assertEqual(response.status_code, 401)
                    self.assertEqual(response.json()["error"]["code"], "UNAUTHENTICATED")
            async with self.client() as c:
                # A different valid principal cannot attach to this SDK session.
                async with httpx.AsyncClient() as http:
                    stolen = await http.post(self.url, headers={"Authorization": "Bearer "+self.tokens["antigravity"],
                        "Mcp-Session-Id": c.router_test_session_id(), "Accept": "application/json, text/event-stream"},
                        json={"jsonrpc": "2.0", "id": 99, "method": "tools/call", "params": {"name": "mailbox_receive", "arguments": {"wait_seconds": 0}}})
                    self.assertEqual(stolen.status_code, 404)
                pending = asyncio.create_task(call(self, c, "mailbox_receive", error="UNAUTHENTICATED"))
                await self.waiting()
                with self.database.transaction(write=True) as conn:
                    conn.execute("UPDATE local_credentials SET revoked=1 WHERE principal_id='codex'")
                await asyncio.wait_for(pending, 1)
                async with httpx.AsyncClient() as http:
                    response = await http.post(self.url, headers={"Authorization": "Bearer "+token})
                    self.assertEqual(response.status_code, 401)
            with self.database.transaction(write=True) as conn:
                conn.execute("UPDATE principals SET enabled=0 WHERE principal_id='antigravity'")
            async with httpx.AsyncClient() as http:
                response = await http.post(self.url, headers={"Authorization": "Bearer "+self.tokens["antigravity"]})
                self.assertEqual(response.status_code, 401)
        run_async(scenario())

    def test_cancellation_notification_and_disconnect_preserve_pending(self):
        async def scenario():
            async with self.client() as c:
                request_id = c._request_id
                pending = asyncio.create_task(c.call_tool("mailbox_receive"))
                await self.waiting()
                await c.send_notification(ClientNotification(CancelledNotification(params=CancelledNotificationParams(requestId=request_id))))
                outcome = await asyncio.wait_for(asyncio.gather(pending, return_exceptions=True), 5)
                self.assertIsInstance(outcome[0], Exception)
                await self.waiting(expected=False)
                await self.control("send", "--to", "codex", "after cancellation")
                page = await call(self, c, "mailbox_receive")
                self.assertEqual([m["text"] for m in page["messages"]], ["after cancellation"])
                self.assertEqual((await call(self, c, "mailbox_receive", {"wait_seconds": 0}))["messages"], [])
            # Cancelling the entire SDK transport disconnects the outstanding POST.
            ready = asyncio.Event()
            async def disconnecting_client():
                async with self.client(terminate=False) as c:
                    ready.set()
                    await c.call_tool("mailbox_receive")
            task = asyncio.create_task(disconnecting_client())
            await ready.wait()
            await self.waiting()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await self.waiting(expected=False)
            await self.control("send", "--to", "codex", "after disconnect")
            async with self.client() as c:
                self.assertEqual((await call(self, c, "mailbox_receive"))["messages"][0]["text"], "after disconnect")
                self.assertEqual((await call(self, c, "mailbox_receive", {"wait_seconds": 0}))["messages"], [])
            rows = self.store.stats()["receive_calls"]
            self.assertEqual(sum(r["cancelled"] for r in rows), 2, rows)
            self.assertTrue(all(r["delivered"] == 0 for r in rows if r["cancelled"]))
        run_async(scenario())

    def test_stop_resume_set_hold_waiter_bound_and_shutdown(self):
        async def scenario():
            await self.control("set-hold", ".05")
            async with self.client() as c, self.client() as c2:
                who = await call(self, c, "whoami")
                self.assertEqual(who["hold_seconds"], .05)
                start = time.monotonic()
                await call(self, c, "mailbox_receive", {"wait_seconds": 999})
                self.assertLess(time.monotonic()-start, .5)
                await self.control("set-hold", "10")
                pending = asyncio.create_task(call(self, c, "mailbox_receive"))
                await self.waiting()
                await call(self, c2, "mailbox_receive", error="RESOURCE_EXHAUSTED")
                await self.control("stop", "codex")
                page = await asyncio.wait_for(pending, 1)
                self.assertEqual(page["status"], "stop")
                self.assertEqual(page["instruction"], "Stop polling and end your turn with a one-line summary.")
                await self.control("send", "--to", "codex", "paused")
                self.assertEqual((await call(self, c, "mailbox_receive"))["status"], "stop")
                await self.control("resume", "all")
                self.assertEqual((await call(self, c, "mailbox_receive"))["messages"][0]["text"], "paused")
                await self.control("stop", "all")
                self.assertEqual((await call(self, c, "mailbox_receive"))["status"], "stop")
                await self.control("resume", "codex")
                pending = asyncio.create_task(call(self, c, "mailbox_receive"))
                await self.waiting()
                await self.control("shutdown")
                self.assertEqual((await asyncio.wait_for(pending, 2))["status"], "stop")
        run_async(scenario())

    def test_hold_change_applies_next_call_and_invalid_receives_are_recorded(self):
        async def scenario():
            await self.control("set-hold", ".5")
            async with self.client() as c:
                started = time.monotonic()
                pending = asyncio.create_task(call(self, c, "mailbox_receive"))
                await self.waiting()
                await self.control("set-hold", "0")
                self.assertEqual((await pending)["status"], "no_mail")
                self.assertGreaterEqual(time.monotonic()-started, .48)
                started = time.monotonic()
                await call(self, c, "mailbox_receive")
                self.assertLess(time.monotonic()-started, .3)
                for value in (True, -1, .5, "1"):
                    await call(self, c, "mailbox_receive", {"wait_seconds": value}, "INVALID_ARGUMENT")
                rows = self.store.stats()["receive_calls"]
                self.assertEqual(len(rows), 6)
                self.assertTrue(all(r["error"] == "INVALID_ARGUMENT" and not r["cancelled"] for r in rows[2:]))
        run_async(scenario())

    def test_200_sequential_polls_keep_resources_bounded(self):
        async def scenario():
            await self.control("set-hold", ".05")
            async def resources():
                # Independent OS counters plus server task/connection telemetry.
                metrics = self.store.stats()["runtime"]
                command = f"$p=Get-Process -Id {metrics['pid']}; @($p.Threads.Count,$p.HandleCount,$p.WorkingSet64) | ConvertTo-Json -Compress"
                p = await asyncio.to_thread(subprocess.run, ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], capture_output=True, text=True, timeout=10)
                self.assertEqual(p.returncode, 0, p.stderr)
                threads, handles, rss = json.loads(p.stdout)
                return (threads, metrics["connections"], handles, rss, metrics["tasks"])
            async with self.client() as c:
                for _ in range(5):
                    await call(self, c, "mailbox_receive")
                await asyncio.sleep(1.1)
                before = await resources()
                for i in range(200):
                    page = await call(self, c, "mailbox_receive")
                    self.assertEqual(page["poll_count"], i+6)
                    self.assertEqual(page["status"], "no_mail")
                await asyncio.sleep(1.1)
                after = await resources()
                self.assertLessEqual(after[0], before[0]+2)
                self.assertLessEqual(after[1], before[1]+2)
                self.assertLessEqual(after[2], before[2]+12)
                self.assertLess(after[3]-before[3], 20*1024*1024)
                self.assertLessEqual(after[4], before[4]+4)
                stats = self.store.stats()
                self.assertEqual(len(stats["receive_calls"]), 205)
                self.assertTrue(all(r["ended"] and r["status"] == "no_mail" and not r["cancelled"] for r in stats["receive_calls"]))
                self.assertEqual(next(p for p in stats["principals"] if p["principal_id"] == "codex")["consecutive_calls"], 205)
                print(f"ROUTER_205_POLLS resources_before={before} resources_after={after}")
        run_async(scenario())

    def test_loopback_bind_and_sdk_host_origin_protection(self):
        for host in ("0.0.0.0", "::", "192.0.2.10", "untrusted.example"):
            with self.assertRaises(ValueError):
                validate_bind(host, False)
            validate_bind(host, True)
        for host in ("localhost", "127.0.0.1", "::1"):
            validate_bind(host, False)
        denied = subprocess.run(self.command("serve", "--host", "0.0.0.0", "--port", "0"), capture_output=True, timeout=10)
        self.assertNotEqual(denied.returncode, 0)
        # The existing process owns the state lock even on a different port.
        second = subprocess.run(self.command("serve", "--port", "0"), capture_output=True, timeout=10)
        self.assertNotEqual(second.returncode, 0)
        headers = {"Authorization": "Bearer "+self.tokens["codex"], "Accept": "application/json, text/event-stream"}
        with httpx.Client() as http:
            response = http.post(self.url, headers={**headers, "Host": "evil.example"}, json={})
            self.assertEqual(response.status_code, 421)
            response = http.post(self.url, headers={**headers, "Origin": "https://evil.example"}, json={})
            self.assertEqual(response.status_code, 403)
        self.assertEqual(self.store.stats()["total_receive_calls"], 0)


class RouterStorageTests(unittest.TestCase):
    def test_reservation_cancellation_crash_recovery_and_auth_at_commit(self):
        from agent_mailbox.core.errors import GatewayError
        with tempfile.TemporaryDirectory(prefix="router-reservations-") as temp:
            home = Path(temp)
            database = initialize(home)
            Provisioner(database).principal("codex", "codex")
            token = issue_token(database, "codex", home / "tokens" / "codex.token")
            store = RouterStore(home)
            sent = store.send("operator", "codex", "preserve this message")["message"]
            first, _, _ = store.begin_receive("codex", token)
            self.assertEqual(store.snapshot("codex", token, first)[1], [sent])
            store.finish_receive(first, "cancelled", cancelled=True)
            with self.assertRaises(GatewayError):
                store.snapshot("codex", token, first)
            second, _, _ = store.begin_receive("codex", token)
            self.assertEqual(store.snapshot("codex", token, second)[1], [sent])
            with database.transaction(write=True) as conn:
                conn.execute("UPDATE local_credentials SET revoked=1")
            with self.assertRaises(GatewayError) as denied:
                store.finish_receive(second, "mail", token=token, principal="codex")
            self.assertEqual(denied.exception.code, "UNAUTHENTICATED")
            # Simulate process death after selection, before response commit.
            RouterStore(home).recover()
            with database.transaction(write=True) as conn:
                conn.execute("UPDATE local_credentials SET revoked=0")
            third, _, _ = store.begin_receive("codex", token)
            self.assertEqual(store.snapshot("codex", token, third)[1], [sent])
            store.finish_receive(third, "mail", token=token, principal="codex")
            fourth, _, _ = store.begin_receive("codex", token)
            self.assertEqual(store.snapshot("codex", token, fourth)[1], [])
            store.finish_receive(fourth, "no_mail", token=token, principal="codex")
            rows = store.stats()["receive_calls"]
            self.assertEqual([r["delivered"] for r in rows], [0, 0, 1, 0])
            self.assertEqual(rows[1]["error"], "SERVER_RESTART")
            self.assertTrue(rows[1]["cancelled"])
            store.recover()
            self.assertEqual(store.status()["principals"][0]["consecutive_calls"], 0)
            fifth, _, _ = store.begin_receive("codex", token)
            self.assertEqual(store.stats()["receive_calls"][-1]["streak"], 1)
            store.finish_receive(fifth, "no_mail", token=token, principal="codex")
