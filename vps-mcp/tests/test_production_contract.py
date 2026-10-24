"""Exact production schemas/dispatch through actual HTTP and isolated socket doubles."""
import asyncio
import ast
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from mailbox_core.identity import Principal, trusted_identity
from mailbox_core.mailboxes import MailboxService
from tests.protocol_support import client, local_server, make_gateway
from tests.support import ServiceCase

HERE = Path(__file__).resolve().parents[1]
FIXTURES = HERE / "tests" / "fixtures"
NEW_TOOLS = {
    "session_open", "session_get", "session_list", "session_renew", "session_close",
    "list_recent_activity", "mailbox_create", "mailbox_list", "mailbox_send",
    "mailbox_receive", "mailbox_ack", "mailbox_reply", "mailbox_get_message",
}


class SocketDouble:
    """Never opens a socket; records byte-level worker/approval IPC contracts."""
    def __init__(self, payload):
        self.payload = payload
        self.address = self.timeout = self.sent = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def settimeout(self, timeout):
        self.timeout = timeout

    def connect(self, address):
        self.address = address

    def sendall(self, data):
        self.sent = data

    def makefile(self, mode):
        assert mode == "rb"
        return io.BytesIO(self.payload)


async def check(services=None):
    gateway = make_gateway(services)
    baseline = json.loads((FIXTURES / "production_tools.json").read_text())
    cases = json.loads((FIXTURES / "production_dispatch.json").read_text())
    async with local_server(gateway.mcp.streamable_http_app()) as url, client(url) as session:
        tools = (await session.list_tools()).tools
        actual = {t.name: t.model_dump(mode="json", exclude_none=True) for t in tools}
        assert len(tools) == (16 if services is None else 29)
        assert set(actual) == set(baseline) | (NEW_TOOLS if services is not None else set())
        for name, definition in baseline.items():
            assert actual[name] == definition, name
        for case in cases:
            double = SocketDouble(json.dumps({"ok": True, "result": case["result"]}).encode() + b"\n")
            # Patch only during this request; all real network IO remains test-owned.
            # gateway.socket is the stdlib module, so use a narrow namespace proxy.
            import socket
            from types import SimpleNamespace
            proxy = SimpleNamespace(AF_UNIX=getattr(socket, "AF_UNIX", -1), SOCK_STREAM=socket.SOCK_STREAM,
                                    socket=lambda *_: double)
            with patch.object(gateway, "socket", proxy):
                result = await session.call_tool(case["tool"], case["args"])
            assert not result.isError, (case["tool"], result)
            assert [c.model_dump(mode="json", exclude_none=True) for c in result.content] == case["content"], case["tool"]
            assert result.structuredContent == case["structured"], case["tool"]
            approval = case["tool"] in {"request_protected", "execute_protected"}
            expected = {"method": case["method"], **case["ipc"]} if approval else {"method": case["method"], "args": case["ipc"]}
            assert json.loads(double.sent) == expected, case["tool"]
            assert double.address == (gateway.APPROVAL_SOCKET if approval else gateway.WORKER_SOCKET)
            assert double.timeout == (45 if approval else 100)
        for name, args, message in (
            ("run_tests", {"test_command": "arbitrary"}, "Unsupported test command"),
            ("request_protected", {"operation": "shell", "unit": "x"}, "Unsupported protected operation"),
        ):
            with patch.object(gateway, "call", side_effect=AssertionError("must not dispatch")), patch.object(gateway, "approval_call", side_effect=AssertionError("must not dispatch")):
                result = await session.call_tool(name, args)
            assert result.isError and message in result.content[0].text


