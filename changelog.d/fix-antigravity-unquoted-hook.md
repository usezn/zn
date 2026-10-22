### Fixed
- Antigravity: `zn hooks install antigravity` wrote the launcher path in quotes, but Antigravity runs hook commands without a shell, so the quotes became part of the file name and the hook never started. The path is now written without quotes, and `zn-gate check` runs the hook the same way and asks for a reinstall when it finds the old quoted form.
