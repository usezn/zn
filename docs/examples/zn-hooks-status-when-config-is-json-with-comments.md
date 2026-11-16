# Example: what zn-gate does when an agent's settings file has comments

Some people keep notes in their agent's settings file, with `//` or `/* */` comments, or leave a comma after the last item. That is not valid JSON, and zn-gate reads the settings files of its agents as plain JSON. This page shows what `check --hooks` and `hooks install` do with such a file, with Claude Code as the example, and how to get the hooks installed anyway. Everything here is described in the [command reference](../cli.md) and on the [check page](../check.md#list-every-installed-hook). All values are made up, and the output has the home folder shortened to `~`.

Run the install commands yourself, in your own terminal. When an AI agent runs them, or there is no terminal, nothing is changed.

## 1. The file

A user settings file of Claude Code (`~/.claude/settings.json`) with two comments:

```text
{
  // my own notes
  "theme": "dark", /* keep */
  "permissions": {
    "allow": ["Bash(ls:*)"]
  }
}
```

## 2. List the hooks

```bash
npx -y zn-gate check --hooks
```

```text
zn hooks installed on this machine (nothing was run or changed):

Claude Code (user): ~/.claude/settings.json
  BROKEN -
  BROKEN: the file is not valid JSON, so Claude Code cannot read its hooks and zn cannot add its own.
    Fix: run `zn hooks install claude-code` in your own terminal.

0 OK, 0 stale, 1 broken.
To remove the hooks of an agent instead, run `zn hooks uninstall <agent>`.
```

The command only reads files. The file counts as one broken row because zn cannot parse it, and the exit code is `1`. The `Fix:` line is the generic one that every broken row gets. For a file with comments it does not help yet: see the next step.

## 3. Try the install

```bash
npx -y zn-gate hooks install claude-code
```

```text
zn hooks: cannot parse ~/.claude/settings.json: Expected property name or '}' in JSON at position 4 (line 2 column 3)
```

The command exits with `1` and leaves the file exactly as it was: no hook is added, and no backup copy is written, because nothing is written. The end of the message comes from Node.js, so its wording and the position can differ on your machine. `hooks uninstall claude-code` refuses the same file in the same way.

The agents that keep their hooks in a JSON settings file are read the same way: Antigravity, Claude Code, Codex CLI, GitHub Copilot, Cursor, Gemini CLI and ZCode. OpenCode is not affected: for OpenCode, zn writes a plugin file and does not edit a JSON settings file.

## 4. Get the hooks in with the comments out

zn writes the settings back without comments, so a file that zn manages cannot keep them. Do it in this order:

1. Copy the file somewhere safe, for example `cp ~/.claude/settings.json ~/settings-with-comments.json`. Your notes stay in that copy.
2. In `~/.claude/settings.json`, delete the comment text and any comma after the last item of an object or list. Keep everything else.
3. Run the install again:

   ```bash
   npx -y zn-gate hooks install claude-code
   ```

   ```text
   Installed zn hooks for claude-code in ~/.claude/settings.json
     backup: ~/.claude/settings.json.bak-zn-<date and time>
   ```

   The install may print one more line, a note about registering the `secrets` MCP server, depending on whether the `claude` command is on your PATH. The backup is a copy of the file as it was before. Your other settings are kept, and the file keeps its indentation and line endings.
4. List the hooks again:

   ```bash
   npx -y zn-gate check --hooks
   ```

   ```text
   Claude Code (user): ~/.claude/settings.json
     OK     PreToolUse ...
     OK     PostToolUse ...
     OK     UserPromptSubmit ...
     OK     UserPromptExpansion ...
     OK     ConfigChange ...
     OK     InstructionsLoaded ...

   6 OK, 0 stale, 0 broken.
   ```

   The rows show the whole command each hook runs, and the matcher in square brackets for the events that have one. This page shortens them. The number of rows depends on your zn-gate version. Exit code `0` means every hook is OK.

## 5. Do not add the comments back

If you put a comment back into the file after the install, the same thing happens again: `check --hooks` shows the file as broken and says `0 OK, 0 stale, 1 broken`. A plain `zn-gate check` then reports the agent as not set up and ends with `Hooks: 0 OK, 0 stale, 1 broken. Run zn-gate check --hooks for details.`, because zn cannot read the hooks it wrote. Keep your notes in a separate file instead, such as the copy from step 4.

## Related

- [List every installed hook](../check.md#list-every-installed-hook), with what OK, stale and broken mean.
- [`hooks install` in the command reference](../cli.md#hooks-install)
- [Checklist: check the hooks after an agent update](hooks-status-after-agent-update.md)
- [All examples](README.md)
