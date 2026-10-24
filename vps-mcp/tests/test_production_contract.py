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
from tests.protocol_support import client, local_server, make_gateway

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


async def check():
    gateway = make_gateway()
    baseline = json.loads((FIXTURES / "production_tools.json").read_text())
    cases = json.loads((FIXTURES / "production_dispatch.json").read_text())
    async with local_server(gateway.mcp.streamable_http_app()) as url, client(url) as session:
        actual = {t.name: t.model_dump(mode="json", exclude_none=True) for t in (await session.list_tools()).tools}
        assert set(actual) == set(baseline) | NEW_TOOLS
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
    def test_exact_16_plus_13_schemas_dispatch_and_response_shapes(self):
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

    def test_all_new_tools_deny_forged_identity_without_state_or_ipc(self):
        async def scenario():
            gateway = make_gateway()
            with ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, MCP_STATE_DB=str(HERE / "must-not-create.db"),
                                              MCP_PRINCIPAL="A", MCP_PRINCIPAL_ID="A", MCP_CLIENT_ID="A"))
                database = stack.enter_context(patch("mailbox_core.database.Database", side_effect=AssertionError("no database")))
                stack.enter_context(patch.object(gateway, "call", side_effect=AssertionError("no worker")))
                stack.enter_context(patch.object(gateway, "approval_call", side_effect=AssertionError("no broker")))
                # Test malicious transport headers using the same ephemeral SDK client.
                from mcp.client.streamable_http import streamablehttp_client
                from mcp import ClientSession
                async with local_server(gateway.mcp.streamable_http_app()) as url:
                    async with streamablehttp_client(url, headers={"X-Principal-ID": "A", "X-Client-ID": "A", "Authorization": "Bearer forged"}) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            for tool in (await session.list_tools()).tools:
                                if tool.name not in NEW_TOOLS:
                                    continue
                                self.assertFalse({"principal_id", "owner", "client_id", "approved", "participants"} & set(tool.inputSchema["properties"]))
                                args = {name: "forged" for name in tool.inputSchema.get("required", [])}
                                args.update(principal_id="A", owner="A", client_id="A", session_id="forged", approved=True)
                                result = await session.call_tool(tool.name, args)
                                self.assertTrue(result.isError, tool.name)
                                self.assertEqual(result.structuredContent["error"]["code"], "UNAUTHENTICATED", tool.name)
                            # A ContextVar alone is insufficient to activate runtime storage.
                            with trusted_identity(Principal("A")):
                                result = await gateway.mcp.call_tool("session_open", {})
                                self.assertEqual(result.structuredContent["error"]["code"], "UNAUTHENTICATED")
                database.assert_not_called()
                self.assertFalse((HERE / "must-not-create.db").exists())
        asyncio.run(scenario())
