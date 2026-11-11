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

## 4. Check the other agents are still protected

Removing one agent must not turn off the others. Run the check again and read each agent's own state:

```bash
npx -y zn-gate check --json
```

It prints one JSON object. The top-level `exit_code` is the one to look at first, and each entry in `agents` tells you about one agent. The output lists every supported agent; the ones not on your machine show `"state": "not-found"`. This is what it looks like after you removed Cursor from a machine where Codex and Cursor were both set up. The excerpt keeps only the fields this page talks about; the real output has more, such as `name` and `fix`:

```json
{
  "exit_code": 0,
  "protected": true,
  "agents": [
    { "id": "codex", "state": "protected", "protected": true, "reason": "" },
    { "id": "cursor", "state": "not-set-up", "protected": false, "reason": "" }
  ]
}
```

- Each agent you still use should have `"state": "protected"` and `"protected": true`.
- Cursor shows `"state": "not-set-up"`. That is the result you wanted: zn is no longer set up for it, and its `reason` is empty.
- `exit_code` is `0` when every agent that is still set up is protected, and `1` when one is not.

If an agent you still use is reported as not protected, its `reason` says why and its `fix` line says what to run. The states are listed in [the machine-readable output](../check.md#machine-readable-output).

To see the hooks themselves, run `npx -y zn-gate check --hooks`. The Cursor lines are gone, and every hook of the agents you kept is `OK`. The last line counts them, for example `14 OK, 0 stale, 0 broken.`

## More

- [Remove zn-gate: every option](../uninstall.md)
- [`hooks uninstall` in the command reference](../cli.md#hooks-uninstall)
