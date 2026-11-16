# Example: install zn-gate hooks for one agent

zn-gate can install its hooks for eight coding agents. Maybe you use several of them and want the hooks in only one of them, here Cursor as the example. Everything on this page is documented in the [command reference](../cli.md) and in [Install, verify and uninstall by agent](../by-agent.md). The install needs an interactive terminal: run the commands yourself, in your own terminal. When an AI agent runs them, or there is no terminal, nothing is changed.

## 1. Install the hooks for that agent

```bash
npx -y zn-gate hooks install cursor
```

`<agent>` is one of `claude-code`, `codex`, `cursor`, `opencode`, `antigravity`, `zcode`, `gemini` or `copilot` (`claude` is accepted for `claude-code`, `gemini-cli` for `gemini`). Only the settings of that one agent change, and a backup of the settings file is written first. A name that is not in the list or a misspelled one is refused before anything is written, with the supported names and exit code 64.

Two options you may need:

- `--no-mcp` leaves the `secrets` MCP server out and installs the hooks only.
- `--project` installs the hooks for the current project instead of your user settings; run the command from that project folder. The shared files then run `zn` from the PATH, so everyone who uses the project needs zn-gate installed globally. For Claude Code, `--project` adds no MCP server: run `npx -y zn-gate hooks install claude-code` without `--project` for the `secrets` server.

Some agents have one extra step after the install: Codex CLI asks you to trust the hooks in its `/hooks` menu. The full steps for each agent are on its own page under [Editors and coding agents](../editors/README.md).

## 2. List the hooks you just installed

```bash
npx -y zn-gate check --hooks
```

This lists every installed zn hook, one line per hook event, with the agent, the settings file, the event and the command it runs, and says whether each one is OK, stale (written by an older zn-gate) or broken, with the command that fixes it. It only reads files: nothing is run, changed or sent. Find the lines of the agent you installed and check that they say OK. See [List every installed hook](../check.md#list-every-installed-hook).

## 3. Check that the hooks work

```bash
npx -y zn-gate check
```

This makes a temporary folder with a fake `.env` file, asks each installed hook to read it, and reports whether the fake secret was blocked. Exit code `0` means every agent that is set up is protected. See [what the output means](../check.md).

## More

- [Install, verify and uninstall by agent](../by-agent.md): the steps for all eight agents, agent by agent.
- [`hooks install` in the command reference](../cli.md#hooks-install)
- [Example: remove zn-gate from one agent and keep the others](uninstall-one-agent.md), for when you want the hooks off again for that one agent.
