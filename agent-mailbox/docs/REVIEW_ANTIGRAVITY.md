# Independent Senior Security & Correctness Review (`agent-mailbox`)

Reviewer: Antigravity (independent review session)
Scope: `agent-mailbox/` (adapter runtime, vendored core integration, PowerShell 5.1 scripts, unit/integration/stdio tests, and documentation).

---

## Summary of Review Coverage

| Area | Assessment |
| --- | --- |
| Authentication & identity binding | Process-bound token verification runs before FastMCP argument validation (`AuthenticatedMCP.call_tool`) and inside every SQLite transaction (`AuthenticatedDatabase.transaction`). Constant-time HMAC-SHA256 (`hmac.compare_digest`) is used, including a dummy digest on unknown token IDs. Fixed a direct-transaction principal-binding gap and redundant double-verification in `AuthenticatedDatabase`. |
| Token handling & storage | Plaintext tokens are never stored in SQLite (only `token_id`, 256-bit random salt, and HMAC-SHA256 digest). CLI errors redact exceptions, and `admin add-principal` omits plaintext tokens unless `--print-token` is passed. Added `*.token` and `tokens/` to `.gitignore` and fixed `add-principal` pre-checks and ACL re-application. |
| Session & mailbox ACLs | All 13 session/mailbox tools enforce `session_acl` membership inside each transaction and return `NOT_FOUND` to non-participants and `FORBIDDEN` to non-owners on owner-only operations (`session_renew`, `session_close`, `mailbox_create`). No tool argument can select or override `principal_id`. |
| Cross-process long-poll & SQLite WAL | `MailboxService.receive` polls every 200 ms without holding a SQLite connection across `await asyncio.sleep(...)`, re-verifying token revocation, principal enabled status, ACL grant, and session expiry/closure on every snapshot. Identified WAL unlink churn and Windows `DELETE_PENDING` `PermissionError` handling in the vendored core. |
| PowerShell 5.1 scripts & client CLI | Verified `codex mcp add ... --` and `agy mcp add [--env ...] <name> <command> [args...]` flag ordering. Fixed relative `-StateDir` resolution against PowerShell `$PWD`, trailing-backslash native argv corruption (`\"`), and npm `.ps1` shim `--` swallowing. |

---

## Findings Table (Ordered by Severity)

Count by severity: **0 Critical, 4 High, 6 Medium, 3 Low**.

