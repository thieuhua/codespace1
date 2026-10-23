# Codex TASK — Port Session + Mailbox MVP onto the REAL production-main baseline

## Objective
Complete the Session + Mailbox MVP on top of the current GitHub origin/main for thieuhua/codespace1, preserving ALL existing 16 production tools and privilege boundaries. The user wants these tested changes eventually integrated into origin/main, NOT deployed on the VPS.

## Verified repositories and refs (2026-10-23)
- Windows repository: E:\thieuh\FolderCode\codespace1
- Dedicated worktree for this task: E:\thieuh\FolderCode\codespace1-mainline
- Worktree branch: feat/mcp-mailbox-on-main, parent origin/main b4b3f1ef7fec01c5b63c384173eb3d6bc2d21321.
- origin/main sequence: a8cc37a (old 6-tool code) -> b3f7ef1 (import exact deployed production files) -> b4b3f1e (remove obsolete old single-process source and prototypes).
- Canonical code: vps-mcp/gateway.py, worker.py, broker.py; vps-mcp/PRODUCTION.md and deploy/production/.
- Production 16 MCP tools: projects, list_files, read_file, write_file, mkdir, rename, remove, git_status, run_tests, run_shell, start_job, job_status, read_job_log, stop_job, request_protected, execute_protected.
- Existing completed MVP source branch in the SAME Git object database: feat/mcp-session-mailbox-mvp, tip 8a73554, commits 4c8816d (M0), d8d164a (M1), a2e6c69 (M2), 1ec7d3f (M3), 8a73554 (M4).
- An earlier recovery prompt exists on feat/mcp-baseline-recovery at 8f55cb0. It was produced under a stale premise. This current prompt supersedes it; DO NOT run a redundant baseline search.
- Windows MVP previously reported 46 passing tests + stress 2,000 messages. Those results describe old source, NOT evidence of correctness on production-main.

## Our mistake, do not repeat
The previous assistant chose origin/feat/vps-mcp-approval-design (1739e6f) as the MVP base even though the actual running 16-tool interface was known. It then treated an out-of-date main ref as authoritative and designed unnecessary baseline recovery. GitHub current main has already been updated with exact production sources and cleanup. Trust the verified b4b3f1e main baseline, do not recreate/replace it.

## Mandatory constraints
1. Work ONLY on E:\thieuh\FolderCode\codespace1-mainline / feat/mcp-mailbox-on-main. Never modify production, restart/touch MCP/tunnel/broker services, deploy, access secrets, approval DB, or connect to live MCP endpoint for testing. Do not use VPS tool operations to modify its own installation.
2. Preserve feat/mcp-session-mailbox-mvp and its five original commits unchanged. Never reset/rebase/force-push main; never overwrite root-owned release code.
3. Do NOT cherry-pick M0–M4 wholesale. Those commits modify obsolete server.py, smoke_test.py, prototypes and CI, none of which belong in production-main. Port desired logic file-by-file and document provenance.
4. Existing gateway.py, worker.py, broker.py, deployment units and owner approval semantics form the baseline. Avoid changes to worker/broker and privileged policy for this feature except explicitly justified tested necessity. All 16 original MCP tool schemas and behavior must remain intact.
5. CRITICAL MODULE COLLISION: old MVP has package vps-mcp/gateway/ with __init__.py; main already has vps-mcp/gateway.py. DO NOT copy gateway/ as-is. Rename transplanted package to vps-mcp/mailbox_core/ (or another clearly noncolliding name). Update every import, test, doc, CI path; verify imports resolve production gateway.py rather than a package shadow.
6. Security: a client-provided principal/client_id/session_id/header is NEVER trusted identity. There is no verified live identity adapter today: default UNAUTHENTICATED, no environment-variable principal bypass. Test identity injection only in isolated in-process tests. A usable runtime adapter requires proof of trusted provider identity and OS confinement before enabling shared mailbox.
7. Database state must NOT live in agent writable repositories or mcp-dev's accessible paths; no embedding into privileged approval store. Production deployment/identity provisioning remains owner-only and explicitly OUT OF SCOPE.
8. Keep lightweight architecture (Python 3.11, FastMCP, SQLite WAL, bounded workers/long-poll/storage), with no new external backend or dashboard.
9. No automated main rewrite. Committing feature work locally is permitted. Push/PR/merge gates are specified below; no VPS deployment, regardless of Git operations.

