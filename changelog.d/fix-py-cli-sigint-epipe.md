### Fixed
- The Python `zn-gate` command no longer prints a stack trace when you press Ctrl-C (it prints "Interrupted." and exits `130`), and no longer prints "Exception ignored" when its output is piped into a command that closes early, such as `zn-gate scan . | head -n0`. It still exits with the status it would have had, like the Node command.
