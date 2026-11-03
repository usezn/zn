### Fixed
- `zn-gate uninstall` now finds and removes the OpenCode plugin that zn wrote (for your user and for the current project) and leaves any other plugin in that folder alone. Before, the plugin stayed behind and, once the program was removed, OpenCode blocked every tool call.
- `zn-gate uninstall` now also lists and removes zn's hook launcher scripts in `~/.zn/hooks` (only the files zn wrote), including one left behind after its hooks were already gone, and the folder when it is empty. `zn hooks uninstall` still leaves the shared launcher in place.
