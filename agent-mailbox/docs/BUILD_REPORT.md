# Agent Mailbox build report

Built locally on 2026-10-25 (Asia/Saigon), Windows, CPython 3.11.4,
SQLite 3.42.0, MCP 1.30.0, on branch `feat/mcp-baseline-recovery`.
All dependency installation was inside `agent-mailbox/.venv`. No commit, push,
branch change, VPS access, production endpoint or remote MCP call was performed.

The initial build and independent review verification below are historical.
Current follow-up results are in [Normal-user ACL and execution-policy fixes](#normal-user-acl-and-execution-policy-fixes).

## Delivered behavior

A standalone `python -m agent_mailbox serve` stdio MCP server exposes the exact
13 session/mailbox tool functions from the source core plus `whoami`. Each
client starts its own server; a shared external SQLite WAL database provides
durable messages, per-principal ACK, reply links, ACLs, TTL, retention, cursors,
idempotency, quotas and bounded polling. No server listener or service is needed.

At the initial build, all 13 core Python/SQL runtime files matched source commit
`a5d3062` after newline normalization. Review resolution now deliberately changes
`database.py` and `sessions.py`; the remaining 11 still match Git blobs. See
[provenance](../agent_mailbox/core/PROVENANCE.md). There is no cross-project import or
runtime source dependency. Core README/provenance and local adapter/docs are new.
The source requirements specify `mcp>=1.15,<2`, not an exact version; this project
pins **1.30.0**, the exact version recorded in the source port's validation report,
which satisfies that range.

Only `agent-mailbox/` and one row in the root README project table changed.
`vps-mcp/`, `focus-monitor/`, `combat-analysis/`, client configs and real default
state were not modified. The root README's existing end-of-file convention is
preserved. Venv/build metadata/bytecode are ignored; no token, database or log
artifact is present in the project's source tree.

## File map

| Location | Purpose |
| --- | --- |
| `agent_mailbox/core/` | Vendored core, SQL migration, provenance and navigation |
| `agent_mailbox/__main__.py` | `serve`/offline `admin` argument parsing and redacted CLI errors |
| `agent_mailbox/server.py` | Authentication before tool validation, stdio lifespan and `whoami` |
| `agent_mailbox/auth.py` | Token format, HMAC verification, issuance, authenticated transaction adapter |
| `agent_mailbox/paths.py` | External-state paths, link/repository checks, ACL/mode handling |
| `agent_mailbox/admin.py` | Core Provisioner integration, credentials, shared-session setup, maintenance |
| `scripts/setup.ps1` | Project venv, dependencies, idempotent principal/session/mailbox setup |
| `scripts/register-clients.ps1` | Absolute Python/token-file paths for Codex and Antigravity |
| `scripts/unregister-clients.ps1`, `common.ps1` | Selected-client removal, quoted dry-run commands, exit checks |
| `tests/test_stdio.py`, `local_support.py` | Real SDK clients and simultaneous real stdio server children |
| `tests/test_admin.py`, `test_auth.py` | Actual offline CLI, credentials, ACL/path handling, SQL authorization |
| Other `tests/` files | Ported session/mailbox/protocol/hardening/crash/stress coverage |
| `requirements.txt`, `pyproject.toml`, `.gitignore` | Exact SDK pin, editable installation, migration package data, ignored artifacts |
| `README.md`, `docs/MAILBOX_API.md` | Vietnamese operator guide and local API contract |

## Design decisions

- Token shape is `amb1.<random 128-bit lookup ID>.<random 256-bit secret>`.
  The DB holds the lookup ID, principal ID, independent random 256-bit salt,
  HMAC-SHA256 digest, creation timestamp and revocation bit. It never stores
  plaintext tokens. `hmac.compare_digest` compares digests, including a dummy
  digest when a well-formed lookup ID does not exist.
- The process reads one token once. File selection has precedence over the raw
  environment fallback; an invalid selected file never falls back. On first
  successful authentication the process binds its principal and refuses a
  different principal even if an offline DB edit remaps the lookup ID.
- `AuthenticatedMCP.call_tool` verifies before SDK validation. The database
  subclass verifies again **inside each transaction** before yielding it to the
  core, with the same SQLite snapshot as authorization/message access. Long-poll
  snapshots recheck token revocation and principal enabled state every 200 ms.
  Revocation committed before a snapshot prevents that snapshot from reading
  history. A transaction already authorized before revocation may complete.
- Missing/malformed credentials do not open SQLite. Servers do not initialize
  storage. Well-formed credentials require existing provisioned state. All
  authentication failures use matching text/structuredContent and MCP isError.
  Tests install a SQLite authorizer to prove revoked calls never reach mailbox
  tables, even with a forged trusted Python context.
- Core migration `user_version=1` is unchanged; offline initialization adds an
  idempotent `local_credentials` table. Grants/principal labels/disable/cleanup
  use the core Provisioner. No admin function is exposed through MCP.
- Default home is `%LOCALAPPDATA%/agent-mailbox`. CLI overrides environment,
  which overrides the default. State/token paths in Git repositories and linked
  paths are rejected. The core's main DB/WAL/SHM hardlink/reparse checks remain.
- Token files use exclusive creation, protection before writing, flush/fsync and
  DB commit before success. Rotation requires a new filename; old credentials
  immediately fail verification. A crash between file creation and DB commit can
  leave an unusable token file; offline recovery must choose/remove that file.
- Shared setup is additive: an active matching owned session is renewed and
  grants are added; the mailbox uses a deterministic idempotency key. Expired
  sessions are replaced. Removing an argument does not revoke an older grant.
- Existing external token-parent ACLs are preserved; only newly created parent
  directories and the token file are protected. Setup re-protects its own state
  and tokens directories. This avoids changing unrelated parent directories.
- The copied core already implements DB polling every 200 ms, independent of
  in-process notifications. No receive-loop change or cross-process IPC shim was
  necessary. Polls hold no DB connection while sleeping.

## Client CLI research

Read-only installed help was inspected with these commands:

```powershell
Get-Command codex,agy,py | Select-Object Name,Source
py -3.11 --version
codex --version
codex mcp add --help
codex exec --help
codex mcp remove --help
agy mcp --help
agy mcp add --help
agy mcp remove --help
```

Installed Codex reports **codex-cli 0.164.0**. Its stdio add syntax is
`codex mcp add [OPTIONS] <NAME> -- <COMMAND>...`; `--env KEY=VALUE` is repeatable.
Installed `agy` help requires **all flags before the server name**:
`agy mcp add [--env K=V] <name> <command> [args...]`. Both support `mcp remove`.
Codex help emitted sandbox warnings about unavailable PATH aliases/arg0 temp
cleanup; help and version inspection still returned successfully.

Official OpenAI documentation was fetched, not inferred from CLI names:
[MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
The per-server `default_tools_approval_mode` supports `auto`, `prompt`, `writes`
and `approve`; tools also have individual overrides. `codex mcp add` has no
tool-approval flag. The README gives a per-invocation `codex exec -c
'mcp_servers.agent_mailbox.default_tools_approval_mode="approve"' ...` example
for an operator who wants unattended mailbox calls. Registration does not
silently change approval policy, and no global sandbox/approval bypass is used.
Actual model execution and managed-policy interaction were not tested.

## Commands and measured results

From the repository root, dependencies were prepared with:

```powershell
py -3.11 -m venv agent-mailbox/.venv
agent-mailbox/.venv/Scripts/python.exe -m pip --isolated install --disable-pip-version-check --no-cache-dir --timeout 20 -v -r agent-mailbox/requirements.txt
agent-mailbox/.venv/Scripts/python.exe -m pip --isolated install --disable-pip-version-check --no-cache-dir --timeout 20 'setuptools>=68' wheel
agent-mailbox/.venv/Scripts/python.exe -m pip --isolated install --disable-pip-version-check --no-cache-dir --no-build-isolation --no-deps -e agent-mailbox
```

All four completed successfully. Setuptools 84.2.1 and wheel 0.48.0 were installed
in this venv. Initial attempts without `--no-cache-dir` stalled (the editable
attempt during isolated build dependency installation) and were interrupted;
they are not reported as successful. Setup uses the working explicit bootstrap
and editable-install sequence. No global install was run.

From `agent-mailbox`, validation commands actually run were:

```powershell
.venv/Scripts/python.exe -m unittest -v tests.test_stdio.StdioTests.test_cross_process_long_poll_wakes_promptly
.venv/Scripts/python.exe -m unittest -v tests.test_stdio tests.test_admin
.venv/Scripts/python.exe -m unittest -v tests.test_auth
.venv/Scripts/python.exe -m unittest discover -v
.venv/Scripts/python.exe -m compileall -q agent_mailbox tests
.venv/Scripts/python.exe -m pip check
.venv/Scripts/python.exe -c "import sys,sqlite3,importlib.metadata; print('Python',sys.version.split()[0], 'SQLite',sqlite3.sqlite_version,'MCP',importlib.metadata.version('mcp'))"
```

Intermediate results, retained to distinguish failures from final evidence:

| Run | Real result |
| --- | --- |
| First cross-process attempts | ACL mutation failed in the restricted Windows token; later Proactor named-pipe creation failed with WinError 5 |
| First successful isolated cross-process test | 1 passed, 8.052 s; wake after send 0.141 s |
| Initial full suite | 40 tests, 4 errors, 94.796 s; all errors traced to `whoami` missing structuredContent |
| After explicit `whoami` CallToolResult fix | 9 stdio/admin tests passed, 66.904 s; wake 0.141 s |
| Added authentication unit tests | 4 passed, 0.137 s |
| Expanded full suite | 44 passed, no skips, 104.489 s; wake 0.140 s |

The 44-test run's stress measurement was 2,000 messages × 1,024 bytes, eight
writers, 32 waiting consumers, 28.016 s, 67,149,824 peak RSS bytes, 4,128,768 DB
bytes and 37 bounded busy retries, under a Windows Job **1 GiB process memory
limit**. A final parent-permission regression and valid environment-token
integration check were added after this run; final verification follows below.

Additional checks completed successfully:

- PowerShell 5.1 `System.Management.Automation.Language.Parser.ParseFile` parsed
  all four `.ps1` files without errors. Actual `powershell.exe -NoProfile
  -NonInteractive -File <script> -WhatIf` executions cover setup, register and
  unregister with a temporary `-StateDir` (where applicable). They printed only
  quoted commands, created no state and called no client CLI.
- `pip check`: `No broken requirements found.` Compileall exited 0.
- A Python verification compared all 13 vendored runtime files against
  `git show a5d3062:vps-mcp/mailbox_core/<path>`: all match after CRLF normalization.
- `git diff --check` passed; an additional source-tree scan checked whitespace
  in new/untracked files and found no DB, token or log artifacts outside the venv.
- `git status --short` showed only root README modification and the new project.

## Limits and unverified operator actions

- On this host the managed shell has a **restricted Windows access token**.
  Changing DACLs is denied, and experimentally creating a directory with an
  owner-only DACL prevents that restricted token from reopening its files.
  The requirement permits owner-only ACLs where possible: the adapter warns
  explicitly and preserves inherited ACLs in this case. Normal-token ACL errors
  fail the operation. Tests assert the warning in the restricted environment and
  retain exact protected owner-only DACL assertions for normal Windows tokens;
  no test is skipped to accommodate the sandbox. Successful normal-token ACL
  application still needs verification by the operator in ordinary PowerShell.
- Windows SDK tests use SelectorEventLoop so MCP 1.30.0 selects its built-in
  Popen/thread stdio fallback. These are real SDK sessions and real child server
  processes, without mocking messages, database operations or process creation.
  This avoids the host's Proactor named-pipe restriction. The server remains
  stdio-only and the dependency is not patched.
- Live Codex/Antigravity registration and a model-driven exchange were deliberately
  not run. Their exact installed help and script previews were verified. No
  real `%LOCALAPPDATA%/agent-mailbox`, `~/.codex`, `~/.gemini`, other client config,
  production port 8765 or privileged production socket was used by tests.
- Tokens prevent accidental identity confusion, not OS isolation for processes
  sharing one Windows account. Such a process can read another token, edit the
  database/code or invoke offline administration. SQLite is not encrypted.
- There is no background retention service, exactly-once delivery, per-device ACK,
  automatic message consumer or command/job execution. ACK is per principal;
  clients must save cursors and retry mutations with stable idempotency keys.
- The core caps the main DB at 128 MiB, not total WAL/SHM disk usage. Worker and
  waiter limits apply per server process. Busy contention returns bounded
  RESOURCE_EXHAUSTED; trusted cleanup/checkpoint and operator disk monitoring
  remain necessary. The measured stress workload is not a host-wide flood bound.
- Linux, packaged-wheel installation and unrestricted-token Windows were not run;
  this task's verified runtime is the Windows editable installation above.

## Final verification

On the final runtime/test sources, from `agent-mailbox`:

```powershell
.venv/Scripts/python.exe -m unittest discover -v
.venv/Scripts/python.exe -m compileall -q agent_mailbox tests
.venv/Scripts/python.exe -m pip check
git diff --check
git status --short
```

- **45 tests passed, zero failures/errors, zero skips, 96.627 seconds.**
- Cross-process long-poll: B was demonstrably still waiting before A sent from
  a different real stdio process; B received the committed message **0.141 s**
  after sending began (asserted below 2 s, against a requested 10 s wait).
- Stress: **2,000 messages × 1,024 bytes**, **8 writers**, **32 pollers**,
  **27.984 s**, **67,584,000 peak RSS bytes** (~64.45 MiB), **4,124,672 DB bytes**,
  **36 bounded busy retries**, under the enforced **1 GiB Windows Job limit**.
- Compileall, `pip check` and whitespace checks exited 0. Only the new project
  and root README table row appear in working-tree changes.
- Final verification includes the existing-parent ACL regression and successful
  authentication using the raw environment-token fallback, in addition to the
  file-token workflow. Expected restricted-token ACL warnings were visible;
  all original supported symlink/hardlink tests ran and passed on this host.

There are no implementation/test blockers. Normal-token Windows ACL application
and real Codex/Antigravity registration/model execution remain operator checks,
deliberately outside this build's authorized execution against real client state.

## Independent review resolution verification

Verified on 2026-10-25, Windows PowerShell **5.1.26100.9711**, Python **3.11.4**,
SQLite **3.42.0**, MCP **1.30.0**, branch `feat/mcp-baseline-recovery`.
Starting HEAD was `a8d496d` (reviewer changes already committed), with a clean
working tree. Build `0abd13a` was the comparison baseline. This resolution made
no commits, pushes, branch changes or dependency installs.

**12 findings are confirmed-fixed; F-07 is rejected-with-reason**. None is deferred.
At that verification, the original review's bytes remained an unchanged prefix of
[REVIEW_ANTIGRAVITY.md](REVIEW_ANTIGRAVITY.md); its appended Resolution records
each failure path, disposition, regression coverage and verification limits.
The follow-up below updates only two runnable commands in that original prefix
to include process-scoped execution-policy bypass; review findings remain intact.
Correct reviewer edits were retained. The parent-ACL test now observes
`private_directory` as well as the token's protection call. Forced native command
lookup was reverted after actual PowerShell 5.1 runs disproved F-07: the original
helper and an npm-style `.ps1` shim preserve `--` through to a native capture
program. Normal PowerShell command discovery and shim-only installations remain
supported; exact argv assertions cover native and shim forwarding.

New runtime behavior adds explicit per-client token-file selections to both
setup and registration, classifies inaccessible WAL/SHM metadata as retryable
storage exhaustion without skipping any link check, and counts session status
refreshes against the existing per-principal write quota. No schema migration
or connection-lifetime change was needed. Fourteen regression tests were added;
all 45 existing tests and their security/stress assertions remain.

Commands actually run from `agent-mailbox`:

```powershell
.\.venv\Scripts\python.exe -m unittest -v tests.test_review_resolution tests.test_auth
.\.venv\Scripts\python.exe -m unittest discover -v
.\.venv\Scripts\python.exe -m compileall -q agent_mailbox tests
.\.venv\Scripts\python.exe -m pip check
git diff --check
```

| Check | Actual result |
| --- | --- |
| Focused review/auth regressions | 19 passed, zero failures/errors/skips, 29.998 s; final full run also includes subsequent stronger rotation and expiry/close-race assertions |
| Intermediate full suite before F-07 rejection | 59 passed, zero failures/errors/skips, 127.337 s; superseded by final verification below |
| Final PowerShell forwarding regressions | 2 passed, zero failures/errors/skips, 2.554 s |
| **Full suite on final runtime/test sources** | **59 passed, zero failures/errors/skips, 135.232 s** |
| Real cross-process long-poll | Wake after send **0.141 s**, original <2 s assertion retained |
| Stress, enforced Windows Job 1 GiB limit | **2,000 messages x 1,024 bytes**, **8 writers**, **32 waiting consumers**, **27.250 s**, **66,543,616 peak RSS bytes** (~63.46 MiB), **4,128,768 DB bytes**, **35 bounded busy retries** |
| Compileall | Exit 0 |
| Dependency consistency | `No broken requirements found.` |
| PowerShell syntax | All **4** `.ps1` files parsed by actual Windows PowerShell 5.1 without errors |
| Final script previews | **6 passed**: setup, register, unregister, each with both `-WhatIf` and `-DryRun`; temporary directory remained empty |
| Additional previews inside full suite | Default paths, selected-client modes, and both principals' rotated token paths; fake CLI sentinels never invoked |
| Source parity | **11/13** core runtime blobs match `a5d3062` after newline normalization; only documented `database.py`/`sessions.py` deviations |
| Review preservation | Original `a8d496d` review intact, all **13** resolution rows present |
| Whitespace/scope | `git diff --check` passed; all changed/untracked source paths are inside `agent-mailbox/` |

The final verbose full-suite transcript is retained locally at ignored
`.test-results/review-unittest-final.txt`.

Failure-path checks also replayed original `0abd13a` functions/classes in memory
without replacing source files. They produced expected regression failures for
F-01, F-02, F-03, F-05, F-08, F-09, F-11 and F-12. The original database adapter
reported sidecar metadata denial as `UNAUTHENTICATED`; the unmetered session get
did not raise at quota; the original direct transaction left identity unbound.
An injected parent-directory protection call failed the strengthened F-10 test
under this host's restricted token. These expected negative probes are separate
from the green full suite.

Actual Windows PowerShell 5.1 runs of the original `common.ps1` reproduced both
F-06 failures: a relative state directory resolved against process CWD after
`Set-Location`, and a spaced path ending in backslash merged the following native
argument into the path. The same original helper passed `--` unchanged through
a temporary npm-style `.ps1` shim and native capture executable, disproving F-07.
The installed npm shim was inspected read-only and uses the same `$args` pattern;
the real Codex/Antigravity CLI was never invoked. Final regression assertions
require exact argv through native, competing-shim and shim-only installations.

SQLite WAL/SHM creation while connected and deletion on final close were
observed in a real temporary database. Permission denial was injected at the
actual `Path.lstat` boundary to verify pre-auth, direct transaction and later
MCP dispatch paths, retry recovery and closed link validation. The specific
NTFS DELETE_PENDING race was not naturally captured. Resolved repository
exclusion used real repository metadata with a controlled path-resolution
boundary; no subst drive or mount was created.

Rotation verification executed only Python admin commands extracted from
`setup.ps1 -WhatIf`, against explicit temporary state. The setup script itself
ran only in preview mode: no pip/install or registration occurred. Native argv
tests used temporary fake `.cmd`/`.ps1` fixtures. No real client CLI, client
configuration, `%LOCALAPPDATA%/agent-mailbox`, `~/.codex`, `~/.gemini`, remote
service, VPS or production endpoint was accessed.

That restricted-token run had no failures. Restricted-token ACL warnings were
expected and asserted; strict normal-token DACL assertions were conditional and
did not execute in the sandbox. Supported symlink/hardlink tests ran without
skips. The subsequent operator run below exposed failures outside the sandbox.

## Normal-user ACL and execution-policy fixes

Follow-up on 2026-10-25, preserving all uncommitted review-resolution changes on
`feat/mcp-baseline-recovery`. The operator reported **59 tests, 4 failures and
14 errors** under a normal, unrestricted user token. The sandbox's prior green
run did not exercise normal-token ACL persistence or Restricted script policy.

`owner_only()` now calls .NET `Directory.SetAccessControl` / `File.SetAccessControl`
on a fresh security descriptor with only its DACL modified. This avoids `Set-Acl`
provider writes of owner/SACL sections and the reported `SeSecurityPrivilege`
failure. Restricted-token failures still emit the inherited-ACL warning;
unrestricted-token failures still raise `OSError` before protected data is written.

`AdminTests.test_owner_only_spaced_file_and_directory` uses TEMP paths with spaces
for both object types. On an unrestricted Windows token it independently reads
the actual DACL through Win32 and requires protection from inheritance, exactly
one allow ACE for the current user SID, full control and the correct directory
inheritance flags. Those strict DACL assertions are explicitly conditional on an
unrestricted token. In this restricted sandbox the test instead requires the
warning/failure fallback for both objects; no test is skipped or weakened.

All script tests now invoke `powershell.exe -NoProfile -ExecutionPolicy Bypass
-File <script> ...` (also using `-NonInteractive`). They explicitly inherit
`PSExecutionPolicyPreference=Restricted` before the command-line process override,
including the temporary script that dot-sources `common.ps1` and executes fake
PowerShell/native CLI fixtures. Project/scripts README commands and the review's
Interop run instructions use the same process-only bypass. No machine/user
execution policy is changed.

Verification of the final sources is recorded below. The unrestricted full-suite
run, including both strict file/directory ACL assertions, is **pending operator
verification**; this sandbox cannot establish those results.

Final checks on this restricted Windows token:

| Check | Actual result |
| --- | --- |
| Full suite, including the corrected inherited Restricted-policy setup | **60 passed, zero failures/errors/skips, 127.775 s** |
| Spaced directory/file ACL regression | Both restricted-token warning/failure checks passed; unrestricted-only DACL assertions were not executed |
| Normal-token ACL failure classification | Existing injected ACL-failure test still requires `OSError`; passed |
| Execution-policy negative control, TEMP fixture only | Without Bypass, inherited Restricted blocked the script; with process-only Bypass, it ran and reported effective policy `Bypass` |
| Real cross-process long-poll | Wake after send **0.125 s**, original <2 s assertion retained |
| Stress, Windows Job 1 GiB limit | **2,000 messages**, **8 writers**, **32 waiters**, **27.313 s**, **67,276,800 peak RSS bytes**, **4,128,768 DB bytes**, **32 bounded busy retries** |
| Compileall / dependency consistency | Exit 0 / `No broken requirements found.` |
| Whitespace / scope | `git diff --check` passed; changes remain inside `agent-mailbox/` |

The final full-suite transcript is retained at ignored
`.test-results/user-token-fixes-unittest-final.txt`. The full-suite command was
`.\.venv\Scripts\python.exe -m unittest discover -v`, streamed to that transcript
through a Python subprocess runner. The policy controls used temporary files and
process environment/command-line settings only. No real client registration,
default state, `~/.codex`, `~/.gemini`, VPS or production access was performed.
No commit or push was made; the existing review-resolution changes remain
uncommitted alongside these fixes. **Unrestricted full-suite verification remains
pending the operator**, including both actual protected owner-only DACL assertions.
