# Example: adopt a detected secret, then run one program with it

zn's scrubber found a secret value in some output and replaced it with a token. This page adopts that token as a named secret, allows one program to use it, and runs the program through `zn run`, so the value is never printed. Every name and value is made up.

Run `zn unlock` and `zn secret adopt` in your own terminal. `adopt` refuses when an AI agent runs it. `zn run` can be started by the agent, but the first use of a secret with a program is confirmed by you, in the vault's own prompt.

For the adopt options and the messages it can print, read [Example: adopt a secret that zn found in a file](secret-adopt-existing-file.md).

## The starting point

The agent printed the output of a script, and zn replaced a value in it:

```text
zn: 1 secret value(s) in this output were replaced with __ZN_ tokens
```

The agent now sees only `__ZN_EXAMPLE_TOKEN_1__`. The value is kept in the vault, for this project folder. The name inside the marker, `EXAMPLE_TOKEN_1`, is the token you adopt.

## 1. Unlock the vault

```bash
zn unlock
```

`zn run` cannot fill a secret while the vault is locked, and it stops before the program starts if it cannot reach the vault.

## 2. Adopt the token under the name the program reads

Here the program is the GitHub CLI, `gh`, which reads its token from the `GH_TOKEN` variable. The secret is named after that variable, and the only command allowed to use it is `gh api user`:

```bash
zn secret adopt EXAMPLE_TOKEN_1 --name GH_TOKEN --command "gh api user"
```

The command prints (illustration):

```text
Adopted __ZN_EXAMPLE_TOKEN_1__ as __ZN_GH_TOKEN__ (env mode).
```

- `--command` is what makes the secret `env` mode. Without `--command` or `--host`, adopt stores it in `proxy` mode for the MCP server instead ([secret-adopt-existing-file.md](secret-adopt-existing-file.md)).
- The value is moved inside the vault. It is never printed.
- Adopt never replaces a stored secret. If `GH_TOKEN` already exists, it refuses and asks for another name.

## 3. Check the policy

```bash
zn secret list
```

The line for `GH_TOKEN` shows its mode (`env`) and its allowed command. It never shows the value.

## 4. Run the program through zn run

```bash
zn run --secrets GH_TOKEN -- gh api user
```

- `--secrets GH_TOKEN` puts the value in the environment of that one process, under the name `GH_TOKEN`.
- The first time this pair of secret and command runs, the vault asks you to confirm it, in its dialog or in the terminal where `zn unlock --foreground` runs. The prompt shows the exact program. The agent cannot answer it. Later runs of the same pair do not ask again.
- The output is masked. If the API echoes the token, the output shows `__ZN_GH_TOKEN__` instead.

A program that is not allowed is refused before it starts. The message the agent gets looks like this (illustration, with `curl` as the program that is not allowed):

```text
`curl` is not allowed to use GH_TOKEN yet. The user can allow it from their own terminal: zn secret allow GH_TOKEN --command curl
```

Allowing a program is a policy change, so the vault asks you to confirm it too. Allow only the program you need, and keep the command as narrow as you can.

## 5. What this does not protect

- The value is in the environment of the `gh` process. It is not in the process list or in the command line. Other processes of your own user can still read it (on Linux, from `/proc/<pid>/environ`) ([What an environment variable does and does not hide](../secrets.md#4-let-a-command-use-a-secret)).
- If `gh` copies the token into the arguments of another program, that copy is visible again.
- The adopted token belongs to the project folder where it was detected. Run `adopt` from that folder.

## 6. Clean up

When the program no longer needs the secret, remove it:

```bash
zn secret rm GH_TOKEN
```

Then rotate the token at its provider if the value was real. A token that zn replaced in output is still valid until its provider revokes it.

## Where to read more

- [Example: adopt a secret that zn found in a file](secret-adopt-existing-file.md): the detection step and the adopt options.
- [Keep secrets out of your coding agent](../secrets.md): markers, `zn run` and the first-use prompt.
- [Example: allow one secret for one program](zn-policy-allow-list-recipes.md): the same allow, written as a recipe.
