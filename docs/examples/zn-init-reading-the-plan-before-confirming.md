# Example: read the plan that init prints before you answer

`zn-gate init` is the guided setup. Before it asks anything, it prints what it found on this machine, and each question that follows names the exact command it would run. This page reads that plan line by line, answers no, and shows what stays unchanged. Everything here is described in the [command reference](../cli.md#init) and in [First 5 minutes with zn-gate](../first-5-minutes.md). The machine in the example has Codex CLI and Cursor installed and nothing else, and all values are made up.

Run `init` yourself, in your own terminal. When an AI agent runs it, or there is no terminal, it only prints the steps and changes nothing.

## 1. Start the setup

```bash
npx -y zn-gate init
```

`init` first looks for the coding agents it supports and checks which ones zn already protects. Then it prints one line per agent:

```text
zn-gate init: set up zn for the coding agents on this machine

  -  Claude Code  not found on this machine
  >  Codex CLI    not set up yet
  >  Cursor       not set up yet
  -  OpenCode     not found on this machine
  -  Antigravity  not found on this machine
  -  GitHub Copilot (VS Code, CLI) not found on this machine
  -  Gemini CLI (experimental) not found on this machine
  -  ZCode        not found on this machine
```

How to read the markers:

- `-` means the agent is not on this machine, so there is nothing to do for it.
- `>` means the agent is there and zn is not set up for it yet, or it is set up but a hook does not work. The line says which: `not set up yet`, or `not protected:` followed by the problem.
- `OK` means the agent is already protected by zn. If every agent that was found says `OK`, `init` says so and exits with `0` without asking anything.

If no supported agent is found at all, it says that nothing was changed and exits with `1`.

## 2. Read the questions

Each step that would change something is a question, and the default answer is no. The first question on a machine where zn-gate is run through `npx` is about a normal install:

```text
install zn-gate <version> for your user: run `npm install -g --fetch-retries=1 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=5000 --fetch-timeout=15000 zn-gate@<version>`? [y/N]
```

The hooks must not point into the temporary copy that `npx` makes, because it can be deleted. That is why a plan that installs hooks starts with an install for your user. The question is left out when the plan has no hook install (for example when only the Claude Code plugin is planned), or when zn-gate is already installed for your user in this version or a newer one. If an older version is installed, the question says which one you have.

After that, `init` asks one question for each agent it would set up. For Codex CLI and Cursor, each question names the command that installs the hooks of that agent, for example ``install zn's hooks for Codex CLI: run `zn hooks install codex`? [y/N]``. For Claude Code, the plan is the plugin: with the `claude` command on your PATH it asks about `claude plugin marketplace add usezn/zn` and `claude plugin install zn-gate@usezn`, and without it, it tells you to type the two `/plugin` commands in Claude Code yourself.

The exact text of the install command contains your zn-gate version, so it changes from release to release.

## 3. Answer no

Press Enter, or type `n`. Here the answer is no to the first question:

```text
  skipped. You can run it later: npm install -g zn-gate@<version>
Codex CLI:
  needs zn-gate installed for your user first. Later: zn hooks install codex
Cursor:
  needs zn-gate installed for your user first. Later: zn hooks install cursor
```

Nothing was installed or changed. Every skipped step prints the command you can run later, in your own terminal. A no to a step of one agent skips the rest of that agent's steps and the next agent still gets its own questions. That is how you decline one agent and accept another.

`init` ends with the same test as `zn-gate check`, so you see that nothing is protected yet:

```text
  -  Codex CLI    zn is not set up for this agent. To protect it, run `npm install -g zn-gate`, then `zn hooks install codex`, in your own terminal.
     version: not found (tested with 0.163.0)
  -  Cursor       zn is not set up for this agent. To protect it, run `npm install -g zn-gate`, then `zn hooks install cursor`, in your own terminal.
     version: not found
```

The exit code is `1` when you skipped a step. It is `0` only when every agent that was found is protected at the end.

## 4. The same plan without a terminal

To read the plan without being asked anything, run `init` where there is no interactive terminal, for example with its input closed:

```bash
npx -y zn-gate init < /dev/null
```

```text
This is not an interactive terminal, so zn only prints the steps. Nothing was changed.
Run them in your own terminal:

  npm install -g zn-gate@<version>
  zn hooks install codex
  zn hooks install cursor

Then check that it works: `npx -y zn-gate check`
(To wrap the MCP servers in your agent configs, which `zn-gate init` used to do: `zn-gate init --wrap-mcp`.)
```

The agent lines at the top are the same. The list at the end is the whole plan as commands you can copy one by one. The exit code is `1`, as no step ran.

## 5. Preview the other kind of setup

The guided setup takes no options. `init --dry-run` is not a preview of this plan: it previews the other setup, the one that wraps your MCP servers with `shield`, and changes nothing. See [Set up zn-gate, preview the steps, remove it](init-and-uninstall.md).

## Related

- [`init` in the command reference](../cli.md#init)
- [Example: install zn-gate hooks for one agent](zn-hooks-install-for-one-agent.md), for a single agent without `init`.
- [Check that it works](../check.md)
- [All examples](README.md)
