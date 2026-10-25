# Vendored core

Copied from `vps-mcp/mailbox_core/` in this repository at source commit
`a5d3062`. Eleven of the thirteen Python/SQL runtime files still match that
source after newline normalization. Local review fixes deliberately change:

- `database.py`: deny access and return retryable `RESOURCE_EXHAUSTED` when
  WAL/SHM metadata cannot be inspected during unlink/NTFS delete-pending races.
  Link/reparse/hardlink validation is never skipped; no connection is retained.
- `sessions.py`: charge `get()`'s `last_seen` refresh to the existing per-principal
  write quota, including closed/expired session views.

The SQL migration and schema version are unchanged. Relative imports keep this
project independent of `vps-mcp`; no source project was modified.

`../auth.py`, `../server.py`, `../paths.py` and `../admin.py` supply the local
token identity, stdio transport, repository exclusion and offline CLI adapters.
`http_runtime.py` is retained for upstream hardening/protocol regression tests;
the shipped CLI exposes only stdio. README text is adapted for this project.
