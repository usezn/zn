### Fixed
- `zn-gate check` runs the hook of the zn-gate plugin for Claude Code the way Claude Code starts it: the command line from the plugin's hooks file, through bash or sh, in its own test folder. Before, it ran the plugin's launcher directly, so a plugin whose start-up script could not reach zn-gate was reported as protected.
