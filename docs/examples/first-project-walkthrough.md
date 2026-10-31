# First project walkthrough: install to uninstall

This page follows one small example project from install to removal. It only strings together steps that the other guides describe, and it links to them for details. The project lives in `~/projects/example-shop`; that path, the key and the values are made up.

Run every command in your own terminal, not through your agent.

## 1. Install

```bash
cd ~/projects/example-shop
npx -y zn-gate init
```

`init` finds your coding agents, shows each step before it runs it and asks first. More: [First 5 minutes](../first-5-minutes.md#1-install).

## 2. Check that it works

```bash
npx -y zn-gate check
```

It makes a temporary folder with a fake key in a `.env` file, asks your agent's hook to read it, and deletes the folder. `OK` next to your agent means it is protected. More: [check](../check.md).

## 3. Move a `.env` file into the vault

Say `~/projects/example-shop/.env` holds this fake value:

```text
EXAMPLE_TOKEN=example-not-a-real-token
PORT=3000
```

Unlock the vault, then move the values:

```bash
npx -y zn-gate unlock
npx -y zn-gate env shadow .env
```

The real values go into the encrypted vault and `.env` keeps markers such as `__ZN_EXAMPLE_TOKEN__`. `env shadow` prints the name of the encrypted copy of the original; write it down, because you need it in step 6. More: [secrets](../secrets.md).

## 4. Work with your agent

- If your agent tries to read a secret file such as `.env`, zn blocks it and the message says what to do next.
- If a command uses a marker, for example one that sends `__ZN_EXAMPLE_TOKEN__` to `https://example.com/api`, zn asks you to approve it first. Read the command and approve it only if it is what you expected.
- A warning (an `advisory`) goes to your agent, not to your screen, and does not block anything unless you turn on strict mode.

Full examples of each message: [First 5 minutes](../first-5-minutes.md#3-what-you-will-see-while-you-work). If a message is unclear, see [troubleshooting](../troubleshooting.md).

## 5. Look before you remove

To list what zn-gate set up without changing anything:

```bash
npx -y zn-gate uninstall --dry-run
```

## 6. Put the values back and uninstall

Put the real values back into `.env` first, with the name of the encrypted copy that `env shadow` printed in step 3:

```bash
npx -y zn-gate env unshadow .env --backup <name>
```

On a computer with no desktop session (for example a server or an SSH session), `env unshadow` cannot show its question and refuses with:

```text
zn env: Not allowed: zn could not ask you outside the agent: no confirmation channel. Start the vault with `zn unlock --foreground` in a terminal of its own (it asks there), or unlock it from a desktop session so zn can show a dialog.
```

In that case, lock the vault, then run it in a terminal of its own (`unlock --foreground` refuses with "already unlocked" while the vault is still unlocked), answer its questions there, and then run the `env unshadow` command again in your first terminal:

```bash
npx -y zn-gate lock
npx -y zn-gate unlock --foreground
```

Then remove zn-gate:

```bash
npx -y zn-gate uninstall
```

It lists what it found and asks before it removes anything. It keeps your vault unless you answer yes to a second, separate question (the default is no). It ends with `zn-gate check` so you can see zn-gate is off.

Last, remove the program itself if you installed it globally:

```bash
npm uninstall -g zn-gate
```

Your code is not changed by any of this. Details, including the manual steps for each part: [Remove zn-gate](../uninstall.md).

## Where to go next

- [First 5 minutes](../first-5-minutes.md), the full page this walkthrough is built from
- [Every command and exit code](../cli.md)
- [What zn-gate cannot protect](../threat-model.md)
