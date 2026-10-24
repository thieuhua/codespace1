# Session and Mailbox core

Application sessions are independent of MCP transport sessions. `sessions.py`
handles ownership, membership, TTL and history; `mailboxes.py` handles ordered
messages, idempotency, per-principal ACK and bounded polling. ACL grants cover
all current and future mailboxes in one session; there is no separate private
inbox within a shared session. Use separate sessions for different audiences.

`database.py` uses one short connection/transaction per operation, WAL, FULL
synchronous commits and atomic `migrations/001_initial.sql` (`user_version=1`).
Writes use `BEGIN IMMEDIATE`; `settings.py` bounds storage/rates. Linked paths
are rejected, but owner-controlled OS permissions are still required to prevent
path replacement. `admin.py` is an offline trusted provisioning/cleanup API;
it is never an MCP tool and has no public administration endpoint.

`identity.py` has a ContextVar bridge with no header, field or environment
fallback. `tools.py` registers 13 tools. Production supplies no services:
requests deny before accessing storage, even if an identity context is present.
Only isolated tests inject services and fixed identities. A future verified
runtime adapter requires an independent owner review; there is no enable flag.

`async_db.py` shares four threads and a 64-operation admission limit while
preserving request contexts. Polling releases connections between snapshots;
32 waiters/process and 20 seconds/wait are the defaults. `http_runtime.py`
notifies waiters before Uvicorn drains HTTP, retaining the production transport
and legacy drain defaults. A cancelled mutation may already have committed:
retry with the same idempotency key.

See the [API and workflow](../docs/MAILBOX_API.md),
[tests](../tests/README.md) and [activation prerequisites](../PRODUCTION.md).
