# Example: reading the lines of `zn vault status`

`zn vault status` shows whether the vault exists and is unlocked and, when it is, when it locks. This page shows the lines it prints in each state, with made-up times and folders. The [vault guide](../secrets.md) explains what the vault is, and [`vault status`](../cli.md#vault-status) in the command line reference lists the exit codes.

Run the commands in your own terminal: `unlock` refuses to run under an AI agent.

## Run it

```bash
npx -y zn-gate vault status
```

On Windows PowerShell, whose default execution policy refuses the `.ps1` shims of `npx` and `zn`, use the `.cmd` forms (or run the commands in Command Prompt). More in the [Windows checklist](windows-checklist.md):

```powershell
npx.cmd -y zn-gate vault status
```

The command prints one `Vault:` line and, except when the vault does not exist yet, one `Location:` line under it.

## When the vault does not exist yet

Before the first `unlock`, the command prints a single line:

```text
Vault: not created yet (run `zn unlock`).
```

The commands named in these lines are written for your machine: on Windows they read `zn.cmd unlock` and `zn.cmd lock`, and when `zn` is not on your PATH they name the `npx -y zn-gate@<version>` form instead. The examples on this page show the short `zn` form. The first `zn unlock` creates the vault. See [Install and unlock the vault](../secrets.md#1-install-and-unlock-the-vault).

## When the vault is locked

```text
Vault: locked (backend passphrase)
Location: ~/.zn/vault
```

The word after `backend` names where the vault key is kept: `macos` for the macOS Keychain, `windows` for the Windows Credential Manager and `libsecret` for the Linux keyring (the Secret Service, such as GNOME Keyring or KWallet). With `passphrase` there is no system entry: the key is kept in the vault folder as `identity.age`, encrypted with the passphrase you set. That backend is used when no system keychain is available, for example on Linux without a desktop session, in WSL or in CI.

## When the vault is unlocked

```text
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 23:09 (in 8 h) at the latest, zn-gate 1.15.0)
Location: ~/.zn/vault
```

Reading the `Vault:` line from left to right:

- `backend passphrase`: the same key-holder word as above.
- `locks after 30 min idle, or at 23:09 (in 8 h) at the latest`: when the vault locks again — after the idle time with no use, or at the end of the session at the latest, in your local time. The two values are the `--idle` and `--ttl` values of the running unlock (30 minutes idle and 8 hours are the defaults).
- `zn-gate 1.15.0`: the version of the running vault.

The `Location:` line is the folder where the vault lives: the `vault` folder inside `~/.zn`, or inside the folder the `ZN_HOME` variable names. It prints the full path on your machine; `~/.zn/vault` here is the short form the docs use.

## When the running vault is outdated

After you update zn-gate, a vault that is still running from the older version keeps secrets as markers in the agent hooks until it is restarted. The status line flags it and says what to do:

```text
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 23:09 (in 8 h) at the latest, zn-gate 1.14.0), outdated: restart with `zn lock`, then `zn unlock`
Location: ~/.zn/vault
```

Run the two commands in your own terminal, in the order the line gives. More in [Install and unlock the vault](../secrets.md#1-install-and-unlock-the-vault).

## Where to read more

- [Keep secrets out of your coding agent](../secrets.md), the page this example is built from
- [`vault`](../cli.md#vault) in the command line reference: `vault status` and the other `vault` subcommands
- [Useful commands](../secrets.md#useful-commands) in the vault guide
