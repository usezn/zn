### Security
- The `.env` guard no longer treats the file named after `-f` or `--env-file` as a read for every `dotenvx` command: only `dotenvx run` and `dotenvx get` read it, while `dotenvx set`, `encrypt`, `decrypt` and the other subcommands rewrite it and are now refused, as for any other command that names a `.env` file.
