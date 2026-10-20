### Fixed
- `zn-gate init` shows the output of npm while it runs, and no longer stops when npm prints more than 1 MiB.
- `zn-gate init` writes the PATH line for a global npm folder to the start-up file of your shell (SHELL decides: bash, zsh or fish), not always to `~/.zshrc` on macOS.
