# Example: keep a secret out of the agent

A short walk-through of the [vault](../secrets.md): store one fake value, let one command use it, and remove it again. All values here are made up. For the full behaviour, read the [full page](../secrets.md).

## Store a secret

Run this in your own terminal: a command that changes the vault refuses to run inside an agent.

```sh
zn-gate secret set PGPASSWORD --command psql
```

zn asks for the value at a hidden prompt, never as an argument (an argument is visible to every process of your user and ends up in command-line logs). For this walkthrough, type a fake value:

```text
FAKE_NOT_A_REAL_PASSWORD_1234
```

`--command psql` says the value may only be used by the program `psql`, which reads its password from the environment variable `PGPASSWORD`. zn warns you when you allow an interpreter such as `node` or `python`, because it runs any code you give it.

## See what is stored

```sh
zn-gate secret list
```

The list shows names and policy, never values. The vault must be unlocked first; if it is locked, run `zn-gate unlock`.

## Let one command use it

The agent runs the command through `zn-gate run` and names the secret:

```sh
zn-gate run --secrets PGPASSWORD -- psql -h db.example.test -U app -c "select 1"
```

The value goes only into the environment of that one process. Wherever the program prints the value, in standard output or in standard error, in raw, base64, hex or URL-encoded form, the output comes back with the marker `__ZN_PGPASSWORD__` in its place.

The first time, the vault asks you to confirm in its own dialog or terminal, and shows the exact program that will run. The agent cannot answer that prompt.

Two things the agent cannot do:

- It cannot print the value: `zn-gate secret get PGPASSWORD` exits with code 77 and points to `zn-gate run` instead. There is no command that shows a secret value.
- It cannot put the marker in the arguments of a command: zn refuses that and tells the agent to pass the secret as an environment variable instead.

## See who used it

```sh
zn-gate secret log --since 1h
```

The local audit log shows who used which secret where, without values.

## Remove it again

```sh
zn-gate secret rm PGPASSWORD
```

This removes the secret together with the first-use approvals it had. A new value stored under the same name asks for approval again. To lock the vault when you finish:

```sh
zn-gate lock
```

## Try it yourself

The commands of this page, in order. Nothing here is real: the value is fake, and the host uses a reserved test domain.

```sh
# Store a fake value (type it at the hidden prompt)
zn-gate secret set PGPASSWORD --command psql

# Names and policy, never values
zn-gate secret list

# The value goes into this one process only; the output comes back masked
zn-gate run --secrets PGPASSWORD -- psql -h db.example.test -U app -c "select 1"

# No way to print a value: exits 77 and points to run
zn-gate secret get PGPASSWORD

# Who used which secret where, without values
zn-gate secret log --since 1h

# Remove the secret and its approvals, then lock the vault
zn-gate secret rm PGPASSWORD
zn-gate lock
```

## More

- [Keep secrets out of your coding agent](../secrets.md)
- [Command reference](../cli.md)
