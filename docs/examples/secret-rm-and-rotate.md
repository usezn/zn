# Example: remove and replace a stored secret

A walk through taking a secret out of the vault and putting a new value in its place, for example after a key was shown by mistake or was replaced at the provider. There is no `zn secret rotate` command: you either remove the secret and store it again, or store the new value over the old one with `--force`. All names and values below are made up (`DEMO_TOKEN`, `FAKE_TOKEN_123`, `sk_test_example`). The output was captured on a throwaway machine, with the vault folder shortened to `~`; the hints in the output are shown with `zn` as the command name.

Both commands are for the person at the keyboard. They need an interactive terminal, refuse to run inside an agent's shell, and never take the value as an argument. For the vault itself, see [Secrets](../secrets.md).

## 1. See what is stored

```bash
zn secret list
```

```text
  DEMO_TOKEN                    proxy
```

The columns are the name, the mode and, when set, the allowed hosts or commands and the last use. The value is never shown.

## 2. Remove it

```bash
zn secret rm DEMO_TOKEN
```

```text
Remove DEMO_TOKEN? [y/N] y
Removed DEMO_TOKEN.
```

Anything but `y` or `yes` keeps the secret and exits with `1`:

```text
Remove DEMO_TOKEN? [y/N] n
Kept DEMO_TOKEN.
```

`zn secret remove DEMO_TOKEN` is the same command. If the secret is not there:

```text
zn secret: Not found: DEMO_TOKEN is not in the vault
```

Run from a place with no terminal, such as a script or an agent's shell, `rm` refuses and changes nothing (exit code `77`):

```text
zn secret: Not allowed: zn secret rm needs an interactive terminal. Open a terminal window yourself and run it there.
```

Check that it is gone:

```bash
zn secret list
```

```text
No secrets stored. Add one with: zn secret set NAME   or import a .env: zn env shadow .env
```

## 3. Store the new value

```bash
zn secret set DEMO_TOKEN
```

The prompt is hidden, so nothing you type or paste is shown. Here `sk_test_example` was typed:

```text
Value for DEMO_TOKEN (hidden): 
Stored DEMO_TOKEN (proxy mode). Agents use it as __ZN_DEMO_TOKEN__.
Tip: allow a host for secrets_http_request: zn secret allow DEMO_TOKEN --host api.example.com
```

The marker `__ZN_DEMO_TOKEN__` is the same as before, so files and prompts that already use it keep working with the new value.

## The shorter way: replace in one step

If the secret already exists, `zn secret set` refuses so that you do not overwrite a value by accident (exit code `64`):

```text
zn secret: DEMO_TOKEN already exists; use --force to replace it
```

With `--force` it stores the new value in one step:

```bash
zn secret set DEMO_TOKEN --force
```

```text
Value for DEMO_TOKEN (hidden): 
Stored DEMO_TOKEN (proxy mode). Agents use it as __ZN_DEMO_TOKEN__.
Tip: allow a host for secrets_http_request: zn secret allow DEMO_TOKEN --host api.example.com
```

A replaced or re-created secret starts with the settings you give it on this command line (`--host`, `--command`, `--mode`), not with the old ones. If the old secret had allowed hosts or commands, add them again with `zn secret allow`, which asks you to confirm in the vault prompt.

## 4. Check the log

Both steps are written to the audit log, without any value:

```bash
zn secret log
```

```text
2026-11-08T11:54:32.137Z  allow  DEMO_TOKEN  remove  -  -    
2026-11-08T11:54:33.915Z  allow  DEMO_TOKEN  set  -  -    created
2026-11-08T11:54:35.192Z  allow  DEMO_TOKEN  set  -  -    updated
chain: valid, 6 records
```

The three lines are the removal, the new value stored after it (`created`), and the value replaced with `--force` (`updated`). The sample is the end of a longer log from a session that also unlocked the vault and stored the secret first. For how to read each column, see Read the secret access log.

## What to check

- `zn secret list` shows the name, and `zn secret log` shows `remove`, then `set`.
- Rotating also means changing the value at the provider: removing a secret from the vault does not revoke the old key there.
- The old value may still be in your shell history or in files you pasted it into. zn cannot remove those.

## See also

- [Secrets](../secrets.md): the vault, modes, and every `zn secret` command.
