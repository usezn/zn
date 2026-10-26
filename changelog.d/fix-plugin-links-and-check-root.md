### Security
- A link inside an agent's plugin folder (for example `~/.claude/plugins/cache/usezn` linked to another folder) no longer leaves the folder it leads to writable: the agent hooks protect it at its real place.
- `zn-gate check` starts the Claude Code plugin from the real path of the folder it checked, not from the path in `installed_plugins.json`.

### Fixed
- `zn-gate check` run inside a dotfiles repository that `~/.claude` links into no longer reports the installed plugin as being inside the project.
