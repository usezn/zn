# Example: removing zn keeps the hooks you wrote yourself

`zn hooks uninstall` removes only the hook entries that zn wrote. A hook you added to the same settings file yourself stays, exactly as it was. This page shows that with one hook of your own in Claude Code's settings, then how to check the result. The full removal guide is [Remove zn-gate](../uninstall.md); every command is in the [command reference](../cli.md#hooks). Run the commands yourself, in your own terminal.

The file and hook below are examples; on your machine they are your own. Your home folder is shown as `~`.

## What is kept

- Every hook entry you wrote, in any event, including events zn does not use. The text of each entry is the same after the uninstall.
- Every other setting in the file, in the same order, with the same indentation, line endings, byte order mark and final newline.

zn knows its own entries by their command. For your user, that is the command that runs zn's launcher script or zn's runner. For one project, it is the `zn hook <agent>` command. An entry with any other command is not zn's, so zn does not remove it.

What is removed: the entries zn wrote. If that leaves an event with no entries, zn removes that event. If that leaves the `hooks` object with nothing in it, zn removes the `hooks` object too.

## 1. Start with a hook of your own

Say `~/.claude/settings.json` holds this before zn is set up:

```json
{
  "theme": "example-theme",
  "hooks": {
    "Notification": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "echo example-user-hook" }]
      }
    ]
  }
}
```

## 2. Install zn's hooks

```bash
zn hooks install claude-code
```

The install adds zn's entries next to yours. Before it edits the file, it writes a backup copy next to it, named with `.bak-zn-` and a time stamp. Your `echo example-user-hook` entry is still there.

## 3. Remove zn's hooks

```bash
zn hooks uninstall claude-code
```

Before it edits the file, it writes another backup copy. The entries zn wrote are removed, and your `echo example-user-hook` entry is left as it was. For Claude Code, the command also removes zn's own `secrets` MCP server, which is not a hook; add `--no-mcp` to leave MCP servers alone.

## 4. Check the result

```bash
npx -y zn-gate check --hooks
```

When no zn hook is left for the agent, the list shows `None found`. Your own hook is not a zn hook, so it is not in that list. Its entry in `~/.claude/settings.json` is still the one you wrote.

## Exceptions and refusals

- **An empty `hooks` object.** If your file had `"hooks": {}` before zn, the uninstall removes it, because it cannot tell that object from the one the install created. The result has the same data, but the bytes may differ.
- **A file zn cannot read.** A settings file that is not plain JSON, for example one with `// comments` in it, is not edited. The install stops with a message that says the file was left unchanged, and the uninstall does the same.
- **OpenCode.** OpenCode has no hooks in a JSON file. zn writes its own plugin file next to your plugins. Your own plugin file, with a different name, is never changed. A plugin file with zn's name that zn did not write is refused, and neither install nor uninstall deletes it.
- **Project hooks.** `--project` works the same way in the settings file of the project. ZCode has no project hooks, so there is nothing to remove there.

The rule above is tested for each agent with a JSON settings file, for your user and for one project: a settings file with hooks of your own is installed and uninstalled again, and it comes back byte for byte. The OpenCode case is tested separately.
