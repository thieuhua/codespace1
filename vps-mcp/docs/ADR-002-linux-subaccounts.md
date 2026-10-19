# ADR-002: Multi-account execution (replaces a general-purpose privileged shell)

**Status: prototype only. Not activated on the VPS.**

Owner-approved design: MCP infrastructure may have the ability to launch high-privilege operations, but assistant-supplied shell **always** runs under a restricted Linux account. Any privileged action must be approved by the human owner and bound to one exact operation with a short-lived, one-use key. There is no user-approvable action that edits or restarts the MCP itself.

## The Linux principals

| Identity | Responsibility | Authority |
| --- | --- | --- |
| `mcp-read` | Read-only tools | Only permitted source/log reads |
| `mcp-shell` | Ordinary Bash, builds and tests | Writable development worktrees; NO sudo |
| `mcp-ops` | Approved operator actions | Only root-owned, exact-argv sudoers actions for named non-MCP services |
| Trusted supervisor | Authenticate/route subprocesses | Execute fixed `runuser -u <account> -- <argv>`; keep protected approval DB |
| Human owner (`thieuhua` via independent SSH) | Manual deployment of the MCP itself | Never delegated through MCP |

A trustworthy implementation should use **two processes**: an unprivileged MCP frontend with no access to the approval DB or secrets, and a separate root-owned supervisor with a small, typed IPC interface. The supervisor must never accept a `bash -c` command for `mcp-ops`; it may spawn arbitrary Bash only under `mcp-shell`. The initial `security/linux_accounts.py` prototype defines these launcher primitives but is deliberately disconnected from `server.py`.

The supervisor and policy are root-owned and never placed in any agent-writable worktree. A high-privilege service launched directly from `/home/thieuhua/code/codespace1` is not an acceptable final configuration.

## Resource boundaries

- Live MCP service code, its systemd unit and drop-ins, tunnel service, approval DB, key files, broker, policy and their controlling helper programs: **immutable DENY** for every assistant-triggered operation.
- Development repository source and build output: **ALLOW** when located in a writable project worktree assigned to `mcp-shell`, not in the live MCP installation tree.
- Other projects' production configs (Nginx site, systemd unit, environment files, deployment scripts): **ASK**, with **specific allowlisted operations** rather than arbitrary Bash and broad filesystem writes.
- Restart `combat-web.service`: illustrative **ASK**, must match exact service identity and run only after approval. Unknown services are DENY until added to a reviewed root-owned allowlist.
- Operation keys are bound to exact principal, command, service target, working directory and timeouts. One-time redemption must occur inside the trusted supervisor.

**Important limitation:** Bash command strings are not a reliable security boundary; a command can use child processes, redirections, Python, symlinks or its own scripts. `mcp-shell` must **not** be able to write protected configuration or MCP installation paths at the Unix filesystem level, even if the command dispatcher misclassifies input. Never grant `mcp-shell` sudo or member of `sudo`; prevent permission to signal the protected daemon via UID separation and systemd controls.

## Approval UX

1. Assistant calls `run_shell(command, key="")`.
2. A command mapped to a supported `mcp-ops` action returns `APPROVAL_REQUIRED` and a request ID. **No execution**.
3. If trusted ChatGPT elicitation can independently attest a human approval, broker may accept it. Otherwise a separate authenticated approval page is mandatory.
4. Owner approves the exact command, scope and effect. Broker issues one-use key; the assistant supplies it only on retry.
5. Broker validates key, exact requested action, immutable DENY policy and identity, consumes key atomically, and invokes the fixed-argv action as `mcp-ops`.

The existing `security/approval_core.py` is an **isolated** one-use-key store and does not prove user authentication or policy enforcement. A ChatGPT-generated token, model-provided `approved=true`, or unsecured approval URL does **not** authorize any operation.

## Minimal system policy sketch (not an installation script)

```text
mcp-shell: no login password, no sudo, owns only /srv/mcp-workspaces/** (selected worktrees)
mcp-read:  no login password, no sudo, read-only mounts / ACLs
mcp-ops:   no login password, narrow sudoers for exact /usr/bin/systemctl restart combat-web.service
MCP live:  owned root:root, never writable/executable under user-managed build output
broker:    owner root:root; no arbitrary shell API; approval DB private to broker
```

Before activation, inspect all symlinks, existing service files, ExecStart/ExecStartPre programs, writable paths, sudoers matching and ACLs on this particular VPS. A permission grant for `combat-web` must not be able to modify or restart `vps-mcp` indirectly. Verify that neither developer nor operator accounts can affect any protected MCP process or configuration.

## Testing and rollout gate

- Python unit tests exercise argument routing and deny unknown operator commands without touching a host.
- Next: disposable Debian 12 VM/systemd integration tests for user creation, sudoers exact argv, filesystem ACL, process signaling and indirect paths.
- Then: trusted supervisor IPC + exact-intent key validation + UI authentication + audit, no production side effects until end-to-end tests pass.
- Lastly: provide the owner a **manual SSH paste-only** deployment with backup, rollback, a verifiable hash and service restart. NEVER execute those commands via MCP.

**Current VPS remains unchanged and uses its existing permissive unprivileged shell until an independently installed replacement is verified.**
