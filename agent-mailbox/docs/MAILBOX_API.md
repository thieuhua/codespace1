# Local Session + Mailbox API (schema version 1)

The stdio server exposes the 13 tools below plus `whoami()` returning
`{"schema_version":1,"principal_id":"<authenticated ID>"}`. All calls
authenticate from the process token before tool dispatch. Identity fields in
arguments confer no authority. Provisioning and grants are offline admin only.

Adapted from `vps-mcp/docs/MAILBOX_API.md` at `a5d3062`.

## Tool contract

`?` means optional. All successful responses include `schema_version: 1`.
IDs are opaque strings authorized by ACL, never credentials. Timestamps are UTC.

| Tool and parameters | Result / policy |
| --- | --- |
| `session_open(name?, ttl_seconds?, idempotency_key?)` | session_id, name, status, created_at, expires_at, last_seen; caller owns session |
| `session_get(session_id)` | Same view; refreshes last_seen, serves resume/status |
| `session_list(cursor?, limit?)` | sessions, next_cursor; only accessible sessions |
| `session_renew(session_id, ttl_seconds?)` | Session view; active/unexpired owner only |
| `session_close(session_id)` | Session view; owner only, idempotent close |
| `list_recent_activity(session_id, after_cursor?, limit?)` | events(operation, resource_id, at), next_cursor, has_more; no contents |
| `mailbox_create(session_id, name?, idempotency_key?)` | mailbox_id, session_id, name, created_at; active owner only |
| `mailbox_list(session_id?, cursor?, limit?)` | mailboxes, next_cursor; only accessible mailboxes |
| `mailbox_send(mailbox_id, text, correlation_id?, idempotency_key?)` | message_id, sequence, sent_at, duplicated |
| `mailbox_receive(mailbox_id, after_cursor?, limit?, wait_seconds?)` | messages, next_cursor, has_more; exclusive sequence cursor |
| `mailbox_ack(mailbox_id, message_id)` | message_id, acknowledged=true; per authenticated principal |
| `mailbox_reply(mailbox_id, in_reply_to, text, idempotency_key?)` | Send result plus in_reply_to; retained message in same mailbox |
| `mailbox_get_message(mailbox_id, message_id)` | One retained message plus schema_version |

A message view has message_id, sequence, text, sender_label, correlation_id,
in_reply_to, sent_at and acknowledged. Read/list/ACK survive closure/expiry until
retention; closed or expired sessions reject send/create/renew. Grants are
offline administration and cover all current/future mailboxes in one session.
Only the owner creates an inbox; every granted participant can send/read within
it. Separate sessions are needed for private audiences.

ACK is informational and **per principal**, not per device/process/consumer
instance. Two clients with the same principal share ACK state. ACK never deletes
history or filters receive. No cursor replays retained history.

Writes commit before success. Sequence is monotonic per mailbox under concurrent
writers. Delivery is at-least-once: persist IDs/cursors after processing and use
idempotency keys for retries. Keys are scoped by principal, operation and session
or mailbox. Same key/payload replays the result; changed payload conflicts.
Cancelled writes may commit; retry with the original key. Retention may remove
a message while its replay tombstone still returns the original ID. Dedupe
ends when trusted cleanup deletes the logical session and its keys.

## Local workflow

Run offline `admin create-shared-session --owner A --participant B --mailbox work`
first, or grant an agent-created session through the trusted Provisioner Python
API. Clients discover shared sessions/mailboxes using list tools. The following
example opens a new session: its grant step remains offline administration.

```text
A: session_open({"name":"build review","idempotency_key":"review-42"})
A: mailbox_create({"session_id":"<session>","name":"work","idempotency_key":"inbox"})
A: mailbox_send({"mailbox_id":"<mailbox>","text":"Review commit 123","idempotency_key":"task-42"})
   A disconnects; trusted administrator grants B membership in <session>.
B: mailbox_receive({"mailbox_id":"<mailbox>","limit":20,"wait_seconds":10})
B: mailbox_ack({"mailbox_id":"<mailbox>","message_id":"<task-message>"})
B: mailbox_reply({"mailbox_id":"<mailbox>","in_reply_to":"<task-message>","text":"Review complete","idempotency_key":"reply-42"})
   A reconnects after a server restart.
A: session_get({"session_id":"<session>"})
A: mailbox_receive({"mailbox_id":"<mailbox>","after_cursor":"<saved-next_cursor>"})
A: list_recent_activity({"session_id":"<session>","limit":20})
```

Messages are plain text. This server does not execute commands, approve
operations or produce job events.

## Bounds and errors

Defaults: 100 stored sessions/owner, 20 mailboxes/session, 10,000 retained messages
or 8 MiB text/mailbox, 32,768 UTF-8 bytes/text, 20,000 keys/principal, 120 new
mutations/principal/minute, 10,000 audit events globally, seven-day retention,
one-day default TTL/seven-day maximum. Pages default to 20/max 100. There are
four DB workers, 64 admitted operations and 32 pollers/process, max 20 seconds
per wait. Admission rejects overload; polls hold no DB lock while sleeping.
The wait bound excludes network latency and any in-progress DB busy timeout.
Revocation/expiry/closure is rechecked while waiting. The stdio lifespan stops waiters during transport shutdown.
An abruptly disconnected client must reconnect and retry with its saved cursor/key.

SQLite has a 128 MiB main-file page cap, not a total DB+WAL+SHM disk cap.
Short snapshots, automatic checkpoints and explicit trusted maintenance bound
normal workloads; owner monitoring/free disk limits are still prerequisites.
Retention hides old messages on read and prunes on send/trusted cleanup.
Cleanup deletes sessions closed/expired for a retention period and cascades ACL,
mailboxes, messages, deliveries and keys. Audit evicts old metadata at its cap.

Errors use MCP `isError=true` and matching text/structuredContent:

```json
{"schema_version":1,"error":{"code":"NOT_FOUND","message":"Resource not available"}}
```

Codes: INVALID_ARGUMENT, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, EXPIRED,
RESOURCE_EXHAUSTED, INTERNAL. Unauthorized and absent resources share NOT_FOUND.
Known participants attempting owner-only operations receive FORBIDDEN. Strict
SDK type validation errors retain SDK error format. SQL/path/payload exception
details are redacted by the mailbox tool boundary. Only `whoami` exposes identity; no provisioning or approval tool is exposed.
Missing, invalid, revoked and disabled credentials all return UNAUTHENTICATED.
Revocation is rechecked inside each polling snapshot before any message read.
