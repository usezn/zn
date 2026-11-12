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

More: [uninstall](uninstall.md#4-your-env-files-and-the-vault), [`hooks uninstall`](cli.md#hooks-uninstall).

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

## Where each command writes its files

The folder each command writes in. zn-gate keeps its own files in the `.zn` folder described above; the settings and configs of your agents live where the agent keeps them.

| Command | Folder it writes in | What it writes there |
| --- | --- | --- |
| `init` | The folders of the agent settings and configs it changes | With `--wrap-mcp`, the wrapped MCP configs and a saved copy of each, written first. The guided setup asks before each step; without a terminal, or when an AI agent runs it, it only prints the steps and changes nothing. |
| `secret` | The `.zn` folder | The vault files: `vault/secrets.age` when you store a secret, and one `vault/<32 hex characters>.age` per project it detects values in. |
| `evidence` | The file you name with `--export --output` | The decision log records, as `jsonl` or `csv`. The log itself, `evidence.jsonl`, stays in the `.zn` folder. |
| `stats` | The `.zn` folder | `stats.json`, when it counts checks. |
| `team` | The `.zn` folder | The team files: `team.json`, `org-policy.json`, `team-upload.json`, `team-notice.json`. |

More: [CLI reference](cli.md).

## What to back up, and what never to copy

There is no zn-gate command that backs up its files. A backup is a copy you make by hand, from the `.zn` folder (or the folder `ZN_HOME` names). Use this table to choose. The paths are the ones listed above. "Never copy" means do not put the file in a repository, a shared drive, a chat or a synced folder.

| Path | Back it up? | Why |
| --- | --- | --- |
| `config.json` | Yes | Your settings. It holds a marker for the cloud key (where the key is and its last four characters), never the key. Deleting it resets your settings and loses no secret. |
| `evidence.jsonl` | Yes, if you want the history | The decision log: what zn-gate allowed or blocked. It is not needed to protect a new computer. |
| `audit.jsonl` | Optional, for the record | The vault audit log. It holds no secret values. Do not edit it by hand: each line is chained to the one before, and `zn-gate vault verify` checks the chain. |
| `stats.json` | Optional | Counts per day, with no values. |
| Your `.env` files | Yes, as your own files, but see the note below | After `env shadow` they hold markers, and the values are in the vault. Before `env shadow`, they hold the real values. |
| The vault files (`vault/secrets.age`, and one `vault/<32 hex characters>.age` per project) | Do not rely on a copy | They are encrypted, but the key is not in them: it is in your system keychain, or behind a passphrase. A copied folder does not move your secrets. Store each secret again on the new computer, or keep the values in your password manager. |
| `vault/identity.age`, `vault/keychain.json` | Never copy | `identity.age` is the vault key (protected by a passphrase), and it exists only on a computer with no system keychain. `keychain.json` holds the vault settings. Do not move or delete either by hand: the vault cannot be opened without `identity.age`. |
| `vault-backup-<date>` | Never copy | An encrypted copy of an old vault, made by `zn-gate vault reset`. It holds old secret values. `zn-gate vault purge` removes it. |
| `run/session.key` and `run/vault.sock` | Never copy | They exist only while the vault is unlocked, and zn-gate removes them when it locks. |
| `hooks/` | No | Launcher scripts for your agents. `zn-gate hooks install <agent>` creates them. |
| `team.json`, `org-policy.json`, `team-upload.json`, `team-upload.lock` | No | They belong to a computer that joined a zn Team. Remove them with `zn-gate team leave`, not by hand. |
| `team-notice.json` | No | A record of which team notices were already shown. `zn-gate team leave` does not remove it, and deleting it only lets a notice show again. |
| `reach-last.json` and `package-registry-cache.json` | No | A small memory of the last `reach --remember` run, and saved package lookups. |
| `requests.jsonl` | No | A record of each time an agent asked for a secret. The agent can ask again. |
| Backups of settings files (`<settings file>.bak-zn-<stamp>`) and saved copies of MCP configs (`<config file>.bak.<number>`) | Keep them where they are | `zn-gate init --revert` puts the saved copy back in place of the wrapped MCP config. |

An `.env` file that held real values is a copy of your secrets in plain text. Copy it only to a place you trust as much as the vault, or move the values into the vault first with `zn-gate env shadow`. The encrypted copy of the original `.env` that `env shadow` keeps (`ENVBAK_...`) is an entry inside `vault/secrets.age`, not a file, so a file backup does not hold it.

For the steps on a new computer, see [Set up zn-gate on a new computer](examples/moving-to-a-new-computer.md).

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
| `vault/secrets.age` | zn-gate, when you store a secret | Yes, but deleting it loses every value in the vault | `zn-gate secret rm NAME` for one secret, or `zn-gate vault purge` |
| `vault/<32 hex characters>.age`, one per project | zn-gate, when it detects values in a project | Yes | `zn-gate vault forget [dir]`, with the vault locked |
| `vault/identity.age` | zn-gate, on a computer with no system keychain | No: the vault cannot be opened without it | `zn-gate vault purge` |
| `vault/keychain.json` | zn-gate, when the vault is created | No | `zn-gate vault purge` |
| `run/session.key` and `run/vault.sock` | zn-gate, while the vault is unlocked | Only while the vault is locked | `zn-gate lock` (zn-gate removes them itself) |
| `config.json` | zn-gate, for your settings and the cloud key marker | Yes; it resets your settings and loses no secret | `zn-gate disconnect` removes the cloud key and its marker in this file, and nothing else |
| `stats.json` | zn-gate, when it counts checks | Yes | None. `ZN_STATS=off` stops the counting. |
| `requests.jsonl` | zn's `secrets_request` tool, when an agent asks for a secret | Yes | None |
| `package-registry-cache.json` | zn-gate, for package lookups | Yes | None |
| `team.json`, `org-policy.json`, `team-upload.json`, `team-upload.lock` | zn-gate, on a computer that joined a zn Team | No: the hooks read them | `zn-gate team leave` |
| `team-notice.json` | zn-gate hooks, to remember which team notices were already shown | Yes. Deleting it only lets a notice show again. | None. `zn-gate team leave` does not remove it. |
| `hooks/` | `zn-gate hooks install <agent>` | Yes, once the hooks are uninstalled | None. `hooks uninstall` leaves it in place. |
| `~/.zn/cache/compile/` | zn-gate, when a hook runs: Node keeps compiled copies of zn-gate's code there so the next hook starts faster | Yes. It is safe to delete: zn-gate rebuilds it on the next hook call. | None. `zn-gate uninstall` leaves it in place. Set `ZN_NO_COMPILE_CACHE=1` to stop zn-gate from using it. |
| `ENVBAK_X<hash>D<stamp>`, an entry inside `vault/secrets.age` | `zn-gate env shadow`, as the encrypted copy of a `.env` file | No: it is not a file, and without it `env unshadow` cannot restore the `.env` file | `zn-gate secret rm NAME`. `zn-gate env unshadow FILE --backup NAME` only restores the file; it does not delete the copy. |

More: [Remove zn-gate](uninstall.md), [CLI reference](cli.md).
