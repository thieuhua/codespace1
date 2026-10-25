"""Same loopback stateless MCP transport with prompt polling shutdown."""
import uvicorn


class GatewayHTTPServer(uvicorn.Server):
    def __init__(self, config, *, before_shutdown=lambda: None):
        super().__init__(config)
        self.before_shutdown = before_shutdown

    async def shutdown(self, sockets=None):
        # Uvicorn drains HTTP requests before ASGI lifespan shutdown, so notify
        # long polls here rather than in the later lifespan teardown.
        self.before_shutdown()
        await super().shutdown(sockets=sockets)


def run_http(mcp, stop_waiters):
    config = uvicorn.Config(mcp.streamable_http_app(), host=mcp.settings.host,
                            port=mcp.settings.port, log_level=mcp.settings.log_level.lower())
    GatewayHTTPServer(config, before_shutdown=stop_waiters).run()
