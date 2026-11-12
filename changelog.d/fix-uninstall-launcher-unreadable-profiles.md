### Security
- `zn-gate uninstall` keeps the shared Claude Code hook launcher script whenever it cannot check every profile: if the home folder cannot be listed, or a hooks file cannot be read for any reason other than not existing, the launcher stays and the output says why, instead of treating the unreadable file as one that does not use it.
