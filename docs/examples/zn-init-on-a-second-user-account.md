# Example: set up zn-gate on a second user account

Two people share one computer, each with their own login. The first account has already set up zn-gate. Now the person on the second account logs in and wants the same protection. This page shows what the second account has to do, and what it finds already there or not there. The page is built from real runs with two separate home folders, which is what separates two accounts for zn-gate: everything zn-gate keeps lives under the home folder of whoever runs it. All names and values are made up. Who can see what, and what an administrator can still read, is on [zn-gate on a shared machine](agents-on-a-shared-machine.md).

Run every command in your own terminal, not through your agent.

## 1. What the second account finds on login

The first account installed the hooks of its coding agent. That changed files in the home folder of the first account only. In the second account there is nothing of zn-gate, even for the same agent. The second account can ask:

```bash
npx -y zn-gate check --hooks
```

```text
zn hooks installed on this machine (nothing was run or changed):

  None found. To set zn up, run `npx -y zn-gate init` in your own terminal.
```

`npx -y zn-gate` needs no global install. If a global `npm install -g zn-gate` of the first account is visible to the second account, `zn` also works there; if not, `npx` does. And the second account has no vault yet:

```bash
npx -y zn-gate vault status
```

```text
Vault: not created yet (run `npx -y zn-gate@1.15.0 unlock`).
```

## 2. Run `init` on the second account

```bash
npx -y zn-gate init
```

In a terminal, `init` asks before each step. When it cannot ask (no terminal, or an AI agent runs it) it only prints the steps and changes nothing, and exits `1`. Run the same command in the first account and in the second account, and the two lists differ, because each is read from the home folder of the account that runs it. The first account:

```text
  OK Claude Code  already protected by zn
  -  Codex CLI    not found on this machine
```

The second account:

```text
  >  Claude Code  not set up yet
  -  Codex CLI    not found on this machine

This is not an interactive terminal, so zn only prints the steps. Nothing was changed.
Run them in your own terminal:

  in Claude Code, type /plugin marketplace add usezn/zn and then /plugin install zn-gate@usezn
```

The rest of the list is cut here. See [`init`](../cli.md#init).

## 3. Or install the hooks directly

For a single agent, the second account can skip the guide:

```bash
npx -y zn-gate hooks install claude-code
```

```text
Installed zn hooks for claude-code in ~/.claude/settings.json
  backup: ~/.claude/settings.json.bak-zn-20261111T135531
```

The `~` is the home folder of the second account: the file is its own `settings.json`, and the backup sits next to it. The file of the first account is not touched, and its hooks do not change when the second account installs or removes its own. See [`hooks install`](../cli.md#hooks-install).

## 4. The second account gets its own vault

```bash
npx -y zn-gate unlock
```

The first run creates a new vault in `~/.zn/vault` of the second account, and locks it again after 30 minutes without use, or after at most 8 hours (the exact time is printed). The vault of the first account is a different set of files, with a different key. The list of the second account starts empty:

```bash
npx -y zn-gate secret list
```

```text
No secrets stored. Add one with: zn secret set NAME   or import a .env: zn env shadow .env
```

The vault key sits in the system keychain of the second account, or, where the machine has none, behind a passphrase that the second account chooses. See [Keep secrets out of your coding agent](../secrets.md#1-install-and-unlock-the-vault).

## 5. Check that the second account is protected

```bash
npx -y zn-gate check --hooks
npx -y zn-gate check
```

The first prints one line per hook with `OK`, and ends with `6 OK, 0 stale, 0 broken.`. The second makes a temporary folder with a fake `.env` file, asks the hook of the second account to read it, and reports that Claude Code "blocked the .env file and allowed the ordinary file". Both only read: nothing is run, changed or sent. See [`check`](../check.md).

## What is per user, in one list

| What | Where, for the second account |
| --- | --- |
| Hooks of the agent | Its own `~/.claude/settings.json` (other agents: their own files in its home folder) |
| Launcher scripts | `~/.zn/hooks` |
| Vault, logs and settings | `~/.zn`, with its own `vault` folder |
| Backups before a change | Next to each settings file that changed |

What is not per user: the program itself, if it was installed with `npm install -g`, and the hooks of a project installed with `--project`. A project install puts the hooks in the project's files, shared by everyone who opens that folder, and it runs `zn` from the `PATH`, so the second account needs `zn-gate` installed globally for it to work. See [Files and folders zn-gate reads or writes](../files-and-folders.md).

## Where to read more

- [zn-gate on a shared machine](agents-on-a-shared-machine.md)
- [Files and folders zn-gate reads or writes](../files-and-folders.md)
- [Example: remove zn-gate from one agent and keep the others](uninstall-one-agent.md)
- [Remove zn-gate](../uninstall.md), which each account runs for itself
