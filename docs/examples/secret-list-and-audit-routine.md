# Example: a monthly review of your secrets and the vault log

A short routine you can run once a month, or after a busy stretch with your agent: list what is in the vault, read who used it, check that the log was not tampered with, and remove what you no longer need. It takes a few minutes. The output below was captured from the real commands in a throwaway home folder with two made-up secrets; only the times differ on your machine. For every option, see [Secrets and the vault](../cli.md#secrets-and-the-vault) in the command line reference, and for the full walkthrough, [Keep secrets out of your coding agent](../secrets.md).

None of these commands ever prints a secret value. The list shows names and settings, and the log shows metadata only.

## The checklist

1. [Unlock the vault](#1-unlock-the-vault)
2. [List the secrets and read each line](#2-list-the-secrets)
3. [Read the log of the last 30 days](#3-read-the-log)
4. [Remove what you do not use](#4-remove-what-you-do-not-use)
5. [Verify the log](#5-verify-the-log)
6. [Lock the vault](#6-lock-the-vault)

## 1. Unlock the vault

```bash
zn unlock
```

`secret list` and the verified view of the log need the vault unlocked. With the vault locked, `zn secret list` stops with `Your secret vault is locked`, and the log is shown without a chain check (see step 3).

## 2. List the secrets

```bash
zn secret list
```

```text
  EXAMPLE_API_KEY               env     hosts=api.example.com  commands=curl
  OLD_TEST_TOKEN                proxy 
```

Each line is a name, the mode that fills it in, and where it may be used. Ask yourself, for each one:

- **Do I still use it?** If not, it goes in step 4.
- **Is the place it may be used right?** `EXAMPLE_API_KEY` may be used only by `curl` and only for `api.example.com`. `OLD_TEST_TOKEN` has no host and no command, so nothing may use it yet. A secret nobody can use and nobody needs is a good one to remove.
- **Do I know every name?** A name you do not recognise was stored by someone or something using your account. See step 3 for when.

To change where a secret may be used, run `zn secret allow NAME --host ... --command ...`, and say yes in the vault prompt.

## 3. Read the log

```bash
zn secret log --since 30d
```

`zn vault log` is the same command. `--since` takes a time such as `1h` or `30d`. This is the start of the log of the captured run, which stored two secrets and then tried to use one of them (two more `deny` lines for the same secret are left out to keep it short):

```text
2026-11-08T13:52:12.973Z  allow  -  unlock  -  -    ttl:60m
2026-11-08T13:52:13.078Z  allow  EXAMPLE_API_KEY  set  -  -    created
2026-11-08T13:52:13.343Z  allow  OLD_TEST_TOKEN  set  -  -    created
2026-11-08T13:52:13.625Z  deny  EXAMPLE_API_KEY  env  -  -  curl  no_confirmation_channel
chain: valid, 6 records
```

Each line holds, in this order: the UTC time, the decision, the secret, the mode (or the action, such as `set`, `remove`, `unlock`), the agent, the tool, the command or host, and a reason. A `-` means there is nothing to show.

What to look for:

| You see | What it means |
| --- | --- |
| `set`, `remove`, `unlock`, `lock` lines | Your own changes. They should match what you remember doing. |
| `deny` on a secret | Something tried to use the secret and was refused. Read the command or host and the reason. If it is a program you use, allow it on purpose; if you do not know it, leave it refused. |
| A secret used that you did not expect, or a command or host you do not know | Find out what ran it. Ask your agent what it was doing at that time. |
| Nothing for a secret over the whole month | It is a candidate for removal. |
| The last line, `chain: valid, N records` | The log was checked and is intact. With the vault locked it says `chain: not checked` instead. |

## 4. Remove what you do not use

```bash
zn secret rm OLD_TEST_TOKEN
```

```text
Remove OLD_TEST_TOKEN? [y/N] Removed OLD_TEST_TOKEN.
```

It also removes the first-use approvals the secret had. The removal is itself logged as a `remove` line, so next month's review sees it. A secret you stored again under the same name asks for approval again. Run `zn secret list` once more to check:

```text
  EXAMPLE_API_KEY               env     hosts=api.example.com  commands=curl
```

If a value may have leaked, store a new value rather than keep the old one: `zn secret set NAME --force` replaces it.

## 5. Verify the log

```bash
zn vault verify
```

```text
Audit log OK: 7 records, chain and MACs verified.
```

Run it after the clean-up, so the count includes your own `remove` line. It is the same check as the `chain:` line, with a clear pass or fail. If it fails, it says at which record. Do not delete or edit the log: the vault keeps a warning until you have looked into it, and the [command line reference](../cli.md#vault-verify) explains what it compares. A failed check also makes `zn secret log` show no records. That behaviour is quoted from the reference and was not run for this page.

## 6. Lock the vault

```bash
zn lock
```

```text
Vault locked.
```

The vault also locks by itself after the idle time or at the end of the session.

## The routine in one block

```bash
zn unlock
zn secret list
zn secret log --since 30d
zn secret rm NAME    # for each secret you no longer use
zn vault verify
zn lock
```

In the captured run, `unlock` printed that no system dialog was available, which is why first-use approvals were refused (the `no_confirmation_channel` reason). On a normal desktop, a dialog asks you, or you run `zn unlock --foreground` in a terminal of its own. The hints in these commands showed `npx -y zn-gate@1.15.0 ...`, because `zn` was not on the PATH; this page shows `zn`.
