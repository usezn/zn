### Security
- The destructive-command check now refuses `env -S` and `env --split-string` command lines that are nested deeper than it reads, instead of allowing them unread. `checkCommand()` and `check_command()` already blocked `env -S "rm -rf /"`; a string wrapped in four or more levels of `env -S` was allowed. The rules version is `2026-10-31.4`.
