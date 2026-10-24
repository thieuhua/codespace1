# VPS MCP — production gateway

This repository contains the current **16-tool**, three-process VPS MCP implementation. Source files `gateway.py`, `worker.py` and `broker.py` were copied byte-for-byte from the root-owned live release when initially committed. The old single-process `server.py` and disconnected security prototypes have been retired.

## Architecture

- `gateway.py` — MCP Streamable HTTP endpoint on `127.0.0.1:8765`, runs as `mcp-gateway` and forwards development requests over a Unix socket.
- `worker.py` — allowlisted repository file operations, Git, shell, tests and bounded jobs, runs as `mcp-dev`.
- `broker.py` — root-owned approval broker for exact owner-allowlisted non-MCP service operations. Owner approval occurs outside MCP.
- `vps-mcp-tunnel.service` is separately managed. Neither tunnel credentials nor owner secrets belong in Git.

The application exposes repository discovery, file CRUD, Git status, shell/test execution, background jobs and protected-operation requests. Development MCP access **cannot deploy or restart its own production gateway**. Running code is installed under `/opt/vps-mcp/releases`, owned by root and separate from writable source.

## Layout

- `oauth/` — OAuth 2.1 front door (password + TOTP owner approval) so Claude custom connectors can reach the gateway over HTTPS; separate service, gateway untouched. See [oauth/README.md](oauth/README.md).
- `deploy/production/` — systemd units and owner-SSH staging installer.
- `production_smoke_test.py` — basic source, unit and deployed-release consistency checks.
- `PRODUCTION.md` — environment-specific deployment notes, secret boundary and source provenance.

## Test

```bash
python3 -m unittest -v vps-mcp/production_smoke_test.py
python3 -m compileall -q vps-mcp/gateway.py vps-mcp/worker.py vps-mcp/broker.py
(cd vps-mcp/oauth && pip install -r requirements.txt && python -m unittest -v test_oauth_proxy && PYTHONPATH=. python e2e_check.py)
bash -n vps-mcp/deploy/production/install.sh
```

On CI or a new checkout with no matching live release, the consistency check validates checked-in sources. On the VPS, it also compares each source with the currently installed live release.

## Deploy

Production installs require **independent owner SSH**, not this MCP's development tools:

```bash
sudo bash vps-mcp/deploy/production/install.sh
```

This prepares an immutable release and systemd unit definitions; it **does not restart any services**. The owner controls activation separately. Service accounts, root-owned policy and approval secrets must already exist. Do not commit SSH keys, tunnel tokens or approval credentials.
