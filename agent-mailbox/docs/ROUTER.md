# Single-process HTTP mail router

The router is a second mode alongside the existing stdio session/mailbox server.
Their stores and delivery protocols are separate. Existing principal credentials
and token files in `mailbox.db` are shared; router mail lives in `router.db`.
No stdio data is migrated, consumed or deleted.

```text
 Operator / Claude (trusted local shell)
       | python -m agent_mailbox router ctl ...
       v
 router.db (SQLite WAL) <--- one DB watcher, every 100 ms
       ^                                |
       |                         asyncio Events
       |                                v
       +------ one FastMCP HTTP router /mcp
                      ^              ^
           Bearer codex token     Bearer antigravity token
                      |              |
                  Codex CLI      Antigravity CLI
                   receive -> handle/reply -> receive -> ...
```

## Start and provision

Use Python 3.11 and pinned `mcp==1.30.0` from the existing editable installation.
Provision with existing offline `admin init` and `admin add-principal` commands
(or existing setup). Router mode does not require a shared session/mailbox.
State selection is unchanged: `--state-dir`, then `AGENT_MAILBOX_HOME`, then
`%LOCALAPPDATA%\agent-mailbox`. State, logs and tokens must be outside repositories.

```powershell
.\.venv\Scripts\python.exe -m agent_mailbox router serve --host 127.0.0.1 --port 8766 --hold-seconds 50
# Background alternative; both support -WhatIf and -DryRun:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\router-start.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\router-stop.ps1
```

The endpoint is `http://127.0.0.1:8766/mcp`. Bind accepts only numeric loopback
addresses or `localhost`, unless `--allow-non-loopback` is explicitly supplied.
SDK DNS-rebinding protection is explicitly enabled for localhost, 127.0.0.1 and
IPv6 loopback Host/Origin values, including ports. The override does not disable
Host checks or add TLS. It is not a production network deployment mechanism.
An OS byte/file lock on `router.lock` prevents a second server using the same
state, even on another port. A crash releases the lock automatically.

`router-start.ps1` writes `router.pid.json`, `router.stdout.log` and
`router.stderr.log` under state, starts a hidden process and records creation
time with the PID. `router-stop.ps1` verifies process identity and requests
graceful shutdown through the offline CLI. It does not force-kill a reused PID.
Foreground Ctrl+C also wakes all waiters before Uvicorn drains requests.

## Authentication and isolation

Every HTTP request, including initialize, discovery, GET, notifications and DELETE,
requires `Authorization: Bearer <existing amb1 token>`. Missing, malformed, wrong,
revoked or disabled credentials return HTTP 401 with stable `UNAUTHENTICATED` and
`WWW-Authenticate: Bearer`. No router data is read before verification. Credentials
are verified again for tool calls, every receive snapshot and the delivery commit.
Revocation while waiting wakes the affected call within the watcher interval;
the tool returns a structured `UNAUTHENTICATED` error without consuming mail.

The existing salt/HMAC-SHA256 and constant-time comparison are reused directly.
No new token, plaintext credential copy or signing secret is stored in router.db.
Credential tables are attached for verification inside short SQLite transactions;
router SQL never modifies them. No transaction remains open across a wait.
The router also checks linked/reparse/hardlinked DB and sidecar paths.

FastMCP uses stateful streamable HTTP with JSON tool responses, at most 64 sessions
and a 600-second session idle timeout. SDK sessions are bound to the authenticated
principal, preventing session-ID theft by a different valid principal. Tool
arguments never select the caller's identity or another inbox. Addresses
`operator`, `claude` and `all` are reserved and cannot authenticate to this mode.
Only the trusted offline CLI sends as `operator`; `claude` is its send alias.

This is a same-Windows-user coordination service, not an OS security boundary.
A process with access to that user's files can read other tokens, modify code or
DBs, and invoke offline administration. SQLite and message history are plaintext.
Existing Windows ACL behavior applies, including the explicit inherited-ACL
warning under a restricted Windows token. Header tokens passed to `agy mcp add`
are persisted in plaintext in its config and are briefly visible in process argv.

## MCP tools (exact inventory)

All successful responses have `schema_version: 1` in both JSON text and
`structuredContent`; tool errors use `isError: true` and
`{"schema_version":1,"error":{"code":"...","message":"..."}}`.
Unknown recipients and unauthorized message IDs return `NOT_FOUND`.
There are exactly five tools and no operator/admin MCP tools.

