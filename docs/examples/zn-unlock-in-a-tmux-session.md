# Example: unlock the vault once and use it in every tmux pane

A worked example of how long an unlock lasts and where it applies when you work in several terminals at once: tmux panes and windows, or separate terminal tabs. The short answer is that the vault is unlocked for your user and your `~/.zn` folder, not for one terminal. The output below comes from real runs in tmux panes on a test computer with a throwaway home folder and a made-up passphrase. Two things were changed for reading: messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> lock`), and here it is shortened to `zn-gate`; and file paths are shown under `~/.zn`. The times are only examples. For the command options, see the [command line reference](../cli.md#unlock).

## Goal

Unlock the vault once, use it from your other panes, know when it locks itself, and lock it on purpose when you are done.

## How it works

`zn-gate unlock` starts a small background program, the vault, that holds your decrypted secrets in memory. It listens on a private socket in `~/.zn/run` and every command you run later talks to it. That socket belongs to your user and your `.zn` folder, so:

- Every pane, window and tab of your user that has the same `~/.zn` folder reaches the same vault. The terminal that ran `unlock` has no special role.
- The vault is not tied to that terminal, unless you start it with `--foreground` (below).
- Another user on the same computer has a vault of their own (see [zn-gate on a shared machine](agents-on-a-shared-machine.md)).

## Unlock in the first pane

```bash
zn-gate unlock
```

```text
Vault unlocked: locks after 30 min idle, or at 22:17 (in 8 h) at the latest. Run `zn-gate lock` to lock now.
Note: no system dialog is available here, so first-use approvals and policy changes will be refused.
      To approve them, run the vault in a terminal of its own instead: zn-gate lock && zn-gate unlock --foreground
```

The first run asks for a passphrase (twice) when the computer has no system keychain. The note about the system dialog appears only on a computer without a desktop, such as a server you reach over SSH. A desktop shows a dialog instead.

## Use it in another pane

Split the window, or open a second tab, and ask the vault:

```bash
zn-gate vault status
```

```text
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 22:17 (in 8 h) at the latest, zn-gate 1.15.0)
Location: ~/.zn/vault
```

The second pane sees the unlocked vault without a passphrase. Commands such as `zn-gate secret list` work there too. If you run `unlock` again, it says so and does nothing:

```text
[zn] The vault is already unlocked, so there is nothing to do. To unlock it again, run `zn-gate lock` in your own terminal first.
```

The exit code of that second `unlock` is `1`.

## Close the first pane

Close the pane that ran `unlock`, and ask again from the other pane:

```bash
zn-gate vault status
```

```text
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 22:17 (in 8 h) at the latest, zn-gate 1.15.0)
Location: ~/.zn/vault
```

Closing the terminal did not lock the vault. It keeps running until one of these happens:

- 30 minutes pass with no use. Each use of the vault starts the idle time again. `--idle` changes it.
- 8 hours pass since the unlock, whatever the use. `--ttl` changes it.
- You run `zn-gate lock`, from any pane.

Both options take a number with `s`, `m` or `h`, between 1 minute and 24 hours. A value outside that range is refused with exit code `2`. For a long session, `zn-gate unlock --ttl 12h --idle 2h` keeps the vault open longer.

## Another folder is another vault

The vault of a pane depends on the home folder and on `ZN_HOME`, the variable that moves the `.zn` folder. A pane whose home is another folder has its own vault, and does not see yours:

```text
Vault: not created yet (run `zn-gate unlock`).
```

Setting `ZN_HOME` to another folder in a pane has the same effect for that pane. Use it on purpose, or not at all.

## Lock it from any pane

```bash
zn-gate lock
zn-gate vault status
```

```text
Vault locked.
Vault: locked (backend passphrase)
Location: ~/.zn/vault
```

Lock when you leave the computer, when you hand it to someone else, or when you finish a task that used secrets. After a lock, the next `unlock` asks for the passphrase again where the computer has no keychain.

## Keep the vault in one pane

On a server, or when you want the prompts of the vault to appear in a terminal of their own, start it in the foreground:

```bash
zn-gate unlock --foreground
```

```text
Vault passphrase:
Vault unlocked: locks after 30 min idle, or at 22:18 (in 8 h) at the latest.
Keep this terminal open: zn asks here before a secret is used by a command for the first time or a policy changes.
Press Ctrl+C or run `zn-gate lock` to lock.
```

Now the vault belongs to that pane. Other panes use it as before:

```text
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 22:18 (in 8 h) at the latest, zn-gate 1.15.0)
```

But when you close the pane that holds a foreground vault, the vault locks with it:

```text
Vault: locked (backend passphrase)
```

Keep that pane open for as long as you need the vault, for example in a tmux window of its own that you do not close.

## What the unlock covers

The unlocked vault answers requests from every program of your user, not only from the pane where you typed `unlock`. That includes a coding agent that runs in one of your panes. What a secret may be used for is decided by the rules you gave it (`--host`, `--command`) and by the first-use approvals, not by the pane. Read [what the vault daemon protects](../threat-model.md#what-the-vault-daemon-protects-and-what-it-does-not) before you leave a vault unlocked for a long time.

## See also

- [Command line reference](../cli.md#unlock): `unlock`, `lock` and `vault status`.
- [Files and folders](../files-and-folders.md): what `run/session.key` and `run/vault.sock` are.
- [Keep secrets out of your coding agent](../secrets.md): the vault from the first secret to the first run.
