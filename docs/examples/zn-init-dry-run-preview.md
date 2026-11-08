# Example: preview what `zn init` will change

`init` has one preview: `--dry-run`. It applies to the MCP step, `init --wrap-mcp`, where zn wraps your MCP servers with `shield`. It lists what would change and changes nothing. The guided `init` (no options) has no dry run, but when it runs without a terminal, or an AI agent runs it, it only prints the steps and changes nothing. Everything here is also in the [command reference](../cli.md#init) and the [short walk-through](init-and-uninstall.md).

The example below was run for real, with the CLI of this repository, in a throwaway home folder with two fake config files. Paths are shortened to `~`, and the command is shown as `zn` (the same as `npx -y zn-gate`). All names are made up.

## The setup

Two fake agent configs:

- Cursor, `~/.cursor/mcp.json`, with two servers that zn has not wrapped yet (`files` and `notes`).
- Claude Code, `~/.claude.json`, with one server that already goes through `zn-gate shield`.

## The command

```bash
zn init --wrap-mcp --dry-run
```

`--dry-run` alone does the same: it selects `--wrap-mcp` too.

## The output

```text
[+]  zn-gate init - Zero-Touch MCP Auto-Discovery & Shielding
------------------------------------------------------------
  [ok] Claude Code          [already_shielded]
  [ok] Cursor               [would_shield] 2 servers
  Claude Desktop       [Not installed/configured]
  Antigravity (AGY)    [Not installed/configured]
  Antigravity (this project) [Not installed/configured]
  Antigravity (shared settings) [Not installed/configured]
  Codex                [Not installed/configured]
  OpenCode             [Not installed/configured]
  Hermes / PiAgent     [Not installed/configured]

Done. Checked 9 environment configurations (0 modified).
```

The first line is `[+]` here because the output went to a file; in a terminal it is a shield emoji. See the table in [Settings](../cli.md#settings).

## What each line means

- `[already_shielded]`: every server in that config already goes through `shield`. Nothing to do.
- `[would_shield] 2 servers`: this is the line to read. Without `--dry-run`, zn would wrap those 2 servers in that config. With `--dry-run` it only says so. The preview lists the agent and the number of servers, not the server names or the new file text.
- `[Not installed/configured]`: no config file for that agent was found where zn looks for it, so it is left alone. Antigravity (this project) looks in the folder you run the command from.
- `Done. Checked 9 environment configurations (0 modified).`: it looked at 9 known configs. In a dry run the number of modified files is always 0.

With `--shadow` added, the Cursor line ends with `(shadow mode)`: servers are wrapped so that problems are logged but nothing is dropped.

## Check that nothing changed

The checksums of both config files were the same before and after the run, and no backup file (`.bak`) appeared next to them. A real run, without `--dry-run`, writes a backup first and prints its name under the line, as `backup: <file>`.

## Next

- Run it without `--dry-run` in your own terminal to wrap the servers: `zn init --wrap-mcp`.
- To undo a wrap, run `zn init --revert`, which puts back the saved configs.
- To preview a removal, see [`uninstall --dry-run`](init-and-uninstall.md#4-preview-the-removal).
