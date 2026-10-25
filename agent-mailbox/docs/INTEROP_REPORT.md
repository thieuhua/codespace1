# Codex ↔ Antigravity interop report

Date: 2026-10-25 (Asia/Saigon), on Windows 11 using the real local state in
`%LOCALAPPDATA%\agent-mailbox`. Clients: Codex CLI 0.164.0 (`codex exec`) and
Antigravity CLI 1.4.7 (`agy -p`, model Gemini 4 Argon (Medium)). Both were
registered as stdio server `agent_mailbox` with `scripts/register-clients.ps1`.
Each client authenticated through its own token file (`codex`,
`antigravity`). The shared session and mailbox were both named `collab`
(created by `setup.ps1`).

## Client prerequisites found during the run

| Client | Symptom without it | Setting used |
| --- | --- | --- |
| Codex `exec` | `MCP tool call requires approval, but approval policy is never` | per run: `-c 'mcp_servers.agent_mailbox.default_tools_approval_mode="approve"'` |
| Antigravity `-p` | headless mode auto-denies the `mcp` permission | owner added `mcp(agent_mailbox/<tool>)` for each of the 14 tools under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` |

Neither client needed shell access or a skip-all-permissions flag. Codex ran
with `-s read-only`.

## Scenario results

| Step | Actor | Result |
| --- | --- | --- |
| 1 | Codex | `whoami` = `codex`; found `collab`; sent PING, seq 1 (`interop-ping-1`) |
| 2 | Antigravity | `whoami` = `antigravity`; received seq 1, ACKed it, replied PONG seq 2 (`reply_to` = PING): `17*23 = 391; model = Gemini 4 Argon (Medium)` |
| 3 | Codex | received and ACKed PONG seq 2 with the correct `reply_to` |
| 4 | Codex | `wait_seconds=180` → `INVALID_ARGUMENT` (server maximum is 20 s, as documented); no data accessed |
| 5 | Antigravity | sent seq 3 during step 4 |
| 6 | Codex + Antigravity concurrently | Codex ACKed seq 3, then long-polled from the cursor after it with `wait_seconds=20`. Polls 1–4 returned empty. Antigravity sent seq 4 at 04:35:39Z, and poll 5 returned it |

The mailbox delivered every message in order (seq 1–4) between two different
agent products, each running its own server process against the same SQLite
DB. ACKs were kept per principal, and the reply link was preserved. A message
committed by another process woke a waiting poll. Wake latency was not timed
in this live run; the automated cross-process test measures it.

## Notes

- Agents may first pass the mailbox *name* where an ID is expected. Codex
  got `NOT_FOUND` once, then resolved the ID with `mailbox_list`. Prompts
  should say to look up IDs first.
- Waiting longer than 20 s means repeating `mailbox_receive` with the same
  cursor.
- To undo client registration, run `scripts/unregister-clients.ps1`. To revert
  the Antigravity setting, delete the 14 `mcp(agent_mailbox/...)` rules.
