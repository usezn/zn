# Example: a `.env` file round trip through the vault

This page follows one small `.env` file into the vault with `env shadow` and back out with `env unshadow`. It only strings together steps that [Keep secrets out of your coding agent](../secrets.md) and the [command line reference](../cli.md) describe. All names and values are made up, and nothing on this page touches a real file of yours.

Run every command in your own terminal, not through your agent: the `env` commands refuse to run inside an agent.

## 1. The starting file

Say the `.env` of a project holds two values like these:

```text
EXAMPLE_API_KEY=example-not-a-real-key
EXAMPLE_WEBHOOK_SECRET=example-not-a-real-secret
```

## 2. Move the values into the vault

Unlock the vault, then shadow the file:

```bash
npx -y zn-gate unlock
npx -y zn-gate env shadow .env
```

Every sensitive value moves into the encrypted vault and the file keeps only markers:

```text
EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__
EXAMPLE_WEBHOOK_SECRET=__ZN_EXAMPLE_WEBHOOK_SECRET__
```

`env shadow` also prints the name of an encrypted copy of the original. Write it down: the step that puts the values back needs it. `--dry-run` only lists what would move. More: [`env shadow`](../cli.md#env-shadow).

## 3. A command still gets the value

The value is not gone, it only moved. A program that reads the variable gets the real value when you start it through `zn run`:

```bash
npx -y zn-gate run --secrets EXAMPLE_API_KEY -- <command>
```

`run` puts the real value in the environment of that process only, for commands you allowed, and masks the value in the output of the command. The first time, the vault asks you to confirm in its own dialog or terminal. A marker that `zn run` inherits from the environment (for example a value from a shadowed `.env` that your shell or direnv loads) is filled in the same way, when the secret allows that program and you have approved it. More: [Let a command use a secret](../secrets.md#4-let-a-command-use-a-secret) and [`run`](../cli.md#run).

## 4. Put the values back

Run the restore command with the name of the encrypted copy that `env shadow` printed in step 2:

```bash
npx -y zn-gate env unshadow .env --backup <name>
```

The file holds the original values again. The plain text leaves the vault only after you confirm in the prompt of the vault (a system dialog, or the terminal where you started `zn unlock --foreground`). More: [`env unshadow`](../cli.md#env-unshadow).

Do not delete the vault while the values are still in it: if you remove zn-gate and delete the vault without putting the values back, those values are gone. See [Your `.env` files and the vault](../uninstall.md#4-your-env-files-and-the-vault).

## Where to read more

- [Keep secrets out of your coding agent](../secrets.md), the page this walkthrough is built from
- [`env`](../cli.md#env) and [`run`](../cli.md#run) in the command line reference
- [Your `.env` files and the vault](../uninstall.md#4-your-env-files-and-the-vault)
