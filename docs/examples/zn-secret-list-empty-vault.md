# Example: what `secret list` prints before you store any secret

`zn-gate secret list` shows the names and policy of the secrets in your vault. This page shows what it prints on a computer where nothing has been stored yet, so you can tell "the vault is empty" from "the vault is closed". All values on this page are made up, and the messages were captured from a real run in a throwaway home folder (zn-gate 1.15.0, passphrase vault, with a fake passphrase).

Run every command in your own terminal, not through your agent: unlocking the vault needs a person at a terminal.

## 1. Before the vault exists

On a computer that has never created a vault, `secret list` cannot open one, so it prints the same message as for a closed vault and exits with code `1`:

```bash
npx -y zn-gate secret list
```

```text
zn secret: Your secret vault is locked. Unlock it in this terminal with: npx -y zn-gate@1.15.0 unlock. Then run this command again.
```

The version number in the message is the version you run. If `zn` is installed on your computer, the message says `zn unlock` instead.

To see which case you are in, ask for the vault status. It exits with code `0` and says so when no vault exists yet:

```bash
npx -y zn-gate vault status
```

```text
Vault: not created yet (run `npx -y zn-gate@1.15.0 unlock`).
```

## 2. Create the vault by unlocking it

```bash
npx -y zn-gate unlock
```

The first `unlock` creates the vault and asks you to choose a passphrase (or uses your system keychain, depending on your computer). It prints, with your own folder in place of the one shown:

```text
Created a new vault (passphrase) in ~/.zn/vault
Vault unlocked: locks after 30 min idle, or at tomorrow 02:30 (in 8 h) at the latest. Run `npx -y zn-gate@1.15.0 lock` to lock now.
```

Depending on your computer, a note follows about first-use approvals: where no system dialog is available, approvals are refused unless you run `unlock --foreground` in a terminal of its own.

## 3. List an empty, unlocked vault

```bash
npx -y zn-gate secret list
```

```text
No secrets stored. Add one with: zn secret set NAME   or import a .env: zn env shadow .env
```

The exit code is `0`: an empty vault is not an error. `secret list` never prints values, only names and policy, so an empty vault prints just this one line.

## 4. Lock the vault again

```bash
npx -y zn-gate lock
```

```text
Vault locked.
```

Now the vault exists but is closed. `vault status` says so and exits with code `0`:

```text
Vault: locked (backend passphrase)
```

`secret list` on a locked vault prints the "vault is locked" message from step 1 again and exits with code `1`, even though the vault is empty. The message does not tell you whether there are secrets inside: unlock to find out.

## Done

You can now tell the three states apart:

| State | `secret list` prints | Exit code |
| --- | --- | --- |
| No vault yet | `Your secret vault is locked...` | `1` |
| Vault exists, locked | `Your secret vault is locked...` | `1` |
| Vault unlocked, no secrets | `No secrets stored. Add one with: ...` | `0` |

`vault status` separates the first two: `not created yet` or `locked`.

## Next steps

- [Store a secret and run a program that uses it](secret-set-and-run.md): the first secret, step by step.
- [Adopt a secret that zn found in a file](secret-adopt-existing-file.md): fill the vault from a value zn replaced with a token.
- [`secret list` in the CLI reference](../cli.md#secret-list)
- [`Your secret vault is locked` in the troubleshooting page](../troubleshooting.md#5-your-secret-vault-is-locked)
