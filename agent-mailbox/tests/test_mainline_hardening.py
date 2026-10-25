import asyncio
import sqlite3
from unittest.mock import patch

from agent_mailbox.core.mailboxes import MailboxService
from tests.protocol_support import make_gateway
from tests.support import ServiceCase


class MainlineHardeningTests(ServiceCase):
    def test_id_types_cannot_substitute_for_each_other(self):
        mail = MailboxService(self.db, clock=lambda: self.now[0])
        with self.as_user():
            sid = self.sessions.open()["session_id"]
            mid = mail.create(sid)["mailbox_id"]
            message = mail.send(mid, "private")["message_id"]
            self.assert_code("NOT_FOUND", self.sessions.get, mid)
            self.assert_code("NOT_FOUND", mail.send, sid, "bad")
            self.assert_code("NOT_FOUND", mail.ack, mid, sid)
            self.assert_code("NOT_FOUND", mail.reply, mid, mid, "bad")
            self.assert_code("NOT_FOUND", mail.get_message, message, message)

    def test_context_isolated_across_parallel_callers_and_tasks(self):
        mail = MailboxService(self.db)
        async def scenario():
            gateway = make_gateway((self.sessions, mail))
            async def open_as(pid):
                with self.as_user(pid):
                    result = await gateway.mcp.call_tool("session_open", {"name": pid})
                    return result.structuredContent["session_id"]
            first, second = await asyncio.gather(open_as("A"), open_as("B"))
            for principal, own, other in (("A", first, second), ("B", second, first)):
                with self.as_user(principal):
                    self.assertEqual(self.sessions.get(own)["session_id"], own)
                    self.assert_code("NOT_FOUND", self.sessions.get, other)
            result = await gateway.mcp.call_tool("session_list", {})
            self.assertEqual(result.structuredContent["error"]["code"], "UNAUTHENTICATED")
        asyncio.run(scenario())

    def test_sqlite_and_unexpected_errors_are_redacted_at_tool_boundary(self):
        mail = MailboxService(self.db)
        gateway = make_gateway((self.sessions, mail))
        async def scenario():
            with self.as_user():
                for exception in (sqlite3.OperationalError("PRIVATE SQL /private/state payload"), RuntimeError("PRIVATE payload")):
                    with patch.object(self.db, "_connect", side_effect=exception):
                        result = await gateway.mcp.call_tool("session_list", {})
                    self.assertTrue(result.isError)
                    self.assertEqual(result.structuredContent["error"]["code"], "INTERNAL")
                    self.assertNotIn("PRIVATE", str(result))
        asyncio.run(scenario())

    def test_http_runner_keeps_legacy_transport_and_drain_defaults(self):
        from agent_mailbox.core.http_runtime import run_http
        gateway = make_gateway()
        with patch("agent_mailbox.core.http_runtime.GatewayHTTPServer") as server:
            run_http(gateway.mcp, gateway.stop_mailbox_waiters)
        config = server.call_args.args[0]
        self.assertEqual((config.host, config.port), ("127.0.0.1", 8765))
        self.assertIsNone(config.timeout_graceful_shutdown)
        self.assertIs(server.call_args.kwargs["before_shutdown"], gateway.stop_mailbox_waiters)
        server.return_value.run.assert_called_once()
