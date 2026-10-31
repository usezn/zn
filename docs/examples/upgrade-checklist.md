# Example: upgrade checklist

A one-screen version of [Upgrading zn-gate](../upgrading.md). Run every command in your own terminal, not through an AI agent. For the version table, the Codex, Node.js and plugin cases, read the [full page](../upgrading.md).

## Before

- [ ] Note your current version: `zn-gate version`.
- [ ] Read the row for each release between your version and the new one in [What each release asks you to do](../upgrading.md#what-each-release-asks-you-to-do). Most say "No action".
- [ ] Optional: run `zn-gate check` now, so you know which agents were protected before the update. Exit code `0` means every agent that is set up is protected.

## During

- [ ] Update the package: `npm install -g zn-gate` (and `pip install -U zn-gate` if you use the Python package). If you only run `npx -y zn-gate ...`, there is nothing to update.
- [ ] If the release notes in the [changelog](../../CHANGELOG.md) say a hook changed, run the install again for the agent they name:

  ```bash
  zn hooks install claude-code   # or codex, cursor, opencode
  ```

  It is safe to repeat: it updates zn's own entries and leaves the rest of your settings alone. Add `--project` for a project install, then commit the changed file.
- [ ] Claude Code plugin: update it with `/plugin` in Claude Code (or `claude plugin update zn-gate@usezn`) and start a new session.
- [ ] Codex: open Codex and approve the changed hooks in `/hooks`.

## After

- [ ] Run `zn-gate check`. Every agent that is set up should say **OK**. If one does not, the output prints the command that fixes it. [What the output means](../check.md).
- [ ] Run `zn-gate version` to confirm the new version.
- [ ] If you need your agent right away while something is broken, turn zn off for it with `zn hooks uninstall <agent>`, then turn it back on with `zn hooks install <agent>` and run `zn-gate check` again.
