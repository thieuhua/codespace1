"""Real local admin and SDK/stdio fixtures; all state lives in a temp directory."""
from contextlib import asynccontextmanager
import asyncio
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from agent_mailbox.admin import initialize, run
from agent_mailbox.__main__ import parser


def run_async(coroutine):
    # MCP SDK's supported Windows fallback uses real Popen pipes and reader
    # threads when SelectorEventLoop has no async subprocess support. Unlike
    # Proactor named pipes, these work under Windows restricted sandbox tokens.
    factory = asyncio.SelectorEventLoop if os.name == "nt" else asyncio.new_event_loop
    with asyncio.Runner(loop_factory=factory) as runner:
        return runner.run(coroutine)


def admin(home, *arguments):
    args = parser().parse_args(["--state-dir", str(home), "admin", *arguments])
    return run(args, home)


def provision(home):
    database = initialize(home)
    for pid in ("A", "B", "C"):
        admin(home, "add-principal", pid)
    shared = admin(home, "create-shared-session", "--owner", "A", "--participant", "B")
    return database, shared["session"]["session_id"], shared["mailbox"]["mailbox_id"]


@asynccontextmanager
async def client(home, token_file=None, *, token=None):
    # Explicit empty variables prevent inheritance of any operator credentials.
    env = {"AGENT_MAILBOX_HOME": str(home), "AGENT_MAILBOX_TOKEN_FILE": "",
           "AGENT_MAILBOX_TOKEN": "", "PYTHONUTF8": "1"}
    args = ["-I", "-m", "agent_mailbox", "--state-dir", str(home), "serve"]
    if token_file is not None:
        args.extend(["--token-file", str(token_file)])
    elif token is not None:
        env.pop("AGENT_MAILBOX_TOKEN_FILE")
        env["AGENT_MAILBOX_TOKEN"] = token
    params = StdioServerParameters(command=sys.executable, args=args, env=env, cwd=str(home.parent))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def call(case, session, tool, args=None, error=None):
    result = await session.call_tool(tool, args or {})
    data = result.structuredContent
    case.assertIsNotNone(data, result)
    case.assertEqual(json.loads(result.content[0].text), data)
    case.assertEqual(data["schema_version"], 1)
    if error:
        case.assertTrue(result.isError, result)
        case.assertEqual(data["error"]["code"], error)
    else:
        case.assertFalse(result.isError, result)
    return data
