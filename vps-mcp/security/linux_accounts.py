"""Unix account executors for a *separate trusted supervisor* (NOT live MCP).

This module has no user-facing MCP entrypoint. Privileged actions must be
authorized by an independent approval service before reaching it.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import select
import signal
import subprocess
import time

RUNUSER = "/usr/sbin/runuser"
SHELL_ACCOUNT = "mcp-shell"
READ_ACCOUNT = "mcp-read"
OPS_ACCOUNT = "mcp-ops"
MAX_COMMAND_BYTES = 8192
MAX_OUTPUT_BYTES = 65536
MAX_OUTPUT_PRODUCED = 1048576
MAX_TIMEOUT_SECONDS = 90

# A root-owned supervisor decides the action ID. These are NOT shell templates.
OPS_ACTIONS: dict[str, tuple[str, ...]] = {
    "restart-combat-web": (
        "/usr/bin/sudo", "-n", "/usr/bin/systemctl", "restart", "combat-web.service"
    ),
}


@dataclass(frozen=True)
class ExecResult:
    exit_code: int
    stdout: str
    timed_out: bool = False
    output_limited: bool = False
    truncated: bool = False

    def as_tool_text(self) -> str:
        return (f"exit={self.exit_code} timed_out={str(self.timed_out).lower()} "
                f"output_limited={str(self.output_limited).lower()} "
                f"truncated={str(self.truncated).lower()}\\n{self.stdout}")


def _check_timeout(timeout_seconds: int) -> None:
    if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= MAX_TIMEOUT_SECONDS:
        raise ValueError("timeout_seconds must be integer in range 1..90")


def _check_command(command: str) -> None:
    if not isinstance(command, str) or not command.strip() or chr(0) in command:
        raise ValueError("invalid shell command")
    if len(command.encode("utf-8")) > MAX_COMMAND_BYTES:
        raise ValueError("shell command exceeds 8192 bytes")


def _run_as_account(
    *, account: str, argv: tuple[str, ...], cwd: Path,
    timeout_seconds: int, _popen=subprocess.Popen,
) -> ExecResult:
    """Switch uid for an explicit argv. Only callable by the trusted supervisor."""
    _check_timeout(timeout_seconds)
    if os.geteuid() != 0:
        raise PermissionError("Linux account executor requires root supervisor")
    if account not in (READ_ACCOUNT, SHELL_ACCOUNT, OPS_ACCOUNT):
        raise PermissionError("unknown execution account")
    if not cwd.is_dir():
        raise ValueError("missing working directory")
    if not argv or any(not isinstance(arg, str) or not arg or chr(0) in arg for arg in argv):
        raise ValueError("invalid process argv")
    proc = _popen(
        (RUNUSER, "-u", account, "--", *argv),
        cwd=str(cwd),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        close_fds=True,
        start_new_session=True,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
    output = b""
    produced = 0
    timed_out = False
    limited = False
    deadline = time.monotonic() + timeout_seconds
    try:
        assert proc.stdout is not None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            readable, _, _ = select.select([proc.stdout], [], [], min(remaining, 0.5))
            if not readable:
                continue
            chunk = os.read(proc.stdout.fileno(), 8192)
            if not chunk:
                break
            produced += len(chunk)
            output = (output + chunk)[-MAX_OUTPUT_BYTES:]
            if produced > MAX_OUTPUT_PRODUCED:
                limited = True
                break
    finally:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        proc.wait(timeout=5)
        if proc.stdout is not None:
            proc.stdout.close()

    return ExecResult(
        proc.returncode, output.decode("utf-8", errors="replace"),
        timed_out, limited, produced > len(output)
    )


def basic_shell(command: str, *, cwd: str, timeout_seconds: int = 30) -> ExecResult:
    """Run untrusted Bash only as mcp-shell, never as root or mcp-ops."""
    _check_command(command)
    directory = Path(cwd).resolve(strict=True)
    # Only an initial-cwd check. OS ownership/ACLs must protect sensitive files.
    roots = (Path("/srv/mcp-workspaces"), Path("/home/thieuhua/code"))
    if not any(directory.is_relative_to(root) for root in roots):
        raise ValueError("cwd outside configured workspace roots")
    return _run_as_account(
        account=SHELL_ACCOUNT,
        argv=("/bin/bash", "--noprofile", "--norc", "-c", command),
        cwd=directory, timeout_seconds=timeout_seconds,
    )


def run_operator_action(action_id: str, *, timeout_seconds: int = 30) -> ExecResult:
    """Trusted broker ONLY; a verified one-use key must already be consumed.

    Never expose as an MCP tool or let model input select this action ID.
    No generic privileged Bash is provided.
    """
    if action_id not in OPS_ACTIONS:
        raise PermissionError("privileged action not allowlisted")
    return _run_as_account(
        account=OPS_ACCOUNT, argv=OPS_ACTIONS[action_id],
        cwd=Path("/"), timeout_seconds=timeout_seconds,
    )
