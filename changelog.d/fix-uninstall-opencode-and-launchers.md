### Fixed
- `zn-gate uninstall` now finds and removes the OpenCode plugin that zn wrote (for your user and for the current project) and leaves any other plugin in that folder alone. Before, the plugin stayed behind and, once the program was removed, OpenCode blocked every tool call.
- `zn-gate uninstall` and `zn hooks uninstall` now also remove zn's hook launcher scripts in `~/.zn/hooks` (only the files zn wrote) and the folder when it is empty.
