# First project walkthrough: install to uninstall

This page follows one small example project from install to removal. It only strings together steps that the other guides describe, and it links to them for details. The project lives in `~/projects/example-shop`; that path, the key and the values are made up.

Run every command in your own terminal, not through your agent.

## 1. Install

Undo: remove zn-gate in step 6, or see [Remove zn-gate](../uninstall.md).

```bash
cd ~/projects/example-shop
npx -y zn-gate init
```

`init` finds your coding agents, shows each step before it runs it and asks first. More: [First 5 minutes](../first-5-minutes.md#1-install).

## 2. Check that it works

Undo: nothing to undo; `check` deletes its temporary folder itself.

```bash
npx -y zn-gate check
```

It makes a temporary folder with a fake key in a `.env` file, asks your agent's hook to read it, and deletes the folder. `OK` next to your agent means it is protected. More: [check](../check.md).

## 3. Move a `.env` file into the vault

Undo: put the values back with `env unshadow` in step 6.

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

Undo: nothing to undo here; to stop zn from watching your agent, remove it in step 6.

- If your agent tries to read a secret file such as `.env`, zn blocks it and the message says what to do next.
- If a command uses a marker, for example one that sends `__ZN_EXAMPLE_TOKEN__` to `https://example.com/api`, zn asks you to approve it first. Read the command and approve it only if it is what you expected.
- A warning (an `advisory`) goes to your agent, not to your screen, and does not block anything unless you turn on strict mode.

Full examples of each message: [First 5 minutes](../first-5-minutes.md#3-what-you-will-see-while-you-work). If a message is unclear, see [troubleshooting](../troubleshooting.md).

## 5. Look before you remove

Undo: nothing to undo; `--dry-run` changes nothing.

To list what zn-gate set up without changing anything:

```bash
npx -y zn-gate uninstall --dry-run
```

## 6. Put the values back and uninstall

Undo: deleting the vault cannot be undone, so answer no to that question if unsure; see [Remove zn-gate](../uninstall.md#your-env-files-and-the-vault).

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

## Cleaning up after a test

Step 6 removes zn-gate itself. If you ran this walkthrough only as a test, this section also removes the throwaway files it left. Run every command in your own terminal. The order matches [Remove zn-gate](../uninstall.md): wrapped MCP servers first, then the hooks, then the plugin, then the vault, and the program last.

1. **Put the real values back.** If you ran `env shadow` in step 3, your `.env` still holds markers until you run `env unshadow` (step 6). Do this before anything is deleted, because a deleted vault cannot give the values back.
2. **Remove what zn-gate set up.** `npx -y zn-gate uninstall` finds and removes it in the right order: it first puts back any MCP servers that `init --wrap-mcp` wrapped (this walkthrough does not wrap any, so there is usually nothing to put back), then the hooks that `init` added in step 1, then the Claude Code plugin if you installed it. It asks before it removes anything.
3. **Delete the vault only if it was just for the test.** The second question of `uninstall` deletes the vault and everything that can open it. Answer no if the vault holds secrets you use elsewhere. The default is no.
4. **Remove the program last**, if you installed it globally: `npm uninstall -g zn-gate`.
5. **Delete the example project.** If you made `~/projects/example-shop` only for this test, and your values are back in `.env`, you can delete the folder. Check the path first, because this cannot be undone:

   ```bash
   ls ~/projects/example-shop
   rm -r ~/projects/example-shop
   ```

6. **Leave or delete the rest of `~/.zn`.** `uninstall` keeps your settings and the decision log (`evidence.jsonl`), which holds what `check` and your work with the agent recorded, and it leaves the small launcher scripts under `~/.zn/hooks`. If you do not plan to use zn-gate again, you can delete the `.zn` folder by hand once the vault is gone. See [Files and folders](../files-and-folders.md).

To check that nothing is left, preview the removal again in the folder where you ran `init`:

```bash
npx -y zn-gate uninstall --dry-run
```

When nothing is left, it prints:

```text
zn-gate uninstall: what zn-gate set up on this computer

Nothing from zn-gate was found for your user or this folder.
```

(That output was captured on a test computer with no zn-gate setup.) `uninstall` also ends with `npx -y zn-gate check`, so you see that zn-gate is off; what it prints is described in [check](../check.md).

Hooks you installed with `--project` in other folders stay until you run `uninstall` from each of those folders. More: [Remove zn-gate](../uninstall.md).
