"""Launch local MCP server and exercise protocol tools without VPS access."""
import asyncio
import os
import pathlib
import subprocess
import sys
import tempfile
import time

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def check():
    with tempfile.TemporaryDirectory() as root:
        pathlib.Path(root, "hello.txt").write_text("hello", encoding="utf-8")
        env = dict(os.environ, MCP_WORKSPACE=root)
        proc = subprocess.Popen([sys.executable, "server.py"], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            error = None
            for attempt in range(35):
                if proc.poll() is not None:
                    raise RuntimeError("MCP server exited early: " + proc.stderr.read().decode(errors="replace"))
                try:
                    async with streamablehttp_client("http://127.0.0.1:8765/mcp") as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            tools = await session.list_tools()
                            names = {tool.name for tool in tools.tools}
                            assert {"list_files", "read_file", "write_file", "git_status", "run_tests"} <= names, names
                            result = await session.call_tool("read_file", {"path": "hello.txt"})
                            assert "hello" in str(result), result
                            result = await session.call_tool("write_file", {"path": "out.txt", "content": "ok"})
                            assert not result.isError, result
                            assert pathlib.Path(root, "out.txt").read_text() == "ok"
                            result = await session.call_tool("read_file", {"path": "../outside"})
                            assert result.isError, "Path traversal must be rejected"
                            print("PASS: initialize, list tools, read, write, path traversal rejection")
                            return
                except (OSError, ConnectionError) as exc:
                    error = exc
                    await asyncio.sleep(0.2)
            raise RuntimeError(f"Server not ready: {error}")
        finally:
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

if __name__ == "__main__":
    asyncio.run(check())
