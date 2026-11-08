# Allow one command to read one secret

This page walks through [`zn secret allow`](../cli.md#secret): it gives one program the right to read one secret, and nothing else. The example program is `psql`, which reads its password from the `PGPASSWORD` environment variable; the secret value and every name on this page are made up. The full walkthrough is [Keep secrets out of your coding agent](../secrets.md).

Run the `secret` commands in your own terminal: they change the vault, and they refuse to run inside an agent.

## 1. Store the secret

```bash
npx -y zn-gate secret set EXAMPLE_DB_PASSWORD
```

zn-gate asks for the value at a hidden prompt; a value is never accepted as an argument. So far the secret has no rule: no command and no host may read it.

## 2. The first run is refused

Your agent wants to run the example command of [secrets.md](../secrets.md), naming the secret after `--secrets`:

```bash
npx -y zn-gate run --secrets EXAMPLE_DB_PASSWORD -- psql -h db.example.test -U app -c "select 1"
```

`psql` is not on the secret's allowed commands, so `run` refuses on purpose and exits `77`. Nothing ran, and the value stayed in the vault. The other exit codes of `run`: `64` wrong usage, `127` the program was not found, `1` another error; when your command runs, the exit code is its own.

## 3. Allow one command

In your own terminal:

```bash
npx -y zn-gate secret allow EXAMPLE_DB_PASSWORD --command psql
```

`secret allow` adds allowed commands or hosts to a secret; at least one option is needed, and `--replace` swaps the lists instead of adding to them. The change is confirmed in the vault prompt, which your agent cannot answer: a system dialog on a desktop, or the terminal where the vault runs in the foreground on a server. [What that prompt is for](../secrets.md#4-let-a-command-use-a-secret)

Choose the command narrowly: an interpreter such as `node`, `python`, `npm` or `make` runs any code it is given, so allowing one lets every script it runs read the secret; zn-gate warns you when you allow one.

## 4. Approve the first use

A command that is allowed still waits for its first use to be approved. Approve it in your own terminal:

```bash
npx -y zn-gate secret approve EXAMPLE_DB_PASSWORD --command psql
```

This is confirmed in the vault prompt too. The approval belongs to the value it was given for: store a different value under the same name, and zn-gate asks again. If you skip this command, the vault asks by itself the first time the command runs: the prompt shows the exact program that will run, and the agent cannot answer it from its own terminal.

## 5. Run the command again

```bash
npx -y zn-gate run --secrets EXAMPLE_DB_PASSWORD -- psql -h db.example.test -U app -c "select 1"
```

Now the value goes into the environment of that one process — never into its arguments, which every process of your user could read (`ps`). If the agent puts the marker `__ZN_EXAMPLE_DB_PASSWORD__` into a command's arguments instead, zn-gate refuses the command and tells the agent to pass the secret as an environment variable. The command's output is masked: raw, base64, hex and URL-encoded forms of the value come back as the marker.

## 6. Verify

```bash
npx -y zn-gate secret list
npx -y zn-gate secret log --since 1h
```

`secret list` shows names and policy, never values: `EXAMPLE_DB_PASSWORD` should be there, allowing `psql`. The vault must be unlocked first. `secret log` shows who used which secret and where, without values, so the `psql` run of step 5 should appear there.

## Where to read more

- [Keep secrets out of your coding agent](../secrets.md), the page this walkthrough comes from
- [`secret`](../cli.md#secret) and [`run`](../cli.md#run) in the command line reference
- [Examples: allow a blocked action after `zn why`](zn-why-allow-command.md), when you come here from a block
