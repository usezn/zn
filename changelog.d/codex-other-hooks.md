### Security
- `zn-gate check` reports Codex as not fully protected when another tool's `PreToolUse` or `PermissionRequest` hook is set up in your Codex folder or the project's `.codex` folder, because Codex runs those hooks at the same time and such a hook can change a command after zn has checked it.
- In Codex, zn's `PostToolUse` hook now also checks the command that really ran and withholds the output when zn blocks that command.
