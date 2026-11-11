# Example: store an access key id and its secret as two vault secrets

Some tools need two values together, such as an AWS access key id and its secret access key. zn stores each value as its own vault secret, and one `run` command can hand both to a program. This page does that with made-up values in the format of an AWS key pair, and `printenv` as the program so that nothing is sent anywhere. For one secret on its own, read [Store a secret and run a program that uses it](secret-set-and-run.md). The full picture is in [Keep secrets out of your coding agent](../secrets.md).

You do this in your own terminal. The agent cannot store a secret or answer the approval in step 3.

## The made-up values

| Vault secret | Value used here |
|---|---|
| `AWS_ACCESS_KEY_ID` | `AKIAEXAMPLEEXAMPLE00` |
| `AWS_SECRET_ACCESS_KEY` | `EXAMPLEexampleEXAMPLEexampleEXAMPLE00000` |

The names are the environment variables that the AWS tools read, so a program that uses them needs nothing else. Use your real values only in your own terminal, never in a file the agent can read.

## 1. Unlock the vault

```bash
npx -y zn-gate unlock
```

If the vault does not exist yet, this creates it. See [secrets, step 1](../secrets.md#1-install-and-unlock-the-vault).

## 2. Store the two secrets

Undo: `npx -y zn-gate secret rm AWS_ACCESS_KEY_ID` and `npx -y zn-gate secret rm AWS_SECRET_ACCESS_KEY` (each asks you to confirm).

```bash
npx -y zn-gate secret set AWS_ACCESS_KEY_ID --command printenv
npx -y zn-gate secret set AWS_SECRET_ACCESS_KEY --command printenv
```

Each command asks for its value at a hidden prompt, so neither value appears in your shell history or in an argument. Type or paste the value for that name:

```text
Value for AWS_ACCESS_KEY_ID (hidden):
Stored AWS_ACCESS_KEY_ID (env mode). Agents use it as __ZN_AWS_ACCESS_KEY_ID__.
Value for AWS_SECRET_ACCESS_KEY (hidden):
Stored AWS_SECRET_ACCESS_KEY (env mode). Agents use it as __ZN_AWS_SECRET_ACCESS_KEY__.
```

`--command printenv` allows only that program to use the secret. For a real use, allow the program that needs the pair, for example `--command aws`, and not a shell. To see what is stored (names and policy, never values):

```bash
npx -y zn-gate secret list
```

```text
  AWS_ACCESS_KEY_ID             env     commands=printenv
  AWS_SECRET_ACCESS_KEY         env     commands=printenv
```

## 3. Approve the first use

The first time a program uses a secret, the vault asks you to confirm. Each secret has its own question, so a pair gives you two. On a computer with a desktop the vault shows a dialog. With no dialog (a server, or `ssh`), lock the vault and start it in a terminal of its own, then answer there:

```bash
npx -y zn-gate lock
npx -y zn-gate unlock --foreground
```

Keep that terminal open and run the next step in another one. The vault terminal then prints a question for each secret. This is the first one (the two path lines are shortened here):

```text
zn: let `printenv` use secret AWS_ACCESS_KEY_ID?
    Secret: AWS_ACCESS_KEY_ID (the value goes into the process)
    Command: printenv
    Runs: <the full path of printenv>
    Project: <your project folder>
    If you did not just start this command, choose Deny.
  Allow? [y/N] y
  -> allowed
```

Answer `y` for `AWS_ACCESS_KEY_ID`, and again when the same question comes for `AWS_SECRET_ACCESS_KEY`. Without a way to ask, nothing is run: `run` says that the first use of `AWS_ACCESS_KEY_ID` was not approved, and exits with `77`.

## 4. Run the program with both secrets

This is the command an agent runs. `--secrets` takes the names separated by a comma, and everything after `--` is the program:

```bash
npx -y zn-gate run --secrets AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY -- printenv AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

Both values go into the environment of that one program. What it prints is masked, so the agent sees the markers and never the values:

```text
__ZN_AWS_ACCESS_KEY_ID__
__ZN_AWS_SECRET_ACCESS_KEY__
```

The exit code of `run` is the exit code of your program, here `0`. The approval is remembered: the next run of the same command asks nothing.

If the program is not allowed for a secret, `run` refuses with exit code `77` and says which secret and the command to allow it, for example `` `env` is not allowed to use AWS_ACCESS_KEY_ID yet ``. All the exit codes are in [Exit codes](../exit-codes.md#secrets-and-the-vault).

## Check who used the secrets

```bash
npx -y zn-gate secret log
```

It lists each use without any value, and ends with a check of the log chain.

## Related

- [Store a secret and run a program that uses it](secret-set-and-run.md)
- [Keep secrets out of your coding agent](../secrets.md)
- [`secret` and `run` in the CLI reference](../cli.md#secret)
