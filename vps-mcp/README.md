# VPS MCP Gateway

## Permission-system design (not yet deployed)

The proposed hybrid approval and immutable MCP self-protection architecture is described in [ADR-001](docs/ADR-001-hybrid-approval.md). This branch contains a **standalone, unconnected** one-use approval token core and unit tests. It does not change the live `run_shell`, enforce policy on the VPS, or grant privileged access.

The MCP server runs on the **Debian 12 VPS**, not GitHub Codespaces. Codespace is used only to edit and test code. The server is connected to ChatGPT through the OpenAI Secure MCP Tunnel, which runs separately as `vps-mcp-tunnel.service`.

## Tools

- `list_files`, `read_file`, `write_file`: UTF-8 files in `MCP_WORKSPACE`.
- `git_status`: Git status in a workspace repository.
- `run_tests`: limited preset test commands.
- `run_shell(command, path=".", timeout_seconds=30)`: non-interactive Bash command executed on the VPS **as the unprivileged `thieuhua` service user**, not root.

The shell tool allows arbitrary Bash syntax and commands. Its **initial working directory** must be under `MCP_WORKSPACE`; a shell command can still change directories and access files that the systemd service is permitted to access. Do not mistake cwd validation for filesystem confinement.

Shell limits: command size at most 8 KiB, timeout 1–90 seconds, combined output retains the last 64 KiB, process group killed on timeout or after 1 MiB generated output, stdin disabled, no interactive TTY. The execution environment is minimized; shell commands are not recorded verbatim in system logs (a short SHA-256 fingerprint is recorded instead).

## Security

The systemd unit uses `User=thieuhua`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only` and restricts writable paths to `/home/thieuhua/code`. It masks the directories containing the tunnel runtime API key (`~/.config/vps-mcp`) and SSH private keys (`~/.ssh`). **This is not a general-purpose security sandbox**; shell execution is powerful. Use ChatGPT's permission prompts to review sensitive actions. Do not expose the local MCP endpoint directly to the Internet.

Other services (Combat Simulator, Nginx, WireGuard, OpenAI Tunnel) should remain unchanged. `run_shell` cannot elevate to root automatically.

## First-time setup

Prerequisites: Python 3.11+, a non-root user, and a checkout of this repository.

```bash
cd ~/code/codespace1/vps-mcp
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
MCP_WORKSPACE=/home/thieuhua/code .venv/bin/python server.py
```

The Streamable HTTP endpoint is `http://127.0.0.1:8765/mcp`. The OpenAI tunnel client forwards traffic from ChatGPT to this endpoint. No inbound public port is needed.

## Updating an existing VPS installation

From an SSH session as `thieuhua`:

```bash
cd ~/code/codespace1
git fetch origin feat/vps-mcp-gateway
git switch --detach origin/feat/vps-mcp-gateway
cd vps-mcp
.venv/bin/pip install -r requirements.txt
sudo install -m 644 deploy/vps-mcp.service /etc/systemd/system/vps-mcp.service
sudo systemctl daemon-reload
sudo systemctl restart vps-mcp
sudo systemctl is-active vps-mcp
```

**Note:** an existing ignored/untracked `.venv` is retained. If the checkout has local tracked changes, back them up and reconcile them first instead of overwriting. Updating the MCP server does not require restarting `vps-mcp-tunnel`. The ChatGPT plugin may need a refresh to discover the new tool.

## Testing

```bash
cd vps-mcp
.venv/bin/python smoke_test.py
```

GitHub Actions runs the same protocol smoke test when this project changes. The test checks startup, MCP tool listing, read/write, path traversal rejection, shell exit codes, timeout enforcement, and output truncation.

## Scope

Code is developed in `thieuhua/codespace1`, branch `feat/vps-mcp-gateway`. Deploy only after GitHub Actions passes. Shell calls execute as the service user with systemd restrictions; additional host-level access would require separate, explicit authorization.
