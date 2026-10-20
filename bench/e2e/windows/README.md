# End-to-end runs on Windows

The same scripted task as in [`../README.md`](../README.md), run on a clean
Windows Server 2022 machine (PowerShell 5.1, Node.js 22.12.0, Git for Windows
2.47.1, Python 3.12.8) against the scripted provider on 127.0.0.1. No real
model, account or API key is used, and every value is fake.

The harness is a PowerShell port of `run_codex.sh` and `run_opencode.sh`:
`../harness/run_codex.ps1`, `../harness/run_opencode.ps1` and
`../harness/run_all.ps1`. `install_and_run.ps1` installs the tools on a
throw-away machine and runs them.

## Results (2026-10-19)

| Agent | Version | Values sent to the provider | Notes |
|---|---|---|---|
| Codex CLI | 0.163.0 | **0** | Same steps and results as on Linux. The marker command was denied with the `zn run -- ...` line and the agent's `zn run` call then worked. Output was replaced through "block". The `python3` command was declined by the vault. The credential read and the pasted prompt were blocked. Codex ran the commands in PowerShell. |
| OpenCode (default shell) | 1.19.3 | **0** | Reads, writes, the credential read and the output scrubbing work. A command that carries a marker **does not run**: zn wraps it in the bash form (`ZN_AGENT=opencode '...node.exe' ...`) and OpenCode's default shell on Windows is PowerShell, which rejects it. Nothing was executed or exposed. The pasted prompt was stopped (OpenCode reports it as a server error). |
| OpenCode (Git Bash, `SHELL` set) | 1.19.3 | **0** | With `SHELL` pointing at Git Bash, the wrapped command runs: the allowed command ran through `zn run` (output masked) and the declined one was refused by the vault. The credential read and the pasted prompt were stopped as on Linux. |
| Claude Code | not run here | | See [`docs/compat.md`](../../../docs/compat.md). |
| Cursor | not run | | No Cursor CLI with hooks can be driven from a script. |

What OpenCode's plugin process sees on Windows (`opencode*/shell-probe.txt`,
written by a small probe plugin): with nothing set, `process.env.SHELL` is
undefined and `ComSpec` is `C:\Windows\system32\cmd.exe`, and the bash tool
ran PowerShell. With `SHELL=C:\Program Files\Git\bin\bash.exe` the plugin sees
that value and the bash tool ran Git Bash.

**Local copies** (not sent): as on Linux, the plain AWS values of the project
file stay in Codex's session log and `--json` events and in OpenCode's local
database (`leak-check.txt`, `local:` line).

## Differences from the Linux run

- `python3` does not exist on Windows. The harness copies `python.exe` to
  `python3.exe` in the run's `bin` folder so the "command not approved" step
  finds a program and the vault declines it, as on Linux.
- The `zn` command is a `zn.cmd` shim in the run's `bin` folder.
- Claude Code and the Codex sandbox (`-s workspace-write`) were not run on
  Windows. The Codex run uses `--dangerously-bypass-approvals-and-sandbox`.
- The hook scenarios of `run_codex_scenarios.sh` were not ported.

## Files

Each folder (`codex/`, `opencode/`, `opencode-git-bash/`) has `summary.txt`,
`leak-check.txt`, `confirmations.jsonl`, `exit-codes.txt` and `run.txt`, with the
same meaning as in the Linux evidence.

## Reproduce

On a disposable Windows machine, from a checkout (it installs Node.js, Git,
Python, `@openai/codex` and `opencode-ai` system-wide):

```powershell
powershell -ExecutionPolicy Bypass -File bench\e2e\windows\install_and_run.ps1 -Pkg packages\zn-gate -Out C:\e2e-out
```

With the tools already installed:

```powershell
powershell -File bench\e2e\harness\run_all.ps1 -Pkg packages\zn-gate -Work C:\e2e-work -Evidence C:\e2e-out
```