class ProductionContractTests(unittest.TestCase):
    def test_default_exact_16_schemas_dispatch_and_response_shapes(self):
        asyncio.run(check())

    def test_original_functions_and_privilege_components_unchanged(self):
        fixture = json.loads((FIXTURES / "production_source.json").read_text())
        actual = {n.name: ast.dump(n, include_attributes=False) for n in ast.parse((HERE / "gateway.py").read_text()).body if isinstance(n, ast.FunctionDef)}
        for name, source in fixture["gateway_functions"].items():
            self.assertEqual(actual[name], source, name)
        for path, digest in fixture["unchanged_sha256"].items():
            self.assertEqual(hashlib.sha256((HERE.parent / path).read_bytes().replace(b"\r\n", b"\n")).hexdigest(), digest, path)

    def test_import_and_production_transport_configuration(self):
        import gateway
        self.assertEqual(Path(gateway.__file__).resolve(), HERE / "gateway.py")
        self.assertFalse((HERE / "gateway").exists())
        self.assertEqual(gateway.mcp.settings.host, "127.0.0.1")
        self.assertEqual(gateway.mcp.settings.port, 8765)
        self.assertTrue(gateway.mcp.settings.stateless_http)
        self.assertTrue(gateway.mcp.settings.json_response)

    def test_ipc_errors_limits_and_legacy_error_messages(self):
        gateway = make_gateway()
        for method, limit, empty_error in ((gateway.call, 4 * 1024 * 1024, "Worker response missing or oversized"),
                                           (gateway.approval_call, 16384, "Approval service unavailable")):
            for payload, message in ((b"", empty_error), (b"x" * (limit + 1), empty_error),
                                     (b'{"ok":false,"error":"PermissionError: denied"}\n', "PermissionError: denied")):
                double = SocketDouble(payload)
                from types import SimpleNamespace
                with patch.object(gateway, "socket", SimpleNamespace(AF_UNIX=-1, SOCK_STREAM=1, socket=lambda *_: double)):
                    with self.assertRaisesRegex(RuntimeError, message):
                        method("test")

    def test_default_new_tools_absent_despite_forged_identity_or_context(self):
        async def scenario():
            with ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, MCP_STATE_DB=str(HERE / "must-not-create.db"),
                                              MCP_PRINCIPAL="A", MCP_PRINCIPAL_ID="A", MCP_CLIENT_ID="A"))
                database = stack.enter_context(patch("mailbox_core.database.Database", side_effect=AssertionError("no database")))
                gateway = make_gateway()
                stack.enter_context(patch.object(gateway, "call", side_effect=AssertionError("no worker")))
                stack.enter_context(patch.object(gateway, "approval_call", side_effect=AssertionError("no broker")))
                # Test malicious transport headers using the same ephemeral SDK client.
                from mcp.client.streamable_http import streamablehttp_client
                from mcp import ClientSession
                async with local_server(gateway.mcp.streamable_http_app()) as url:
                    async with streamablehttp_client(url, headers={"X-Principal-ID": "A", "X-Client-ID": "A", "Authorization": "Bearer forged"}) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            baseline = json.loads((FIXTURES / "production_tools.json").read_text())
                            tools = (await session.list_tools()).tools
                            self.assertEqual(len(tools), 16)
                            self.assertEqual({t.name: t.model_dump(mode="json", exclude_none=True) for t in tools}, baseline)
                            for name in NEW_TOOLS:
                                result = await session.call_tool(name, {})
                                self.assertTrue(result.isError, name)
                                self.assertIn("Unknown tool", result.content[0].text, name)
                            # A ContextVar alone cannot register tools or activate storage.
                            with trusted_identity(Principal("A")):
                                self.assertEqual({t.name for t in await gateway.mcp.list_tools()}, set(baseline))
                                for name in NEW_TOOLS:
                                    result = await session.call_tool(name, {})
                                    self.assertTrue(result.isError, name)
                                    self.assertIn("Unknown tool", result.content[0].text, name)
                                gateway.stop_mailbox_waiters()
                database.assert_not_called()
                self.assertFalse((HERE / "must-not-create.db").exists())
        asyncio.run(scenario())


class InjectedProductionContractTests(ServiceCase):
    def test_injected_exact_16_plus_13_schemas_dispatch_and_response_shapes(self):
        asyncio.run(check((self.sessions, MailboxService(self.db))))

    def test_all_new_tools_deny_forged_identity_without_storage_access_or_ipc(self):
        async def scenario():
            gateway = make_gateway((self.sessions, MailboxService(self.db)))
            with ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, MCP_STATE_DB=str(HERE / "must-not-create.db"),
                                              MCP_PRINCIPAL="A", MCP_PRINCIPAL_ID="A", MCP_CLIENT_ID="A"))
                database = stack.enter_context(patch("mailbox_core.database.Database", side_effect=AssertionError("no database")))
                run_db = stack.enter_context(patch("mailbox_core.tools.run_db", side_effect=AssertionError("no storage access")))
                stack.enter_context(patch.object(gateway, "call", side_effect=AssertionError("no worker")))
                stack.enter_context(patch.object(gateway, "approval_call", side_effect=AssertionError("no broker")))
                from mcp.client.streamable_http import streamablehttp_client
                from mcp import ClientSession
                async with local_server(gateway.mcp.streamable_http_app()) as url:
                    async with streamablehttp_client(url, headers={"X-Principal-ID": "A", "X-Client-ID": "A", "Authorization": "Bearer forged"}) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            tools = {t.name: t for t in (await session.list_tools()).tools}
                            baseline = json.loads((FIXTURES / "production_tools.json").read_text())
                            self.assertEqual(set(tools), set(baseline) | NEW_TOOLS)
                            self.assertEqual(len(tools), 29)
                            for name in NEW_TOOLS:
                                tool = tools[name]
                                self.assertFalse({"principal_id", "owner", "client_id", "approved", "participants"} & set(tool.inputSchema["properties"]))
                                args = {name: "forged" for name in tool.inputSchema.get("required", [])}
                                args.update(principal_id="A", owner="A", client_id="A", session_id="forged", approved=True)
                                result = await session.call_tool(tool.name, args)
                                self.assertTrue(result.isError, tool.name)
                                self.assertEqual(result.structuredContent["error"]["code"], "UNAUTHENTICATED", tool.name)
                database.assert_not_called()
                run_db.assert_not_called()
                self.assertFalse((HERE / "must-not-create.db").exists())
        asyncio.run(scenario())
