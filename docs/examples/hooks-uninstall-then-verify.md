# Example: remove the hooks, then check that they are gone

zn's hooks live in the settings files of your coding agents. This page removes them and then confirms with `zn-gate check --hooks` that none is left. The full removal guide is [Remove zn-gate](../uninstall.md); every command is in the [command reference](../cli.md). Run the commands yourself, in your own terminal: they need an interactive terminal, and they exit with `77` when they refuse.

The agent names and paths below are examples; on your machine they name your agents and your files. Your home folder is shown as `~`.

## 1. See what is installed now

```bash
npx -y zn-gate check --hooks
```

This lists every zn hook set up for your agents, one line per hook event, with the agent, the settings file, the event and the command it runs, and says for each one whether it is `OK`, `STALE` or `BROKEN`. It only reads files: nothing is run, changed or sent. [What the output means](../check.md#list-every-installed-hook).

## 2. Remove the hooks

For one agent:

```bash
npx -y zn-gate hooks uninstall claude-code
```

`<agent>` is `claude-code`, `codex`, `cursor`, `opencode`, `antigravity`, `zcode`, `gemini` or `copilot` (`claude` is accepted for `claude-code`, `gemini-cli` for `gemini`). Add `--project` if you installed the hooks for one project only, and run the command from that project's folder (ZCode has no project hooks, so `--project` does not apply to it). A backup of the settings file is written first. For Claude Code it also removes zn's own `secrets` MCP server; add `--no-mcp` to leave MCP servers alone. The small launcher script under `~/.zn/hooks` is left in place, because every profile of the same agent on the machine shares it; [`uninstall`](../cli.md#uninstall) removes it.

To remove everything zn-gate set up in one step, hooks included:

```bash
npx -y zn-gate uninstall
```

It finds what is set up, prints the list with the file paths, and asks "Remove what is listed above?" before it removes anything. It follows the order of the [remove page](../uninstall.md): the wrapped MCP servers first, then the hooks and the plugin, and it ends by running `zn-gate check`, so you see what is left.

## 3. Confirm the hooks are gone

```bash
npx -y zn-gate check --hooks
```

When no zn hook is left on the machine, the output is:

```text
zn hooks installed on this machine (nothing was run or changed):

  None found. To set zn up, run `npx -y zn-gate init` in your own terminal.
```

The exit code is `0`. Plain `zn-gate check` prints its one line about hooks only when at least one hook is installed, so after a successful removal it says nothing about hooks.

## If a hook is still listed

A line that is not `OK` is followed by the reason and a `Fix:` line. Run the fix in your own terminal, then run `zn-gate check --hooks` again. If you no longer want zn for that agent, run `zn hooks uninstall <agent>` instead, as the output itself suggests.

One common mistake is removing the program with `npm uninstall -g zn-gate` before the hooks. The hooks stay in your agent's settings and can no longer start, so `zn-gate check` reports lines such as:

```text
its hook cannot start: its zn-gate files (<path>) is no longer there
```

Each reason is explained in [The hooks are set up but cannot run](../check.md#the-hooks-are-set-up-but-cannot-run).

## More

- [Remove zn-gate](../uninstall.md), including [checking that it is off](../uninstall.md#check-that-it-is-off)
- [Command reference: `hooks`](../cli.md#hooks) and [`check`](../cli.md#check)
- [List every installed hook](../check.md#list-every-installed-hook)
