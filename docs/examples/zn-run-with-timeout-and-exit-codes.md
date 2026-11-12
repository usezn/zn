# Example: zn run, exit codes and a time limit

`zn-gate run` starts one program and ends with the exit code of that program.
That lets a script branch on the result as if the program had run alone. This
page shows the exit codes with real runs, how a program that is stopped by a
signal ends, why zn-gate has no time limit of its own, and one way to add one.
All commands are harmless and every value is made up. For the secrets side of
`run`, read [store a secret and run a program](secret-set-and-run.md). The full
list of codes of every command is in [Exit codes](../exit-codes.md).

The runs below name no secret. Everything after `--` belongs to your program.

## The program's exit code comes back unchanged

```sh
zn-gate run -- true
```

The program exits with `0`, and so does `zn-gate run`.

```sh
zn-gate run -- false
```

Exit code `1`.

```sh
zn-gate run -- sh -c 'exit 3'
```

Exit code `3`. Whatever the program returns is what you get, so `3` here means
"the program returned 3", not a zn-gate code. Output of the program is passed
on as it is (zn-gate only masks secret values in it), and its standard input is
the one of your terminal:

```sh
zn-gate run -- sh -c 'echo hello; exit 7'
```

```text
hello
```

Exit code `7`. In the code, the program's code is the value `zn-gate run`
resolves with when the program closes
(`lib/broker/run.js` of the package, lines 453 and 457).

## Codes that zn-gate itself returns

Some codes come from zn-gate and not from your program. They are the codes in
[the exit codes page](../exit-codes.md) for `run`, set at lines 497 to 500 of
the same file:

| Code | When | Real run |
|---|---|---|
| `64` | Wrong usage: no `--` and no program | `zn-gate run` prints `zn run: usage: zn run [--secrets NAME[,NAME...]] [--agent ID] [--egress-allow HOST[:PORT],...] -- <command> [args...]` |
| `77` | zn-gate refused: a secret was not allowed or not approved | Not reproduced here |
| `127` | The program was not found | `zn-gate run -- no-such-program-xyz` prints a line that starts with `zn run: Not found:`, names the program and says to check that it is installed and on your PATH |
| `1` | Any other error | `zn-gate run --secrets EXAMPLE_KEY -- true` with the vault locked prints `zn run: Your secret vault is locked. Unlock it in this terminal with: npx -y zn-gate@1.15.0 unlock. Then run this command again.` |

A program can return `64`, `77` or `127` too, so a script cannot always tell
who returned the code. Read the line that starts with `zn run:` on standard
error: zn-gate always prints one when it is the one that stopped.

## A program stopped by a signal

When the program ends because of a signal, there is no exit code of its own.
`zn-gate run` then returns `130` if the signal was `SIGINT` and `143` for any
other signal (line 457):

```sh
zn-gate run -- sh -c 'kill -INT $$'
zn-gate run -- sh -c 'kill -TERM $$'
zn-gate run -- sh -c 'kill -KILL $$'
```

These end with `130`, `143` and `143`. A program killed by `SIGKILL` also gives
`143`, not `137`. When you press Ctrl+C in the terminal, or `zn-gate run`
receives `SIGINT` or `SIGTERM`, it passes that signal on to the program
(lines 441 to 444).

## There is no time limit

`zn-gate run` has no option for a time limit, and the code of `run` has none: a
program that does not end keeps `zn-gate run` waiting. To add a limit, put a
tool that has one in front of your program. On Linux, `timeout` from coreutils
does:

```sh
zn-gate run -- timeout 1 sleep 3
```

`timeout` stops `sleep` after one second and returns its own code, `124`, which
`zn-gate run` passes on. Other systems may have no `timeout` command, or a
different one.

## Branch on the result in a script

```sh
zn-gate run -- sh -c 'exit 3'
status=$?
case $status in
  0) echo "ok" ;;
  3) echo "the program asked for a retry (3)" ;;
  64|77|127) echo "zn-gate refused, or could not start the program ($status)" ;;
  *) echo "the program failed with $status" ;;
esac
```

The real output of this script:

```text
the program asked for a retry (3)
```

Read `$?` on the line right after `zn-gate run`: any other command in between
replaces it.

## Next steps

- For every code of every command, read [Exit codes](../exit-codes.md).
- For the options of `run`, read [`run` in the CLI reference](../cli.md#run).
- To hand a secret to the program, read [store a secret and run a program](secret-set-and-run.md).
