"""Restricted VPS MCP server. Runs on the VPS; no SSH hop is needed."""
import os
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

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
