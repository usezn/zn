### Security
- A shell command that names more than 64 files, or that runs the instruction-file check out of time, is no longer allowed silently. It now asks (and is refused in strict mode) with a message saying it names too many files to check, as a write to `AGENTS.md` or `CLAUDE.md` does.
