"""One authenticated HTTP router; trusted control remains an offline CLI."""
import asyncio
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
import ipaddress
import json
import logging
import os
import time
import threading

from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.auth.provider import AccessToken
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse
import uvicorn

from . import __version__
from .auth import AuthenticatedDatabase, TOKEN_PATTERN, unauthenticated
from .core.errors import GatewayError, exhausted, invalid
from .core.http_runtime import GatewayHTTPServer
from .core.settings import Settings
from .paths import safe_path
from .router_store import RouterStore, hold_value
from .server import error_result

NO_MAIL = "No mail yet. Call mailbox_receive again now to keep listening. Do not end your turn."
MAIL = "Handle these messages (reply with mailbox_send or mailbox_reply), then call mailbox_receive again. Do not end your turn."
STOP = "Stop polling and end your turn with a one-line summary."
PROTOCOL = "Call mailbox_receive repeatedly. " + MAIL + " " + NO_MAIL + " On status stop: " + STOP
WATCH_SECONDS = 0.1
MAX_WAITERS = 64


def result(data):
    data = {"schema_version": 1, **data}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(data))], structuredContent=data)


@dataclass
class RequestState:
    token: str
    principal: str
    call_id: str | None = None
    hold: float = 0
    poll_count: int = 0
    status: str = "error"
    error: str | None = None
    disconnected: bool = False
    finished: bool = False
    event: asyncio.Event | None = None


class RouterRuntime:
    def __init__(self, store):
        self.store = store
        self.waiters = {}
        self.stopping = False
        self.server = None
        self.watcher = None

    def stop(self):
        self.stopping = True
        for state in self.waiters.values():
            state.event.set()

    async def watch(self):
        previous_auth = None
        last_metrics = 0
        while True:
            await asyncio.sleep(WATCH_SECONDS)
            try:
                with self.store.transaction() as conn:
                    ready = {r[0] for r in conn.execute("SELECT DISTINCT recipient FROM messages WHERE delivered_at IS NULL AND reserved_by IS NULL")}
                    ready.update(r[0] for r in conn.execute("SELECT principal FROM controls WHERE stopped=1"))
                    auth = tuple(tuple(r) for r in conn.execute("SELECT token_id,revoked,enabled FROM local_credentials JOIN principals USING(principal_id) ORDER BY token_id"))
                    shutdown = conn.execute("SELECT 1 FROM settings WHERE key='shutdown'").fetchone()
                if auth != previous_auth:
                    ready.update(self.waiters)
                    previous_auth = auth
                for pid in ready:
                    if pid in self.waiters:
                        self.waiters[pid].event.set()
                if shutdown:
                    self.stop()
                    if self.server:
                        self.server.should_exit = True
                if time.monotonic()-last_metrics >= 1:
                    metrics = {"pid": os.getpid(), "at": time.time(), "tasks": len(asyncio.all_tasks()),
                               "threads": threading.active_count(), "waiters": len(self.waiters),
                               "watchers": 1, "connections": len(self.server.server_state.connections) if self.server else 0}
                    with self.store.transaction(write=True) as conn:
                        conn.execute("INSERT OR REPLACE INTO settings VALUES ('runtime',?)", (json.dumps(metrics),))
                    last_metrics = time.monotonic()
            except GatewayError:
                # Wake calls so storage errors are reported and instrumented;
                # a transient lock must not silently kill the sole watcher.
                for state in self.waiters.values():
                    state.event.set()

    def finish(self, state, *, cancelled=False):
        if state.call_id and not state.finished:
            self.store.finish_receive(state.call_id, "cancelled" if cancelled else state.status,
                                      cancelled=cancelled, error=state.error,
                                      token=state.token if not cancelled and state.status in ("mail", "no_mail", "stop") else None,
                                      principal=state.principal)
            state.finished = True
        if cancelled and state.event:
            state.event.set()
        if self.waiters.get(state.principal) is state:
            self.waiters.pop(state.principal)

    async def receive(self, state, wait_seconds):
        if wait_seconds is not None and (type(wait_seconds) is not int or wait_seconds < 0):
            invalid("wait_seconds must be a nonnegative integer or null")
        hold = state.hold if wait_seconds is None else min(wait_seconds, state.hold)
        if state.principal in self.waiters or len(self.waiters) >= MAX_WAITERS:
            exhausted("At most one receive per principal and 64 receives overall")
        state.event = asyncio.Event()
        self.waiters[state.principal] = state
        deadline = asyncio.get_running_loop().time() + hold
        while True:
            if state.disconnected or state.finished:
                raise asyncio.CancelledError()
            state.event.clear()
            status, messages = self.store.snapshot(state.principal, state.token, state.call_id)
            if self.stopping:
                status, messages = "stop", []
            remaining = deadline - asyncio.get_running_loop().time()
            if status != "no_mail" or remaining <= 0:
                state.status = status
                return result({"status": status, "messages": messages, "poll_count": state.poll_count,
                               "server_time": time.time(), "instruction": {"mail": MAIL, "no_mail": NO_MAIL, "stop": STOP}[status]})
            try:
                await asyncio.wait_for(state.event.wait(), remaining)
            except TimeoutError:
                pass


