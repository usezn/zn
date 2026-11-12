# Example: store a secret and run a program that uses it

A short walk-through of the two commands behind "the agent never sees the value": `secret set` stores a value in the local vault, and `run` starts one program with that value in its environment. The name and the value here are made up. For the full picture, read [Keep secrets out of your coding agent](../secrets.md).

You do this in your own terminal. The agent cannot do the first two steps: they need a person at a terminal.

## 1. Unlock the vault

Undo: `npx -y zn-gate lock` locks it again.

```bash
npx -y zn-gate unlock
```

The first run creates the vault. It stays unlocked for 8 hours, or until 30 minutes without use, or until `lock`. More: [secrets, step 1](../secrets.md#1-install-and-unlock-the-vault).

## 2. Store the secret and allow one program

Undo: `npx -y zn-gate secret rm EXAMPLE_API_KEY` (it asks you to confirm).

Say a program reads its key from the environment variable `EXAMPLE_API_KEY`. Store the secret under that name and allow the program that may use it (here `printenv`, which only prints a variable):

```bash
npx -y zn-gate secret set EXAMPLE_API_KEY --command printenv
```

zn asks for the value at a hidden prompt, so it never appears in your shell history or in an argument:

```text
Value for EXAMPLE_API_KEY (hidden):
```

Type or paste a fake value such as `example-not-a-real-key-1234`. The value must be at least 8 characters. Then zn prints:

```text
Stored EXAMPLE_API_KEY (env mode). Agents use it as __ZN_EXAMPLE_API_KEY__.
```

`--command` makes it an `env` mode secret, the kind `run` can put in a program's environment. Without `--command` or `--host`, zn adds a tip about which one to allow. To see what is stored (names and policy, never values):

```bash
npx -y zn-gate secret list
```

If the name already exists, `secret set` stops with `EXAMPLE_API_KEY already exists; use --force to replace it`.

## 3. Run the program with the secret

This is the command an agent runs. It names the secret with `--secrets`, and everything after `--` is the program:

```bash
npx -y zn-gate run --secrets EXAMPLE_API_KEY -- printenv EXAMPLE_API_KEY
```

The first time a program uses a secret, the vault asks you to confirm in its own dialog, or in the terminal where you ran `zn unlock --foreground`. The prompt shows the exact program that will run. The agent cannot answer it.

The value goes only into that program's environment. What the program prints is masked: the value comes back as the marker, so the agent sees `__ZN_EXAMPLE_API_KEY__` and never the value.

The exit code of `run` is the exit code of your program (here `0`). In a Makefile, that is what makes `make` stop when the program fails: [Example: a failing `zn run` stops make](zn-secret-run-exit-code-passthrough-in-make.md).

## What an agent gets when it is not allowed

| What the agent tries | What happens | Exit code |
|---|---|---|
| A program that the secret does not allow, for example `curl` | Refused: `` `curl` is not allowed to use EXAMPLE_API_KEY yet `` and the command to allow it | `77` |
| The marker in the arguments, such as `printenv __ZN_EXAMPLE_API_KEY__` | Refused, because an argument is visible to other processes; zn says to pass the secret as an environment variable | `77` |
| A secret that is not in the vault | `secret EXAMPLE_API_KEY is not in the vault` | `127` |
| `secret get EXAMPLE_API_KEY` | zn does not print secret values | `77` |
| `run` with a missing or wrong option | A usage message | `64` |

All of the exit codes are listed in [Exit codes](../exit-codes.md#secrets-and-the-vault).

## Check who used the secret

```bash
npx -y zn-gate secret log
```

It lists each use (time, decision, secret name, mode, agent, program) without any value, then checks the audit log chain.

## Limits to know

- An environment variable is not in `ps` or in shell history, but other processes of your user can still read it. See [what an environment variable does and does not hide](../secrets.md#4-let-a-command-use-a-secret).
- Allow a specific program. Allowing `node`, `python` or `make` lets every script they run read the secret, and zn warns you.

## Next steps

- To store two values that a program needs together, such as an access key id and its secret, see [store an access key id and its secret as two vault secrets](zn-secret-set-for-an-aws-credential-pair.md).
- More worked examples: [Examples](README.md).
