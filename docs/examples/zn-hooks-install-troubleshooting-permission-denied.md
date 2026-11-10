# Troubleshooting: `hooks install` when a settings file is not writable

This page shows what `zn-gate hooks install` prints, and what it changes, when
the settings file of a coding agent cannot be read or written. The example uses
Claude Code and made-up paths. The messages below are copied from the code at
`origin/next`.

## The message

```text
zn hooks: Your account is not allowed to read or change /home/example/.claude/settings.json. Check who owns it and its permissions, then try again.
```

- The prefix `zn hooks:` is the command group (`packages/zn-gate/lib/broker/cli.js:645`).
- The rest is the plain-words text for a permission error, `EACCES` or `EPERM`
  (`packages/zn-gate/lib/errors.js:32-33`). The code itself is shown only with
  `ZN_VERBOSE=1` or `DEBUG=zn`.
- The path is the one the system reported for the failed step. That can be the
  settings file, or the backup copy that zn tries to make first (see below).
- The command exits `1` (`packages/zn-gate/lib/broker/cli.js:646`).
- No `Installed zn hooks for ...` line is printed.

Usage errors are different. They exit `64`, for example an unknown agent name.

## What the command does, in order

For Claude Code, `install` runs these steps (`packages/zn-gate/lib/agents/claude-code.js:487-498`):

1. **Read** the settings file. If the file cannot be read, the command stops
   here with the message above. Nothing is written and no backup is made.
2. **Back up** the file first. zn copies it to a file next to it, named
   `<name>.bak-zn-<UTC time>` (`claude-code.js:354-360`, `490`). If that copy
   fails, the command stops here with the message above.
3. **Write** the new content to a temporary file in the same folder, then rename
   it over the settings file (`packages/zn-gate/lib/broker/files.js:117-127`).
   If the write fails, the temporary file is removed and the error is shown the
   same way.

zn does not check the permission bits of the file before it starts. What
happens therefore depends on where the problem is:

| What is not writable | What you see | What changed |
| --- | --- | --- |
| The settings file cannot be read | the permission message, exit `1` | nothing |
| The folder of the settings file | the permission message (the backup copy fails), exit `1` | nothing |
| Only the settings file (read-only), folder writable | the backup is made, then the new file replaces the old one; the message may not appear, depending on the operating system | the backup file exists; the file now has the permissions zn writes (`0644`, `claude-code.js:498`) |

So a read-only settings file is not a reliable guard: zn may replace it. Do not
count on the read-only bit to protect the file.

## A link that points nowhere

If the settings file is a symbolic link to a file that does not exist, zn
stops before it touches anything (`packages/zn-gate/lib/broker/cli.js:554`):

```text
zn hooks: /home/example/.claude/settings.json is a link to a file that does not exist, so zn did not change anything. Remove the link or point it to a real file, then run `zn-gate hooks install claude-code` again.
```

This one exits `64`. The text is shortened here; the last sentence names the
command as zn prints it, which may differ from the example.

## How to fix it

1. Read the settings file's owner and permissions in your own terminal, and
   fix them if they are wrong. Do this yourself, not through an agent.
2. Run the command again in your own terminal. `hooks install` needs an
   interactive terminal (`docs/cli.md`, `hooks`):

   ```bash
   zn-gate hooks install claude-code
   ```

   For the settings of one project instead of your user settings, add
   `--project`.
3. Check the result:

   ```bash
   zn-gate check --hooks
   ```

   See [hooks-status-after-agent-update.md](hooks-status-after-agent-update.md)
   for how to read that output.

## Related pages

- [zn-hooks-install-for-one-agent.md](zn-hooks-install-for-one-agent.md): install the hooks for one agent only.
- [hooks-uninstall-then-verify.md](hooks-uninstall-then-verify.md): remove the hooks and confirm that none is left.
- [init-and-uninstall.md](init-and-uninstall.md): the guided setup and removal.
