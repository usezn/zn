# Files and folders zn-gate reads or writes

A short list of the files and folders that the commands below touch, taken from the pages linked in each section. Read those pages for the full behaviour.

## The `.zn` folder

zn-gate keeps the vault and its settings in a `.zn` folder in your home folder (`~/.zn`).

| Path | What it is |
| --- | --- |
| The vault files | Your stored secrets, encrypted. |
| `audit.jsonl` | The vault audit log: what the vault did (which secret was used, unlock, reset). Never holds secret values. Next to the vault files. Check it with `zn vault verify`; read it with `zn vault log`. |
| `evidence.jsonl` | The decision log: what zn-gate allowed or blocked. Check it with `zn-gate evidence --verify`. If it is damaged, you move it aside to `evidence.damaged.jsonl`, see [troubleshooting](troubleshooting.md#10-the-evidence-log--is-damaged). |
| `~/.zn/vault-backup-<date>` | Encrypted copy of an old vault, made by `zn-gate vault reset`. |
| `~/.zn/hooks` | A small launcher script, shared by every profile of the same agent. `npm update -g zn-gate` refreshes these launchers by itself (a short install step); a project-local install does not touch them, and neither does an update with `--ignore-scripts`. |
| `~/.zn/reach-last.json` | Written only by `reach --remember`. |

More: [uninstall](uninstall.md#your-env-files-and-the-vault), [`hooks uninstall`](cli.md#hooks-uninstall).

## `reach`

`zn-gate reach` is read only.

- It reads the `.env` files of the folder you point at (not its sub-folders): files named `.env` or `.env.<name>`, up to 256 KB each. Example files such as `.env.example` are skipped. Only the names of the secrets are reported, never the values.
- It checks that a fixed list of credential files in your home folder exist (for example `~/.aws/credentials`, `~/.netrc`, `~/.kube/config`). It runs `stat` and does not read them.
- It reads agent settings in your home folder and in the folder you check.
- It writes no file, except with `--remember`. Then it writes one small file, `~/.zn/reach-last.json` (or `reach-last.json` in the folder that `ZN_HOME` names). It holds counts and a date for each folder, under a hash of the folder path, so it has no path, file name or value.

More: [reach](reach.md).

## `.env` files

- `zn-gate secret import [FILE]` reads a `.env` file (default `.env`) into the vault. The file is not changed.
- `zn-gate env shadow [FILE]` moves the values into the vault and leaves markers in the file. It prints the name of an encrypted copy of the original.
- `zn-gate env unshadow FILE --backup ENVBAK_NAME` puts the original values back from that copy.
- `zn-gate uninstall` never edits your `.env` files.

More: [uninstall](uninstall.md), [CLI reference](cli.md).

## Hooks and settings of your agents

- `zn-gate hooks install <agent>` adds the hooks, and the `secrets` MCP server unless `--no-mcp` is given. A backup of the settings file is written first. With `--project`, it writes the shared files of the folder you are in.
- `zn-gate hooks uninstall <agent>` removes them again and also writes a backup first. It leaves the launcher script under `~/.zn/hooks` in place.
- `zn-gate init --wrap-mcp` wraps MCP servers and saves a copy of each config first. `zn-gate init --revert` puts the saved copy back, and changes made to that file since are lost.

More: [CLI reference](cli.md), [remove by hand](editors/remove-by-hand.md).

## `uninstall`

`zn-gate uninstall` prints the list of what it found, with the file paths, and asks before it removes anything. With `--dry-run` it changes nothing.

- It removes the hooks, the `secrets` MCP server, and the Claude Code plugin.
- It puts back the saved copies of wrapped MCP configs.
- It keeps the vault unless you answer yes to a second question. A yes deletes the vault files, the vault audit log (`audit.jsonl`), the `vault-backup-*` folders, the token maps, the session key and the vault key in your system keychain.
- The rest of the `.zn` folder stays: your settings and the decision log (`evidence.jsonl`).

More: [Remove zn-gate](uninstall.md), [`uninstall` in the CLI reference](cli.md#uninstall).

## Who creates each one, and how to remove it

Every command is run in your own terminal. "None" means no documented command removes it: delete it by hand.

| Path | Created by | Delete by hand? | Command that removes it |
| --- | --- | --- | --- |
| `~/.zn` (the whole folder) | zn-gate, when it first stores the vault or settings | Yes, once you have your values back. A deleted vault cannot be recovered. | None for the whole folder. See the rows below for what is inside. |
| The vault files | zn-gate, when you store secrets | Yes | `zn-gate uninstall` (answer yes to the second question), or `zn-gate vault purge` |
| `audit.jsonl` | zn-gate, next to the vault files | Yes | `zn-gate uninstall` (second yes), or `zn-gate vault purge` |
| `~/.zn/vault-backup-<date>` | `zn-gate vault reset` | Yes | `zn-gate vault purge` |
| `~/.zn/hooks` | `zn-gate hooks install <agent>` | Yes | None. `hooks uninstall` leaves it in place. |
| `~/.zn/reach-last.json` | `zn-gate reach --remember` | Yes | None |
| `.env` files | You. `env shadow` changes the values in them to markers. | Yes, they are your files. | None. `env unshadow FILE --backup ENVBAK_NAME` puts the values back; `uninstall` never edits them. |
| Settings file backups (written before `hooks install` or `hooks uninstall` changes a file) | `zn-gate hooks install <agent>`, `zn-gate hooks uninstall <agent>` | Yes | None |
| Saved copies of MCP configs | `zn-gate init --wrap-mcp` | Yes, but then `init --revert` can no longer put the copy back. | None. `zn-gate init --revert` puts the copy back in place of the wrapped config. |
| Hooks in your agent's settings | `zn-gate hooks install <agent>` | Yes, see [remove by hand](editors/remove-by-hand.md). | `zn-gate hooks uninstall <agent>`, or `zn-gate uninstall` |

More: [Remove zn-gate](uninstall.md), [CLI reference](cli.md).
