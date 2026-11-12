# Example: a failing `zn run` stops make

You can run a build step through `zn run` in a Makefile target, so the step gets a secret from the vault. This page shows that `zn run` ends with the exit code of the program it ran, so when that program fails, `make` stops at that line. The secret name and its value here are made up, and the program only exits with a code. Do this in your own terminal.

## What you need

A vault that is unlocked, with the fake secret stored and one program allowed to use it. [Store a secret and run a program that uses it](secret-set-and-run.md) shows each step. Here the program is `sh`, because it can exit with a code you choose:

```bash
npx -y zn-gate secret set EXAMPLE_API_KEY --command sh
```

Type a fake value such as `example-not-a-real-key-1234` at the hidden prompt. Undo: `npx -y zn-gate secret rm EXAMPLE_API_KEY`.

The first time `sh` uses the secret, the vault asks you to confirm in its own dialog, or in the terminal where you ran `npx -y zn-gate unlock --foreground`. The question names the program and warns that `sh` runs any code it is given, so every script it runs could read the secret. Answer `y` for this walk-through. Later runs of the same program do not ask again. In a real project, allow the program your recipe really runs, not a shell.

## 1. The Makefile

Create a file named `Makefile` with two targets. A Makefile needs a tab character, not spaces, at the start of each recipe line, so this command writes the file for you and keeps the tabs:

```bash
printf 'build:\n\tnpx -y zn-gate run --secrets EXAMPLE_API_KEY -- sh -c "exit 3"\n\t@echo "build finished"\n\nreport:\n\t@echo "report step"\n' > Makefile
```

The file now holds this (each indented line starts with one tab):

```text
build:
    npx -y zn-gate run --secrets EXAMPLE_API_KEY -- sh -c "exit 3"
    @echo "build finished"

report:
    @echo "report step"
```

The `build` recipe has two lines. The first runs `sh -c "exit 3"` through `zn run`, so the program starts with `EXAMPLE_API_KEY` in its environment and ends at once with the code `3`. The second prints a message, to show whether `make` goes on.

## 2. Run it

```bash
make build
echo "make exited with $?"
```

`make` prints the recipe line, and then stops:

```text
npx -y zn-gate run --secrets EXAMPLE_API_KEY -- sh -c "exit 3"
make: *** [Makefile:2: build] Error 3
make exited with 2
```

- `Error 3` is the exit code of the program that `zn run` started. Its `3` came back unchanged.
- `build finished` was never printed, because `make` stops at the first recipe line that fails. A target that comes after it, such as `report` in `make build report`, does not run either.
- `make` itself exits with `2` whenever a recipe fails, whatever the code was. To read the program's code, look at the `Error` line. The wording of that line depends on your version of `make` (this output is from GNU Make 4.4.1).

`make report` on its own prints `report step` and exits with `0`.

## Why it works

`zn run` waits for the program and ends with its exit code. It does not change a failure into a success, and it does not hide one. If the program is stopped by a signal, `zn run` ends with `130` for an interrupt and `143` otherwise.

The secret does not change this. The value goes only into the environment of the program, and what the program prints is masked. The exit code is not masked or rewritten.

## When zn itself stops the line

`zn run` can also end before the program starts. Its own codes then show up in `Error N` in the same way:

| What happened | What `zn run` printed | `make` shows |
|---|---|---|
| The program is not allowed to use the secret, for example `printenv` | `zn run: Not allowed: ... is not allowed to use EXAMPLE_API_KEY yet` and the command to allow it | `Error 77` |
| The secret is not in the vault | `zn run: Not found: secret ... is not in the vault` | `Error 127` |
| The vault is locked | `zn run: Your secret vault is locked` and the command to unlock it | `Error 1` |

A wrong option for `zn run` ends with `64`. All of the codes are in [Exit codes](../exit-codes.md#secrets-and-the-vault). In every case the recipe stops, so a missing approval or a locked vault cannot let a build go on without its secret.

## Without a secret

`zn run` also passes the code of the program when you name no secret. It does not need the vault then:

```bash
npx -y zn-gate run -- sh -c "exit 3"
echo "exit code: $?"
```

```text
exit code: 3
```

## Where to read more

- [Store a secret and run a program that uses it](secret-set-and-run.md), the steps behind this page
- [Exit codes](../exit-codes.md#secrets-and-the-vault), the codes of `run` and the secrets commands
- [`run`](../cli.md#run) in the command line reference
