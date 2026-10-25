# Router long-poll endurance experiment

Date: 2026-10-25 (Asia/Saigon), Windows 11. One router process
(`router serve`, 127.0.0.1:8766). Two worker agents each ran one turn that
looped on `mailbox_receive`:

- Codex CLI 0.164.0: `codex exec`, `model_reasoning_effort=low`, `-s read-only`,
  with per-run `tool_timeout_sec=120` and `default_tools_approval_mode="approve"`.
- Antigravity CLI 1.4.7: `agy -p`, `--print-timeout 0`, MCP allow-rules.

Both used the same worker prompt: loop on `mailbox_receive`, follow
instructions found in mail, stop only on status `stop`. The operator (Claude)
drove the run through `router ctl` from a script:

- Hold time was 50 s for the first 10 minutes, then 10 s (`set-hold 10`).
- Every 5 minutes the operator sent one task to each agent:
  - Codex: reply with the value of k*k+7.
  - Antigravity: send Codex `ping #k`, then reply `relayed #k`.
- The cap was 150 minutes, after which `stop all` would be sent.

## Results

| | Antigravity | Codex |
| --- | --- | --- |
| Consecutive `mailbox_receive` calls in one turn | **86** | **563** |
| Time in the loop | 37 min | 133 min |
| Operator tasks completed | 7/7 relayed (ping sent to Codex, then `relayed #k`) | 26/26 answers correct |
| Mail in / out | 7 / 14 | 33 / 26 (26 tasks + 7 pings) |
| Receive errors or timeouts | 0 | 0 |
| How it ended | provider quota: `429 RESOURCE_EXHAUSTED`, "Individual quota reached" | provider quota: ChatGPT "You've hit your usage limit" |
| Tokens reported | n/a | 431,513 |

Neither agent left the loop on its own, ignored an instruction, timed out on
a 50 s hold, or broke routing. Both runs ended only when the account's model
quota ran out. Mail sent to Antigravity after it stopped (19 messages) stayed
queued as pending for its next session.

## Takeaways

- The real limit is provider quota, not the loop. Every receive cycle is one
  model step, even one that returns `no_mail`. Shorter holds burn quota
  proportionally: at a 10 s hold Codex made about 4.4 calls/min.
- For long-lived listeners, use a hold close to the client's tool timeout
  (50 s with Codex `tool_timeout_sec=120`; Antigravity also tolerated 50 s).
  That gives about 70 model steps per hour per idle agent.
- The workers also respond in real time: operator mail reached a waiting
  agent within the router's ≤ 250 ms wake interval (measured in
  `tests/test_router.py`). Every task in this run was answered within its
  5-minute window.
- Router-side instrumentation (`ctl status/stats/log`) was enough to watch
  the run; the operator never had to read agent transcripts.
