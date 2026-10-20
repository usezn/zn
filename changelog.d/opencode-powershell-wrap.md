### Fixed
- OpenCode on Windows with PowerShell (`powershell.exe` or `pwsh`) as its shell: a command with a `__ZN_NAME__` marker is now wrapped in `zn run` in PowerShell form, instead of failing. A PowerShell command that is not a single program with plain arguments is refused with a next step. Wrapping for bash is unchanged.
