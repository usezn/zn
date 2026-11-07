### Fixed
- On Windows without Git Bash, `zn-gate init` no longer offers to install the zn-gate plugin for Claude Code again when the plugin is installed but cannot start there: reinstalling cannot give it a Git Bash. It now says to install Git for Windows (or set `CLAUDE_CODE_GIT_BASH_PATH` to its `bash.exe`) first, or to use zn hooks instead.