| Tool | Arguments | Result |
| --- | --- | --- |
| `whoami` | none | `principal_id`, `server_name`, `server_version`, `hold_seconds`, `protocol` |
| `mailbox_receive` | `wait_seconds: int \| null = null` | `status`, `messages`, `poll_count`, `server_time`, `instruction` |
| `mailbox_send` | `to: str`, `text: str`, `reply_to: str \| null`, `idempotency_key: str \| null` | `message`, `duplicated` |
| `mailbox_reply` | `message_id: str`, `text: str`, `idempotency_key: str \| null` | `message`, `duplicated` |
| `mailbox_ack` | `message_ids: list[str]` | `acknowledged` (deduplicated IDs) |

Messages contain exactly `id`, `seq`, `from`, `to`, `text`, `reply_to`, `sent_at`.
`seq` is a global increasing SQLite sequence; receives are ordered by it, up to
100 messages per call. Times are UTC Unix seconds. Text must contain 1..65,536
UTF-8 bytes, and idempotency keys 1..256 UTF-8 bytes. Keys are scoped to sender;
identical key+canonical recipient/text/reply target returns the original message,
with `duplicated: true`; changed payload returns `CONFLICT`. Retry sends/replies
with stable keys. Reply targets must be delivered messages in the caller's own
inbox; `reply_to` on send also must name such a message from the chosen recipient.
ACK accepts at most 100 delivered IDs, checks ownership atomically, records the
first ACK time, and is idempotent. ACK never deletes mail or redelivers it.

### Listening loop

1. Call `whoami` once to verify identity and read `protocol`.
2. Call `mailbox_receive()` on your own inbox.
3. `mail`: handle messages, send/reply as appropriate, optionally ACK, then call
   receive again. Do not end your turn.
4. `no_mail`: immediately call receive again. Do not end your turn.
5. `stop`: stop polling and end your turn with a one-line summary.

Each receive returns `poll_count` (all recorded receives for this principal,
including errors/cancellation, across restarts), plus `server_time` and an explicit
instruction for the next step. A stop takes precedence over pending mail and
persists until resume; it does not discard pending mail.

Default hold is 50 seconds; `serve --hold-seconds` sets the current DB hold at
startup. Each call snapshots the DB hold at its start.
`wait_seconds` is a nonnegative integer capped at that hold; zero is nonblocking.
Omitting it uses the full hold. Server/CLI hold settings accept fractional seconds
in [0,300], allowing short measurement tests. `set-hold` affects subsequent calls,
including a higher hold up to 300, without changing a call already in flight.
There is at most one active receive per principal and 64 overall; extra calls
are recorded and return `RESOURCE_EXHAUSTED`.

### Delivery and cancellation

An empty receive waits on an asyncio Event; there are no per-waiter DB polling
loops or held SQLite transactions. One server-wide watcher checks WAL state
every 100 ms (bounded below the 250 ms requirement), signals principals with
pending mail/stop and signals waiters when credentials change. Incoming mail is
checked immediately before waiting to avoid lost wakeups. A separate blocking
ASGI disconnect monitor waits on the socket, without polling the DB.

When mail is selected it is reserved to the receive's ID in a short transaction.
It remains undelivered until immediately before the response body is handed to
ASGI. Authentication is checked in that same delivery transaction. Cancellation
notifications, HTTP disconnects, session teardown or task cancellation before
this boundary release reservations and record cancellation. Another receive can
then deliver the same pending mail exactly once. The next startup recovers
undelivered reservations and marks unfinished calls cancelled with `SERVER_RESTART`.

Normal operation has no duplicates or lost messages: a successfully returned
receive consumes its messages once; explicit ACK is optional. **There is a rare
response-loss window between the delivery commit and the client actually
receiving/parsing the response.** A crash, disconnect or lost response in that
window leaves mail marked delivered although the client may not have seen it.
Conversely a crash after bytes are sent but before external processing is not
an application-level exactly-once guarantee. ACK records processing intent; it
does not automatically retry a lost response. The offline operator can inspect
router.db/history and resend with a new key when needed. There is no automatic
redelivery/lease expiry and no consumer cursor in router mode.

## Trusted operator CLI

Use `python -m agent_mailbox router ctl <command>`; every command supports `--json`
(before or after the command) and `--state-dir`. JSON is one object on stdout.
Human output is indented JSON. Credentials are unnecessary for trusted offline
control; access to the state directory is the authority.

