# Vendored core

Copied from `vps-mcp/mailbox_core/` in this repository at source commit
`a5d3062`. The Python modules and SQL migration are copied without runtime
changes. Relative imports keep this project independent of `vps-mcp`.

`../auth.py`, `../server.py`, `../paths.py` and `../admin.py` supply the local
token identity, stdio transport, repository exclusion and offline CLI adapters.
`http_runtime.py` is retained for upstream hardening/protocol regression tests;
the shipped CLI exposes only stdio. README text is adapted for this project.
