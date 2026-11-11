# zn-gate on a shared machine

This page is for a computer that several people log in to with their own accounts: a shared workstation, a lab machine or a server where each person runs a coding agent. It says what zn-gate keeps for each user, what belongs to the whole machine, and what one user cannot see of another. Every path comes from the pages linked below and from the zn-gate code; nothing here needs an account anywhere.

The short version: install the program once, and let every person set up their own hooks and their own vault. Run every command in your own terminal, not through your agent.

## What is per user

Each account has its own state, in its own home folder.

| What | Where | Notes |
| --- | --- | --- |
| Vault, settings and logs | `~/.zn` | The vault files, `audit.jsonl` (vault audit log), `evidence.jsonl` (decision log), `stats.json` (local counts), `config.json`, MCP pins in `mcp-pins`, `team.json` and `org-policy.json` when you joined a zn Team organization. See [files and folders](../files-and-folders.md). |
| The key that opens the vault | Your system keychain | macOS Keychain, Windows Credential Manager or the Linux keyring (Secret Service), whichever your account can use. Where there is none (a Linux server without a desktop session), the key is kept in `identity.age` inside your vault folder, protected by a passphrase you choose. |
| The `connect` API key | Your system keychain | `zn-gate connect` stores it in a keychain item named `zn-cloud`. It is not shared with other accounts. |
| The unlocked vault | A private socket and `session.key` in `~/.zn/run` | `zn-gate unlock` starts it for your account only. `zn-gate lock` or the session end closes it. |
| Hooks of your agent | Your agent's own settings in your home folder | For example `~/.claude/settings.json` for Claude Code, `~/.codex/hooks.json` for Codex CLI, `~/.cursor/hooks.json` for Cursor. [Remove by hand](../editors/remove-by-hand.md) lists the files for each agent. |
| Launcher scripts | `~/.zn/hooks` | Small scripts such as `zn-hook-claude-code.sh`, shared by every profile of the same agent on that account. |
| Backups before a change | Next to the settings file that changed | For example `hooks.json.bak-zn-<date>`. |

When you move the `.zn` folder with the `ZN_HOME` variable, everything in the first row goes to that folder instead. Do not point two accounts at the same `ZN_HOME`: see [Do not share one `.zn` folder](#do-not-share-one-zn-folder).

## What is for the whole machine

Only the program itself:

- `npm install -g zn-gate` installs the `zn` and `zn-gate` commands once, in the place where npm keeps global programs. Whether the other accounts can run it depends on how Node.js was installed on the machine: an install for the whole system is usually visible to every account, one made by a per-user tool such as nvm is not. If an account cannot find `zn`, it can still run `npx -y zn-gate ...`, which needs no global install.
- A project that uses `zn hooks install <agent> --project` has hooks in the project's own files (for example `.claude/settings.json`). They are shared with everyone who opens that folder, and they run `zn` from the PATH, so each of those people needs zn-gate installed globally. Details in [hooks install](../cli.md#hooks-install).

Installing the program does not turn protection on for anyone. Protection starts for an account when that account installs its hooks.

## Set it up for each user

Each person does this in their own account:

```bash
zn hooks install claude-code     # or codex, cursor, opencode, antigravity
zn-gate check
```

Use the agent name that person runs; [Agent compatibility](../compat.md) lists them. `zn-gate check` shows whether the hook of that account stops the read of a fake key, and it reports `not found on this machine` for an agent that account does not have. The first `zn-gate unlock` creates that person's vault. The install methods are in the [install matrix](../install-matrix.md).

## What one user cannot see of another

- **The files.** `~/.zn` and its `vault` and `run` folders are created closed to everyone but the owner (mode `0700`; the vault and log files are written with mode `0600`). zn-gate checks on Linux and macOS that these folders belong to the current user and closes them to group and others; it refuses a folder owned by another user. On Windows the folders get an access list with one entry, your account.
- **The vault and its key.** The vault files are encrypted, and the key sits in the keychain of the account that created it (or behind that account's passphrase).
- **The unlocked vault.** Another account cannot connect to your vault daemon. Every connection has to prove that it can read your `session.key`, which only your account can read. On Linux and macOS the daemon also refuses to start unless its socket, the key file and their folder belong to you and are closed to others.
- **The logs.** Your decision log, your stats and your audit log are in your own `~/.zn`. `zn-gate stats`, `zn-gate report` and `zn-gate evidence` read the account that runs them and show nothing of anyone else.
- **Agent hooks and settings.** Another account's hooks are in that account's home folder. Your hooks do not change when someone else installs or removes theirs.

What this does not do:

- An administrator (root on Linux and macOS, an administrator on Windows) can read the files of every account, as on any computer. zn-gate is not a sandbox between users; see [what it does not protect](../threat-model.md).
- A project folder that several accounts can read is visible to all of them, with its `.env` files and any project hooks you put there. Keep secrets in each person's vault, not in a shared folder.
- zn-gate hooks guard what your agent does in your session. They do not stop another account's own programs.

## Do not share one `.zn` folder

It can look like a shortcut to give everyone the same `ZN_HOME`. Do not: the vault checks who owns the folder and its files and refuses the ones that belong to another user (the message says `directory is owned by another user` or `file is owned by another user`). On Windows, the vault does not start in a folder that another account created or whose permissions it cannot change. One vault is for one person.

## Remove it

- Each user runs `zn-gate uninstall` in their own account. It finds only what that account set up (its hooks, plugin and wrapped MCP servers) and the project folder you are in, and removes nothing of another account. [Remove zn-gate](../uninstall.md) has the steps, including the question about the vault.
- `npm uninstall -g zn-gate` removes the program for everyone who uses that global install. Do it last, after every user has run `zn-gate uninstall`, so nobody is left with hooks and no program behind them.
- The `~/.zn` folder of an account that is no longer used can be deleted by hand once its owner has their values back. A deleted vault cannot be recovered.

## See also

- [Files and folders zn-gate reads or writes](../files-and-folders.md)
- [Install matrix](../install-matrix.md)
- [Remove zn-gate](../uninstall.md)
- [Threat model](../threat-model.md)
