# Remove zn-gate

You can remove zn-gate in one step, or piece by piece. Either way, run the commands yourself, in your own terminal: zn-gate refuses to uninstall when an AI agent or a script runs it, and your agent is not allowed to run it for you.

None of this changes your code.

## One step: `zn-gate uninstall`

```bash
npx -y zn-gate uninstall
```

(If you installed zn-gate with `npm install -g zn-gate`, run `zn-gate uninstall`.)

What it does:

1. **It looks first.** It finds what zn-gate set up for your user and for the folder you are in: the Claude Code plugin, zn's hooks for each agent, and MCP servers that `init --wrap-mcp` wrapped. It prints the list with the file paths. Only the hooks of the folder you are in are found: if you used `--project` in several projects, run it again from each project folder.
2. **It asks in your terminal.** Nothing is removed until you answer yes to "Remove what is listed above?".
3. **It removes what it listed.** For wrapped MCP servers it puts back the copy of the config saved before wrapping (changes you made to that file since are lost), then looks again and lists any server that is still wrapped, with the manual step. Hooks and the plugin are removed as the manual steps below do. If a step cannot be done, it says so and prints what to run yourself: for example, a wrapped MCP server with no saved copy is left as it is (remove the "zn-gate shield" wrapper by hand), and if the `claude` command is not found, the plugin is not removed and the command to remove it is printed.
4. **It keeps your vault.** The vault holds your stored secrets. It is only deleted if you answer yes to a second, separate question, and the default is no. That second yes deletes the vault files (and the local audit log, `audit.jsonl`, which sits next to them) and then the vault key in your system keychain. If a file cannot be removed, the key is kept so what is left still opens, and uninstall says which files remain. Before it asks, it lists everything the second yes deletes: the vault files, every `vault-backup-*` folder, the token maps, the session key and the audit log. It also deletes every `vault-backup-*` folder (the encrypted copies made by `zn vault reset`), the token maps and the session key, then checks that none is left; if one cannot be removed, or the keychain entry stays, uninstall says so instead of reporting the vault as deleted. The rest of the `.zn` folder stays: your settings. The vault is kept, not deleted, if it is unlocked (run `zn-gate lock`, then run uninstall again) or if the computer is managed by a zn Team organization. Deleting it cannot be undone.
5. **It tells you if something is left.** If any step failed, it exits with code `1` (see [exit codes](cli.md#uninstall)); `0` means everything listed was removed.
6. **It ends with `zn-gate check`**, so you see that zn-gate is off, and prints the last step: `npm uninstall -g zn-gate`, which removes the program itself.

To see the list without changing anything, add `--dry-run`:

```bash
npx -y zn-gate uninstall --dry-run
```

Your `.env` files are never edited by `uninstall`. If you moved their values into the vault with `env shadow`, they hold markers such as `__ZN_API_KEY__`. Put the real values back before you delete the vault: see [Your `.env` files and the vault](#your-env-files-and-the-vault).

## Piece by piece

Use this if you want to remove only one part. Each command is run in your own terminal.

### Claude Code plugin

```bash
claude plugin uninstall zn-gate@usezn
```

Or, inside Claude Code, type `/plugin`, open the **Installed** tab, pick zn-gate and choose **Uninstall**. To also remove the usezn plugin list, run `claude plugin marketplace remove usezn`.

### Hooks (Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app, GitHub Copilot, or Claude Code without the plugin)

```bash
npx -y zn-gate hooks uninstall claude-code
```

Use `codex`, `cursor`, `opencode`, `antigravity`, `zcode` or `copilot` instead of `claude-code` for the others (ZCode has no project hooks, so `--project` does not apply to it). Add `--project` if you installed the hooks for one project only; run it from that project's folder. A backup of the settings file is written first. For Claude Code it also removes zn's own `secrets` MCP server. Add `--no-mcp` to leave MCP servers alone.

### MCP servers wrapped by `init --wrap-mcp`

```bash
npx -y zn-gate init --revert
```

This puts back each MCP settings file as it was saved just before zn wrapped it. Changes you made to those files later, such as MCP servers you added, are lost, so add them again afterwards. It only undoes MCP wrapping: it does not remove the plugin or any hooks. If you only ever ran `init` without `--wrap-mcp`, there is nothing for it to restore.

A zn-gate MCP server you added by hand (an entry named `zn-gate` in your agent's MCP settings) is not touched by any command here: delete that entry yourself.

### Your `.env` files and the vault

If you ran `env shadow`, your `.env` file holds markers, and the real values are in the vault. If you remove zn-gate and delete the vault without putting the values back, those values are gone. Put them back first, with the name of the encrypted copy that `env shadow` printed when you ran it:

```bash
npx -y zn-gate env unshadow .env --backup <name>
```

zn-gate keeps the vault and its settings in a `.zn` folder in your home folder. Removing the plugin, the hooks or the program leaves it there. To delete the vault, answer yes to the second question of `zn-gate uninstall`: it deletes the vault files, the local audit log (`audit.jsonl`) and the vault key in your system keychain. The rest of the `.zn` folder stays: your settings and the `vault-backup-*` folders (encrypted copies of your secrets), which you delete by hand. It keeps the vault if it is unlocked (run `zn-gate lock`, then run uninstall again) or if the computer is managed by a zn Team organization. You can also delete the whole folder by hand once you have your values back. A vault cannot be recovered after that.

### The program itself

```bash
npm uninstall -g zn-gate
```

If you also installed the Python package, `pip uninstall zn-gate` removes it.

## Check that it is off

```bash
npx -y zn-gate check
```

`uninstall` runs this for you at the end. If it still reports something as set up, the line says which part is left and what to run.

## Related

- [Files zn-gate writes in each editor, and how to remove them by hand](editors/remove-by-hand.md)
- [Every command and exit code](cli.md#uninstall)
- [Keep your `.env` values in the vault](secrets.md)
- [Words you do not know](glossary.md)