| ID | Severity | File:Line | Failure Scenario | Status |
| --- | --- | --- | --- | --- |
| F-01 | High | `agent_mailbox/paths.py:35-48`, `agent_mailbox/paths.py:51-59` | **Repository exclusion bypass via resolved paths (`subst` / volume mounts) and empty-path fallback.** Previously, `safe_path()` checked `(path, *path.parents)` for `.git` and reparse points only on the lexical path `Path(value).expanduser().absolute()`, then returned `path.resolve()` without checking ancestors of the resolved path. If a Windows `subst` drive or mount point (e.g., `subst Z: E:\thieuh\FolderCode\codespace1\agent-mailbox`) maps into a subdirectory of a Git repository where `.git` is above the mapped root, lexical ancestors (`Z:\state`, `Z:\`) have neither `.git` nor reparse attributes, while `path.resolve()` resolves into the Git repository (`E:\...\agent-mailbox\state`) and writes `mailbox.db` and tokens inside the repo. Additionally, passing `--state-dir ""` or `--token-file ""` was treated as falsy (`value or ...`), silently falling back to default paths instead of failing closed. | `fixed-by-reviewer` |
| F-02 | High | `agent_mailbox/admin.py:28-30`, `agent_mailbox/admin.py:41-46`, `README.md:107-110` | **Re-running setup from normal PowerShell does not re-apply owner-only ACLs to existing token files or `mailbox.db`.** `README.md:108-110` instructs operators that if initial setup runs under a restricted Windows token (which warns and leaves inherited ACLs), they should re-run `setup.ps1` from a normal PowerShell session to apply private ACLs. However, `admin add-principal <id> --if-missing` returned early (`created: false`) without calling `owner_only(path)` on the existing token file, and `admin init` only called `owner_only()` on `home` and `home/tokens`, never on `mailbox.db`. Any custom `--token-file` (whose parent ACL is untouched by design) or POSIX file created under a permissive mode remained unprotected after re-running setup. | `fixed-by-reviewer` |
| F-03 | High | `agent_mailbox/admin.py:34-53` | **`admin add-principal` mutates `principals` before checking token file existence, overwrites custom labels on `--rotate`, and issues dead tokens to disabled principals.** (1) `provisioner.principal()` committed a write transaction to `principals` before `issue_token()` checked `if path.exists(): raise ValueError(...)`. Running `admin add-principal newagent --token-file <existing.token>` or `admin add-principal codex --rotate` (without a new `--token-file`) failed with exit code 1 but left `newagent` committed in `principals` (or overwrote `codex`'s label). (2) Running `admin add-principal codex --rotate --token-file ...` without `--label` (as documented in `README.md:48`) evaluated `args.label or args.id`, overwriting any custom `--label` previously set for `codex`. (3) Running `add-principal <id> --rotate` on a principal disabled via `admin disable <id>` (`enabled=0`) succeeded and wrote a new token file that immediately failed every MCP call with `UNAUTHENTICATED`. | `fixed-by-reviewer` |
| F-04 | High | `scripts/setup.ps1:21-23`, `scripts/register-clients.ps1:14-16`, `agent_mailbox/auth.py:67-68`, `README.md:20-21,48-49` | **Post-rotation breakage in `setup.ps1` and `register-clients.ps1`.** By design (`BUILD_REPORT.md:77`), `issue_token(..., rotate=True)` rejects existing filenames (`Token file already exists; choose a new path when rotating`), and `README.md:48` instructs operators to rotate to `tokens\codex-new.token`. After doing so, the old `tokens\codex.token` still exists on disk with the deleted credential. Re-running `.\scripts\setup.ps1` invokes `admin add-principal codex --if-missing` (defaulting to `tokens\codex.token`), which fails `verify()` on the old token file and aborts `setup.ps1`. Furthermore, `.\scripts\register-clients.ps1` hardcodes `tokens\<principal>.token` (with no `-TokenFile` option), so running it after rotation registers the invalidated `tokens\codex.token` instead of `codex-new.token`. | `needs-fix` |
| F-05 | Medium | `agent_mailbox/auth.py:106-123` | **`AuthenticatedDatabase.transaction()` fails to bind `bound_principal` when called before `authenticate()`, and `authenticate()` runs `verify()` twice per call.** Previously, `transaction()` checked `if self.bound_principal is not None and self.bound_principal != principal:` but never assigned `self.bound_principal = principal`. If a caller invoked `SessionService(db)` or `MailboxService(db)` without calling `db.authenticate()` first, `bound_principal` remained `None` indefinitely, allowing an offline `local_credentials.principal_id` remap to switch the process's principal mid-run. Additionally, `authenticate()` opened `with self.transaction() as conn:` (which already called `verify()`) and then called `verify()` a second time inside the `with` block. | `fixed-by-reviewer` |
| F-06 | Medium | `scripts/common.ps1:6-21` | **PowerShell 5.1 relative `-StateDir` resolution against process CWD and trailing-backslash `\"` argv corruption.** (1) `Get-MailboxStateDir` called `[System.IO.Path]::GetFullPath($Value)` directly. Because PowerShell `Set-Location` (`cd`) updates `$PWD` (`(Get-Location).ProviderPath`) without updating `[System.Environment]::CurrentDirectory`, passing a relative `-StateDir ..\state` resolved against the initial Win32 process directory instead of `$PWD`. (2) Passing `-StateDir "D:\Agent State\"` (standard PowerShell tab-completion with a trailing backslash and space) preserved the trailing `\`. When PowerShell 5.1 passes `"D:\Agent State\"` or `"AGENT_MAILBOX_HOME=D:\Agent State\"` to native executables, it formats the Win32 command line with a trailing `\"`, which `CommandLineToArgvW` parses as an escaped double quote, merging subsequent arguments (`admin init` or `--env`) into the path. | `fixed-by-reviewer` |
| F-07 | Medium | `scripts/common.ps1:23-32`, `scripts/register-clients.ps1:18-20` | **PowerShell 5.1 strips `'--'` when splatting `@Arguments` to npm's `codex.ps1` shim.** On Windows, npm installs both `codex.ps1` (`ExternalScript`) and `codex.cmd` (`Application`), and PowerShell command discovery prefers `codex.ps1`. When `& 'codex' @Arguments` splats an array containing `'--'` to a `.ps1` script, PowerShell 5.1's script parameter binder consumes `'--'` as its own end-of-parameters token and strips `'--'` from `$args` before `codex.ps1` forwards `$args` to the binary. `codex mcp add` then receives `-I` and `-m` before `--` and fails with `error: unexpected argument '-I' found`. | `fixed-by-reviewer` |
| F-08 | Medium | `agent_mailbox/__main__.py:9-40`, `README.md:24-38` | **`--state-dir` is rejected when appended after the `admin <action>` subcommand.** `parser()` added `--state-dir` to the root parser, `serve`, and `admin`, but not to the `admin` action subparsers (`init`, `add-principal`, `revoke`, `disable`, `list-principals`, `cleanup`, `create-shared-session`). Running a command from `README.md:32-36` with `--state-dir D:\AgentState` appended at the end (e.g., `python -m agent_mailbox admin init --state-dir D:\AgentState`) failed with `unrecognized arguments: --state-dir`. | `fixed-by-reviewer` |
| F-09 | Medium | `agent_mailbox/core/database.py:50-74,88-96`, `agent_mailbox/auth.py:116-123` | **Per-transaction connection open/close causes continuous WAL unlink churn and unhandled Windows `DELETE_PENDING` `PermissionError`.** `Database.transaction()` opens and closes a SQLite connection on every transaction, and long-polls hold no connection between 200 ms ticks. Whenever the last open connection closes, SQLite automatically checkpoints and unlinks `mailbox.db-wal` and `mailbox.db-shm`. Under concurrent cross-process polling/writing on Windows NTFS, unlinking `-wal`/`-shm` briefly places them in `DELETE_PENDING` state, causing a concurrent `candidate.lstat()` in `Database._check_path()` to raise `PermissionError` (`[WinError 5]`). Because `_check_path()` only catches `FileNotFoundError`, a `PermissionError` during `authenticate()` is misclassified by `auth.py:122` as `UNAUTHENTICATED`, and during tool execution escapes `Database.transaction()` (which only catches `sqlite3.Error`) and returns `INTERNAL` instead of `RESOURCE_EXHAUSTED`. (Vendored `core/` left unmodified to preserve `a5d3062` blob parity.) | `needs-fix` |
| F-10 | Medium | `tests/test_auth.py:26-45` | **`test_custom_token_path_does_not_change_existing_parent_permissions` could pass without proving its claim under restricted Windows tokens.** In the restricted Windows token environment where the test suite runs (`BUILD_REPORT.md:186-194`), `owner_only()` cannot modify DACLs (`Set-Acl` fails, warns, and leaves the DACL unchanged). Therefore, comparing `parent`'s SDDL before and after `issue_token()` passes even if `issue_token()` regresses and calls `private_directory(path.parent)` on an existing parent directory. Strengthened the test to also assert `owner_only` is called exclusively on `token_path.resolve()` and never on `parent`. | `fixed-by-reviewer` |
| F-11 | Low | `agent_mailbox/core/sessions.py:41-47`, `docs/MAILBOX_API.md:77-78` | **`session_get` executes unthrottled `BEGIN IMMEDIATE` write transactions (`PRAGMA synchronous=FULL`) for any granted participant.** `docs/MAILBOX_API.md:77-78` claims a limit of `120 new mutations/principal/minute`, but `SessionService.get()` updates `logical_sessions.last_seen` in a write transaction without calling `self.rate(db, pid)`, even when the session is closed or expired. A participant can call `session_get` in a tight loop to contend for the SQLite write lock without hitting the per-principal write rate limit. (Vendored `core/` left unmodified.) | `needs-fix` |
| F-12 | Low | `agent_mailbox/admin.py:86-99` | **`create-shared-session` mutates `last_seen` on expired sessions and has a TOCTOU race between `sessions.get()` and `sessions.renew()`.** Previously, `create-shared-session` ran `sessions.renew(row[0], args.ttl_seconds) if sessions.get(row[0])["status"] == "active" else None`. When an existing session had expired (`status='active'` in SQL, `expires_at <= now`), `sessions.get(row[0])` executed a write transaction updating `last_seen` on the expired session before discarding it, and if expiry occurred between `get()` and `renew()`, `renew()` raised an unhandled `GatewayError("EXPIRED")` instead of opening a new session. | `fixed-by-reviewer` |
| F-13 | Low | `.gitignore:1-12`, `tests/test_admin.py:119-143` | **Missing `*.token` / `tokens/` in `.gitignore` and missing `codex` assertion in dry-run registration test.** (1) `.gitignore` excluded `*.db*`, `*.sqlite*`, and `*.log` but not `*.token` or `tokens/`. (2) `test_registration_dry_run_and_powershell_51_syntax` verified flag ordering on the `agy` output line from `register-clients.ps1 -WhatIf` but never inspected the `codex` output line (`'codex' 'mcp' 'add' ... 'agent_mailbox' '--' ...`). | `fixed-by-reviewer` |

---

## Files Edited by Reviewer and Why

1. [`agent-mailbox/.gitignore`](file:///E:/thieuh/FolderCode/codespace1/agent-mailbox/.gitignore)
   - Added `*.token` and `tokens/` so token files or token directories accidentally created inside the repository tree are ignored by Git (F-13).
2. [`agent-mailbox/agent_mailbox/__main__.py`](file:///E:/thieuh/FolderCode/codespace1/agent-mailbox/agent_mailbox/__main__.py)
   - Registered `--state-dir` (`default=argparse.SUPPRESS`) on each subparser in `admin` (`init`, `add-principal`, `revoke`, `disable`, `list-principals`, `cleanup`, `create-shared-session`) so `--state-dir` works whether placed before `admin`, after `admin`, or at the end of the command line (F-08).
3. [`agent-mailbox/agent_mailbox/paths.py`](file:///E:/thieuh/FolderCode/codespace1/agent-mailbox/agent_mailbox/paths.py)
   - Rejected empty/whitespace path strings in `safe_path()`, checked ancestor links/reparse points and `.git` directories on both lexical and resolved paths, and changed `state_home()` so an explicit empty `--state-dir ""` is rejected rather than falling back to defaults (F-01).
4. [`agent-mailbox/agent_mailbox/auth.py`](file:///E:/thieuh/FolderCode/codespace1/agent-mailbox/agent_mailbox/auth.py)
   - Set `self.bound_principal = principal` inside `AuthenticatedDatabase.transaction()` so principal binding is enforced even when transactions run without a prior `authenticate()` call, and removed the redundant second `verify()` call inside `authenticate()` (F-05).
5. [`agent-mailbox/agent_mailbox/admin.py`](file:///E:/thieuh/FolderCode/codespace1/agent-mailbox/agent_mailbox/admin.py)
   - Applied `owner_only()` to `mailbox.db` on `admin init` and to the existing token file on `admin add-principal --if-missing` (F-02).
   - In `add-principal`, rejected disabled principals (`enabled=0`), checked `path.exists()` before `provisioner.principal()` to avoid mutating `principals` when token creation fails, preserved existing custom labels on `--rotate` when `--label` is omitted, and rejected `--token-file ""` (F-01, F-03).
   - In `create-shared-session`, replaced the `sessions.get()` pre-check before `sessions.renew()` with a `try ... except GatewayError` around `sessions.renew()` so expired sessions do not have `last_seen` overwritten and cannot fail in a TOCTOU window (F-12).
6. [`agent-mailbox/scripts/common.ps1`](file:///E:/thieuh/FolderCode/codespace1/agent-mailbox/scripts/common.ps1)
   - In `Get-MailboxStateDir`, resolved relative paths against `(Get-Location).ProviderPath` and trimmed trailing directory separators (`\`, `/`) to prevent Windows PowerShell 5.1 `\"` native command-line quoting corruption on paths with spaces (F-06).
   - In `Invoke-MailboxCommand`, resolved executables with `Get-Command -CommandType Application` when not in preview mode so npm `.ps1` shims (`codex.ps1`) cannot strip the `'--'` separator during PowerShell script parameter binding (F-07).
7. [`agent-mailbox/tests/test_auth.py`](file:///E:/thieuh/FolderCode/codespace1/agent-mailbox/tests/test_auth.py)
   - Strengthened `test_custom_token_path_does_not_change_existing_parent_permissions` to assert `owner_only` is called only once on `token_path.resolve()` (proving the parent is untouched even under restricted Windows tokens) (F-10), and verified in `test_process_cannot_rebind_to_another_principal_and_disabled_rechecked` that `AuthenticatedDatabase.transaction()` binds `bound_principal` before `authenticate()` is called (F-05).
8. [`agent-mailbox/tests/test_admin.py`](file:///E:/thieuh/FolderCode/codespace1/agent-mailbox/tests/test_admin.py)
   - Verified custom `--label` preservation across `--rotate`, `--state-dir` placement after `admin init`, empty path rejection in `safe_path("")`, and `'codex'` argument/flag ordering in `test_registration_dry_run_and_powershell_51_syntax` (F-01, F-03, F-08, F-13).

*(All 13 vendored files in `agent_mailbox/core/` were left completely untouched.)*

---

## Interop Test Plan (`codex` <-> `antigravity` over `collab`)

### Preconditions

1. Provision external state and register both clients from an ordinary Windows PowerShell 5.1 session:
   ```powershell
   cd E:\thieuh\FolderCode\codespace1\agent-mailbox
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-clients.ps1
   ```
2. Verify offline state has active principals `codex` and `antigravity` (`enabled: 1, revoked: 0`):
   ```powershell
   .\.venv\Scripts\python.exe -m agent_mailbox admin list-principals
   ```

### Scenario 1: Sequential Ping-Pong with Cursor & Idempotency Persistence

1. **Identity & Discovery (both agents)**:
   - **Codex** calls `whoami()` -> expects `{"schema_version": 1, "principal_id": "codex"}`.
   - **Antigravity** calls `whoami()` -> expects `{"schema_version": 1, "principal_id": "antigravity"}`.
   - Both call `session_list()` and locate the active session named `"collab"` (`session_id = <SID>`).
   - Both call `mailbox_list({"session_id": "<SID>"})` and locate the mailbox named `"collab"` (`mailbox_id = <MID>`).
2. **Ping (`codex` -> `antigravity`)**:
   - **Codex** calls:
     ```json
     {"mailbox_id": "<MID>", "text": "PING from codex: ready for review", "correlation_id": "interop-1", "idempotency_key": "codex-ping-1"}
     ```
     Expects `sequence: 1`, `duplicated: false`, `message_id: "<MSG_PING>"`.
   - **Codex** retries the exact same `mailbox_send` call with `idempotency_key: "codex-ping-1"` -> expects `duplicated: true` and the identical `message_id: "<MSG_PING>"` and `sequence: 1`.
3. **Receive, ACK, and Pong (`antigravity` -> `codex`)**:
   - **Antigravity** calls `mailbox_receive({"mailbox_id": "<MID>", "limit": 20, "wait_seconds": 0})`.
   - Expects `messages[0]` with `message_id: "<MSG_PING>"`, `sender_label: "codex"`, `text: "PING from codex: ready for review"`, `acknowledged: false`, and saves `next_cursor = "<CURSOR_1>"`.
   - **Antigravity** calls `mailbox_ack({"mailbox_id": "<MID>", "message_id": "<MSG_PING>"})` -> expects `{"acknowledged": true}`.
   - **Antigravity** calls `mailbox_reply`:
     ```json
     {"mailbox_id": "<MID>", "in_reply_to": "<MSG_PING>", "text": "PONG from antigravity: ACKed", "idempotency_key": "agy-pong-1"}
     ```
     Expects `sequence: 2`, `in_reply_to: "<MSG_PING>"`, `message_id: "<MSG_PONG>"`.
4. **Incremental Cursor Receive & Per-Principal ACK Isolation (`codex`)**:
   - **Codex** calls `mailbox_get_message({"mailbox_id": "<MID>", "message_id": "<MSG_PING>"})` -> expects `acknowledged: false` (proving `antigravity`'s ACK is isolated per principal).
   - **Codex** calls `mailbox_receive({"mailbox_id": "<MID>", "after_cursor": "<CURSOR_1>", "limit": 20})` (or from initial cursor after saving the cursor from `sequence: 1`) -> receives only `sequence: 2` (`<MSG_PONG>`, `in_reply_to: "<MSG_PING>"`, `sender_label: "antigravity"`), and saves `next_cursor = "<CURSOR_2>"`.
   - **Codex** calls `mailbox_ack({"mailbox_id": "<MID>", "message_id": "<MSG_PONG>"})`.

### Scenario 2: Concurrent Cross-Process Long-Poll Variant

1. **Start Long-Poll Waiter First (`antigravity`)**:
   - Using saved `<CURSOR_2>` (where no newer messages exist), **Antigravity** invokes:
     ```json
     {"mailbox_id": "<MID>", "after_cursor": "<CURSOR_2>", "limit": 20, "wait_seconds": 15}
     ```
   - Confirm the call blocks waiting for new messages (holding no SQLite lock between 200 ms poll snapshots).
2. **Concurrent Send From Separate Stdio Process (`codex`)**:
   - Between `t = 1s` and `t = 3s` after **Antigravity** starts waiting, **Codex** (in its own separate `python -m agent_mailbox serve` process) invokes `mailbox_send`:
     ```json
     {"mailbox_id": "<MID>", "text": "WAKE from codex during long-poll", "correlation_id": "interop-2", "idempotency_key": "codex-wake-1"}
     ```
3. **Wake Verification (`antigravity`)**:
   - **Antigravity**'s blocked `mailbox_receive` call must return within **< 1 second** of **Codex**'s `mailbox_send` commit (well before the 15-second timeout), yielding `sequence: 3` (`"WAKE from codex during long-poll"`) and `<CURSOR_3>`.
4. **Owner vs Participant ACL Check**:
   - **Antigravity** (participant, non-owner) calls `session_renew({"session_id": "<SID>"})` and `session_close({"session_id": "<SID>"})` -> both must fail with `isError: true` and `error.code == "FORBIDDEN"`.
   - **Codex** (owner) calls `session_renew({"session_id": "<SID>", "ttl_seconds": 604800})` -> succeeds with `status: "active"`.


---

## Resolution (verified 2026-10-25)

The original review above is preserved, except that the two Interop setup commands
now use process-only `-ExecutionPolicy Bypass` for Restricted-policy machines.
The working tree was clean at
start: reviewer changes were already committed in `a8d496d`, following build
`0abd13a`. Every changed file in that commit was inspected against the build.
**12 findings are confirmed-fixed; F-07 is rejected-with-reason**. No finding is deferred.
The qualifications below distinguish deterministic failure-path verification
from host conditions that were not reproduced naturally.

| ID | Resolution | Verified failure path, disposition and regression evidence |
| --- | --- | --- |
| F-01 | confirmed-fixed | Retained lexical AND resolved ancestor checks and explicit empty-path rejection. The old implementation returns a resolved repository path unchecked; empty CLI paths select defaults. `PathReviewTests.test_resolved_repository_and_explicit_empty_paths_fail_closed` checks real repository metadata across a controlled alias-resolution boundary, empty/whitespace state paths and token-file failure without environment fallback. Admin regression also rejects an empty token filename. No system drive mapping was created. |
| F-02 | confirmed-fixed | Retained `owner_only(mailbox.db)` on init and `owner_only(token_file)` on reuse. Repeated initialization previously protected directories only, and the token reuse branch returned before protecting the file. `AdminReviewTests.test_init_and_if_missing_reapply_file_protection` invokes real admin actions, observes both file protection calls and retains real ACL/mode application. Existing normal-token ACL assertions remain unchanged. |
| F-03 | confirmed-fixed | Retained existing-path/disabled-principal checks before provisioning and existing-label preservation. The original `Provisioner.principal()` commits before exclusive token creation rejects an existing filename. `test_rejected_provisioning_preserves_principals_credentials_and_labels` proves rejected commands leave no new principal, do not relabel or change credentials, and cannot issue a token to a disabled identity. Existing `test_admin_roundtrip_tokens_acl_idempotency_rotation_and_revoke` proves rotation preserves a custom label and revokes the old credential. |
| F-04 | confirmed-fixed | Reproduced rotating both principals, leaving invalid default files and observing default `--if-missing` fail `UNAUTHENTICATED`. Added `-CodexTokenFile` / `-AntigravityTokenFile` to setup AND registration; paths are absolute and relative values resolve from PowerShell `$PWD`. `test_rotated_tokens_flow_through_setup_and_registration_previews` executes only the Python admin commands extracted from setup's preview against temporary state, then verifies registration's preview selects the same live files, old credentials remain invalid, and neither token contents nor files change. README explains carrying these overrides into subsequent runs; revoked tokens are never automatically restored or discovered by scanning. |
| F-05 | confirmed-fixed | Retained first-successful-transaction binding and single verification in `authenticate()`. The reviewer's expanded test still authenticated before remapping, so it did not independently exercise the earlier gap. Added `test_first_direct_transaction_binds_before_any_authenticate`: direct service transaction, actual credential remap, then direct service rejection before any `authenticate()` call. `test_authenticate_verifies_once` covers redundant verification. |
| F-06 | confirmed-fixed | Retained `$PWD`-relative resolution and trailing-separator normalization. `PowerShellReviewTests.test_relative_state_native_argv_and_powershell_shim_forwarding` runs actual Windows PowerShell 5.1, changes its location independently of process CWD, resolves a relative path with spaces/trailing slash, and checks exact argv captured by a temporary native-command fixture. Setup/registration rotation previews also cover absolute state paths with spaces/trailing slash. |
| F-07 | rejected-with-reason | Actual Windows PowerShell 5.1 execution of the original helper and an npm-style `.ps1` shim forwards `["mcp","add","--","-I","-m","agent_mailbox"]` unchanged to a native capture executable. Read-only inspection of the installed `codex.ps1` confirms the same `$args` forwarding pattern. The claimed binder consumption does not occur. Reverted the reviewer's forced `Application` lookup: it adds an unnecessary compatibility restriction and can bypass the selected PowerShell shim. The argv regression now requires identical correct forwarding through a native `.cmd`, competing `.ps1`/`.cmd` entries, and a `.ps1`-only entry. No real client CLI was executed. |
| F-08 | confirmed-fixed | Retained `argparse.SUPPRESS` declarations on all seven admin action parsers, which avoid overwriting an earlier state selection. `test_state_dir_at_every_admin_parser_level` covers all seven actions at all three option positions. The original parser rejects the trailing position. |
| F-09 | confirmed-fixed | A real `Path.lstat()` failure on WAL/SHM previously becomes `UNAUTHENTICATED` during authentication and escapes as `PermissionError` during a direct service transaction. Changed only sidecar metadata denial to fail closed with bounded retryable `RESOURCE_EXHAUSTED`; SQLite is never opened with unchecked sidecars. `test_sidecar_permission_denial_is_retryable_before_sql_and_during_dispatch` injects that OS failure at the actual filesystem boundary, covers pre-auth and later dispatch snapshots, successful full-operation retry, and matching MCP text/structured errors. `test_sidecar_links_still_rejected_after_permission_denial` retains hardlink rejection and recovery; original symlink/reparse tests remain. SQLite's last-close sidecar unlink is observed separately. The exact NTFS DELETE_PENDING scheduling race was not captured naturally, so that specific cause remains an inference. Connection-per-transaction lifetime and bounded polling are preserved. |
| F-10 | confirmed-fixed | Confirmed that actual SDDL equality alone is insufficient under a restricted token. Repaired the reviewer test: its spy on `auth.owner_only` cannot see `paths.private_directory` calling `paths.owner_only`. Kept the real permission comparison and file-call assertion, and additionally require `auth.private_directory` never to be called for an existing parent. An injected parent-protection regression now causes the test to fail even on this restricted host. |
| F-11 | confirmed-fixed | Added `self.rate(db, pid)` after ACL authorization and before `last_seen` update, in the same transaction. `test_get_refresh_consumes_participant_quota_and_rolls_back_when_exhausted` exercises active/closed/expired sessions, a granted participant's limit, unchanged `last_seen` after rejection, next-window recovery, read-only listing and unauthorized callers not consuming quota. Docs clarify that quotas bound accepted writes, not attempted lock acquisitions/requests. |
| F-12 | confirmed-fixed | Retained direct renewal with narrowly handled `EXPIRED`/`CONFLICT`; other errors still propagate. `test_expired_shared_session_replaced_without_refreshing_history` verifies the original expired session's sentinel `last_seen` stays unchanged. `test_shared_session_handles_expiry_and_close_races_but_preserves_other_errors` changes real state between selection and renewal, covers both expiry and close, verifies replacement, and ensures quota failures are not swallowed. |
| F-13 | confirmed-fixed | Retained both ignore patterns and all added Codex/Antigravity flag-order assertions; these strengthen the existing tests. `test_client_selection_and_dryrun_have_no_cli_side_effects` additionally covers both preview switches and selected-client modes with temporary CLI sentinels, absent token/state paths, and no CLI invocation or state creation. Ignore patterns are accidental-commit protection; repository path rejection remains the runtime boundary. |

### Reviewer edit audit

- Kept `.gitignore`, `__main__.py`, `paths.py`, `admin.py` and their correct
  behavioral fixes, after adding the regressions above.
- Kept the `auth.py` fix and both reviewer's existing authentication assertions;
  added an independent test that remaps identity before authentication.
- Kept `common.ps1` path normalization fixes. Reverted forced native command
  lookup after disproving F-07; verified exact argv through both native commands
  and npm-style PowerShell shims, including a shim-only installation.
- Kept every original assertion in `tests/test_admin.py` and `tests/test_auth.py`.
  Strengthened the parent-permission test to observe the missing call boundary.
  No original tests were skipped, weakened, removed or given looser limits.
- Two local core changes (`database.py`, `sessions.py`) are intentional deviations
  from `a5d3062`; updated provenance documents them. The other eleven runtime
  blobs and SQL migration retain source parity after newline normalization.

### Verification boundaries

Regression probes loaded original `0abd13a` functions into memory without
replacing files. They produced expected failures for resolved-path exclusion,
ACL reapplication, provisioning prechecks, direct identity binding, admin option
placement, sidecar error mapping, session refresh quota, and expired-session
history. An injected parent-ACL regression also failed the strengthened test.
Separate baseline PowerShell runs reproduced F-06's wrong relative CWD and
trailing-backslash argument merging, while disproving F-07's separator claim.
The full suite and measured results are recorded in
[BUILD_REPORT.md](BUILD_REPORT.md#independent-review-resolution-verification).

Only project sources and temporary test fixtures were written. No setup script
was executed outside preview mode, no registration/removal touched real configs,
no default operator state or home client configs were accessed, and no remote
production/VPS contact, commit or push was performed. Actual unrestricted-token
ACL application and live client/model exchange remain operator checks outside
this task's authorized execution; they are not deferred code fixes.
