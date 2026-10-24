"""Real HTTP + SDK clients; trusted fixture identity is injected in-process only."""
import asyncio
from contextlib import asynccontextmanager
from mcp.server.fastmcp import FastMCP
from mailbox_core.database import Database
from mailbox_core.identity import Principal, trusted_identity
from mailbox_core.mailboxes import MailboxService
from mailbox_core.sessions import SessionService
from mailbox_core.tools import register
from tests.protocol_support import local_server, client, make_gateway
from tests.support import ServiceCase


class FixedTestIdentity:
    """Test-only application wrapper. No headers or tool fields select identity."""
    def __init__(self, app, pid):
        self.app, self.pid = app, pid

    async def __call__(self, scope, receive, send):
        with trusted_identity(Principal(self.pid)):
            await self.app(scope, receive, send)


class ProtocolTests(ServiceCase):
    def fixture(self, pid):
        db = Database(self.settings)
        gateway = make_gateway((SessionService(db), MailboxService(db)))
        app = FixedTestIdentity(gateway.mcp.streamable_http_app(), pid)
        app.stop = gateway.stop_mailbox_waiters
        return app

    def test_two_clients_restart_and_unauthorized_guesses(self):
        async def call(c, tool, args=None, error=None):
            r = await c.call_tool(tool, args or {})
            if error:
                self.assertTrue(r.isError, r)
                self.assertEqual(r.structuredContent["error"]["code"], error)
            else:
                self.assertFalse(r.isError, r)
            return r.structuredContent

        async def scenario():
            async with local_server(self.fixture("A")) as url, client(url) as a:
                schema = (await a.list_tools()).tools
                self.assertEqual(len(schema), 29)
                for tool in schema:
                    self.assertFalse({"principal_id", "owner", "client_id", "approved", "participants"} & set(tool.inputSchema["properties"]))
                s = await call(a, "session_open", {"name": "dispatch", "idempotency_key": "s"})
                sid = s["session_id"]
                self.admin.grant(sid, "B")
                box = await call(a, "mailbox_create", {"session_id": sid})
                mid = box["mailbox_id"]
                for tool, args in (("session_open", {"ttl_seconds": True}),
                                   ("mailbox_receive", {"mailbox_id": mid, "wait_seconds": True}),
                                   ("mailbox_receive", {"mailbox_id": mid, "limit": "20"})):
                    self.assertTrue((await a.call_tool(tool, args)).isError)
                await call(a, "mailbox_receive", {"mailbox_id": mid, "wait_seconds": 21}, "INVALID_ARGUMENT")
                sent = await call(a, "mailbox_send", {"mailbox_id": mid, "text": "do work", "idempotency_key": "task"})
                duplicate = await call(a, "mailbox_send", {"mailbox_id": mid, "text": "do work", "idempotency_key": "task"})
                self.assertTrue(duplicate["duplicated"])
                await call(a, "mailbox_send", {"mailbox_id": mid, "text": "changed", "idempotency_key": "task"}, "CONFLICT")
            # New app, DB object, listener and SDK connection simulate restart/reconnect.
            async with local_server(self.fixture("B")) as url, client(url) as b:
                page = await call(b, "mailbox_receive", {"mailbox_id": mid})
                self.assertEqual(page["messages"][0]["text"], "do work")
                await call(b, "mailbox_ack", {"mailbox_id": mid, "message_id": sent["message_id"]})
                await call(b, "mailbox_reply", {"mailbox_id": mid, "in_reply_to": sent["message_id"], "text": "done"})
                await call(b, "session_close", {"session_id": sid}, "FORBIDDEN")
            async with local_server(self.fixture("C")) as url, client(url) as c:
                for tool, args in (("session_get", {"session_id": sid}),
                                   ("mailbox_list", {"session_id": sid}),
                                   ("mailbox_receive", {"mailbox_id": mid}),
                                   ("mailbox_send", {"mailbox_id": mid, "text": "attack", "principal_id": "A"}),
                                   ("mailbox_ack", {"mailbox_id": mid, "message_id": sent["message_id"]})):
                    await call(c, tool, args, "NOT_FOUND")
                self.assertEqual((await call(c, "session_list"))["sessions"], [])
                self.assertEqual((await call(c, "mailbox_list"))["mailboxes"], [])
            async with local_server(self.fixture("A")) as url, client(url) as a:
                await call(a, "session_get", {"session_id": sid})
                page = await call(a, "mailbox_receive", {"mailbox_id": mid})
                self.assertEqual([r["text"] for r in page["messages"]], ["do work", "done"])
                self.assertFalse(page["messages"][0]["acknowledged"])
                activity = await call(a, "list_recent_activity", {"session_id": sid})
                self.assertNotIn("do work", str(activity))
                await call(a, "session_renew", {"session_id": sid})
                await call(a, "session_close", {"session_id": sid})
        asyncio.run(scenario())

    def test_shutdown_releases_active_http_poll(self):
        async def scenario():
            app = self.fixture("A")
            running = local_server(app, app.stop)
            url = await running.__aenter__()
            try:
                async with client(url) as c:
                    s = (await c.call_tool("session_open")).structuredContent
                    box = (await c.call_tool("mailbox_create", {"session_id": s["session_id"]})).structuredContent
                    task = asyncio.create_task(c.call_tool("mailbox_receive", {"mailbox_id": box["mailbox_id"], "wait_seconds": 20}))
                    await asyncio.sleep(0.1)
                    started = asyncio.get_running_loop().time()
                    await running.__aexit__(None, None, None)
                    result = await asyncio.wait_for(task, 2)
                    self.assertTrue(result.isError)
                    self.assertEqual(result.structuredContent["error"]["code"], "RESOURCE_EXHAUSTED")
                    self.assertLess(asyncio.get_running_loop().time() - started, 1)
            finally:
                await running.__aexit__(None, None, None)
        asyncio.run(scenario())
