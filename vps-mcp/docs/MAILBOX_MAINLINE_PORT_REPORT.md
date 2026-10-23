# Session + Mailbox mainline port

Baseline: `b4b3f1ef7fec01c5b63c384173eb3d6bc2d21321`, verified against
GitHub `origin/main` by fetch on 2026-10-23 (Asia/Saigon). The existing planning
commit `11d50c5` is preserved. Source branch `feat/mcp-session-mailbox-mvp`
at `8a73554e5438a639e31cfa79fce192ab440820a9` is read-only provenance.
No whole milestone is cherry-picked.

## Selective inventory

| Decision | Source | Destination / reason |
| --- | --- | --- |
| KEEP FROM MAIN | `gateway.py` original 16 functions and IPC helpers | Preserve signatures, descriptions, schemas, worker and broker dispatch |
| KEEP FROM MAIN | `worker.py`, `broker.py`, `requirements.txt`, `deploy/production/*` | Byte-identical; no privileged policy or deployment changes |
| PORT/RENAME | M0 `gateway/__init__.py`, settings; M1 database, identity, sessions, admin, common, errors, migration | `mailbox_core/`; avoids shadowing production `gateway.py` |
| PORT/RENAME | M2 mailboxes; M3 tools/activity; M4 bounded workers, HTTP shutdown and durability hardening | `mailbox_core/`; preserve the functional core |
| ADAPT | M3/M4 registration in obsolete `server.py` | Add registration to production `gateway.py`; preserve its FastMCP configuration |
| ADAPT | M0/M4 environment-derived storage defaults | Remove implicit storage activation; runtime has no services/identity adapter and denies before any database access |
| ADAPT | M1–M4 service, protocol, hardening and stress tests | Rename imports; test actual 29-tool production gateway with temporary adapters and isolated IPC |
| ADAPT | M0 six-tool fixture and smoke harness | New exact 16-tool fixture captured from production baseline; source-only smoke plus owned ephemeral HTTP |
| ADAPT | M4 CI and docs | Windows/Linux checks for the production architecture; accurate activation prerequisites |
| DISCARD | `server.py`, `smoke_test.py`, `security/*`, prototype tests, obsolete deploy unit | Deleted or incompatible with real production; never restored |
| DISCARD | old `BASELINE*`, recovery prompt, milestone plans | Stale six-tool premise; provenance is recorded here instead |

`tests/fixtures/production_source.json` captures the original gateway function
ASTs and SHA-256 hashes of unchanged components. Protocol fixtures capture the
baseline schemas and response/error envelopes before additive registration.

## Validation and remaining requirements

Implementation and measured results are recorded as the port is verified.
This is source integration only. No production endpoint, state, credentials,
services, installation or restart is used by this task.
