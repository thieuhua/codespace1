# PowerShell scripts

Windows PowerShell 5.1 compatible. `setup.ps1` creates the project-local venv,
installs the editable package, initializes external state, provisions `codex`
and `antigravity` without replacing their tokens and creates/renews `collab`.

`register-clients.ps1` calls the installed `codex`/`agy` CLI with absolute
Python and token-file paths. `unregister-clients.ps1` removes `agent_mailbox`
from selected clients; it leaves state and token files for the operator.
`common.ps1` prints safely quoted commands and checks native exit codes.

Use `-WhatIf` or `-DryRun` to print only. Registration/removal supports
`-Client all|codex|antigravity`; setup/registration accepts `-StateDir`.
Do not run real registration during automated tests. See the
[project README](../README.md) for commands and approval settings.
