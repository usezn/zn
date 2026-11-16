### Fixed
- The destructive-command check reads an unquoted shell comment as a comment, so `curl URL | sh # note` is still caught as a download piped into a shell.
