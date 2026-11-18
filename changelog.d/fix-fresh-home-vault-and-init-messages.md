### Fixed
- `zn-gate secret list` and the other vault commands on a machine with no vault yet say "No vault yet" and how to create one, instead of saying the vault is locked. A vault that exists but is locked keeps the unlock message.
- `zn-gate init` with no coding agent installed explains that nothing can be set up until one is installed, and `init` without a terminal says plainly that it, and `zn hooks install`, need an interactive terminal.
