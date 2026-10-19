# ADR-001: Hybrid permission & approval gateway

**Status:** Design accepted (hybrid UI). **NOT deployed.** The legacy `run_shell` on VPS is unchanged; it does not enforce this policy yet. The new approval-core module is intentionally **not connected** to `server.py`.

## Owner's non-negotiable rules

1. MCP has the infrastructure capacity for privileged operations but exposes only a **basic shell by default**.
2. Operations crossing project configuration/service boundaries require authenticated user approval.
3. MCP may **never** change its own deployment, policy, broker, credentials, running binaries, service units, or restart/stop its own server/tunnel. A key must not override this.
4. A privileged action must carry a **one-time per-command key** via `run_shell(command, key=...)`, checked by the server.
5. Prefer an in-ChatGPT approval prompt **only if it provides independently verifiable user authorization**; otherwise use the authenticated external approval page.
6. Changes to the MCP implementation are created and tested in GitHub `thieuhua/codespace1`; the owner manually applies/restarts the MCP installation on VPS.

## Architecture / trust boundary

```text
ChatGPT / MCP Tunnel
       |
       v
Unprivileged MCP gateway (no privileged DB access, no sudo)
   |           |
   |           +-- basic shell in sandboxed, low-privilege worker
   |
   +-- create request / check status ---> broker API (root-owned Unix socket)
                                           |
                  owner authenticated ---> approval UI
                                           |
                               root-owned broker / policy
                                           |
                            allowlisted privileged operations
                            (NO general-purpose privileged Bash)
```

The broker may run with elevated Unix privileges. The general MCP endpoint **must not**: a root Bash tool or an all-purpose `sudo` helper makes "DENY forever" technically unenforceable. All untrusted commands run in a separate low-privilege process with OS-enforced filesystem and process limits. This still satisfies a service architecture with privileged capacity.

The broker's Unix socket and SQLite DB must be owned by root and inaccessible to the MCP gateway and sandbox worker except via narrowly scoped broker API. The broker and the secrets used to grant approvals cannot be writable by the agent.

### Authorization decisions

- **ALLOW:** basic shell sandbox, read ordinary source, edit explicitly writable project trees, build and test. Actual containment comes from Linux filesystem/mount/sandbox permissions, not shell string matching.
- **ASK:** a broker-supported operation such as restarting the allowlisted `combat-web.service` or atomically changing an explicitly allowed project configuration file.
- **DENY (immutable):** any alteration of `vps-mcp`, `vps-mcp-tunnel`, their code currently executed on VPS, service units, credentials, policy, broker, approval DB, approval web service, systemd aliases/drop-ins/timers/sockets that control these services, or the ability to signal/kill their processes. Also deny generic root shell, arbitrary paths, arbitrary service names, and any privileged operation not implemented by the broker.

**Critical:** The broker must derive the final program and argv from a typed allowlisted operation (for example `systemctl --no-ask-password restart combat-web.service`). It must **not** execute a user-supplied command string with `bash -c`. Approved raw text is bound for audit/UX, but approval never turns arbitrary Bash into safe root execution.

Protect indirect routes: symlinks, hardlinks, bind mounts, systemd aliases, unit drop-ins, environment files, helper programs, cron, scripts and binaries invoked on restart. Use immutable/root-owned privileged allowlists and real-path checks combined with actual OS permission separation. Deny rather than guess when side-effects cannot be bounded.

### Identity and user-facing UI

**Preferred:** MCP client supports elicitation, and its approval event is verifiably bound to an authenticated owner identity, a specific request ID and exact operation. Simply displaying a ChatGPT confirmation widget or receiving `{"approved": true}` from the LLM is **not** trusted authorization.

**Fallback:** independent HTTPS approval UI with authenticated login (suggest passkey/WebAuthn or owner-bound OIDC + re-auth for privileged operations), CSRF protection, secure HttpOnly cookies, origin checks, and deny-by-default on timeout. No privileged link or token in URL. Model may receive only a nonsecret request ID and an unprivileged URL pointing to the approval page.

If the client only supports unverified elicitation/form prompts, it can **display** the request but the broker must require owner authentication in the fallback UI to actually approve. MCP Elicitation URL mode is designed for this kind of separate sensitive interaction (do not put approval secrets in form mode).

### Tool protocol / responses (target contract)

