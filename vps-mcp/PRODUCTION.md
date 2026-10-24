# Production provenance and boundaries

The canonical implementation is `gateway.py`, `worker.py`, and `broker.py`. It was copied byte-for-byte from `/opt/vps-mcp/releases/d835f82831e9837e` and introduced in commit `b3f7ef1`. The production process may continue using that release until the owner explicitly updates it.

- Gateway: `mcp-gateway`, port `127.0.0.1:8765`.
- Development worker: `mcp-dev`, allowlisted repository directories; socket `/run/vps-mcp/worker.sock`.
- Root-owned approval broker: operations and units restricted by independently owned `/etc/vps-mcp/protected.json`.
- Separate existing tunnel: managed outside this project's deployment script.

`mcp-dev` has its own GitHub deploy key and development repository write permission. The gateway, privileged policy, SSH identities, approval password, tunnel credentials and production systemd units are not writable from the development MCP.

**Never commit** the Git private key, approval password, tunnel credentials or contents of `/etc/vps-mcp/protected.json`. The owner-SSH installer `deploy/production/install.sh` stages code and systemd definitions without restarting anything. Review and activate production separately. For source-only verification, run `python3 -m unittest -v vps-mcp/production_smoke_test.py`.

## Source candidate versus recorded production release

The Session/Mailbox port adds `mailbox_core/` to `gateway.py`; worker, broker and
service units remain the original production sources. Production can continue
running its previous release. Default smoke never reads `/opt`, sockets, state
or credentials. A candidate/released gateway difference is expected, while a
changed baseline worker/broker/unit still fails the source contract checks.

An owner can deliberately verify an **offline release copy**, independently of
the candidate checkout, against the recorded exact Git blob hashes:

```bash
python3 vps-mcp/production_smoke_test.py \
  --release-dir /path/to/offline-recorded-release \
  --manifest vps-mcp/tests/fixtures/released_b4b3f1e.json
```

This compares raw bytes, fails on any released-file tampering and separately
reports expected candidate/release differences. Future releases need their own
recorded trusted manifest. Normal Windows source checks normalize Git checkout
CRLF; exact release checks do not. No live release verification was performed
for this port.

## Unactivated mailbox feature and owner prerequisites

No production installation, restart, provisioning or activation is part of this
port. Production registration passes no services. The new tools deny before
opening a DB even when a Principal context exists. There is no environment flag
to enable them, and `MCP_STATE_DB` is not consumed. `trusted_identity` and service
injection are privileged Python integration APIs exercised in temporary tests.

Before any separate future activation the owner must:

1. Prove a trusted provider identity source, validate its issuer/audience and
   request binding, and reject spoofed direct headers/fields. Review an adapter
   that binds/resets identity per request and supplies private-state services.
2. Verify the gateway and shell remain different OS identities. Choose DB/WAL/SHM
   outside all agent-writable repositories, `/var/lib/vps-mcp-dev`, temporary
   shell-accessible mounts and the approval store. Use a gateway-owned private
   directory (0700/files 0600 or equivalent DACL); `mcp-dev` must have neither
   traversal nor write access, including via its shared group. Parent directories
   must prevent replacement. Current service units do not provision state or
   write access; owner-only service confinement/provisioning needs separate review.
3. Provision principals and session grants offline only after identity validation.
   Review quotas, retention, disk/WAL monitoring and memory headroom. The 1 GiB
   stress limit is not proof under the gateway service's 190 MiB limit.
4. Stage a complete immutable package in a separate environment. The installer
   source now includes modules/migration in its manifest, hash and comparisons;
   it preserves owner SSH/root ownership/approval units and performs no restart.
   Never invoke it through development MCP. Test provider auth, A/B/C ACLs,
   worker isolation and all 29 tool schemas in staging before rollout.

These are prerequisites for later runtime use, not permission to deploy now.

## Backup, maintenance and rollback (future owner procedure)

Before a migration, use SQLite's online backup API to a new protected file;
verify integrity and `user_version`. Do not copy a live DB without its WAL.
Schema version 1 is applied atomically on database construction. A future
version is refused; no downgrade is automatic. `Provisioner(db).cleanup()` is
trusted offline retention maintenance; `Database.checkpoint()` returns SQLite's
busy/log/checkpoint counts. Retry busy checkpoints later. Deleted pages are
reused; never VACUUM on the tool request path.

The owner records code/dependencies/unit configuration and takes a consistent
backup before a separate rollout. To roll back, independently stop only the
candidate, preserve its state for review, restore recorded compatible code and
configuration, and if necessary restore a verified pre-migration backup into a
separate private directory while no process has it open. Never mix older DB
files with newer WAL/SHM. Pre-mailbox code simply leaves the separate store unused.
Backup restoration omits later messages; retain/reconcile the candidate data
explicitly. Approval policy/state/secrets and tunnel are outside this procedure.
