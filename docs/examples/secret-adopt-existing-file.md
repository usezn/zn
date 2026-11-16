# Example: adopt a secret that zn found in a file

When a command of your agent prints a secret, zn replaces the value with a token such as `__ZN_AWS_KEY_1__` before the model sees it, and the value stays in the vault on your machine. `zn secret adopt` turns such a detected value into a named secret that you and your agent can use. This page walks one adoption step by step, with a made-up value, and checks the result with `zn secret list`. It only strings together steps that [Keep secrets out of your coding agent](../secrets.md), the [command line reference](../cli.md) and the [troubleshooting page](../troubleshooting.md#a-secret-or-odd-text-showed-up-in-output-a-prompt-or-an-answer) describe.

Run every command in your own terminal, not through your agent: the commands that add, change or remove a value need an interactive terminal, and they refuse to run inside an agent.

One note on the fake value: zn leaves a value that says it is fake alone on purpose, so that examples and test data still work. The made-up key below is an illustration; the walkthrough starts where a real-looking value has already been detected.

## 1. The starting file

Say a script in your project holds a key:

```text
# deploy.sh
aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE
```

The agent runs or prints the script, and the value reaches zn's scrubber. zn replaces the value with a token and says so:

```text
zn: 1 secret value(s) in this output were replaced with __ZN_ tokens
```

After that, the model only sees `__ZN_AWS_KEY_1__`. The value itself stays on your machine: the vault keeps the values zn detected for this project, so that it can put the markers back. ([What these messages mean](../troubleshooting.md#a-secret-or-odd-text-showed-up-in-output-a-prompt-or-an-answer).)

## 2. Adopt the value as a named secret

Unlock the vault and adopt the token under a name you choose, in the folder of the project where the value was detected (the values zn detects are kept per project):

```bash
npx -y zn-gate unlock
npx -y zn-gate secret adopt AWS_KEY_1 --name AWS_PROD
```

The command prints:

```text
Adopted __ZN_AWS_KEY_1__ as __ZN_AWS_PROD__ (proxy mode).
```

- The token is the name inside the marker, here `AWS_KEY_1`. Writing the full marker `__ZN_AWS_KEY_1__` works too.
- The value moves inside the vault: it is never printed, and nothing sends it back to the terminal.
- The new secret starts without approvals: its first use asks you to confirm, like any other secret.
- With no `--host` or `--command`, the secret is stored in `proxy` mode: the `secrets` MCP server may send it as a header to the hosts you allow ([how the MCP server uses it](../secrets.md#5-let-the-agent-call-an-api)). Give `--host api.example.com` or `--command psql` on the adopt command to name its host or program right away.

Three refusals worth knowing, each with its fix in the message:

- The vault is locked: run `npx -y zn-gate unlock` first.
- `__ZN_AWS_KEY_1__ is not known for this project`: the value was detected in another project, or the token name is misspelled. Run the command in the project folder where the value showed up.
- `AWS_PROD already exists`: pick another name. An adoption never replaces a stored secret.

## 3. Check what is in the vault

```bash
npx -y zn-gate secret list
```

```text
  AWS_PROD                     proxy
```

`secret list` shows names and policy, never values. `proxy` is the mode from step 2.

## 4. Say where the secret may be used

```bash
npx -y zn-gate secret allow AWS_PROD --host api.example.com
```

This adds the host to the secret's allowed hosts, and the vault asks you to confirm the change. From then on the agent can call `https://api.example.com` with the secret in a header through the `secrets` MCP server, and `secret list` also shows `hosts=api.example.com` after the mode. For a program instead of an API, allow a command (`--command psql`) and run it through `zn run` ([let a command use a secret](../secrets.md#4-let-a-command-use-a-secret)).

## 5. Clean up

```bash
npx -y zn-gate secret rm AWS_PROD
```

The command asks `Remove AWS_PROD?` in your terminal and removes the approvals the secret had.

Adopting does not touch the file that held the value: the key is still in `deploy.sh`. Remove it from the script yourself, and if the value was real and reached a log or a file you share, rotate it. For the values of a `.env` file, `zn secret import` reads the file directly instead of adopting detected tokens.

Lock the vault when you are done:

```bash
npx -y zn-gate lock
```

## Where to read more

- [Keep secrets out of your coding agent](../secrets.md), the page this walkthrough is built from
- [`secret adopt`](../cli.md#secret-adopt), [`secret list`](../cli.md#secret-list), [`secret allow`](../cli.md#secret-allow) and [`secret rm`](../cli.md#secret-rm) in the command line reference
- [What to do when zn replaces a secret value](../troubleshooting.md#a-secret-or-odd-text-showed-up-in-output-a-prompt-or-an-answer) in the troubleshooting page
