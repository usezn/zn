# Example: remove zn-gate from one agent and keep the others

A short walk-through for when zn-gate protects several agents and you want it off for only one of them, here Cursor. Everything here is documented on the [remove page](../uninstall.md) and in the [command reference](../cli.md). Run the commands yourself, in your own terminal: when an AI agent runs them, or there is no terminal, nothing is changed.

## 1. Dry run first

```bash
npx -y zn-gate uninstall --dry-run
```

This prints what zn-gate set up for your user and for the folder you are in, with the file paths, and changes nothing. Read the list to see which agents have zn's hooks. `uninstall` itself removes every agent in that list, so do not run it without `--dry-run` for this task.

## 2. Remove the hooks of one agent

```bash
npx -y zn-gate hooks uninstall cursor
```

Use `codex`, `opencode` or `antigravity` instead of `cursor` for the others. A backup of the settings file is written first, and the other agents are not touched. Add `--project` if you installed the hooks for one project only; run it from that project's folder.

For Claude Code, use `claude-code` instead. If you installed it as a plugin, remove the plugin with `claude plugin uninstall zn-gate@usezn`. `hooks uninstall claude-code` also removes zn's own `secrets` MCP server; add `--no-mcp` to leave MCP servers alone.

## 3. Check what is left

```bash
npx -y zn-gate check
```

It shows the state of zn-gate on this machine. See [what the output means](../check.md).

## More

- [Remove zn-gate: every option](../uninstall.md)
- [`hooks uninstall` in the command reference](../cli.md#hooks-uninstall)
