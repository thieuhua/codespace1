# VPS MCP Server

Runs **on Debian 12 VPS**, not in Codespaces. Codespace is only a source-code editor. This initial implementation exposes bounded file operations, git status and a test runner under one workspace; it deliberately does **not** expose arbitrary shell execution or root access.

## Setup on VPS

Prerequisites: Python 3.11+, a non-root account, a checkout of this repository, and a workspace directory owned by the service user.

```bash
cd ~/code/codespace1/vps-mcp
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
MCP_WORKSPACE=/home/thieuhua/code .venv/bin/python server.py
```

The server binds to `127.0.0.1:8765` and uses the Streamable HTTP endpoint `/mcp`. It is **not externally accessible** until a reverse proxy is configured.

## Secure exposure

Use an existing HTTPS domain with a dedicated route, e.g. `https://mcp.example.com/mcp`. Terminate TLS at Nginx and enforce authentication **before** forwarding to `http://127.0.0.1:8765`. Use an identity-aware proxy or OAuth-compatible MCP gateway; do not publish this service with no authentication. Restrict incoming traffic, apply rate limits, and do not log credentials.

A plain bearer token checked only by an arbitrary reverse-proxy header is not sufficient unless the proxy actually validates that token. Register the HTTPS URL in ChatGPT as a custom MCP app only after authentication is configured and the product supports the chosen auth scheme. ChatGPT cannot connect simply because this repository exists.

## Deployment

Copy `deploy/vps-mcp.service` to `/etc/systemd/system/vps-mcp.service`, update paths and account as necessary, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vps-mcp
sudo systemctl status vps-mcp
```

Never put secrets in Git, and never run the service as root. Keep the workspace limited to intended projects. The workspace is writable; back up valuable files and review changes before enabling writes for external clients.

## Notes

The initial MCP tools are `list_files`, `read_file`, `write_file`, `git_status`, `run_tests`. The server is **not yet deployed** and no public URL or ChatGPT app connection has been established.
