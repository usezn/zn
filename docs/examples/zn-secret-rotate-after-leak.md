# Example: rotate a key after it leaked

A key you use was pasted into a chat, committed, or printed by a tool, and now you must replace it. This page walks through that in order: revoke the old key, find the copies, store the new value, and check that nothing still uses the old one. The provider, the key and every value here are made up: `example-cloud` stands for whichever service issued your key, and the key is the example key from AWS's own documentation.

Run every command in your own terminal, not through your agent.

## 1. Revoke the old key at the provider

Do this first, before anything else. zn cannot revoke a key at another service: only that provider can. In the console of `example-cloud`:

1. Create a new key, and keep it on screen or in your clipboard.
2. Revoke (or delete) the old key.

A revoked key is harmless wherever a copy of it remains: in a file, in a chat history or in git. Until you revoke it, every copy is still a working key.

## 2. Find the copies on your computer

Three read-only commands show where the old value may still be. None of them prints a value.

The `.env` files of a project, and what your agents can reach from it (names only):

```bash
npx -y zn-gate reach .
```

```text
WHAT THEY CAN REACH (secrets and credential files an agent could read; names only, never values)
  HIGH   .env in this folder has 1 secret (AWS_ACCESS_KEY_ID)
         Claude Code can read them today.
         Fix: npx -y zn-gate env shadow .env
```

The session history your agents keep on disk (see [`reach --history`](../reach.md#history-did-your-agents-keep-a-secret-of-yours)):

```bash
npx -y zn-gate reach --history
```

```text
CLAUDE CODE
  ~/.claude/projects/-home-me-app/3f2a.jsonl
    1 x AWS_KEY
    Do this: Rotate this AWS access key in the AWS console (IAM), then delete this session file if you do not need it.
```

Once the old key is revoked, that copy is harmless. Delete the session file by hand if you do not need it. zn cannot see what was already sent to your model provider, and it cannot delete anything there.

The files of a project:

```bash
npx -y zn-gate scan .
```

```text
Findings (1):
  [x] .env:1 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]
```

`scan` reads the files of the folder. It does not look at the git history, so a key that was ever committed is still in the history after you fix the file. That is one more reason to revoke it. Also check places zn cannot see: other computers, your CI settings and any password manager entry.

## 3. Store the new value

Pick the case that fits.

### The old value is in a file, not in the vault

Store the new value under a name, with the program that may use it (here `printenv`):

```bash
npx -y zn-gate secret set AWS_ACCESS_KEY_ID --command printenv
```

Paste the new fake value at the hidden prompt, for example `example-new-key-4444`. Then replace the old value in the file with the marker `__ZN_AWS_ACCESS_KEY_ID__`. Do not run `env shadow` on the file first: it would move the old value into the vault.

### The old value is already in the vault

Replace it under the same name with `--force`, and repeat the rules the secret had (`secret list` shows them). Without the options, the rules are reset:

```bash
npx -y zn-gate secret set AWS_ACCESS_KEY_ID --force --command printenv
```

```text
Value for AWS_ACCESS_KEY_ID (hidden):
Stored AWS_ACCESS_KEY_ID (env mode). Agents use it as __ZN_AWS_ACCESS_KEY_ID__.
```

The first-use approvals of that secret end with the old value. The vault asks you again the next time a program uses it.

### `env shadow` made a copy of the old file

`env shadow` keeps an encrypted copy of the original `.env` file in the vault. It holds the old value, so after a leak it is one more copy. `secret list` shows it as a `backup` entry named `ENVBAK_...`:

```text
  AWS_ACCESS_KEY_ID             env     commands=printenv
  ENVBAK_X812E0E96D202611110948  backup
```

Remove it, and confirm the question:

```bash
npx -y zn-gate secret rm ENVBAK_X812E0E96D202611110948
```

```text
Remove ENVBAK_X812E0E96D202611110948? [y/N] y
Removed ENVBAK_X812E0E96D202611110948.
```

`secret rm` also deletes the copy for good, so do it only after you no longer need to restore that file.

## 4. Check that nothing still uses the old value

```bash
npx -y zn-gate scan .
npx -y zn-gate secret list
npx -y zn-gate secret log
```

- `scan .` should end with `Audit Result : PASSED - NO THREATS DETECTED` and exit `0`. The old value is only found if it has a known key format, so this is a check, not a proof.
- `secret list` should show your secret with its rules and no `ENVBAK_` entry for the old file.
- `secret log` shows each change without any value. In this example it lists the `updated` record of the new value and the `remove` record of the old copy, and ends with whether the log chain is valid.

Last, run `npx -y zn-gate reach --history` again. A key you already revoked can still be listed there, because the file is still on disk. That is expected: the key no longer works.

## Where to go next

- [Keep secrets out of your coding agent](../secrets.md), how to keep the new value out of files
- [Files that hold secrets, and how to remove each one](../secrets.md#files-that-hold-secrets-and-how-to-remove-each-one)
- [`reach`](../reach.md), what it checks and what it never shows
- [`secret`](../cli.md#secret), every option of the commands used here
