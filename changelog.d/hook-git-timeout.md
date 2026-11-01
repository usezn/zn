### Fixed
- A git command that hangs (for example on a network drive) no longer blocks the Claude Code hook. zn stops git after 3 seconds, and a file whose git state cannot be read is handled as one that could be committed: secret values stay as placeholders in it.
