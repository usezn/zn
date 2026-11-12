# Example: pass several vault secrets to one command

This page gives one command two secrets from the vault in a single `zn run`: a made-up `deploy` script that needs a database password and a webhook token. It only strings together steps that [Keep secrets out of your coding agent](../secrets.md) and the [command line reference](../cli.md) describe. All names and values are made up, but the steps are real: `secret set` writes entries to your local vault, and `zn run` really starts the program you name. Try it with a disposable vault and a harmless test program of your own in place of `deploy`.

Run every command in your own terminal, not through your agent: the `secret` commands refuse to run inside an agent, and the first use of a secret is confirmed in the vault's own prompt, which the agent cannot answer.

## 1. Store each secret under its variable name

Say the `deploy` script reads two environment variables, `EXAMPLE_DB_PASSWORD` and `EXAMPLE_WEBHOOK_TOKEN`. A secret gets the name of the variable the program reads, and `--command` records which program may use it. Unlock the vault, then store each value at the hidden prompt (never as an argument):

```bash
npx -y zn-gate unlock
npx -y zn-gate secret set EXAMPLE_DB_PASSWORD --command deploy
npx -y zn-gate secret set EXAMPLE_WEBHOOK_TOKEN --command deploy
```

One `secret set` stores one secret, so a second secret is a second call. `--force` replaces an existing secret.

Allowing an interpreter such as `node`, `python`, `npm` or `make` lets every script it runs read the secret, and zn warns you when you allow one.

## 2. Run the command with both secrets

Name both secrets after `--secrets`, separated by commas, and put the command after `--`:

```bash
npx -y zn-gate run --secrets EXAMPLE_DB_PASSWORD,EXAMPLE_WEBHOOK_TOKEN -- deploy
```

`run` fills both values into the environment of that one process and masks them in its output (that is not isolation: child processes of the program inherit the environment, and other processes of your user may be able to read it; see [what an environment variable does and does not hide](../secrets.md#4-let-a-command-use-a-secret)): raw, base64, hex and URL-encoded forms come back as markers. `-s` is short for `--secrets`. A value never goes into a command-line argument, where every process of your user could see it: if a marker such as `__ZN_EXAMPLE_DB_PASSWORD__` ends up in the arguments, zn refuses the command and tells the agent to pass the secret as an environment variable instead.

The first time each secret is used, the vault asks you to confirm in its dialog or its terminal, and the prompt shows the exact program that will run — here, `deploy`. The agent cannot answer these prompts from its own terminal, so make the first run yourself. More: [Let a command use a secret](../secrets.md#4-let-a-command-use-a-secret) and [`run`](../cli.md#run).

## 3. If the run is refused

`zn run` exits `77` when it refuses: the secret is not allowed for that program, or its first use is not approved yet. Add the program with `secret allow`, or approve a first use with `secret approve`:

```bash
npx -y zn-gate secret allow EXAMPLE_WEBHOOK_TOKEN --command deploy
npx -y zn-gate secret approve EXAMPLE_WEBHOOK_TOKEN --command deploy
```

Both changes are confirmed in the vault prompt. The other exit codes of `run`: `64` wrong usage, `127` the program was not found, `1` another error; otherwise the exit code is your command's.

## 4. Check what is stored and what was used

The check step, in your own terminal:

```bash
npx -y zn-gate secret list
npx -y zn-gate secret log --since 1h
```

`secret list` shows names and policy, never values: both names should be there, each allowing `deploy`. The vault must be unlocked first; on a locked vault the command exits with an error. `secret log` shows who used which secret and where, without values, so the deploy run from step 2 should appear there — with the names, never the values.

## Where to read more

- [Keep secrets out of your coding agent](../secrets.md), the page this walkthrough is built from
- [`secret`](../cli.md#secret) and [`run`](../cli.md#run) in the command line reference
- [A `.env` file round trip through the vault](env-file-round-trip.md), for the many values of a whole file instead of two typed secrets
