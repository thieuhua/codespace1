"""Stdio only. Authentication wraps tool validation and all core dispatch."""
from contextlib import asynccontextmanager
import json
import logging

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent

from .auth import AuthenticatedDatabase
from .core.async_db import run_db
from .core.errors import GatewayError
from .core.identity import trusted_identity
from .core.mailboxes import MailboxService
from .core.sessions import SessionService
from .core.settings import Settings
from .core.tools import register


def error_result(code, message):
    data = {"schema_version": 1, "error": {"code": code, "message": message}}
    return CallToolResult(isError=True, content=[TextContent(type="text", text=json.dumps(data))],
                          structuredContent=data)


class AuthenticatedMCP(FastMCP):
    def __init__(self, database, **kwargs):
        self.database = database
        super().__init__("agent_mailbox", **kwargs)

    async def call_tool(self, name, arguments):
        try:
            principal = await run_db(self.database.authenticate)
        except GatewayError as exc:
            return error_result(exc.code, exc.message)
        except Exception:
            return error_result("UNAUTHENTICATED", "Valid local authentication required")
        with trusted_identity(principal):
            return await super().call_tool(name, arguments)


def create_server(home, token):
    database = AuthenticatedDatabase(Settings(home / "mailbox.db"), token)
    sessions, mailboxes = SessionService(database), MailboxService(database)

    @asynccontextmanager
    async def lifespan(_):
        try:
            yield {}
        finally:
            mailboxes.stop_waiters()

    server = AuthenticatedMCP(database, lifespan=lifespan,
                              instructions="Durable local agent messages. Discover shared sessions with session_list; "
                                           "use idempotency keys and persist receive cursors. Identity is process-bound.")
    register(server, services=(sessions, mailboxes))

    @server.tool()
    def whoami() -> CallToolResult:
        """Return the authenticated principal ID; no tool arguments select identity."""
        from .core.identity import current_principal
        data = {"schema_version": 1, "principal_id": current_principal().principal_id}
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(data))], structuredContent=data)

    return server


def serve(home, token):
    logging.basicConfig(level=logging.WARNING)
    create_server(home, token).run(transport="stdio")
