# Install channels: what exists today

Last checked: 2026-11-18, against the public registries (latest release: 1.16.0).

zn-gate is installed from two places: npm (Node.js) and PyPI (Python). This page lists every other way
people ask about, says plainly whether it exists, and gives the exact command when it does. "Not available
yet" means exactly that: no such package exists, so any command you find online for it is not ours.

Run every command in your own terminal, not through an AI agent.

## The short answer

To protect a coding agent (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app,
GitHub Copilot), you only need one command, and it works on macOS, Linux and Windows once Node.js is installed:

```bash
npx -y zn-gate init
```

If you have no Node.js, install the LTS version from [nodejs.org](https://nodejs.org/) first, then open a new
terminal. Everything else on this page is an alternative for a specific need.

## Channel by channel

| Channel | Exists today? | Command | What it gives you |
|---|---|---|---|
| npx | Yes | `npx -y zn-gate init` | Guided setup for your coding agents. Nothing stays installed, so there is nothing to update. |
| npm, global install | Yes | `npm install -g zn-gate` | The `zn-gate` and `zn` commands on your PATH. Run `zn hooks install <agent>` afterwards, or use `npx -y zn-gate init` instead. |
| pipx | Yes, Python package only | `pipx install zn-gate`, then `pipx ensurepath` | The Python command line (`scan`, `test`, `status`) in its own environment. It does not set up any coding agent. |
| uv | Yes, Python package only | `uv tool install zn-gate` (or `uvx zn-gate scan .` to run it once) | The same Python command line as pipx. |
| pip | Yes, Python package only | `python3 -m venv .venv`, then `.venv/bin/pip install zn-gate` | For agents you build yourself (LangChain, CrewAI, LlamaIndex, plain tool calling). |
| Docker image | Not available yet | None | There is a `Dockerfile` in the repository that you can build yourself, but no image is published. |
| Homebrew | Not available yet | None | There is no `zn-gate` formula or cask. |
| winget | Not available yet | None | There is no zn-gate package in the winget catalog. |
| Scoop | Not available yet | None | There is no zn-gate manifest in the main or extras bucket. |

Which one should I use?

- **You use a coding agent and want it protected:** `npx -y zn-gate init`. If you prefer a permanent
  install, `npm install -g zn-gate` and then `zn-gate init`.
- **You only want to scan a folder for leaked secrets, without Node.js:** pipx or uv. They cannot protect an
  agent: that part needs Node.js.
- **You build agents in Python:** the Python package in a virtual environment.

## What each channel needs

### npx and npm

Both need Node.js 18 or later. The Claude Code plugin needs 20.19 or later; with an older Node.js,
`npx -y zn-gate init` sets up zn's hooks for Claude Code instead. On Windows PowerShell, `npm` and `npx` can
fail with "running scripts is disabled on this system": use `npm.cmd` and `npx.cmd`, or see the note in the
[README](../README.md). To update a global install, see [Upgrading](upgrading.md).

### pipx, uv and pip

They need Python 3.10 or later. On Ubuntu and Debian, install pipx first with `sudo apt update && sudo apt
install pipx`; bare `pip` is often missing there and refuses to install into the system Python. After
`pipx ensurepath`, close and reopen the terminal, or `zn-gate` is reported as "command not found". The
Python package has no `check` and installs no hooks: for that, use npx.

### Docker

The repository's `Dockerfile` builds the experimental local gateway (`zn start`), not the hooks that protect
your coding agents, so a Docker image would not protect a coding agent running on your computer. If you want
to run the gateway in a container, you build the image yourself: see
[Running in Docker](rust-core.md#running-in-docker).

## What a missing channel would need

These are not planned commitments. They describe what it would take, so you can judge how long it would
be before they exist.

| Channel | What it would take |
|---|---|
| Homebrew | A tap (a small repository of our own) with a formula that installs the npm package and depends on Node.js, plus a test that runs `zn-gate check` after install. After that, `brew install usezn/tap/zn-gate`. Homebrew's own catalog is a separate request that its maintainers decide. |
| Scoop | A bucket (a small repository of our own) with a manifest that depends on `nodejs-lts` and installs the npm package. After that, `scoop bucket add usezn` and `scoop install zn-gate`. Scoop's own buckets are separate requests that their maintainers decide. |
| winget | A manifest sent to Microsoft's winget catalog through a pull request, which needs an installer file (an `.exe` or `.msi`) that winget can download. zn-gate is a Node.js package, so we would first have to ship a self-contained Windows installer, which we do not build today. |
| Docker image | A release step that builds the image, scans it and pushes it to a public registry with a version tag, signed like the other release files. Useful for servers and the gateway, not for protecting a coding agent on a laptop. |

## If you are unsure whether a package is ours

The only places that publish zn-gate are [npm](https://www.npmjs.com/package/zn-gate),
[PyPI](https://pypi.org/project/zn-gate/) and the [GitHub releases](https://github.com/usezn/zn/releases) of
`usezn/zn`. A package with the same name anywhere else is not ours. To check that a download is genuine, see
[Verify a release](verify-release.md).
