### Security

- `zn team join` no longer needs the join token on the command line, where it stays in your shell history and in the process list. Run `zn team join -` and give the token on standard input (for example `printf %s "$TOKEN" | zn team join -`), or set `ZN_TEAM_JOIN_TOKEN` and run `zn team join`. A token given as an argument still works, now with a one-line note on how to avoid the history. The token is never printed.
