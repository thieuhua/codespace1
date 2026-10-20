"""Launch local MCP server and exercise protocol tools without VPS access."""
import asyncio
import os
import pathlib
import socket
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
            # Wait for the TCP listener before opening an MCP session.
            # The MCP client raises an ExceptionGroup on connection failure,
            # which is not caught by a plain OSError handler.
            for attempt in range(50):
                if proc.poll() is not None:
                    raise RuntimeError("MCP server exited early: " + proc.stderr.read().decode(errors="replace"))
                try:
                    with socket.create_connection(("127.0.0.1", 8765), timeout=0.2):
                        break
                except OSError:
                    await asyncio.sleep(0.2)
            else:
                raise RuntimeError("MCP server did not listen within 10 seconds")
            async with streamablehttp_client("http://127.0.0.1:8765/mcp") as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    names = {tool.name for tool in tools.tools}
                    assert {"list_files", "read_file", "write_file", "git_status", "run_tests", "run_shell"} <= names, names
                    result = await session.call_tool("read_file", {"path": "hello.txt"})
                    assert "hello" in str(result), result
                    result = await session.call_tool("write_file", {"path": "out.txt", "content": "ok"})
                    assert not result.isError, result
                    assert pathlib.Path(root, "out.txt").read_text() == "ok"
                    result = await session.call_tool("read_file", {"path": "../outside"})
                    assert result.isError, "Path traversal must be rejected"
                    result = await session.call_tool("run_shell", {"command": "printf 'shell-ok\\n'; pwd"})
                    assert not result.isError and "shell-ok" in str(result), result
                    assert root in str(result) and "exit=0" in str(result), result
                    result = await session.call_tool("run_shell", {"command": "exit 7"})
                    assert not result.isError and "exit=7" in str(result), result
                    result = await session.call_tool("run_shell", {"command": "printf nope", "path": "../outside"})
                    assert result.isError, "Shell cwd traversal must be rejected"
                    result = await session.call_tool("run_shell", {"command": "echo nope", "timeout_seconds": 91})
                    assert result.isError, "Shell timeout cap must be enforced"
                    result = await session.call_tool("run_shell", {"command": "sleep 5", "timeout_seconds": 1})
                    assert not result.isError and "timed_out=true" in str(result), result
                    result = await session.call_tool("run_shell", {"command": "printf '%70000s' x"})
                    assert not result.isError and "truncated=true" in str(result), result
                    print("PASS: initialize, list tools, read, write, traversal rejection, shell exit, timeout and output cap")
        finally:
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

if __name__ == "__main__":
    asyncio.run(check())
