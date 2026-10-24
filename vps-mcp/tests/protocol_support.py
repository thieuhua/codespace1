"""Owned ephemeral HTTP listeners only; no production endpoint or sockets."""
import asyncio
import importlib.util
from contextlib import asynccontextmanager
from pathlib import Path
import socket
from unittest.mock import patch
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
import uvicorn
from mailbox_core.http_runtime import GatewayHTTPServer


def make_gateway(services=None):
    """Load actual production gateway; injection exists only in this test helper."""
    from mailbox_core.tools import register
    spec = importlib.util.spec_from_file_location("isolated_gateway", Path(__file__).resolve().parents[1] / "gateway.py")
    gateway = importlib.util.module_from_spec(spec)
    with patch("mailbox_core.tools.register", side_effect=lambda mcp: register(mcp, services=services)):
        spec.loader.exec_module(gateway)
    return gateway

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


