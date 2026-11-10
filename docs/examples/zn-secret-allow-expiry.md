# How long a secret allow lasts, and how to revoke it

A `secret allow` has no timer. The hosts and commands it adds stay in the vault until you change them or remove the secret. This page explains what does expire, what each way of taking an allow back does, and what the vault asks you before it changes anything. All names and values here are made up.

Run every command below in your own terminal. Commands that change the vault refuse to run inside an agent.

## What does not expire

- **The allow.** `zn-gate secret allow` writes the lists of hosts and commands into the vault with no time field. Nothing removes them by itself.
- **The first-use approval.** The approval that `zn run` asks for the first time a command uses a secret also has no timer. It stays until one of the events in the table below.

## What does expire: the unlocked vault

The vault itself locks again. These are the defaults of `zn-gate unlock`:

- `--ttl`: the vault locks after this long, whatever the use. The default is `8h`, and the allowed range is 1 minute to 24 hours.
- `--idle`: the vault locks after this long without use. The default is `30m`.

A locked vault does not change what is allowed. It only means that `zn run` and the vault commands ask you to unlock first. See [section 5 of the troubleshooting page](../troubleshooting.md#5-your-secret-vault-is-locked).

## What an approval depends on

An approval counts only for the value it was given for, and only for the program file it was given for:

- Each time a value is set or replaced, the secret gets a new generation id. An approval is recorded with the generation it was granted for, so a new value under the same name asks again.
- Storing the same value again (`zn-gate secret set NAME --force` with the same text) keeps the id and the approvals.
- If the program file changes after you approved it, the vault asks again, and the prompt says that the program changed.

## How to take an allow back

| You want to | Run this (in your own terminal) | What happens |
|---|---|---|
| Keep one host and drop the others | `zn-gate secret allow API_TOKEN --replace --host api.example.com` | The host list becomes only `api.example.com`. The command list is kept, because `--replace` only swaps the list you name. |
| Keep one command and drop the others | `zn-gate secret allow API_TOKEN --replace --command psql` | The command list becomes only `psql`. The host list is kept. |
| Remove the secret and everything allowed for it | `zn-gate secret rm API_TOKEN` | Asks `Remove API_TOKEN?`. On yes, the secret, its allows and its approvals are removed. |
| Make the approvals of a secret count again | `zn-gate secret set API_TOKEN --force` and a new value | A new value gets a new generation, so every approval of the old value stops counting. |

Two limits of the table:

- `secret allow` needs at least one option, so it cannot empty a list. To clear every host and command of a secret, remove the secret with `secret rm` and store it again.
- `--replace` with fewer entries is a narrowing. The vault does not ask for a confirmation for a narrowing, so the change takes effect at once. A change that adds a host, a command or a placement is a widening, and the vault asks for it in its own prompt first.

### A removed command is refused even if it was approved

If you remove a command from the list, `zn run` refuses that command even if an approval for it is still stored. `zn run` checks the list first and only then the approval. The `--replace` narrowing does not delete the old approval record, so `secret rm` is the way to remove it completely.

## Check what is left

```sh
zn-gate secret list
```

Each stored secret is one line with its name, its mode, and its `hosts=` and `commands=` lists. Names and policy only, never values. A list with nothing in it is left out of the line.

Illustration with made-up names (the exact spacing depends on the length of your names):

```text
API_TOKEN                     proxy   hosts=api.example.com  last used 2026-11-09T10:12:00Z
PGPASSWORD                    env     commands=psql
```

To see who used a secret, and when, run `zn-gate secret log --since 1h`. It shows the uses without values.

## What the commands print

A successful `secret allow` prints the new policy on one line. This is an illustration with made-up values, in the format the command writes:

```text
API_TOKEN: mode=proxy hosts=api.example.com commands=- http=header
```

Exit codes:

- `0`: the change was made.
- `1`: the secret is not stored (`zn secret: Not found: API_TOKEN is not in the vault`), or a removal was answered no (`Kept API_TOKEN.`).
- `64`: wrong usage, for example `secret allow` with no option.

## Related

- [Secrets](../secrets.md): how the vault, the modes and the allow lists fit together.
- [`secret allow`, `secret rm` and `secret approve` in the command reference](../cli.md#secret-allow).
- [Keep a secret out of the agent](keep-a-secret-out-of-the-agent.md): store, use and remove one fake secret.
