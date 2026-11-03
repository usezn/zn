### Security
- `git --exec-path=<folder>` is now blocked unless the folder is the system folder of git's own programs (such as `/usr/lib/git-core`), like the `GIT_EXEC_PATH` variable: git runs its subcommands from that folder, so another one could make it run any program. `git --exec-path` with no value, which only prints the folder, is still allowed.
