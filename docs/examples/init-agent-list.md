# Example: which agents `zn-gate init` finds

`zn-gate init` lists the coding agents it can find on this machine, shows what is missing for each one, and sets up only the ones you say yes to. This page explains how it decides that an agent is there, why an agent you use may be missing from the list, and what it prints when it cannot ask you. The output below was made with a made-up home folder and fake agent folders, so nothing on your machine was used. The guided setup itself is in [init and uninstall](init-and-uninstall.md); every command is in the [command reference](../cli.md#init). Run the commands yourself, in your own terminal.

## How `init` decides an agent is there

An agent is listed as found when any of the checks in its row finds something.

| Agent | Found when |
|---|---|
| Claude Code | the `claude` command is on your PATH, or the Claude config folder exists (`CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`) |
| Codex CLI | the `codex` command is on your PATH, or the Codex folder exists (`CODEX_HOME` if set, otherwise `~/.codex`) |
| Cursor | the `cursor` command is on your PATH, or `~/.cursor` exists |
| OpenCode | the `opencode` command is on your PATH, or its config folder exists (`~/.config/opencode`, or inside `XDG_CONFIG_HOME` if set) |
| Antigravity | `~/.gemini/antigravity`, `~/.gemini/antigravity-cli` or `~/.gemini/config` exists (no PATH check) |
| GitHub Copilot (VS Code, CLI) | the Copilot folder exists (`COPILOT_HOME` if set, otherwise `~/.copilot`) (no PATH check) |
| Gemini CLI (experimental) | the `gemini` command is on your PATH, or one of `~/.gemini/settings.json`, `oauth_creds.json`, `GEMINI.md` or `tmp` exists |
| ZCode | the `zcode` command is on your PATH, or `~/.zcode` exists |

Two more rules:

- An agent that already has zn set up is always listed as found, because zn's own hooks or plugin show it is there.
- An agent that is not found is listed with `not found on this machine`, and `init` gives no steps for it.

## Why an agent can be missing

- **Its command is not on the PATH of this terminal, and its folder does not exist yet.** A desktop app you have not run, or a CLI installed for another user, may have neither. Put its command on your PATH in this terminal, then run `zn-gate init` again.
- **Its folder is somewhere else.** The folder names are the ones in the table. If the agent uses a folder that you moved with one of the variables above (for example `CODEX_HOME`), `init` looks there only when that variable is set in the terminal you run it from.
- **You run `init` as another user, or with `sudo`.** `init` looks in the home folder of the user who runs it, so an agent of another account on a shared computer is not seen. See [agents on a shared machine](agents-on-a-shared-machine.md).
- **The agent is not one of the eight.** The list is the eight agents in the table. Other editors are at [usezn.com/docs/install](https://usezn.com/docs/install).

## What `init` prints without a terminal

`init` asks before it changes anything. When it cannot ask, because it runs without an interactive terminal, or because an AI agent runs it, it prints the same list and then the steps, and changes nothing. The first line of its message says which case it is.

This is the output of `zn-gate init` run from a made-up home folder that has a `.claude`, a `.cursor`, a `.codex` and a `.config/opencode` folder, with no agent command on the PATH. Nothing was typed into a terminal, so the steps are printed:

```text
zn-gate init: set up zn for the coding agents on this machine

  >  Claude Code  not set up yet
  >  Codex CLI    not set up yet
  >  Cursor       not set up yet
  >  OpenCode     not set up yet
  -  Antigravity  not found on this machine
  -  GitHub Copilot (VS Code, CLI) not found on this machine
  -  Gemini CLI (experimental) not found on this machine
  -  ZCode        not found on this machine

This is not an interactive terminal, so zn only prints the steps. Nothing was changed.
Run them in your own terminal:

  npm install -g zn-gate@1.15.0
  in Claude Code, type /plugin marketplace add usezn/zn and then /plugin install zn-gate@usezn
  zn hooks install codex
  zn hooks install cursor
  zn hooks install opencode

Then check that it works: `npx -y zn-gate check`
(To wrap the MCP servers in your agent configs, which `zn-gate init` used to do: `zn-gate init --wrap-mcp`.)
```

Three things to note in that output:

- The first step, `npm install -g zn-gate`, appears because that copy of zn-gate was not installed for the user. The steps depend on how zn-gate is installed, so yours can differ.
- Claude Code has no `claude` command on this PATH, so its steps are two commands to type inside Claude Code, not a command for the terminal.
- The line `Nothing was changed.` is about your agents' settings. zn still writes its own log of checks (`~/.zn/evidence.jsonl`) and a state file under `~/.zn/state`, and npm writes its usual debug log when it looks up the global install folder. No agent setting, hook or plugin file was touched.

When an AI agent runs the same command, the second line says `An AI agent is running this, so zn only prints the steps: installing hooks is your decision.` The rest is the same.

With no agent found at all, `init` prints `No supported coding agent was found` and asks you to install one, then run it again. It changes nothing in that case either.

## Exit codes

- `0`: every agent found is already protected.
- `1`: no supported agent was found, or the steps were only printed. This is the code in the example above.