class RouterMCP(FastMCP):
    def __init__(self, runtime, **kwargs):
        self.runtime = runtime
        super().__init__("agent_mailbox", instructions=PROTOCOL, **kwargs)

    def request_state(self):
        return self.get_context().request_context.request.scope["router_state"]

    async def call_tool(self, name, arguments):
        state = self.request_state()
        try:
            # Per-tool recheck, in addition to per-HTTP-request authentication.
            with self.runtime.store.authorized(state.token, state.principal):
                pass
            if name == "mailbox_receive":
                state.call_id, state.hold, state.poll_count = self.runtime.store.begin_receive(state.principal, state.token)
                value = (arguments or {}).get("wait_seconds")
                if value is not None and (type(value) is not int or value < 0):
                    invalid("wait_seconds must be a nonnegative integer or null")
            answer = await super().call_tool(name, arguments)
            if isinstance(answer, CallToolResult) and answer.isError:
                state.error = "INVALID_ARGUMENT"
            return answer
        except GatewayError as exc:
            state.error = exc.code
            return error_result(exc.code, exc.message)
        except ToolError as exc:
            cause = exc.__cause__
            state.error = cause.code if isinstance(cause, GatewayError) else "INVALID_ARGUMENT"
            if name in ("mailbox_send", "mailbox_reply") and not isinstance(cause, GatewayError):
                self.runtime.store.record_send_error(state.principal, None, state.error)
            return error_result(state.error, cause.message if isinstance(cause, GatewayError) else "Invalid tool arguments")
        except BaseException:
            # SDK notification cancellation can end the tool before ASGI completes.
            self.runtime.finish(state, cancelled=True)
            raise


class RouterHTTP:
    """Auth before transport; monitor disconnects; commit at the response boundary."""
    def __init__(self, app, runtime):
        self.app, self.runtime = app, runtime

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = HTTPConnection(scope).headers
        values = headers.getlist("authorization")
        token = values[0][7:] if len(values) == 1 and values[0][:7].lower() == "bearer " else ""
        try:
            if not TOKEN_PATTERN.fullmatch(token):
                unauthenticated()
            principal = AuthenticatedDatabase(Settings(self.runtime.store.auth_path), token).authenticate().principal_id
            if principal in ("operator", "claude", "all"):
                unauthenticated()
        except GatewayError:
            return await JSONResponse({"error": {"code": "UNAUTHENTICATED", "message": "Valid local authentication required"}},
                                      status_code=401, headers={"WWW-Authenticate": "Bearer"})(scope, receive, send)
        state = RequestState(token, principal)
        scope["router_state"] = state
        scope["user"] = AuthenticatedUser(AccessToken(token=token, client_id=principal, scopes=[]))
        monitor = None
        response_start = None

        async def disconnected():
            while True:
                event = await receive()
                if event["type"] == "http.disconnect":
                    state.disconnected = True
                    if state.event:
                        state.event.set()
                    self.runtime.finish(state, cancelled=True)
                    return

        async def monitored_receive():
            nonlocal monitor
            event = await receive()
            if scope["method"] == "POST" and event["type"] == "http.request" and not event.get("more_body", False) and monitor is None:
                monitor = asyncio.create_task(disconnected())
            return event

        async def boundary_send(event):
            nonlocal response_start
            if scope["method"] == "POST" and event["type"] == "http.response.start":
                response_start = event
                return
            if event["type"] == "http.response.body" and state.call_id and not state.finished:
                if state.disconnected:
                    self.runtime.finish(state, cancelled=True)
                    return
                # No await between recheck, delivery commit and entering ASGI send.
                try:
                    # Session DELETE can produce a transport cancellation error
                    # before the tool task receives its CancelledError.
                    self.runtime.finish(state, cancelled=state.status == "error" and state.error is None)
                except GatewayError as exc:
                    state.status, state.error = "error", exc.code
                    self.runtime.finish(state)
                    body = json.loads(event["body"])
                    body["result"] = error_result(exc.code, exc.message).model_dump(by_alias=True, exclude_none=True)
                    event = {**event, "body": json.dumps(body).encode()}
                    response_start = {**response_start, "headers": [(k, v) for k, v in response_start["headers"] if k.lower() != b"content-length"] +
                                      [(b"content-length", str(len(event["body"])).encode())]}
            if response_start is not None:
                await send(response_start)
                response_start = None
            await send(event)

        try:
            await self.app(scope, monitored_receive, boundary_send)
        finally:
            if monitor:
                monitor.cancel()
                await asyncio.gather(monitor, return_exceptions=True)
            self.runtime.finish(state, cancelled=not state.finished)


