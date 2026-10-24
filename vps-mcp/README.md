# VPS MCP — production gateway

This repository contains the three-process VPS MCP implementation, based on the
16-tool production source at `b4b3f1e`, plus 13 optional Session/Mailbox tools.
**The default gateway advertises exactly 16 tools.** The 13 new tools are not
registered until services are explicitly injected, yielding 29 tools after
activation. There is no trusted runtime identity/private-state adapter. The existing 16 tool
implementations, worker, broker, service units and approval semantics are preserved.
The old single-process server and security prototypes remain retired.

## Architecture

- `gateway.py` — MCP Streamable HTTP endpoint on `127.0.0.1:8765`, runs as `mcp-gateway` and forwards development requests over a Unix socket.
- `worker.py` — allowlisted repository file operations, Git, shell, tests and bounded jobs, runs as `mcp-dev`.
- `broker.py` — root-owned approval broker for exact owner-allowlisted non-MCP service operations. Owner approval occurs outside MCP.
- `mailbox_core/` — separate application sessions, SQLite WAL mailboxes, ACLs,
  quotas and bounded polling. This package does not shadow `gateway.py`.
- `vps-mcp-tunnel.service` is separately managed. Neither tunnel credentials nor owner secrets belong in Git.

The application exposes repository discovery, file CRUD, Git status, shell/test execution, background jobs and protected-operation requests. Development MCP access **cannot deploy or restart its own production gateway**. Running code is installed under `/opt/vps-mcp/releases`, owned by root and separate from writable source.

## Layout

- `oauth/` — OAuth 2.1 front door (password + TOTP owner approval) so Claude custom connectors can reach the gateway over HTTPS; separate service, gateway untouched. See [oauth/README.md](oauth/README.md).
- `deploy/production/` — systemd units and owner-SSH staging installer.
- `production_smoke_test.py` — basic source, unit and deployed-release consistency checks.
- `PRODUCTION.md` — environment-specific deployment notes, secret boundary and source provenance.
- [Core](mailbox_core/README.md), [tests](tests/README.md),
  [API/workflow](docs/MAILBOX_API.md), [port report](docs/MAILBOX_MAINLINE_PORT_REPORT.md).

## Local setup and isolated run

Python 3.11 is the tested runtime. Create dependencies inside this project:

```bash
cd vps-mcp
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest -v tests.test_protocol tests.test_production_contract
```

On Windows use `py -3.11` and `.venv/Scripts/python.exe`. These tests load the
actual gateway on owned ephemeral ports, mock privileged IPC, and inject known
identities only in process with temporary databases. Do not run `gateway.py`
locally against production sockets. Its runtime entrypoint remains loopback
`127.0.0.1:8765`, stateless Streamable HTTP with JSON responses.

## Test

```bash
cd vps-mcp
.venv/bin/python -m unittest -v production_smoke_test.py
.venv/bin/python -m unittest discover -v
.venv/bin/python -m compileall -q gateway.py worker.py broker.py mailbox_core tests oauth production_smoke_test.py deploy/production/release_manifest.py
bash -n deploy/production/install.sh
.venv/bin/python -m pip install -r oauth/requirements.txt
(cd oauth && ../.venv/bin/python -m unittest -v test_oauth_proxy && ../.venv/bin/python e2e_check.py)
for f in oauth/deploy/*.sh; do bash -n "$f"; done
```

On Windows substitute `.venv/Scripts/python.exe` (or `../.venv/Scripts/python.exe`
inside `oauth`) and use Git Bash for syntax checks. OAuth E2E owns an ephemeral
gateway port and mocks privileged IPC; it does not contact port 8765 or live sockets.

Default verification reads checked-in sources only, including original function
ASTs and canonical Git-content hashes (checkout CRLF is normalized). It never
probes a live installation. An explicit release-directory/manifest mode retains
exact byte integrity checks for an owner-selected recorded release; see PRODUCTION.md.
Windows skips seven real POSIX IPC/process/broker tests; Ubuntu and unprivileged
Debian 12 CI execute them. No local WSL, Docker, root or production credentials
are required. The stress child enforces a 1 GiB memory limit.

## Deploy

This port is source integration only; nothing is installed or restarted on the
VPS. Future production staging requires independent owner SSH and a separate
review. The installer source now hashes/copies the required `mailbox_core`
modules and SQL migration, while preserving root ownership and existing units.
It does not provision mailbox identity/state or activate the feature.
The owner must first verify provider authentication and OS confinement, choose
private state inaccessible to `mcp-dev`, and review a runtime adapter. Details
and backup/rollback requirements are in [PRODUCTION.md](PRODUCTION.md).
