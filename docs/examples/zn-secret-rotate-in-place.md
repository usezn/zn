# Example: replace a vault secret's value without changing its name

You rotated a key at its provider, and the new key must go into the vault under the same name, so that nothing else has to change. This page shows that with one made-up secret, `EXAMPLE_API_KEY`. The name and every value here are fake. For the full picture, read [Keep secrets out of your coding agent](../secrets.md).

Run every command in your own terminal, not through your agent. Commands that add, change or remove a value refuse to run inside an agent.

## What stays the same, and what does not

- The name and the marker stay. Agents still write `__ZN_EXAMPLE_API_KEY__`, so no file, prompt or config that uses the marker needs an edit.
- The value is replaced. The old one is gone from the vault.
- The rules of the secret (its mode, hosts and commands) are **not** kept. `secret set` takes them from the options you give it, so you give them again.
- The first-use approvals of the secret end, because they belong to the old value.

## 1. Look at the current rules

The vault must be unlocked (`npx -y zn-gate unlock`). Write down what the secret allows now:

```bash
npx -y zn-gate secret list
```

```text
  EXAMPLE_API_KEY               env     commands=printenv
```

This secret is in `env` mode and only `printenv` may use it. `list` shows names and rules, never values.

## 2. Replace the value

`secret set` stops if the name already exists. `--force` replaces it. Repeat the options the secret had (here `--command printenv`):

```bash
npx -y zn-gate secret set EXAMPLE_API_KEY --force --command printenv
```

zn asks for the value at a hidden prompt, so it never appears in your shell history or in an argument. Paste the new fake value, for example `example-new-key-3333`. The value must be at least 8 characters.

```text
Value for EXAMPLE_API_KEY (hidden):
Stored EXAMPLE_API_KEY (env mode). Agents use it as __ZN_EXAMPLE_API_KEY__.
```

Undo: there is no step back to the old value. If you still have it, run the same command with the old value.

### If you leave the options out

The same command without `--command` replaces the value and also resets the rules. This is real output from a throwaway vault:

```text
Stored EXAMPLE_API_KEY (proxy mode). Agents use it as __ZN_EXAMPLE_API_KEY__.
Tip: allow a host for secrets_http_request: zn secret allow EXAMPLE_API_KEY --host api.example.com
```

`secret list` then shows `proxy` with no commands, so `zn run` would refuse the program. Run the command of step 2 again with the options, and the list shows `env` and `commands=printenv` again.

## 3. First-use approvals start again

The first time a program uses a secret, the vault asks you to confirm it. That approval is tied to the value it was given for. When you store a different value under the same name, the old approval no longer counts, and zn asks again (see [`secret approve`](../cli.md#secret-approve)).

You can approve now, in your own terminal:

```bash
npx -y zn-gate secret approve EXAMPLE_API_KEY --command printenv
```

Or wait: the next `run` asks for the same confirmation in the vault prompt. The prompt is a system dialog, or the terminal where you ran `zn unlock --foreground`. The agent cannot answer it. If you store the exact same value again, the approvals are kept.

## 4. Check the result

```bash
npx -y zn-gate secret list
npx -y zn-gate secret log
```

`secret log` shows the change without any value. The first store is a `set` record with the reason `created`, and each replacement is a `set` record with the reason `updated` (shortened, from a throwaway vault):

```text
2026-11-11T09:44:22.323Z  allow  EXAMPLE_API_KEY  set  -  -    created
2026-11-11T09:44:23.603Z  allow  EXAMPLE_API_KEY  set  -  -    updated
```

After the records, the last line says whether the log chain is valid.

Then run the program once, as an agent would. It prints the marker, not the value:

```bash
npx -y zn-gate run --secrets EXAMPLE_API_KEY -- printenv EXAMPLE_API_KEY
```

## If you are rotating because the key leaked

Revoke the old key at its provider before you do anything else. Replacing the value in the vault does not make the old key stop working.

## Where to go next

- [`secret set`](../cli.md#secret-set), every option of the command
- [Store a secret and run a program that uses it](secret-set-and-run.md), the first store and the first run
- [Keep secrets out of your coding agent](../secrets.md)
