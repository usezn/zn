# Example: set up zn-gate, preview, then remove it

A short walk-through of `init` and `uninstall`, including a dry run of each. Everything here is documented in the [command reference](../cli.md) and on the [remove page](../uninstall.md). Run the commands yourself, in your own terminal: when an AI agent runs them, or there is no terminal, they only print steps and change nothing.

## 1. Set up

```bash
npx -y zn-gate init
```

`init` finds the coding agents on this machine (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app, and the experimental Gemini CLI and Copilot CLI), shows what is missing, and asks before each step. Exit code `0` means it is done, or every agent found is already protected. `1` means no supported agent was found, or the steps were only printed.

## 2. Preview wrapping MCP servers

To see what `init --wrap-mcp` would do to your MCP server configs, add `--dry-run`:

```bash
npx -y zn-gate init --wrap-mcp --dry-run
```

It shows what would change and changes nothing. Run it without `--dry-run` to wrap the servers with `shield`; backups are written first.

## 3. Check

```bash
npx -y zn-gate check
```

This shows that zn stops your agent from reading a fake secret, in a temporary folder. Nothing is sent and no setting changes. See [what the output means](../check.md).

## 4. Preview the removal

```bash
npx -y zn-gate uninstall --dry-run
```

It finds what zn-gate set up for your user and for the folder you are in, prints the plan with the file paths, and changes nothing.

## 5. Remove

```bash
npx -y zn-gate uninstall
```

It prints the same plan and asks "Remove what is listed above?". Nothing is removed until you answer yes. Then it removes the plugin, the hooks and the wrapped MCP servers it listed.

- Your vault is kept unless you answer yes to a second, separate question. The default is no, and deleting it cannot be undone.
- Your `.env` files are never edited. If you used `env shadow`, put the values back first with `env unshadow`.
- It ends by running `check`, and prints the last step: `npm uninstall -g zn-gate`.

Exit code `0` means everything listed was removed, or there was nothing to remove. `1` means you answered no, or a step failed. `77` means there was no interactive terminal, or an AI agent ran it: nothing was changed.

## Full pages

- [Command reference: `init`](../cli.md#init) and [`uninstall`](../cli.md#uninstall)
- [Remove zn-gate](../uninstall.md), including removing one part at a time
