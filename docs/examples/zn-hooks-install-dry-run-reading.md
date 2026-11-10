# Example: see what `hooks install` will change before it changes anything

`hooks install` has no preview. There is no `--dry-run` for it, so this page shows what you can read before you run it, what the install writes, and how to check and undo the result. The example uses Claude Code, with made-up paths. Run the install in your own terminal: it refuses to run inside an agent or without a terminal, and then it changes nothing.

The steps build on [install the hooks for one agent](zn-hooks-install-for-one-agent.md) and on [the command reference](../cli.md#hooks-install).

## 1. Try the preview flag

If you add `--dry-run`, the command stops before anything is written:

```text
$ npx -y zn-gate hooks install claude-code --dry-run
zn hooks: unknown option "--dry-run". The options of zn hooks are --project and --no-mcp.
exit 64
```

The only options of `hooks install` are `--project` and `--no-mcp`. An unknown option is refused with exit code `64` before the terminal check.

Without the flag, outside a terminal, the install stops with exit code `77`:

```text
$ npx -y zn-gate hooks install claude-code
zn hooks: Not allowed: zn hooks install needs an interactive terminal. Open a terminal window yourself and run it there.
exit 77
```

Nothing is written in either case.

## 2. See what is installed now

`check --hooks` lists the zn hooks that are already installed. It only reads files:

```bash
npx -y zn-gate check --hooks
```

On a computer where zn has never been installed, it prints:

```text
zn hooks installed on this machine (nothing was run or changed):

  None found. To set zn up, run `npx -y zn-gate init` in your own terminal.

exit 0
```

If the list shows hooks for the agent you are about to install, the install will update them rather than add a second copy. Read the list first. See [List every installed hook](../check.md#list-every-installed-hook).

## 3. Find the file the install will change

For Claude Code the install changes one settings file:

- **Your user settings:** `settings.json` in the folder named by `CLAUDE_CONFIG_DIR`, or in `.claude` in your home folder when that variable is not set.
- **A project (`--project`):** `.claude/settings.json` in the folder you run the command from.

Open the file read-only, for example with `cat`, and note the hook entries that are already there. Hooks of other tools stay in the file; the install only replaces entries that zn wrote before.

Make your own copy before you start:

```bash
cp ~/.claude/settings.json ~/settings-before-zn.json
```

If the file does not exist yet, the install creates it and writes no backup.

The `--project` file is shared with everyone who uses the project, so if your project is in version control, read it in the project folder before you install.

## 4. What the install writes

From the code, `hooks install claude-code` does these steps, in this order:

1. Writes a backup of the settings file next to it, named like `settings.json.bak-zn-<date and time>`, if the file exists.
2. Adds zn's hook entries, one group for each event the agent calls. It first removes earlier zn entries, so running the install twice does not stack them.
3. Registers the `secrets` MCP server, unless you pass `--no-mcp`.

## 5. Install and read the output

Run the install in your own terminal, for the agent you chose:

```bash
npx -y zn-gate hooks install claude-code
```

Add `--project` to change only the project file, or `--no-mcp` to skip the `secrets` server. The output names the file it changed and the backup it made:

```text
Installed zn hooks for claude-code in <path to settings.json>
  backup: <path to the backup>
```

If the output shows `backup:`, you can compare the two files with a diff tool.

## 6. Check the result

```bash
npx -y zn-gate check --hooks
npx -y zn-gate check
```

The first command should list the hooks of the agent with `OK` on each line. The second runs a test with a fake `.env` file and reports whether the fake secret was blocked. See [what the output means](../check.md).

## 7. Undo it

To remove only zn's hooks for that agent:

```bash
npx -y zn-gate hooks uninstall claude-code
```

The small launcher under `~/.zn/hooks` stays, because other profiles of the same agent may use it.

To go back to the file you saved, copy it over `settings.json` while the agent is closed, then run `check --hooks` to confirm the list is empty for that agent.

## 8. Other commands that show a plan

These commands have a dry run, but they cover other parts of zn:

- [`init --wrap-mcp --dry-run`](../cli.md#init) shows the MCP servers it would wrap. It does not show hooks.
- [`uninstall --dry-run`](../cli.md#uninstall) shows what the full removal would take away.

## Related

- [Install the hooks for one agent](zn-hooks-install-for-one-agent.md)
- [Remove the hooks and check that none is left](hooks-uninstall-then-verify.md)
- [Re-check the hooks after an agent update](hooks-status-after-agent-update.md)
