# Production provenance and boundaries

The canonical implementation is `gateway.py`, `worker.py`, and `broker.py`. It was copied byte-for-byte from `/opt/vps-mcp/releases/d835f82831e9837e` and introduced in commit `b3f7ef1`. The production process may continue using that release until the owner explicitly updates it.

- Gateway: `mcp-gateway`, port `127.0.0.1:8765`.
- Development worker: `mcp-dev`, allowlisted repository directories; socket `/run/vps-mcp/worker.sock`.
- Root-owned approval broker: operations and units restricted by independently owned `/etc/vps-mcp/protected.json`.
- Separate existing tunnel: managed outside this project's deployment script.

`mcp-dev` has its own GitHub deploy key and development repository write permission. The gateway, privileged policy, SSH identities, approval password, tunnel credentials and production systemd units are not writable from the development MCP.

**Never commit** the Git private key, approval password, tunnel credentials or contents of `/etc/vps-mcp/protected.json`. The owner-SSH installer `deploy/production/install.sh` stages code and systemd definitions without restarting anything. Review and activate production separately. For verification, run `python3 -m unittest -v vps-mcp/production_smoke_test.py`.
