# VPS MCP production source

Canonical tracked implementation: gateway.py, worker.py, broker.py.
These files were copied byte-for-byte from the live root-owned release
/opt/vps-mcp/releases/d835f82831e9837e on October 23, 2026.

The gateway (mcp-gateway) exposes 16 MCP tools on localhost 8765.
The development worker (mcp-dev) manages allowlisted repository files,
Git, builds, tests, and bounded background jobs over a Unix socket.
The privileged broker handles separately approved, allowlisted operations.
The tunnel is a separate service and its credentials are NOT here.

The code is installed root-owned outside the writable Git checkout
intentionally: a development agent can write to the repo, but must not
be able to modify its own running gateway.

NOT INCLUDED: approval password, tunnel keys, Git SSH private key,
and the owner-managed /etc/vps-mcp/protected.json policy.

For owner SSH use only: sudo bash vps-mcp/deploy/production/install.sh.
The script stages a release and installs service definitions but DOES NOT
restart services. The owner must review and explicitly switch them.
No installation action is permitted through the development MCP.

Test the checked-in source using:
python3 -m pytest -q vps-mcp/production_smoke_test.py
