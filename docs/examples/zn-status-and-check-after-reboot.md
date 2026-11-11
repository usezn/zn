# Example: check zn-gate after a restart

After you restart your computer, four things can be different: the zn vault is locked, the cloud check may be off until the key can be read again, your agents may have updated while the computer was off, and the hooks are still where you left them. This page walks through the commands that show each of these, in the order to run them. Run every command in your own terminal, not through an agent.

The output below comes from real runs of the commands on a throwaway home folder, with a fake key and a fake passphrase. Two things were changed for reading: messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> unlock`), and here it is shortened to `zn-gate`; and file paths are shown under `~/.zn`, where zn keeps its files by default. The first line of `status` may show a shield icon instead of `[+]`, depending on your terminal.

## 1. Read the status

```bash
zn-gate status
```

`status` reads files only. It shows the versions, whether the optional cloud check is on, and where the API key comes from. After a restart with the cloud check connected and the vault locked, it looks like this:

```text

[+]  zn-gate Status:
  Package Version : 1.15.0
  Rules Version   : 2026-11-08.11 (scrub 2026-10-31.1, audit 2026-11-06.4)
  Active Engine   : Local rules + cloud for analyze_prompt (ZN_CLOUD=1)
  Endpoint        : https://api.usezn.com/v30/analyze
  API key         : Not set
  Connected       : yes, key ...0000 (not found in the zn vault: run zn unlock; cloud check falls back to local rules). Turn off: zn-gate disconnect
  Leaves machine  : analyze_prompt text only, secrets redacted locally first
```

- `API key : Not set` together with `Connected : yes ... not found in the zn vault` means the key is saved in the vault, the vault is locked, and zn cannot read the key. The cloud check still runs, but it uses the local rules only for the time being. The fix is `zn-gate unlock` (section 3).
- If the vault is unlocked and the key is saved in it, the `API key` line says `Set (saved by zn-gate connect, in the zn vault)` instead.
- If the key is saved in the system keychain, the `API key` line says `Set (saved by zn-gate connect, in your system keychain)`. zn reads that key without the vault, so a locked vault does not affect it.
- If there is no `Connected` line, the cloud check was never connected, and the vault does not matter for it.

`status` always exits with `0`, so read the lines, not the exit code.

## 2. Check the vault

```bash
zn-gate vault status
```

After a restart the vault is locked. zn keeps the vault key in a background process of your user, started by `zn-gate unlock`, and a restart ends that process. The vault is never unlocked by itself at startup:

```text
Vault: locked (backend passphrase)
Location: ~/.zn/vault
```

`vault status` exits with `0`. The backend in brackets is the one the vault was created with. A vault on the `passphrase` backend asks for its passphrase; the keychain backends (macOS Keychain, Windows Credential Manager, or the Linux keyring) open without one, as long as your system keychain is open.

## 3. Unlock the vault when you need it

```bash
zn-gate unlock
```

Run it in your own terminal. It refuses to run under an AI agent, and it needs an interactive terminal for the keychain backends too. A successful unlock on the `passphrase` backend prints:

```text
Vault unlocked: locks after 30 min idle, or at <time> (in 8 h) at the latest. Run `zn-gate lock` to lock now.
Note: no system dialog is available here, so first-use approvals and policy changes will be refused.
      To approve them, run the vault in a terminal of its own instead: zn-gate lock && zn-gate unlock --foreground
```

- The vault locks again after 30 minutes without use (`--idle`), or at the end of the session at the latest (`--ttl`, 8 hours by default). `<time>` is the local time of that end.
- On a desktop with a system dialog, the note about dialogs does not appear, and the vault says that confirmations for the first use of a secret appear as a system dialog.
- Once the vault is open, `zn-gate vault status` shows `Vault: unlocked (...)` with the same lock times.
- Running `zn-gate unlock` when the vault is already unlocked stops with a message that says so. To lock it on purpose, run `zn-gate lock`. It prints `Vault locked.` when it was open, or `Vault was not unlocked.` when it was not; both exit with `0`.

Secrets that a command or an agent needs are unavailable while the vault is locked. When a hook needs one, it stops and tells the agent to ask you to run `zn-gate unlock` in your own terminal. An agent cannot unlock the vault itself.

## 4. Check that the hooks are still there

```bash
zn-gate check --hooks
```

A restart does not remove the hooks. They are entries in the settings files of your agents, and this command reads only those files, runs no hook and does not need the vault. On a computer where no agent has zn hooks, it prints:

```text
zn hooks installed on this machine (nothing was run or changed):

  None found. To set zn up, run `npx -y zn-gate init` in your own terminal.
```

With hooks installed, each one is listed as OK, STALE or broken. A STALE line means the hook was written by an older zn-gate, which often happens after an update. The next step is in [the hooks page after an agent update](hooks-status-after-agent-update.md).

## 5. Run the check

```bash
zn-gate check
```

`check` makes a temporary folder with a fake `.env` file and an ordinary file, and asks each installed hook whether the agent may read them. It does not use the vault either. On a computer where no supported agent is found, the output is:

```text

zn-gate check: does zn stop your coding agent from reading a secret?

zn made a test folder with a fake key in a .env file and an ordinary file next to it, then asked
each agent's zn hook whether the agent may read them. This is what happened:

  -  Claude Code  not found on this machine
  -  Codex CLI    not found on this machine
  -  Cursor       not found on this machine
  -  OpenCode     not found on this machine
  -  Antigravity  not found on this machine
  -  GitHub Copilot (VS Code, CLI) not found on this machine
  -  Gemini CLI (experimental) not found on this machine
  -  ZCode        not found on this machine

No supported coding agent was found on this machine (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app), so there is nothing to check.
Install one, then run `npx -y zn-gate init`. Other editors: https://usezn.com/docs/install

The test folder was deleted.

Decision time per tool call: no data yet. It is measured on each tool call your agent makes through zn.
```

On a computer with a protected agent, each agent gets an OK line when its hook blocks the `.env` file and allows the ordinary file. What each line means, and the NOT protected lines, is in [the check page](../check.md). `check` exits with `0` when every agent that is set up is protected, and with `1` when one is not, or when none is set up, as [the command reference](../cli.md#check) says.

## What a restart does not change

| Item | After a restart | What to run if it is wrong |
|---|---|---|
| Hooks in the agent settings | Still there | `zn-gate check --hooks` shows them |
| Cloud check connection | Still connected | `zn-gate status` shows it |
| Vault | Locked | `zn-gate unlock`, in your own terminal |
| Lock timers | Start again at each unlock | `zn-gate unlock --idle <time>` sets the idle time |
| Agent MCP server | Started again by the agent | Restart the agent, as in [the MCP server page](mcp-server-with-zn-gate.md) |

After the steps above, a locked vault with hooks in place is the normal state after a restart. The only thing to do is run `zn-gate unlock` before a command or an agent needs a secret.
