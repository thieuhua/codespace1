"""Separate real server processes, actual MCP SDK and shared SQLite WAL state."""
import asyncio
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_mailbox.core.admin import Provisioner
from agent_mailbox.server import create_server
from tests.local_support import run_async, admin, call, client, provision

TOOLS = {
    "session_open": {}, "session_get": {"session_id": "guess"}, "session_list": {},
    "session_renew": {"session_id": "guess"}, "session_close": {"session_id": "guess"},
    "list_recent_activity": {"session_id": "guess"},
    "mailbox_create": {"session_id": "guess"}, "mailbox_list": {},
    "mailbox_send": {"mailbox_id": "guess", "text": "private"},
    "mailbox_receive": {"mailbox_id": "guess"},
    "mailbox_ack": {"mailbox_id": "guess", "message_id": "guess"},
    "mailbox_reply": {"mailbox_id": "guess", "in_reply_to": "guess", "text": "private"},
    "mailbox_get_message": {"mailbox_id": "guess", "message_id": "guess"}, "whoami": {},
}


class StdioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-mailbox-stdio-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "private state"
        self.database, self.sid, self.mid = provision(self.home)
        self.a = self.home / "tokens" / "A.token"
        self.b = self.home / "tokens" / "B.token"

    def test_two_processes_ack_reply_restart_and_schema(self):
        async def scenario():
            async with client(self.home, self.a) as a, client(self.home, self.b) as b:
                schema = (await a.list_tools()).tools
                self.assertEqual({t.name for t in schema}, set(TOOLS))
                for tool in schema:
                    self.assertFalse({"principal_id", "owner", "participants", "client_id", "approved"}
                                     & set(tool.inputSchema["properties"]))
                self.assertEqual((await call(self, a, "whoami"))["principal_id"], "A")
                self.assertEqual((await call(self, b, "whoami"))["principal_id"], "B")
                sent = await call(self, a, "mailbox_send", {"mailbox_id": self.mid, "text": "review", "idempotency_key": "task"})
                page = await call(self, b, "mailbox_receive", {"mailbox_id": self.mid})
                self.assertEqual([m["text"] for m in page["messages"]], ["review"])
                await call(self, b, "mailbox_ack", {"mailbox_id": self.mid, "message_id": sent["message_id"]})
                view = await call(self, b, "mailbox_get_message", {"mailbox_id": self.mid, "message_id": sent["message_id"]})
                self.assertTrue(view["acknowledged"])
                reply = await call(self, b, "mailbox_reply", {"mailbox_id": self.mid, "in_reply_to": sent["message_id"], "text": "done"})
                page = await call(self, a, "mailbox_receive", {"mailbox_id": self.mid, "after_cursor": page["next_cursor"]})
                self.assertEqual(page["messages"][0]["message_id"], reply["message_id"])
                self.assertEqual(page["messages"][0]["in_reply_to"], sent["message_id"])
                await call(self, b, "session_close", {"session_id": self.sid}, "FORBIDDEN")
                for tool, args in (("session_open", {"ttl_seconds": True}),
                                   ("mailbox_receive", {"mailbox_id": self.mid, "limit": "20"}),
                                   ("mailbox_receive", {"mailbox_id": self.mid, "wait_seconds": True})):
                    self.assertTrue((await a.call_tool(tool, args)).isError)
                await call(self, a, "mailbox_receive", {"mailbox_id": self.mid, "wait_seconds": 21}, "INVALID_ARGUMENT")
            async with client(self.home, self.a) as restarted:
                await call(self, restarted, "session_get", {"session_id": self.sid})
                page = await call(self, restarted, "mailbox_receive", {"mailbox_id": self.mid})
                self.assertEqual([m["text"] for m in page["messages"]], ["review", "done"])
                self.assertFalse(page["messages"][0]["acknowledged"])
                duplicate = await call(self, restarted, "mailbox_send", {"mailbox_id": self.mid, "text": "review", "idempotency_key": "task"})
                self.assertTrue(duplicate["duplicated"])
                await call(self, restarted, "mailbox_send", {"mailbox_id": self.mid, "text": "changed", "idempotency_key": "task"}, "CONFLICT")
                activity = await call(self, restarted, "list_recent_activity", {"session_id": self.sid})
                self.assertNotIn("review", json.dumps(activity))
        run_async(scenario())

    def test_third_principal_and_forged_identity_cannot_read(self):
        async def scenario():
            async with client(self.home, self.home / "tokens" / "C.token") as c:
                await call(self, c, "session_get", {"session_id": self.sid, "principal_id": "A"}, "NOT_FOUND")
                await call(self, c, "mailbox_receive", {"mailbox_id": self.mid, "owner": "A"}, "NOT_FOUND")
                await call(self, c, "mailbox_list", {"session_id": self.sid}, "NOT_FOUND")
                self.assertEqual((await call(self, c, "session_list"))["sessions"], [])
                self.assertEqual((await call(self, c, "mailbox_list"))["mailboxes"], [])
        run_async(scenario())

    def test_cross_process_long_poll_wakes_promptly(self):
        async def scenario():
            async with client(self.home, self.a) as a, client(self.home, self.b) as b:
                started = time.monotonic()
                pending = asyncio.create_task(call(self, b, "mailbox_receive", {"mailbox_id": self.mid, "wait_seconds": 10}))
                await asyncio.sleep(0.5)
                self.assertFalse(pending.done(), "B must already be waiting before A writes")
                committed = time.monotonic()
                await call(self, a, "mailbox_send", {"mailbox_id": self.mid, "text": "wake from another process"})
                page = await asyncio.wait_for(pending, 3)
                latency = time.monotonic() - committed
                self.assertEqual(page["messages"][0]["text"], "wake from another process")
                self.assertLess(latency, 2)
                self.assertLess(time.monotonic() - started, 4)
                print(f"CROSS_PROCESS_POLL wake_after_send_seconds={latency:.3f}")
        run_async(scenario())

    def test_every_tool_fails_closed_for_missing_invalid_revoked_disabled(self):
        async def deny_all(token_file=None, token=None):
            async with client(self.home, token_file, token=token) as session:
                for tool, args in TOOLS.items():
                    await call(self, session, tool, args, "UNAUTHENTICATED")
                # Authentication runs even before SDK argument validation.
                await call(self, session, "session_open", {"ttl_seconds": True}, "UNAUTHENTICATED")

        async def scenario():
            await deny_all()
            await deny_all(token="invalid-secret")
            # Well-shaped but wrong secret exercises constant-time digest comparison.
            real = self.a.read_text().strip()
            async with client(self.home, token=real) as fallback:
                self.assertEqual((await call(self, fallback, "whoami"))["principal_id"], "A")
            await deny_all(token=real[:-1] + ("A" if real[-1] != "A" else "B"))
            async with client(self.home, self.b) as live:
                await call(self, live, "whoami")
                await asyncio.to_thread(admin, self.home, "revoke", "B")
                await call(self, live, "whoami", error="UNAUTHENTICATED")
                await call(self, live, "mailbox_receive", {"mailbox_id": self.mid}, "UNAUTHENTICATED")
            await deny_all(self.b)
            Provisioner(self.database).disable("A")
            await deny_all(self.a)
        run_async(scenario())

    def test_revocation_during_long_poll_and_token_file_does_not_switch_identity(self):
        async def scenario():
            async with client(self.home, self.a) as a, client(self.home, self.b) as b:
                # Process reads its secret once; replacing the file cannot rebind identity.
                self.b.write_text(self.a.read_text(), encoding="ascii")
                self.assertEqual((await call(self, b, "whoami"))["principal_id"], "B")
                pending = asyncio.create_task(call(self, b, "mailbox_receive", {"mailbox_id": self.mid, "wait_seconds": 10}, "UNAUTHENTICATED"))
                await asyncio.sleep(0.5)
                self.assertFalse(pending.done())
                # Direct offline transaction avoids subprocess ACL latency in timing assertion.
                with self.database.transaction(write=True) as conn:
                    conn.execute("UPDATE local_credentials SET revoked=1 WHERE principal_id='B'")
                await call(self, a, "mailbox_send", {"mailbox_id": self.mid, "text": "must not leak"})
                await asyncio.wait_for(pending, 3)
        run_async(scenario())

    def test_missing_token_never_connects_or_creates_state(self):
        async def scenario():
            empty = Path(self.temp.name) / "never-created"
            server = create_server(empty, "")
            with patch.object(server.database, "_connect", side_effect=AssertionError("No DB access permitted")) as connect:
                # Missing secret is rejected by authenticate before opening SQLite.
                result = await server.call_tool("whoami", {})
                self.assertEqual(result.structuredContent["error"]["code"], "UNAUTHENTICATED")
                connect.assert_not_called()
            self.assertFalse(empty.exists())
        run_async(scenario())
