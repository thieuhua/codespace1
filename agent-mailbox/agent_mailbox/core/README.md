# Session + Mailbox core

Vendored unchanged runtime from `vps-mcp/mailbox_core` at `a5d3062`.
See [provenance](PROVENANCE.md) and the [project README](../../README.md).

- `sessions.py`: durable sessions, owners, ACLs, TTL, metadata activity.
- `mailboxes.py`: ordered messages, idempotency, per-principal ACK, bounded
  SQLite polling (200 ms, no connection held while sleeping).
- `database.py`, `migrations/`: WAL, FULL synchronous commits, short transactions,
  migration version 1, linked-path rejection, bounded SQLite contention.
- `common.py`, `settings.py`: validation, pagination and quotas.
- `identity.py`: trusted Python ContextVar bridge, no model-supplied identity.
- `tools.py`: exactly 13 core tool schemas; no offline administration tools.
- `async_db.py`: four workers, 64 admitted operations, request context propagation.
- `admin.py`: trusted Provisioner for identity labels, grants, disable and cleanup.
- `http_runtime.py`: retained upstream HTTP regression harness only.

The stdio adapter authenticates before tool dispatch. Its Database subclass
rechecks credentials inside every transaction before the core sees mailbox data.
The core API itself is privileged Python code, not an authentication interface.
