# PowerShell scripts

Router mode adds `router-start.ps1` (hidden background server, PID/creation-time
record and stdout/stderr logs under state), `router-stop.ps1` (verified PID,
graceful offline shutdown), and `register-router-clients.ps1` (replace the
`agent_mailbox` registration with a loopback HTTP URL). All support `-WhatIf` and
`-DryRun`, which never read tokens, invoke CLIs or write state.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\router-start.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-router-clients.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\router-stop.ps1 -WhatIf
```

Router start accepts `-BindHost`, `-Port`, `-HoldSeconds`, `-AllowNonLoopback` and
`-StateDir`. Registration accepts `-Url`, `-Client` and token-file selections.
Codex requires `AGENT_MAILBOX_ROUTER_TOKEN` in its launching shell; the script
only registers the environment variable's name. Antigravity reads its token at
registration and stores the header in plaintext in its config; output is redacted.
See [ROUTER.md](../docs/ROUTER.md) for commands, protocol and security limits.

Windows PowerShell 5.1 compatible. `setup.ps1` creates the project-local venv,
installs the editable package, initializes external state, provisions `codex`
and `antigravity` without replacing their tokens and creates/renews `collab`.

`register-clients.ps1` calls the installed `codex`/`agy` CLI with absolute
Python and token-file paths. `unregister-clients.ps1` removes `agent_mailbox`
from selected clients; it leaves state and token files for the operator.
`common.ps1` prints safely quoted commands and checks native exit codes.

Run from the project directory, including when the effective policy is Restricted:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-clients.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-clients.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\unregister-clients.ps1 -WhatIf
# Run to remove the selected client registrations:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\unregister-clients.ps1
```

`-ExecutionPolicy Bypass` applies only to this PowerShell process; it never changes
the current user's or machine's execution policy.

Use `-WhatIf` or `-DryRun` to print only. Registration/removal supports
`-Client all|codex|antigravity`; setup/registration accepts `-StateDir`.
Both setup and registration accept `-CodexTokenFile` and `-AntigravityTokenFile`.
After rotation, pass the new filename to both scripts on every subsequent run;
defaults still refer to `tokens/<principal>.token`. Relative paths use `$PWD`.
Command lookup preserves PowerShell's normal `.ps1`/native executable selection;
argv forwarding, including Codex's `--`, is verified against temporary fixtures.
Do not run real registration during automated tests. See the
[project README](../README.md) for commands and approval settings.
