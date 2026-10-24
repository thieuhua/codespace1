"""Additive MCP API; no changes to the legacy tool implementations."""
import json
import logging
from mcp.types import CallToolResult, TextContent
from pydantic import StrictFloat, StrictInt, StrictStr
from .errors import GatewayError
from .identity import current_principal
from .async_db import run_db

logger = logging.getLogger("vps_mcp.mailbox")


def register(mcp, *, services=None):
    """services is privileged in-process injection, used only by isolated tests.

    Production passes no services: no runtime identity/state adapter is approved.
    Neither environment variables nor a trusted ContextVar alone activate storage.
    """
    state = services

    async def invoke(index, method, **kwargs):
        try:
            current_principal()  # Deny before opening/creating any state database.
            if state is None:
                raise GatewayError("UNAUTHENTICATED", "Runtime identity and private state adapter not provisioned")
            service = state[index]
            fn = getattr(service, method)
            if index == 1 and method == "receive":
                result = await fn(**kwargs)
            else:
                result = await run_db(fn, **kwargs)
            return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))], structuredContent=result)
        except GatewayError as error:
            result = {"schema_version": 1, "error": {"code": error.code, "message": error.message}}
        except Exception:
            # Avoid logging exceptions: SQL/path/payload may appear in exception text.
            logger.error("gateway operation failed operation=%s", method)
            result = {"schema_version": 1, "error": {"code": "INTERNAL", "message": "Operation failed"}}
        return CallToolResult(isError=True, content=[TextContent(type="text", text=json.dumps(result))], structuredContent=result)

    @mcp.tool()
    async def session_open(name: StrictStr = "", ttl_seconds: StrictInt | None = None, idempotency_key: StrictStr | None = None) -> CallToolResult:
        """Open a durable logical session for the trusted authenticated principal."""
        return await invoke(0, "open", name=name, ttl_seconds=ttl_seconds, idempotency_key=idempotency_key)

    @mcp.tool()
    async def session_get(session_id: StrictStr) -> CallToolResult:
        """Resume/read session status and refresh last_seen. Historical reads survive closure."""
        return await invoke(0, "get", session_id=session_id)

    @mcp.tool()
    async def session_list(cursor: StrictStr | None = None, limit: StrictInt = 20) -> CallToolResult:
        """List only sessions accessible to the authenticated principal."""
        return await invoke(0, "list", after_cursor=cursor, limit=limit)

    @mcp.tool()
    async def session_renew(session_id: StrictStr, ttl_seconds: StrictInt | None = None) -> CallToolResult:
        """Owner-only renewal of an active, unexpired session."""
        return await invoke(0, "renew", session_id=session_id, ttl_seconds=ttl_seconds)

    @mcp.tool()
    async def session_close(session_id: StrictStr) -> CallToolResult:
        """Owner-only idempotent closure; retains history until retention cleanup."""
        return await invoke(0, "close", session_id=session_id)

    @mcp.tool()
    async def list_recent_activity(session_id: StrictStr, after_cursor: StrictStr | None = None, limit: StrictInt = 20) -> CallToolResult:
        """Read paginated session activity metadata without message contents."""
        return await invoke(0, "activity", session_id=session_id, after_cursor=after_cursor, limit=limit)

    @mcp.tool()
    async def mailbox_create(session_id: StrictStr, name: StrictStr = "", idempotency_key: StrictStr | None = None) -> CallToolResult:
        """Owner creates a mailbox; inherits the session ACL provisioned outside MCP."""
        return await invoke(1, "create", session_id=session_id, name=name, idempotency_key=idempotency_key)

    @mcp.tool()
    async def mailbox_list(session_id: StrictStr | None = None, cursor: StrictStr | None = None, limit: StrictInt = 20) -> CallToolResult:
        """List mailboxes accessible to the authenticated principal."""
        return await invoke(1, "list", session_id=session_id, after_cursor=cursor, limit=limit)

    @mcp.tool()
    async def mailbox_send(mailbox_id: StrictStr, text: StrictStr, correlation_id: StrictStr | None = None, idempotency_key: StrictStr | None = None) -> CallToolResult:
        """Append bounded text durably. Use an idempotency key when retrying a send."""
        return await invoke(1, "send", mailbox_id=mailbox_id, text=text, correlation_id=correlation_id, idempotency_key=idempotency_key)

    @mcp.tool()
    async def mailbox_receive(mailbox_id: StrictStr, after_cursor: StrictStr | None = None, limit: StrictInt = 20, wait_seconds: StrictFloat = 0) -> CallToolResult:
        """Receive ordered history after a cursor; wait_for_updates uses wait_seconds <=20."""
        return await invoke(1, "receive", mailbox_id=mailbox_id, after_cursor=after_cursor, limit=limit, wait_seconds=wait_seconds)

    @mcp.tool()
    async def mailbox_ack(mailbox_id: StrictStr, message_id: StrictStr) -> CallToolResult:
        """Acknowledge for the current principal; other consumers retain their own state."""
        return await invoke(1, "ack", mailbox_id=mailbox_id, message_id=message_id)

    @mcp.tool()
    async def mailbox_reply(mailbox_id: StrictStr, in_reply_to: StrictStr, text: StrictStr, idempotency_key: StrictStr | None = None) -> CallToolResult:
        """Reply to a retained message in the same mailbox; does not confer job access."""
        return await invoke(1, "reply", mailbox_id=mailbox_id, in_reply_to=in_reply_to, text=text, idempotency_key=idempotency_key)

    @mcp.tool()
    async def mailbox_get_message(mailbox_id: StrictStr, message_id: StrictStr) -> CallToolResult:
        """Read one retained message and this principal's acknowledgement state."""
        return await invoke(1, "get_message", mailbox_id=mailbox_id, message_id=message_id)

    def stop_waiters():
        if state is not None:
            state[1].stop_waiters()

    return stop_waiters
