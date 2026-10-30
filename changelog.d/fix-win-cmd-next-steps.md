### Fixed
- On Windows, the commands zn-gate tells you to run (`zn.cmd`, `npx.cmd`, `zn-gate.cmd`) use the `.cmd` form, so they work with PowerShell's default Restricted execution policy, which refuses the `.ps1` shims. Covers `zn-gate check`, `zn-gate init` and the next-step text of blocked calls. Output on macOS and Linux is unchanged.