```text
run_shell(command, path=".", timeout_seconds=30, key="")
```

- For `ALLOW`: execute in the sandbox, ignoring any key; present bounded stdout, exit code, timeouts.
- For `ASK` without key: create pending request and return `APPROVAL_REQUIRED` with opaque `request_id`, **canonical** command, target, proposed effect, expiration, and an approval page URL (not a preauthorized bearer URL). Nothing executes.
- For `ASK` with key: broker checks owner approval + request ID + exact principal, kind, target, command bytes, cwd, timeout and requested effect. Atomically consumes key **before** dispatching allowlisted operation.
- For `DENY`: return `PERMISSION_DENIED_IMMUTABLE`, without creating a request. Ignore keys.
- For unknown, ambiguous or unanalyzable commands: fail closed; do not silently run on the host. For privileged actions not supported by broker, return `UNSUPPORTED_OPERATION` and provide owner-paste instructions instead.
- For `APPROVED` requests, UI issues a 256-bit random one-time key (90-second validity) for the approved exact action. The user can paste it into ChatGPT; later an authenticated MCP status flow may hand it back **only to the original authorized caller**, never to a different user/client. Never put keys in MCP form elicitation, URLs, logs or the repository.

The broker only stores a SHA-256 digest of this high-entropy key; the initial proof-of-concept core has a 5-minute pending request window and 90-second issued-key window. Never accept a caller-supplied `approved_by` value. Approval identity must come from independent authentication.

**Idempotence:** one-time consumption prevents replay, but does not by itself guarantee exactly-once external side effects after process crashes. Broker should store execution attempt/terminal result and avoid auto-retrying ambiguous privileged commands.

### Protected resources on VPS

- `/etc/systemd/system/vps-mcp.service` and `vps-mcp-tunnel.service` including any aliases, drop-ins and activation paths
- `/home/thieuhua/code/codespace1/vps-mcp` **on the running VPS**
- Tunnel runtime executable, API key directory `/home/thieuhua/.config/vps-mcp` and auth/security material
- Privileged broker binary/config, policy, audit log and approval SQLite database (location to be allocated under root-owned `/var/lib` or `/etc`)
- Other project service configs (e.g. `combat-web.service`, Nginx site) are **ASK**, not ALLOW, with scoped broker operations

Editing the **GitHub branch** containing future MCP code is permitted as development; the live copy cannot be updated from MCP and may only be deployed manually by the owner over independent SSH.

## Implementation phases and acceptance

1. **Contract + isolated token core (this branch):** unit tests for exact-command scope, expiry, replay, denied requests, concurrent redemption. No production policy claims.
2. **OS privilege separation:** root-owned broker + nonroot gateway and shell worker; GitHub Actions exercises sandbox denial of MCP code, secrets and signals. Prove practical containment, including indirect paths and symlinks, in disposable Debian test VM.
3. **Policy engine:** explicit ALLOW/ASK/DENY policy for each tool and resource. Only structured allowlisted operations reach broker. Enforce by capability and OS permissions, not merely regex matching.
4. **Approval UX:** verify ChatGPT elicitation capabilities; implement trusted in-ChatGPT path only when attestation is available, else authenticated external HTTPS page. Test forged approval claims and spoofed identity.
5. **Rollout:** tests, backup, manually pasted install/restart script, rollback. Never use existing MCP `run_shell` to modify, deploy, or restart MCP or tunnel services.

## Minimum negative tests before production

- `run_shell("systemctl restart vps-mcp", key=valid)` is **DENY**.
- Approving `combat-web.service` cannot restart a different unit, including via alias or shell interpolation.
- A key cannot be reused, extended, transferred to another principal, another command, cwd, target or timeout.
- Approve/deny functions and approval DB are not reachable from MCP worker, writable workspace, or arbitrary Python imports.
- An unapproved command cannot modify a different project's configs through indirect scripts.
- A compromised normal shell cannot edit live `vps-mcp` binaries, stop/restart them, signal them, or modify key/policy/approval assets.
- High-privilege helper lacks any general-purpose code/shell execution route; failure always **DENY**.
- UI cancel/timeout/network failure grants no rights; forged ChatGPT widget response cannot grant.
- Approval captures exact diff/effects where applicable, and operator sees them *before* confirming.

**Do not deploy the policy until all relevant OS-level separation and denial tests pass.**
