"""Root-installed MCP protocol gateway. Runs as mcp-gateway, no project write permission."""
import json
import os
import socket
from mcp.server.fastmcp import FastMCP

WORKER_SOCKET = os.environ.get("MCP_WORKER_SOCKET", "/run/vps-mcp/worker.sock")
mcp = FastMCP("vps-operations", host="127.0.0.1", port=8765, stateless_http=True, json_response=True)

def call(method, **args):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(100)
        client.connect(WORKER_SOCKET)
        client.sendall((json.dumps({"method": method, "args": args}, ensure_ascii=False) + "\n").encode())
        with client.makefile("rb") as stream:
            payload = stream.readline(4 * 1024 * 1024 + 1)
    if len(payload) > 4 * 1024 * 1024 or not payload:
        raise RuntimeError("Worker response missing or oversized")
    response = json.loads(payload)
    if not response["ok"]:
        raise RuntimeError(response["error"])
    return response["result"]

@mcp.tool()
def projects() -> dict[str, str]:
    """List the exact repository directories that this MCP instance may develop."""
    return call("projects")

@mcp.tool()
def list_files(path: str = ".") -> list[str]:
    """List project directories. Use 'codespace1' or its absolute path for that project."""
    return call("list_files", path=path)

@mcp.tool()
def read_file(path: str) -> str:
    """Read UTF-8 file inside an allowed repository (up to 1 MiB)."""
    return call("read_file", path=path)

@mcp.tool()
def write_file(path: str, content: str) -> str:
    """Write UTF-8 file inside an allowed repository (up to 1 MiB)."""
    return call("write_file", path=path, content=content)

@mcp.tool()
def mkdir(path: str, parents: bool = False) -> str:
    """Create a directory within a granted repository."""
    return call("mkdir", path=path, parents=parents)

@mcp.tool()
def rename(source: str, target: str) -> str:
    """Rename a file or directory; never overwrite the destination."""
    return call("rename", source=source, target=target)

@mcp.tool()
def remove(path: str) -> str:
    """Remove a file or EMPTY directory in an allowed repository, not a repository itself."""
    return call("remove", path=path)

@mcp.tool()
def git_status(path: str = ".") -> str:
    """Run git status without modifying the repository."""
    return call("git_status", path=path)

@mcp.tool()
def run_tests(path: str = ".", test_command: str = "pytest") -> str:
    """Run a conventional test command (pytest, unittest, ctest) in the sandbox."""
    cmds = {"pytest": "python3 -m pytest -q", "unittest": "python3 -m unittest discover", "ctest": "ctest --output-on-failure"}
    if test_command not in cmds:
        raise ValueError("Unsupported test command")
    return call("run_shell", command=cmds[test_command], path=path, timeout_seconds=90)

@mcp.tool()
def run_shell(command: str, path: str = ".", timeout_seconds: int = 30) -> str:
    """Arbitrary Bash development command inside an OS sandbox, 1-90 second deadline.

    Initial cwd must be an approved repository. Filesystem access is limited by
    systemd mount permissions; this is NOT a shell command regex gate. Commands
    do not have sudo/root. For tasks longer than 90 seconds, use start_job.
    """
    return call("run_shell", command=command, path=path, timeout_seconds=timeout_seconds)

@mcp.tool()
def start_job(command: str, path: str = ".") -> dict:
    """Start a bounded, long-running development job. Return job ID for follow-up."""
    return call("start_job", command=command, path=path)

@mcp.tool()
def job_status(job_id: str) -> dict:
    """Read process status and recent output for development job."""
    return call("job_status", job_id=job_id)

@mcp.tool()
def read_job_log(job_id: str, offset: int = 0, max_bytes: int = 32768) -> dict:
    """Page through complete background-job output with byte offsets; max 64 KiB per call."""
    return call("read_job_log", job_id=job_id, offset=offset, max_bytes=max_bytes)

@mcp.tool()
def stop_job(job_id: str) -> dict:
    """Stop a development job; never affects gateway, tunnel or other services."""
    return call("stop_job", job_id=job_id)

APPROVAL_SOCKET = "/run/vps-mcp-approval/request.sock"

def approval_call(method, **kwargs):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(45)
        client.connect(APPROVAL_SOCKET)
        client.sendall((json.dumps({"method": method, **kwargs}) + "\n").encode())
        data = client.makefile("rb").readline(16385)
    if not data or len(data) > 16384:
        raise RuntimeError("Approval service unavailable")
    response = json.loads(data)
    if not response["ok"]:
        raise RuntimeError(response["error"])
    return response["result"]

@mcp.tool()
def request_protected(operation: str, unit: str) -> dict:
    """Request approval to restart an EXACT owner-allowlisted non-MCP service.

    Does not execute anything. The owner must approve independently via authenticated
    web or root-only CLI. No MCP service or tunnel may ever be targeted.
    """
    if operation != "restart_service":
        raise ValueError("Unsupported protected operation")
    return approval_call("request", operation=operation, params={"unit": unit})

@mcp.tool()
def execute_protected(request_id: str, key: str) -> dict:
    """Execute the previously approved EXACT protected operation once.

    Key is issued through the owner's separate approval UI or SSH; AI messages
    without a valid key are NOT authorization. Key consumed before execution.
    """
    return approval_call("execute", request_id=request_id, key=key)

from mailbox_core.tools import register as register_session_mailbox

stop_mailbox_waiters = register_session_mailbox(mcp)

if __name__ == "__main__":
    from mailbox_core.http_runtime import run_http
    run_http(mcp, stop_mailbox_waiters)
