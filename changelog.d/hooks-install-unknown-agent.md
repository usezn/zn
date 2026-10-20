### Fixed
- `zn-gate hooks install` and `hooks uninstall` now check the agent name before they ask for a terminal. For a misspelled name they suggest the closest supported one, and they list the supported agents and exit with code 64. Before, a script or an agent was told "needs an interactive terminal" and could think the agent was supported. The Python package has no `hooks` command.