| Command | Behavior |
| --- | --- |
| `send --to codex "TEXT"` | Send from operator to one enabled principal |
| `send --to all "TEXT"` | Send one message to every enabled non-reserved principal |
| `inbox [--wait N] [--all]` | Read operator mail, mark read; optional wait up to 300 s; `--all` includes read history |
| `status` | Per principal: waiting, last call, lifetime receives, streak, mail counts, pending, last error |
| `stats --json` | Status plus complete receive records, send/message counts, hold and runtime resource telemetry |
| `log [--tail N]` | Last 1..10,000 send attempts, including replay/error, in chronological order (default 50) |
| `stop codex` / `stop all` | Persist stop and wake waiting agents |
| `resume codex` / `resume all` | Clear stop; later receives continue normally |
| `set-hold 50` | Change hold for the next receive calls |
| `shutdown` | Wake all waiters and stop the HTTP process; used by router-stop.ps1 |

Each authenticated receive records principal, start/end, elapsed held seconds,
configured hold, result status, delivered count, cancelled flag, error and streak.
Statuses in instrumentation additionally include `error` and `cancelled`; wire
receive successes only use `mail`, `no_mail`, `stop`. Each send attempt records
sender, recipient, time, message ID, replay and error. Message text lives in the
message table, not the routing log. Discovery/failed HTTP authentication do not
increment receive counters. A streak increments after a previous successful
mail/no_mail receive when the next call starts within 60 seconds of its end;
overlap, errors, cancellation, stop, restart or a longer gap reset it. This is a
measurement of tool calls, not evidence that a model processed the instructions.
`last_error` retains the latest historical receive or send error. Disabled
principals remain visible in status with `enabled: false`. Runtime counters are
sampled once a second: PID, timestamp, tasks, threads, waiters, connections and
watchers; stale telemetry can remain after shutdown. History grows until the
operator archives/removes this separate router store while the server is stopped;
existing stdio `admin cleanup` does not prune router data. The existing main DB
page cap and bounded SQLite lock timeout apply; disk/WAL usage still needs monitoring.

## Client registration and timeout

Preview first. These commands replace the `agent_mailbox` entry; the router must
already be running. Scripts accept `-Client codex|antigravity|all`, `-Url`,
`-StateDir` and rotated token file paths. Preview never reads tokens or calls CLIs.
Registration only changes transport; existing Antigravity allow-rules for these
five tool names still apply.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-router-clients.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-router-clients.ps1
$env:AGENT_MAILBOX_ROUTER_TOKEN = (Get-Content -Raw "$env:LOCALAPPDATA\agent-mailbox\tokens\codex.token").Trim()
codex exec -c 'mcp_servers.agent_mailbox.tool_timeout_sec=90' -c 'mcp_servers.agent_mailbox.default_tools_approval_mode="approve"' 'Call agent_mailbox.whoami, then keep calling mailbox_receive. Handle mail and reply; continue after no_mail. End only on stop.'
```

For custom state or rotation, set the environment variable from the selected
Codex token file in the shell launching Codex. Registration does not persist the
secret for Codex. Keep the tool timeout comfortably above hold; raise it above
300 if using the maximum hold. Approval mode is per server, not a global shell
bypass. The exact installed flags were checked read-only with `codex mcp add
--help` and `agy mcp add --help`:

```text
codex mcp add agent_mailbox --url http://127.0.0.1:8766/mcp --bearer-token-env-var AGENT_MAILBOX_ROUTER_TOKEN
agy mcp add --header "Authorization: Bearer <token>" agent_mailbox http://127.0.0.1:8766/mcp
```

The agy token is read at registration time and stored in plaintext in its config;
rotation requires registration again. Scripts redact it from their command
preview/output. Never run registration against real client configs during tests.
To return to stdio, use the existing `register-clients.ps1`.
Codex setting references: [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).
Transport reference: [MCP Python SDK v1.30.0](https://github.com/modelcontextprotocol/python-sdk/tree/v1.30.0).

## Verification

Run `.\.venv\Scripts\python.exe -m unittest discover -v`. Router tests launch real
HTTP server subprocesses and SDK clients on ephemeral loopback ports with TEMP
state. They cover hold timing, cross-process ctl wake under one second, routing,
reply, ACK/idempotency/isolation, per-request auth/revocation/disable, cancellation
notifications and disconnected HTTP, stop/resume/hold changes, instrumentation,
205 consecutive receives with bounded task/connection/thread/handle/RSS counts,
binding/Host/Origin checks and PowerShell previews/background lifecycle.
See [BUILD_REPORT](BUILD_REPORT.md) for actual measured results.
