### Security
- Codex CLI: `zn hooks install codex` no longer lets Codex run tool calls unchecked when the Node.js it was installed with disappears (an `nvm` switch or uninstall, an upgrade). The hook command was that Node.js's absolute path, so it failed to start (exit 127) and Codex, which blocks only on a deny or on exit code 2, ran the call without telling you. The hook is now a small launcher script under `~/.zn/hooks` that runs the Node.js it was installed with, else `zn` from your PATH, else blocks (exit code 2 for tool calls and prompts, a deny for approval requests, a warning on the other events) without needing Node.js. Run `zn hooks install codex` again to switch an existing install over.

### Fixed
- `zn-gate check` now reports a Codex hook whose Node.js, zn-gate files or launcher script are gone, and says to run `npm install -g zn-gate` and `zn hooks install codex`.
