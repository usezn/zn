# Install matrix

Last reviewed: 2026-11-11

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
| Python package | `pip install zn-gate` | `zn-gate status` (prints the version, the Python version and whether the optional cloud check is on). The Python package sets up no agent coverage, so `check` belongs to the npm package. |
| Hooks for one agent | `zn hooks install claude-code`, `codex`, `cursor`, `opencode`, `antigravity`, `copilot`, `zcode` or `gemini` (experimental) | `npx -y zn-gate check` |

`init` ends with the `check` run. `check` makes a temporary folder with a fake key in a `.env` file, asks your
agent's hook to read it, and deletes the folder. If it says `NOT protected`, see
[first-5-minutes.md](first-5-minutes.md#2-check-that-it-worked).

## Operating system

| Operating system | What the pages say | Verify with |
|---|---|---|
| Windows | Documented per agent in the Windows row of [compat.md](compat.md). Claude Code is supported, including its PowerShell tool (2.1.299 or later). Codex CLI and OpenCode have one end-to-end run each on Windows Server 2022; Cursor is not tested; Antigravity is not verified by us. | `npx -y zn-gate check`. If PowerShell says "running scripts is disabled on this system", use `npx.cmd -y zn-gate check` |
| macOS | No separate install steps. The same commands apply; compat.md mentions macOS only for managed settings paths and for how approved programs are started. | `npx -y zn-gate check` |
| Linux | The same commands apply. On Debian or Ubuntu, `sudo apt install nodejs` can install an old Node.js (Ubuntu 22.04 ships version 12): run `node --version` and, if it is older than 18, install a current Node.js from [nodejs.org](https://nodejs.org/) or the NodeSource packages (see [first-5-minutes.md](first-5-minutes.md#before-you-start)). | `npx -y zn-gate check` |

Node.js 22 LTS is recommended (from [nodejs.org](https://nodejs.org/)). Node.js 18 or later works for the hooks and the CLI; the Claude Code plugin needs 20.19 or later. The npm package declares Node.js 18 or later in the `engines` field of its package.json. Using only the Python package (`pip install zn-gate`, without the hooks) does not need Node.js. Without `npx`, install the LTS version from [nodejs.org](https://nodejs.org/) and open a new terminal.

## Install on a machine without internet

Use these steps on a computer that cannot reach the internet. You need a second computer with internet access, and a way to copy one file between them, such as a USB stick.

Node.js must already be installed on the offline computer, because installing it also needs the internet. Download the Node.js 22 LTS installer on the computer with internet, copy it over and install it first. The Claude Code plugin needs Node.js 20.19 or later; the hooks and the command line work on 18 or later.

**1. On a computer with internet**, download the package file:

```sh
npm pack zn-gate@<version>
```

This creates `zn-gate-<version>.tgz`. Replace `<version>` with the version you want; the [npm page](https://www.npmjs.com/package/zn-gate) lists them. Copy the file to the offline computer.

**2. On the offline computer**, in your own terminal, go to the folder with the file and run:

```sh
npm install -g ./zn-gate-<version>.tgz --offline
zn hooks install claude-code
```

The `.tgz` file contains every dependency zn-gate needs, so npm downloads nothing. Replace `claude-code` with the agent you use; the [compatibility page](compat.md) lists every supported agent and its name. Run the install command in a terminal window, not through your agent.

**3. Check that it works**, in the same terminal:

```sh
zn-gate check
```

It should say that your agent is protected.

**What works without internet**

- The hooks, which check what your agent reads, writes and runs.
- `zn-gate test`, `zn-gate status`, `zn-gate scan`, `zn-gate audit`, `zn-gate reach` and `zn-gate report`.
- `zn-gate analyze` with the local check, which is the default.

**What needs internet**

- The cloud check of `zn-gate analyze`. On an offline computer, leave it off: do not set `ZN_CLOUD=1` and do not run `zn-gate connect`. With the cloud check off, nothing is sent to usezn.com.
- `zn-gate connect`, which checks an API key with usezn.com.
- The team commands that join or sync with a zn organization.
- `claude plugin marketplace add usezn/zn`, which installs the Claude Code plugin from GitHub. Use `zn hooks install claude-code`, as in step 2, instead.

**Updating later.** Download the newer `.tgz` on a computer with internet, copy it over, and run `npm install -g ./zn-gate-<new-version>.tgz --offline` again.

**Do not run** `npm install -g zn-gate` on the offline computer. npm tries the registry first and waits a long time before it fails. Use the `zn-gate` and `zn` commands from step 2 instead.

## See also

- [First 5 minutes](first-5-minutes.md)
- [Agent compatibility](compat.md)
- [Offline and local-only use](examples/offline-and-local-only.md)
