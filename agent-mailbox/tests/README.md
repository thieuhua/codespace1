# Isolated verification

Run from `agent-mailbox`: `.venv/Scripts/python.exe -m unittest discover -v`.
All runtime state is in `tempfile.TemporaryDirectory`, outside repositories.

Core tests, crash fixtures and the 2,000-message/8-writer/32-poller stress worker
are ported from `vps-mcp` at `a5d3062`, with local imports. The standalone core
HTTP harness replaces production-gateway loading: inventory is 13 core tools,
with original session/ACL/protocol assertions preserved. Legacy production tool,
deployment, OAuth, broker and worker tests are outside this project's scope.

`test_stdio.py` launches two simultaneous real stdio servers through MCP 1.30.0
SDK clients against one temp state: ACK/reply/restart, cross-process long-poll,
third-principal rejection, every-tool authentication, revocation while waiting,
and immutable process identity. `test_admin.py` exercises actual CLI subprocesses,
token files, rotation, no plaintext in DB, paths and PowerShell 5.1 previews.

Windows SDK tests select SelectorEventLoop, invoking the SDK's supported
Popen/thread fallback. This avoids named-pipe permission failures of Python's
Proactor under restricted Windows tokens; it does not replace the SDK, protocol
or server processes. ACL tests require exact owner-only DACLs outside restricted
tokens; in a restricted token they require the explicit inherited-ACL warning.
The original symlink test skips only if the OS forbids creating symlinks.

Only `-WhatIf` is used for setup/register/unregister scripts. No real client
configuration, real default state, remote MCP, VPS or production endpoint is used.
Detailed measured results are in [BUILD_REPORT](../docs/BUILD_REPORT.md).
