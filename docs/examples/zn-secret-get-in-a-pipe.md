# Example: piping a vault value into another tool

You may want to write `zn-gate secret get NAME | some-tool`. This page shows what happens when you try, and what to do instead. For the full reference, read the [CLI page](../cli.md#secret-get) and the [secrets page](../secrets.md).

The output below comes from real runs against a throwaway vault with a made-up secret called `DEMO_TOKEN`. Messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> run`), and here it is shortened to `zn-gate`.

## What `secret get` does

`secret get` exists, and so does its alias `secret reveal`. Neither prints a value. Every call is refused, whatever the name is, whether the vault is locked or unlocked, and whether a person or an agent runs it. The message goes to standard error and the exit code is 77:

```bash
zn-gate secret get DEMO_TOKEN
```

```text
zn secret: Not allowed: zn does not print secret values. To use one in a command, run: zn-gate run --secrets NAME -- <command>
```

The same refusal came back in a terminal, without a terminal, with the name left out, and with an agent's environment variable set. Nothing is written to standard output.

## What a pipe sees

Put the command in front of a pipe and the next tool gets nothing:

```bash
zn-gate secret get DEMO_TOKEN 2>/dev/null | wc -c
```

```text
0
```

`wc` counted 0 bytes: standard output was empty. The exit code of the pipeline is the exit code of its last command, so without `set -o pipefail` the shell reports 0 even though `secret get` exited with 77. In the throwaway run, the pipeline ended with 0 without `pipefail` and with 77 with it. A script that pipes from `secret get` can therefore look as if it worked. Do not build a script on this command.

## What to do instead

Let the program that needs the value read it itself. This is the path the vault is built for:

1. Store the value once, in your own terminal, naming the program that may use it. You type the value at a hidden prompt:

   ```bash
   zn-gate secret set DEMO_TOKEN --command printenv
   ```

2. Run that program through `run`. The value goes into the program's environment, under the name `DEMO_TOKEN`, and never into your shell or its history:

   ```bash
   zn-gate run --secrets DEMO_TOKEN -- printenv DEMO_TOKEN
   ```

   The first time a program uses a secret, the vault asks you to confirm in its own dialog, or in the terminal where you ran `zn-gate unlock --foreground`. See [secret allow or secret approve](zn-secret-allow-vs-approve-decision.md).

`run` masks the value in the output of the program. In the throwaway run, `printenv` printed the marker and not the value:

```text
__ZN_DEMO_TOKEN__
```

So the output of `run` is safe to pipe on to another tool. The pipe gets the marker, not the value:

```bash
zn-gate run --secrets DEMO_TOKEN -- printenv DEMO_TOKEN | wc -c
```

```text
18
```

That is the 17 characters of the marker and the newline. The exit code of `run` is the exit code of your program. If the program is not allowed to use the secret, nothing is run and the exit code is 77.

If the tool you want to feed needs the value itself, for example a command-line client that reads a token from an environment variable, run that tool with `zn-gate run --secrets NAME -- <tool> ...`. Store the secret under the name the tool reads and allow that program, as in the [secrets page](../secrets.md).

## Shell history

A value that you type on a command line is kept in your shell history and in the transcripts of agents. For that reason `secret set` refuses a value given as an argument and exits with 64:

```text
zn secret: values are never accepted as arguments (they end up in shell history and agent transcripts). Run `zn secret set DEMO_TOKEN2` and type or paste the value at the hidden prompt, or use --clipboard.
```

Use the hidden prompt, or `--clipboard`. Then there is nothing to find in your history.

## Related

- [Store a secret and run a program that uses it](secret-set-and-run.md)
- [Secrets in the vault](../secrets.md)
- [`secret get` in the command reference](../cli.md#secret-get)