def create_router(home, host="127.0.0.1", port=8766, hold_seconds=50):
    runtime = RouterRuntime(RouterStore(home, hold_seconds))
    runtime.store.set_hold(hold_seconds)
    runtime.store.recover()
    security = TransportSecuritySettings(enable_dns_rebinding_protection=True,
        allowed_hosts=["localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*", "[::1]", "[::1]:*"],
        allowed_origins=["http://localhost", "http://localhost:*", "http://127.0.0.1", "http://127.0.0.1:*", "http://[::1]", "http://[::1]:*"])
    if host not in ("localhost", "127.0.0.1", "::1", "0.0.0.0", "::"):
        security.allowed_hosts.extend([host, f"{host}:*"])
    mcp = RouterMCP(runtime, host=host, port=port, json_response=True, stateless_http=False,
                    max_sessions=64, session_idle_timeout=600, log_level="WARNING", transport_security=security)

    @mcp.tool()
    async def whoami() -> CallToolResult:
        """Identify yourself and read the listening loop protocol."""
        state = mcp.request_state()
        return result({"principal_id": state.principal, "server_name": "agent_mailbox",
                       "server_version": __version__, "hold_seconds": runtime.store.hold(), "protocol": PROTOCOL})

    @mcp.tool()
    async def mailbox_receive(wait_seconds: int | None = None) -> CallToolResult:
        """Listen on your own inbox, then repeat until status stop. Do not end your turn."""
        return await runtime.receive(mcp.request_state(), wait_seconds)

    @mcp.tool()
    async def mailbox_send(to: str, text: str, reply_to: str | None = None, idempotency_key: str | None = None) -> CallToolResult:
        """Route a message to a principal or operator (alias claude)."""
        state = mcp.request_state()
        return result(runtime.store.send(state.principal, to, text, reply_to, idempotency_key, state.token))

    @mcp.tool()
    async def mailbox_reply(message_id: str, text: str, idempotency_key: str | None = None) -> CallToolResult:
        """Reply to the sender of a delivered message in your own inbox."""
        state = mcp.request_state()
        return result(runtime.store.reply(state.principal, state.token, message_id, text, idempotency_key))

    @mcp.tool()
    async def mailbox_ack(message_ids: list[str]) -> CallToolResult:
        """Optionally record idempotent acknowledgements of delivered messages."""
        state = mcp.request_state()
        return result(runtime.store.ack(state.principal, state.token, message_ids))

    app = mcp.streamable_http_app()
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        runtime.watcher = asyncio.create_task(runtime.watch(), name="router-db-watcher")
        try:
            async with original_lifespan(app):
                yield
        finally:
            runtime.stop()
            runtime.watcher.cancel()
            await asyncio.gather(runtime.watcher, return_exceptions=True)

    app.router.lifespan_context = lifespan
    return RouterHTTP(app, runtime), runtime


@contextmanager
def server_lock(home):
    """An OS lock survives neither crashes nor PID reuse; no stale lock deletion."""
    path = safe_path(home / "router.lock", file=True)
    with path.open("a+b") as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def validate_bind(host, allow_non_loopback):
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback and not allow_non_loopback:
        raise ValueError("Non-loopback binding requires --allow-non-loopback")


def serve(args, home):
    validate_bind(args.host, args.allow_non_loopback)
    hold_value(args.hold_seconds)
    if not home.is_dir():
        raise ValueError("Provision state first")
    logging.basicConfig(level=logging.WARNING)
    with server_lock(home):
        app, runtime = create_router(home, args.host, args.port, args.hold_seconds)
        config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning", access_log=False,
                                timeout_graceful_shutdown=5)
        runtime.server = GatewayHTTPServer(config, before_shutdown=runtime.stop)
        runtime.server.run()

