### Fixed
- `zn team managed-config` now writes the same Claude Code hook command for a given system whichever system runs it: the Windows file keeps the scrub that reads variable names in any case (Git Bash), and the Linux and macOS files the short one.
- `zn-gate check` on Windows reports a project hook guard with the short Linux and macOS scrub as modified instead of guarded, because that scrub leaves a loader variable written in another case set.