## Task steps
### Phase A — Provenance + selective inventory
- Read root AGENTS.md / README.md, vps-mcp/README.md, PRODUCTION.md, production_smoke_test.py, .github/workflows/vps-mcp-test.yml, gateway.py/worker.py/broker.py, original vps-mcp/docs/MVP_IMPLEMENTATION_REPORT.md via git show 8a73554, and all five MVP commits.
- Capture exact 16 production signatures and structured response/error shapes as contract fixtures. Compare GitHub main to local origin/main; if main advanced since worktree creation, fetch and safely rebuild integration worktree at new main BEFORE porting, preserving any local work.
- Produce a module matrix: KEEP FROM MAIN, PORT/RENAME FROM MVP, ADAPT, DISCARD.
- Do not add deleted server.py, security prototypes, smoke_test.py, or stale baseline CI back.

### Phase B — Port the functional core
- Copy/adapt old MVP gateway/{database,identity,sessions,mailboxes,async_db,tools,settings,errors,common,admin,http_runtime,migrations} to mailbox_core/ and only when relevant; keep trusted offline provisioning separate from MCP exposed tools.
- Register the 13 MVP tools additively in existing gateway.py: 16 original + 13 new = 29 if none of the old tool names are renamed/removed. Do not break Unix socket forwarding or protected broker IPC; preserve transport address / lifecycle.
- Check initialize/shutdown/long-poll cancellation integration under production gateway FastMCP configuration.
- Maintain ordered durable send/receive, idempotency, per-consumer or per-principal ACK semantics (document actual distinction), TTL, quotas, bounded polling, ACL, crash safety and WAL handling. Check any ID type confusion.
- Keep application-level sessions separate from MCP transport sessions.
- Do not silently enable tools via an unverified runtime principal. Provide explicit truthful operational limitation and the exact owner-side prerequisites for later activation.

### Phase C — Tests and verification
- Port worthwhile MVP tests, isolate source-only tests so they do NOT bind or contact production 127.0.0.1:8765, privileged services, live sockets, credentials or state.
- Test in-memory/temporary authenticated test adapters only.
- Verify 16 old tools are still registered with exact original names, parameter schemas and dispatch paths, plus 13 new tool definitions.
- Verify source-only test vps-mcp/production_smoke_test.py is updated: old hard-coded count 16 needs future-compatible assertions (required base set + new set); distinguish an EXPECTED checked-in-vs-live release difference from a source regression rather than weakening integrity check silently. Keep ability to deliberately check exact released source for the currently deployed commit.
- Test unauthenticated default, forged identity, cross-principal ACL, inbox ownership, ACK isolation, idempotency replay and payload mismatch, migrations, parallel writers, storage caps, SQLite errors, timeout/cancel, service shutdown, restart/crash, CI Linux and Windows, low-memory stress.
- Run existing production smoke, compileall, bash syntax checks where possible. Tests must not require WSL/Docker/root locally. Linux CI should exercise POSIX behavior in an isolated runner.
- Supply a realistic agent workflow example while accurately showing that runtime auth is pending until verified and provisioned.

### Phase D — Commit / GitHub
- Commit logical increments on feat/mcp-mailbox-on-main. Preserve parent b4b3f1e and a clean tree; do NOT modify old MVP branch history.
- Update README/docs to describe true production architecture and staged runtime requirements. Write docs/MAILBOX_MAINLINE_PORT_REPORT.md with selective old->new file/commit mapping, conflict decisions, 16+13 contract matrix, measured test results, limitations, and why code has not been deployed.
- Push integration branch and open PR to main only after local checks pass (user request is to bring work toward origin/main); inspect GitHub Actions checks.
- Merge PR using a regular MERGE COMMIT / no-FF after ALL required checks pass, no 16-tool regression and no outstanding critical security blocker. If trusted identity/OS isolation remains a prerequisite for runtime use, clearly mark feature unactivated; do not treat it as a blocker to merging a strictly fail-closed implementation if tests pass. If PR merge permissions, failing CI, or conflicts block safe merge, stop and report exact blocker; do not force push or bypass checks.
- NO VPS production install/restart even after main merge.

## Definition of done
- Mainline-based source exposes the complete original 16 tool schemas unchanged plus the 13 Session/Mailbox tools.
- Python module names do not collide; gateway-worker-broker separation untouched.
- MVP core functional tests and isolated production 16-tool regression tests pass on Windows and Linux CI.
- No path from ordinary mcp-dev shell to private mailbox state or privileged broker is introduced.
- Integration is committed/PR-reviewed/merged to GitHub main when all gates pass; otherwise report precise blocker and keep feature branch.
- Hand back commit SHA(s), PR link/status, exact tests actually run, and any remaining runtime activation requirements.
