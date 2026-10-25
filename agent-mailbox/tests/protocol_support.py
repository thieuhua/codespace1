"""Owned ephemeral HTTP listeners only; no production endpoint or sockets."""
import asyncio
from contextlib import asynccontextmanager
import socket
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
import uvicorn
from agent_mailbox.core.http_runtime import GatewayHTTPServer


def make_gateway(services=None):
    """Standalone core harness; no source/import dependency on another project."""
    from types import SimpleNamespace
    from mcp.server.fastmcp import FastMCP
    from agent_mailbox.core.tools import register
    mcp = FastMCP("core-test", host="127.0.0.1", port=8765, stateless_http=True, json_response=True)
    stop = register(mcp, services=services)
    return SimpleNamespace(mcp=mcp, stop_mailbox_waiters=stop)


async def check():
    # Protocol smoke owns an ephemeral listener and never contacts production.
    gateway = make_gateway()
    async with local_server(gateway.mcp.streamable_http_app()) as url, client(url) as c:
        assert (await c.list_tools()).tools == []


@asynccontextmanager
async def local_server(app, before_shutdown=lambda: None):
    # Own the port continuously from bind through shutdown (no allocation race).
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        port = listener.getsockname()[1]
        assert port != 8765
        runner = GatewayHTTPServer(uvicorn.Config(app, log_level="critical", lifespan="on",
                                                timeout_graceful_shutdown=2), before_shutdown=before_shutdown)
        task = asyncio.create_task(runner.serve(sockets=[listener]))
        try:
            async with asyncio.timeout(10):
                while not runner.started:
                    if task.done():
                        await task
                        raise RuntimeError("test server stopped during startup")
                    await asyncio.sleep(0.01)
            yield f"http://127.0.0.1:{port}/mcp"
        finally:
            runner.should_exit = True
            try:
                await asyncio.wait_for(task, 5)
            except TimeoutError:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


@asynccontextmanager
async def client(url):
    async with streamablehttp_client(url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session
