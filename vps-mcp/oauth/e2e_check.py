"""End-to-end check: the unmodified gateway.py + the MCP SDK's own OAuth client + this proxy.

Not part of unit-test discovery. Needs the packages from requirements.txt and a free port 8765:

    python e2e_check.py

The proxy is served in-process (ASGI) under the public name https://mcp.test, so no DNS or TLS
is needed; the gateway runs as a real subprocess and the proxy talks to it over real HTTP.
"""
import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
from pydantic import AnyUrl

from mcp import ClientSession
from mcp.client.auth import OAuthClientProvider
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

import oauth_proxy as op

GATEWAY = Path(__file__).resolve().parents[1] / "gateway.py"
PASSWORD = "e2e password that is long enough"
CALLBACK = "https://claude.ai/api/mcp/auth_callback"


class MemoryStorage:
    def __init__(self):
        self.tokens: OAuthToken | None = None
        self.client: OAuthClientInformationFull | None = None

    async def get_tokens(self):
        return self.tokens

    async def set_tokens(self, tokens):
        self.tokens = tokens

    async def get_client_info(self):
        return self.client

    async def set_client_info(self, info):
        self.client = info


def wait_for_port(port: int, seconds: float = 20.0) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise SystemExit(f"port {port} never opened")


async def main() -> None:
    gateway = subprocess.Popen([sys.executable, str(GATEWAY)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for_port(8765)
        settings = op.Settings(public_url="https://mcp.test", db_path=":memory:")
        owner = op.OwnerCredentials.create(PASSWORD)
        store = op.Store(":memory:")
        upstream = httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5), trust_env=False)
        app = op.build_app(settings, store, owner, op.FailureLimiter(), upstream)
        captured: dict = {}

        captured["logins"] = 0

        async def redirect_handler(auth_url: str) -> None:  # plays the owner's browser
            step = int(time.time() // 30) + captured["logins"]  # a fresh TOTP step per login: codes are single-use
            captured["logins"] += 1
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://mcp.test") as browser:
                step1 = await browser.get(auth_url)
                assert step1.status_code == 302, step1.text
                page_url = step1.headers["location"]
                assert "/owner/approve?req=" in page_url, page_url
                assert (await browser.get(page_url)).status_code == 200
                bad = await browser.post("/owner/approve", data={
                    "req": parse_qs(urlparse(page_url).query)["req"][0], "password": "wrong wrong wrong", "code": "000000", "action": "approve"})
                assert bad.status_code == 401, bad.status_code
                good = await browser.post("/owner/approve", data={
                    "req": parse_qs(urlparse(page_url).query)["req"][0], "password": PASSWORD,
                    "code": op.hotp(owner.totp_key, step), "action": "approve"})
                assert good.status_code == 303, good.status_code
                query = parse_qs(urlparse(good.headers["location"]).query)
                captured["code"], captured["state"] = query["code"][0], query.get("state", [None])[0]

        async def callback_handler() -> tuple[str, str | None]:
            return captured["code"], captured["state"]

        storage = MemoryStorage()
        provider = OAuthClientProvider(
            server_url="https://mcp.test/mcp",
            client_metadata=OAuthClientMetadata(
                client_name="e2e-claude", redirect_uris=[AnyUrl(CALLBACK)], grant_types=["authorization_code", "refresh_token"],
                response_types=["code"], scope="mcp", token_endpoint_auth_method="client_secret_post"),
            storage=storage, redirect_handler=redirect_handler, callback_handler=callback_handler)

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://mcp.test", auth=provider,
                                     timeout=30) as http:
            async with streamable_http_client("https://mcp.test/mcp", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    init = await session.initialize()
                    print("initialize ok, server =", init.serverInfo.name)
                    tools = (await session.list_tools()).tools
                    assert len(tools) == 16, len(tools)
                    print("tools through OAuth proxy:", len(tools))

                    result = await session.call_tool("projects", {})  # worker is not running here: must be a tool error, not an auth error
                    assert result.isError, result
                    print("tool call reached the gateway (worker offline -> isError=True, as expected)")

                    # The SDK refreshes proactively once its own expiry clock has passed (a server-side
                    # 401 makes it restart the full authorization instead), so age the client-side clock.
                    first_refresh = storage.tokens.refresh_token
                    provider.context.token_expiry_time = time.time() - 1
                    again = await session.list_tools()
                    assert len(again.tools) == 16
                    assert storage.tokens.refresh_token != first_refresh, "refresh token was not rotated"
                    print("access token aged -> SDK refreshed it transparently, refresh token rotated")

                    # A token the server no longer knows (e.g. after revoke-all) must end in a fresh owner login.
                    assert captured["logins"] == 1
                    store.revoke_everything()
                    assert len((await session.list_tools()).tools) == 16
                    assert captured["logins"] == 2, captured["logins"]
                    print("after revoke-all the old token is useless; client had to log in with the owner again")

        anonymous = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://mcp.test")
        assert (await anonymous.post("/mcp", json={})).status_code == 401
        print("anonymous request rejected with 401")
        print("E2E OK")
    finally:
        gateway.terminate()
        gateway.wait(timeout=10)


if __name__ == "__main__":
    os.chdir(tempfile.gettempdir())
    asyncio.run(main())
