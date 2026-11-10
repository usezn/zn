# Remove zn-gate

You can remove zn-gate in one step, or piece by piece. Either way, run the commands yourself, in your own terminal: zn-gate refuses to uninstall when an AI agent or a script runs it, and your agent is not allowed to run it for you.

None of this changes your code.

## Before you remove it

Check these four things first. Each is explained further down this page.

1. **Run the commands yourself.** Use your own terminal, not your agent: zn-gate refuses to uninstall when an AI agent or a script runs it.
2. **Put back your `.env` values.** If you ran `env shadow`, run `npx -y zn-gate env unshadow .env --backup <name>` before you delete the vault. See [Your `.env` files and the vault](#4-your-env-files-and-the-vault).
3. **Lock the vault.** An unlocked vault is kept, not deleted. Run `zn-gate lock`, then run uninstall again.
4. **Preview the list.** Run `npx -y zn-gate uninstall --dry-run` to see what would be removed without changing anything. If you used `--project` in several projects, plan to run uninstall from each project folder.

## The order: MCP servers, then hooks, the program last

Whichever way you remove zn-gate, follow this order:

1. Wrapped MCP servers (`init --revert`). Do this first: a saved copy put back after the hooks are removed could bring back zn's `secrets` server.
2. The hooks, and for Claude Code the plugin.
3. Your `.env` values (`env unshadow`), then the vault if you want it deleted.
4. The program itself, last: `npm uninstall -g zn-gate`, then `pip uninstall zn-gate` if you also installed the Python package.

If you remove the program first, your agent's settings still point at a command that is gone. `npx -y zn-gate uninstall` does the steps in this order for you.

## One step: `zn-gate uninstall`

```bash
npx -y zn-gate uninstall
```

(If you installed zn-gate with `npm install -g zn-gate`, run `zn-gate uninstall`.)

What it does:

1. **It looks first.** It finds what zn-gate set up for your user and for the folder you are in: the Claude Code plugin, zn's hooks for each agent (for OpenCode, the plugin file that zn wrote; other plugins stay), zn's hook launcher scripts in `~/.zn/hooks`, and MCP servers that `init --wrap-mcp` wrapped. It prints the list with the file paths. Only the hooks of the folder you are in are found: if you used `--project` in several projects, run it again from each project folder.
2. **It asks in your terminal.** Nothing is removed until you answer yes to "Remove what is listed above?".
3. **It removes what it listed.** For wrapped MCP servers it puts back the copy of the config saved before wrapping (changes you made to that file since are lost), then looks again and lists any server that is still wrapped, with the manual step. Hooks and the plugin are removed as the manual steps below do. If a step cannot be done, it says so and prints what to run yourself: for example, a wrapped MCP server with no saved copy is left as it is (remove the "zn-gate shield" wrapper by hand), and if the `claude` command is not found, the plugin is not removed and the command to remove it is printed.
4. **It keeps your vault.** The vault holds your stored secrets. It is only deleted if you answer yes to a second, separate question, and the default is no. Before it asks, it lists everything that yes deletes: the vault files, the token maps of your projects, the vault audit log (`audit.jsonl`, the record of what the vault did), every `vault-backup-*` folder (the encrypted copies made by `zn vault reset`), the session key and the failed-unlock counter. It deletes them, then the vault key in your system keychain, and checks that none is left. If a file cannot be removed, the key is kept so what is left still opens, and uninstall says which files remain; if the keychain entry stays, it says so instead of reporting the vault as deleted. The rest of the `.zn` folder stays, including the decision log (`evidence.jsonl`, what zn-gate allowed or blocked) and your settings. The vault is kept, not deleted, if it is unlocked (run `zn-gate lock`, then run uninstall again) or if the computer is managed by a zn Team organization. Deleting it cannot be undone.
5. **It tells you if something is left.** If any step failed, it exits with code `1` (see [exit codes](cli.md#uninstall)); `0` means everything listed was removed.
6. **It ends with `zn-gate check`**, so you see that zn-gate is off, and prints the last step: `npm uninstall -g zn-gate`, which removes the program itself.

To see the list without changing anything, add `--dry-run`:

```bash
npx -y zn-gate uninstall --dry-run
```

Your `.env` files are never edited by `uninstall`. If you moved their values into the vault with `env shadow`, they hold markers such as `__ZN_API_KEY__`. Put the real values back before you delete the vault: see [Your `.env` files and the vault](#4-your-env-files-and-the-vault).

## What each command removes and leaves

This is a summary of the sections below. Each command is run in your own terminal.

| Command | Removes | Leaves |
| --- | --- | --- |
| `npx -y zn-gate uninstall` | What it lists and you confirm: the Claude Code plugin, zn's hooks for each agent, and wrapped MCP servers (restored from the saved copy). | Your code and your `.env` files. The vault, unless you answer yes to the second question (that yes also deletes the vault audit log and the `vault-backup-*` folders). The rest of the `.zn` folder, including the decision log (`evidence.jsonl`) and your settings. The program itself (`npm uninstall -g zn-gate`). |
| `claude plugin uninstall zn-gate@usezn` | The Claude Code plugin. | Hooks, wrapped MCP servers, the vault and the program. |
| `npx -y zn-gate hooks uninstall claude-code` | zn's hooks for that agent (for Claude Code, also zn's own `secrets` MCP server unless you add `--no-mcp`). A backup of the settings file is written first. | The plugin, wrapped MCP servers, the vault and the program. |
| `npx -y zn-gate init --revert` | The MCP wrapping: each MCP settings file is put back as it was saved before wrapping. | The plugin, hooks, the vault and the program. Later changes to those MCP files are lost. |
| `npm uninstall -g zn-gate` (last) | The program itself. | The `.zn` folder with the vault and settings. Zn's hooks, if you have not removed them first. |
| `pip uninstall zn-gate` (after that) | The Python package. | Everything else listed above. |

## Piece by piece

Use this if you want to remove only one part, or to do the steps yourself. Go in this order, with the wrapped MCP servers first, then the hooks, and the program last. Each command is run in your own terminal.

If you remove the parts by hand, use the order `zn-gate uninstall` uses: put back the wrapped MCP servers first (`init --revert`), because a saved copy put back after the hooks are removed could bring back zn's `secrets` server. Then the hooks, then the plugin, then your `.env` values and the vault if you want it gone, then the program (and the Python package).

### 1. MCP servers wrapped by `init --wrap-mcp`

```bash
npx -y zn-gate init --revert
```

This puts back each MCP settings file as it was saved just before zn wrapped it. Changes you made to those files later, such as MCP servers you added, are lost, so add them again afterwards. It only undoes MCP wrapping: it does not remove the plugin or any hooks. If you only ever ran `init` without `--wrap-mcp`, there is nothing for it to restore.

A zn-gate MCP server you added by hand (an entry named `zn-gate` in your agent's MCP settings) is not touched by any command here: delete that entry yourself.

### 2. Hooks (Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app, GitHub Copilot, Gemini CLI, or Claude Code without the plugin)

```bash
npx -y zn-gate hooks uninstall claude-code
```

Use `codex`, `cursor`, `opencode`, `antigravity`, `zcode` or `copilot` instead of `claude-code` for the others (ZCode has no project hooks, so `--project` does not apply to it). Add `--project` if you installed the hooks for one project only; run it from that project's folder. A backup of the settings file is written first. For Claude Code it also removes zn's own `secrets` MCP server. Add `--no-mcp` to leave MCP servers alone.

If you removed the program first (`npm uninstall -g zn-gate`), the hooks stay and your agent tells you that zn-gate is not installed any more; the command above still works. See [Troubleshooting](troubleshooting.md#18-your-agent-says-zn-gate-is-not-installed-any-more).

### 3. Claude Code plugin

```bash
claude plugin uninstall zn-gate@usezn
```

Or, inside Claude Code, type `/plugin`, open the **Installed** tab, pick zn-gate and choose **Uninstall**. To also remove the usezn plugin list, run `claude plugin marketplace remove usezn`.

### 4. Your `.env` files and the vault

If you ran `env shadow`, your `.env` file holds markers, and the real values are in the vault. If you remove zn-gate and delete the vault without putting the values back, those values are gone. Put them back first, with the name of the encrypted copy that `env shadow` printed when you ran it:

```bash
npx -y zn-gate env unshadow .env --backup <name>
```

zn-gate keeps the vault and its settings in a `.zn` folder in your home folder. Removing the plugin, the hooks or the program leaves it there. To delete the vault, answer yes to the second question of `zn-gate uninstall`: it deletes the vault files, the vault audit log (`audit.jsonl`), the `vault-backup-*` folders (encrypted copies of your secrets), the token maps, the session key and the vault key in your system keychain. The rest of the `.zn` folder stays: your settings and the decision log (`evidence.jsonl`), which you can delete by hand. It keeps the vault if it is unlocked (run `zn-gate lock`, then run uninstall again) or if the computer is managed by a zn Team organization. You can also delete the whole folder by hand once you have your values back. A vault cannot be recovered after that.

### 5. The program itself, last

Do this only after the hooks and the plugin are gone.

```bash
npm uninstall -g zn-gate
```

If you also installed the Python package, run `pip uninstall zn-gate` after that.

## Check that it is off

```bash
npx -y zn-gate check
```

`uninstall` runs this for you at the end. If it still reports something as set up, the line says which part is left and what to run.

## Common mistakes

- **Removing the program before the hooks.** `npm uninstall -g zn-gate` removes the program but not what it set up. The hooks stay in your agent's settings, and `zn-gate check` then reports lines such as `its hook cannot start: its zn-gate files (<path>) is no longer there`. See [The hooks are set up but cannot run](check.md#the-hooks-are-set-up-but-cannot-run). Run `npx -y zn-gate uninstall` first, and `npm uninstall -g zn-gate` last, as the uninstall output tells you.
- **Asking your agent to run uninstall.** It refuses when an AI agent runs it, and also when there is no interactive terminal (a script, or a pipe), and nothing changes: it prints `zn uninstall: Not allowed: zn-gate uninstall needs an interactive terminal. Open a terminal window yourself and run it there.` and exits with `77` (see [exit codes](exit-codes.md#set-up-and-check)). Open your own terminal and run it there. `--dry-run` is the one form that also works without a terminal, because it only prints the list.
- **Forgetting a `--project` install.** `uninstall` looks at your user settings and at the folder you run it in, not at every project on the computer. Hooks you installed with `--project` in another folder stay until you run uninstall from that folder (or `hooks uninstall <agent> --project` there). Use `--dry-run` in a folder to see whether anything is listed. See [Before you remove it](#before-you-remove-it).
- **Expecting uninstall to delete the vault.** It keeps the vault unless you answer yes to the second question, and it keeps it anyway while the vault is unlocked or when a zn Team organization manages the computer. The rest of the `.zn` folder (settings and the decision log) is never deleted by it either. See [What each command removes and leaves](#what-each-command-removes-and-leaves).
- **Deleting the vault before putting your `.env` values back.** If you ran `env shadow`, your `.env` file holds markers, `uninstall` does not edit it, and the real values are only in the vault. Run `env unshadow` first. See [Your `.env` files and the vault](#4-your-env-files-and-the-vault).

For the questions people ask most, see [Uninstall](faq.md#uninstall) in the FAQ.

## Related

- [Files zn-gate writes in each editor, and how to remove them by hand](editors/remove-by-hand.md)
- [Every command and exit code](cli.md#uninstall)
- [Keep your `.env` values in the vault](secrets.md)
- [Words you do not know](glossary.md)
