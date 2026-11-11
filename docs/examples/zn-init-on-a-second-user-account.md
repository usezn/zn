# Example: set up zn-gate on a second user account

Two people share one computer, each with their own login. The first, Ana, has already set up zn-gate. Now Ben logs in to his own account and wants the same protection. This page shows what Ben has to do, and what he finds already there or not there. The page is built from real runs with two separate home folders, which is what separates two accounts for zn-gate: everything zn-gate keeps lives under the home folder of whoever runs it. All names and values are made up. Who can see what, and what an administrator can still read, is on [zn-gate on a shared machine](agents-on-a-shared-machine.md).

Run every command in your own terminal, not through your agent.

## 1. What Ben finds when he logs in

Ana installed the hooks of her coding agent. That changed files in Ana's home folder only. In Ben's account there is nothing of zn-gate, even for the same agent. Ben can ask:

```bash
npx -y zn-gate check --hooks
```

```text
zn hooks installed on this machine (nothing was run or changed):

  None found. To set zn up, run `npx -y zn-gate init` in your own terminal.
```

`npx -y zn-gate` needs no global install. If Ana's `npm install -g zn-gate` is visible to Ben, `zn` also works for him; if not, `npx` does. And Ben has no vault yet:

```bash
npx -y zn-gate vault status
```

```text
Vault: not created yet (run `npx -y zn-gate@1.15.0 unlock`).
```

## 2. Run `init` as Ben

```bash
npx -y zn-gate init
```

In a terminal, `init` asks before each step. When it cannot ask (no terminal, or an AI agent runs it) it only prints the steps and changes nothing, and exits `1`. Run the same command in Ana's account and in Ben's, and the two lists differ, because each is read from the home folder of the account that runs it. Ana's:

```text
  OK Claude Code  already protected by zn
  -  Codex CLI    not found on this machine
```

Ben's:

```text
  >  Claude Code  not set up yet
  -  Codex CLI    not found on this machine

This is not an interactive terminal, so zn only prints the steps. Nothing was changed.
Run them in your own terminal:

  in Claude Code, type /plugin marketplace add usezn/zn and then /plugin install zn-gate@usezn
```

The rest of the list is cut here. See [`init`](../cli.md#init).

## 3. Or install the hooks directly

For a single agent, Ben can skip the guide:

```bash
npx -y zn-gate hooks install claude-code
```

```text
Installed zn hooks for claude-code in ~/.claude/settings.json
  backup: ~/.claude/settings.json.bak-zn-20261111T135531
```

The `~` is Ben's home folder: the file is Ben's own `settings.json`, and the backup sits next to it. Ana's file is not touched, and her hooks do not change when Ben installs or removes his. See [`hooks install`](../cli.md#hooks-install).

## 4. Ben gets his own vault

```bash
npx -y zn-gate unlock
```

The first run creates a new vault in `~/.zn/vault` of Ben's account, and locks it again after 30 minutes without use, or after at most 8 hours (the exact time is printed). The vault of Ana is a different set of files, with a different key. Ben's list starts empty:

```bash
npx -y zn-gate secret list
```

```text
No secrets stored. Add one with: zn secret set NAME   or import a .env: zn env shadow .env
```

The vault key sits in the system keychain of Ben's account, or, where the machine has none, behind a passphrase that Ben chooses. See [Keep secrets out of your coding agent](../secrets.md#1-install-and-unlock-the-vault).

## 5. Check that Ben is protected

```bash
npx -y zn-gate check --hooks
npx -y zn-gate check
```

The first prints one line per hook with `OK`, and ends with `6 OK, 0 stale, 0 broken.`. The second makes a temporary folder with a fake `.env` file, asks Ben's hook to read it, and reports that Claude Code "blocked the .env file and allowed the ordinary file". Both only read: nothing is run, changed or sent. See [`check`](../check.md).

## What is per user, in one list

| What | Where, for Ben |
| --- | --- |
| Hooks of the agent | Ben's own `~/.claude/settings.json` (other agents: their own files in his home folder) |
| Launcher scripts | `~/.zn/hooks` |
| Vault, logs and settings | `~/.zn`, with its own `vault` folder |
| Backups before a change | Next to each settings file that changed |

What is not per user: the program itself, if it was installed with `npm install -g`, and the hooks of a project installed with `--project`. A project install puts the hooks in the project's files, shared by everyone who opens that folder, and it runs `zn` from the `PATH`, so Ben needs `zn-gate` installed globally for it to work. See [Files and folders zn-gate reads or writes](../files-and-folders.md).

## Where to read more

- [zn-gate on a shared machine](agents-on-a-shared-machine.md)
- [Files and folders zn-gate reads or writes](../files-and-folders.md)
- [Example: remove zn-gate from one agent and keep the others](uninstall-one-agent.md)
- [Remove zn-gate](../uninstall.md), which each account runs for itself
