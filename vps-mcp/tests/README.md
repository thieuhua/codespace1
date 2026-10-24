# Isolated tests

From `vps-mcp`, install unchanged `requirements.txt` into project-local `.venv`
and run `.venv/Scripts/python.exe -m unittest discover -v` on Windows, or
`.venv/bin/python -m unittest discover -v` on Linux. Run production source
smoke separately with `python -m unittest -v production_smoke_test.py`.

- `fixtures/` records the production baseline schemas, function ASTs, canonical
  source hashes, dispatch/result envelopes and exact released-source hashes.
- `test_production_contract.py` uses the actual production gateway, SDK/HTTP,
  socket doubles and exact 16+13 inventory. No real privileged socket is opened.
- `test_sessions.py`, `test_mailboxes.py`, `test_hardening.py`,
  `test_mainline_hardening.py` cover ACLs, context isolation, ID confusion,
  dedupe, migrations, storage bounds/errors, crash recovery, cancel and shutdown.
- `test_protocol.py` tests A/B/C restart, ACK/reply and shutdown through the
  real 29-tool gateway with test-only fixed identities and temporary state.
- `test_posix_production.py` runs actual worker Unix sockets, Bash and jobs
  only in Linux temporary fixtures; broker policy/account/systemctl are mocked.
  These seven POSIX cases are explicitly skipped on Windows.
- `test_release_integrity.py` and `test_release_packaging.py` verify explicit
  offline release checking and complete source packaging without installation.
- `stress_worker.py` commits 2,000 1-KiB messages with eight writers, paginates
  history and exercises 32 pollers inside an enforced 1 GiB child-process limit.
  The child deadline is 300 seconds on Windows and 90 seconds on POSIX to allow
  for Windows hosted-runner FULL-sync disk latency. Run it directly for aggregate
  timing, peak RSS, DB size and retry counts.

Concurrent writers share `support.retry_storage_busy`: at most ten attempts
with bounded backoff and unchanged idempotency keys. Only the SQLite storage
busy/full error is retried; quota, validation and ACL errors propagate. The
hardening tests still require a held lock to fail within its configured deadline
and verify retry recovery without duplicate messages or masked quota failures.

`protocol_support.py` owns ephemeral sockets continuously through shutdown.
Tests never bind/contact production port 8765, privileged sockets, live state,
credentials or services. No root/WSL/Docker is needed locally. Windows/Ubuntu
and unprivileged Debian 12 CI run the same suite; test logs are ignored under
`.test-results/`. Peak memory in this workload does not prove safety at every
quota combination or under the production service's 190 MiB limit.
