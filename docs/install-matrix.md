# Install matrix

Install methods by operating system, with the command that verifies each one. Everything here is
taken from [compat.md](compat.md) and [first-5-minutes.md](first-5-minutes.md); read those pages for the full
details. Run every command in your own terminal, not through your agent.

## How to read this table

Each row is one way to install zn, or one operating system. The "Command" column is what you run; the
"Verify with" column is the command that shows the install worked. Run each command in your own terminal, not
through your agent. The Windows row only summarizes what [compat.md](compat.md) says per agent, so read that page
before you rely on it.

Notation used in the tables:

| Notation | Meaning |
|---|---|
| `code font` | A command or value to type exactly as shown. |
| `<agent>` | A placeholder: replace it with one agent name from the "Hooks for one agent" row, such as `claude-code`. |
| `exits with 0` | The command ended without a failure; for `npx -y zn-gate test`, all built-in examples passed. |
| `NOT protected` | The output of `check` when the hook did not stop the read of the fake key. See [first-5-minutes.md](first-5-minutes.md#2-check-that-it-worked). |
| "one end-to-end run" | A single run of the agent itself on Windows Server 2022, not part of CI. See the evidence link in [compat.md](compat.md). |
| "not tested" | No run was made, so the page makes no claim for it. |
| "not verified by us" | We have not checked it ourselves; see the Antigravity notes in [compat.md](compat.md). |
| "No separate install steps" | The same commands as in the first table apply on that system. |

## Install methods and how to verify them

| Install method | Command | Verify with |
|---|---|---|
| Guided setup (`init`) | `npx -y zn-gate init` | `npx -y zn-gate check`, then `npx -y zn-gate test` (exits with `0` when all built-in examples pass) |
| Global program | `npm install -g zn-gate`, then `zn hooks install <agent>` | `zn-gate check` |
| Python package | `pip install zn-gate` | `npx -y zn-gate check` |
| Hooks for one agent | `zn hooks install claude-code`, `codex`, `cursor`, `opencode` or `antigravity` | `npx -y zn-gate check` |

`init` ends with the `check` run. `check` makes a temporary folder with a fake key in a `.env` file, asks your
agent's hook to read it, and deletes the folder. If it says `NOT protected`, see
[first-5-minutes.md](first-5-minutes.md#2-check-that-it-worked).

## Operating system

| Operating system | What the pages say | Verify with |
|---|---|---|
| Windows | Documented per agent in the Windows row of [compat.md](compat.md). Claude Code is supported, including its PowerShell tool (2.1.299 or later). Codex CLI and OpenCode have one end-to-end run each on Windows Server 2022; Cursor is not tested; Antigravity is not verified by us. | `npx -y zn-gate check`. If PowerShell says "running scripts is disabled on this system", use `npx.cmd -y zn-gate check` |
| macOS | No separate install steps. The same commands apply; compat.md mentions macOS only for managed settings paths and for how approved programs are started. | `npx -y zn-gate check` |
| Linux | The same commands apply. On Debian or Ubuntu, `sudo apt install nodejs` can install an old Node.js (Ubuntu 22.04 ships version 12): run `node --version` and, if it is older than 18, install a current Node.js from [nodejs.org](https://nodejs.org/) or the NodeSource packages (see [first-5-minutes.md](first-5-minutes.md#before-you-start)). | `npx -y zn-gate check` |

All methods need Node.js: 22 LTS is recommended, 18 or later works for the hooks and the CLI, and the Claude
Code plugin needs 20.19 or later. Without `npx`, install the LTS version from
[nodejs.org](https://nodejs.org/) and open a new terminal.

## See also

- [First 5 minutes](first-5-minutes.md)
- [Agent compatibility](compat.md)
