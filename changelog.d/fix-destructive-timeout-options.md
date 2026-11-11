### Security
- The destructive-command rules (Node.js and Python, also used by the hooks) now see through the options of `timeout` (`-s`, `-k`, `--signal`, `--kill-after`, `--foreground`, `--preserve-status`, `--verbose`, `--`) before they check the command it runs, also when `nohup` or another `timeout` follows. A `timeout` line they cannot read cleanly is checked as the command, never skipped.
