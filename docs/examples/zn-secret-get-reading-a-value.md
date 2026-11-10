# Example: reading one stored secret with `secret get`

This page shows what `zn-gate secret get` does when you ask it for a stored value, why it never prints one, and how a command can use the value without you seeing it. The secret name and the values are made up.

## 1. Who can read a value with `secret get`

Nobody, through this command. `secret get` refuses every time it runs, whether you type it in your own terminal or an AI agent runs it. The refusal does not depend on the terminal: the command throws before it looks at the vault.

`secret reveal` is an alias of `secret get` and behaves the same way.

## 2. What you see when you try

```bash
npx -y zn-gate secret get API_TOKEN
```

The command prints one line to the error output and exits with code `77`:

```text
zn secret: Not allowed: zn does not print secret values. To use one in a command, run: npx -y zn-gate@1.15.0 run --secrets NAME -- <command>
```

Three parts of that line are fixed text: the prefix `zn secret:` (the group of the command), `Not allowed:` (the refusal), and the sentence after it. The last part depends on your setup. If `zn` is on your `PATH`, the suggestion reads `zn run --secrets NAME -- <command>`. Otherwise it reads `npx -y zn-gate@<version> run --secrets NAME -- <command>`, with the version of the release you installed.

Exit code `77` means "refused by policy", the same code that the other refusals of zn use.

## 3. Use the value in a command instead

`run` starts a command with the secret in its environment, so the command can read the value without you printing it. Store the value first, with a hidden prompt:

```bash
npx -y zn-gate secret set API_TOKEN
```

Then start your command through `run`:

```bash
npx -y zn-gate run --secrets API_TOKEN -- <command>
```

`--secrets` takes one or more names, separated by commas. `run` only passes a secret to a command that the secret allows, so check the allow rules first, as described in [Let a command use a secret](../secrets.md#4-let-a-command-use-a-secret). To see which names are stored, without any values, run:

```bash
npx -y zn-gate secret list
```

## Where to read more

- [`secret get`](../cli.md#secret-get) in the command line reference
- [`run`](../cli.md#run), with the options it takes
- [Let a command use a secret](../secrets.md#4-let-a-command-use-a-secret)
