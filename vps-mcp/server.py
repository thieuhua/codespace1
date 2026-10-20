"""Restricted VPS MCP server. Runs on the VPS; no SSH hop is needed."""
import hashlib
import logging
import os
import select
import signal
import time
import pathlib
import subprocess
from mcp.server.fastmcp import FastMCP

ROOT = pathlib.Path(os.environ.get("MCP_WORKSPACE", "/home/thieuhua/code")).resolve(strict=True)
MAX_BYTES = 256_000
mcp = FastMCP("vps-operations", host="127.0.0.1", port=8765, stateless_http=True, json_response=True)

def inside(path: str) -> pathlib.Path:
    p = (ROOT / path).resolve()
    if not p.is_relative_to(ROOT):
        raise ValueError("Path outside MCP_WORKSPACE")
    return p

@mcp.tool()
def list_files(path: str = ".") -> list[str]:
    """List workspace directory entries."""
    p = inside(path)
    if not p.is_dir():
        raise ValueError("Not a directory")
    return sorted(x.name + ("/" if x.is_dir() else "") for x in p.iterdir())[:300]

@mcp.tool()
def read_file(path: str) -> str:
    """Read a UTF-8 text file under the workspace."""
    p = inside(path)
    if not p.is_file() or p.stat().st_size > MAX_BYTES:
        raise ValueError("Missing file or too large")
    return p.read_text(encoding="utf-8")

@mcp.tool()
def write_file(path: str, content: str) -> str:
    """Write UTF-8 text in the workspace (existing files or new files)."""
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise ValueError("Content too large")
    p = inside(path)
    if not p.parent.is_dir():
        raise ValueError("Parent directory must exist")
    p.write_text(content, encoding="utf-8")
    return str(p.relative_to(ROOT))

@mcp.tool()
def git_status(path: str = ".") -> str:
    """Return git status for a workspace repository."""
    p = inside(path)
    r = subprocess.run(["git", "-C", str(p), "status", "--short", "--branch"],
                       capture_output=True, text=True, timeout=15, check=False)
    return (r.stdout + r.stderr)[:12000]

@mcp.tool()
def run_tests(path: str = ".", test_command: str = "pytest") -> str:
    """Run one of a small set of test commands; no arbitrary shell."""
    allowed = {"pytest": ["python3", "-m", "pytest", "-q"],
               "ctest": ["ctest", "--output-on-failure"],
               "unittest": ["python3", "-m", "unittest", "discover"]}
    if test_command not in allowed:
        raise ValueError("Unsupported test command")
    p = inside(path)
    r = subprocess.run(allowed[test_command], cwd=p, capture_output=True,
                       text=True, timeout=120, check=False)
    return f"exit={r.returncode}\n" + (r.stdout + r.stderr)[-16000:]


MAX_SHELL_COMMAND_BYTES = 8192
MAX_SHELL_OUTPUT_BYTES = 65536
MAX_SHELL_TOTAL_OUTPUT_BYTES = 1048576
MAX_SHELL_TIMEOUT_SECONDS = 90
logger = logging.getLogger("vps_mcp.shell")


@mcp.tool()
def run_shell(command: str, path: str = ".", timeout_seconds: int = 30) -> str:
    """Run a non-interactive Bash command on the VPS as the unprivileged service user.

    The working directory must be inside MCP_WORKSPACE. Commands themselves
    are NOT confined to that directory: systemd permissions are the security
    boundary. No sudo/root, interactive input, or persistent sessions.
    Timeout: 1..90 seconds; output: last 64 KiB, hard cap 1 MiB.
    """
    if not isinstance(command, str) or not command.strip():
        raise ValueError("Command must not be empty")
    if "\x00" in command or len(command.encode("utf-8")) > MAX_SHELL_COMMAND_BYTES:
        raise ValueError("Invalid or oversized command")
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) or not 1 <= timeout_seconds <= MAX_SHELL_TIMEOUT_SECONDS:
        raise ValueError("timeout_seconds must be an integer between 1 and 90")

    directory = inside(path)
    if not directory.is_dir():
        raise ValueError("Working directory does not exist")
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(ROOT),
        "LANG": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
    }
    fingerprint = hashlib.sha256(command.encode("utf-8")).hexdigest()[:16]
    logger.info("shell start cwd=%s command_sha256_prefix=%s", directory, fingerprint)
    process = subprocess.Popen(
        ["/bin/bash", "--noprofile", "--norc", "-c", command],
        cwd=directory,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    tail = b""
    total = 0
    timed_out = False
    output_limit_hit = False
    deadline = time.monotonic() + timeout_seconds
    try:
        assert process.stdout is not None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            ready, _, _ = select.select([process.stdout], [], [], min(remaining, 0.5))
            if not ready:
                continue
            chunk = os.read(process.stdout.fileno(), 8192)
            if not chunk:
                break
            total += len(chunk)
            tail = (tail + chunk)[-MAX_SHELL_OUTPUT_BYTES:]
            if total > MAX_SHELL_TOTAL_OUTPUT_BYTES:
                output_limit_hit = True
                break
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=5)
        if process.stdout is not None:
            process.stdout.close()

    exit_code = process.returncode
    truncated = total > len(tail)
    logger.info(
        "shell end cwd=%s command_sha256_prefix=%s exit=%s timed_out=%s output_limited=%s",
        directory, fingerprint, exit_code, timed_out, output_limit_hit,
    )
    header = f"exit={exit_code} timed_out={str(timed_out).lower()} output_limited={str(output_limit_hit).lower()} truncated={str(truncated).lower()}\n"
    return header + tail.decode("utf-8", errors="replace")


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
