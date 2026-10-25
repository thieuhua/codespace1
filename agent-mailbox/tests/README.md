# Isolated verification

`test_router.py` runs real HTTP router subprocesses and MCP SDK clients against
TEMP state on ephemeral ports: timed holds, cross-process ctl wake <1 second,
routing/replies/operator inbox, ACK/idempotency/ownership, auth/revocation/disable,
cancellation notifications and disconnected POSTs, stop/resume/set-hold,
instrumentation, 205 consecutive receives with bounded OS/runtime resources and
SDK Host/Origin protection. `test_router_scripts.py` checks PowerShell 5.1
previews without reading tokens or invoking registration and runs background
start/stop only on explicit TEMP state and an ephemeral port. Real client
registration and real model polling endurance are operator measurements.

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
The spaced-file/directory regression reads the actual DACL through a separate
Windows API: protection, exactly one current-user allow ACE, full control and
directory inheritance flags are asserted only with an unrestricted token.
Every script test starts `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
<script> ...`, with an inherited process policy of Restricted. This also covers
dot-sourced helpers and temporary `.ps1` shims without changing user/machine policy.
The original symlink test skips only if the OS forbids creating symlinks.

Only `-WhatIf`/`-DryRun` previews are used for setup/register/unregister scripts. No real client
configuration, real default state, remote MCP, VPS or production endpoint is used.
Detailed measured results are in [BUILD_REPORT](../docs/BUILD_REPORT.md).

`test_review_resolution.py` covers resolved repository paths, every admin parser
position, first-transaction identity binding, WAL/SHM failure classification and
link rejection, session refresh quotas, provisioning prechecks, ACL reapplication,
rotation through previewed commands, shared-session expiry/close races, and real
PowerShell 5.1 native argv against temporary fake executables. Only preview mode
invokes setup/registration scripts; extracted Python admin commands run on TEMP
state, without installing packages or registering clients.
