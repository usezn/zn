### Security
- `zn-gate check` runs the hook script of the Claude Code plugin (`scripts/zn-node.sh`) or the ZCode plugin (`scripts/zn-hook.sh`) only when its sha256 is one zn has shipped. An edited or replaced script is reported as NOT protected and is not run; a plugin newer than the zn-gate you run asks you to update zn-gate first.
- `zn-gate check` finds a zn-gate plugin for Cursor up to 8 folders below `~/.cursor/plugins` and through links.
