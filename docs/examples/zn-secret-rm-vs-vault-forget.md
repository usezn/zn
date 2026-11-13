# Example: `secret rm` or `vault forget`

Two zn-gate commands that both "remove something from the vault", and they remove different things. This page shows what each one deletes, what it leaves alone, and which one to pick. All values are made up. For every option, read the [command line reference](../cli.md#secret-rm) and the [secrets page](../secrets.md).

The output below comes from real runs of the commands against a throwaway vault. Two things were changed for reading: messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> lock`), and here it is shortened to `zn-gate`; and folder names are shown under `~/projects`.

## The short answer

| | `secret rm NAME` | `vault forget [dir]` |
|---|---|---|
| What it removes | One named secret, with its first-use approvals | The token map of one project folder |
| What is a token map | Not applicable | The list of which marker stands for which value that zn detected in that project (see the [glossary](../glossary.md)) |
| Vault must be | unlocked | locked |
| Asks before acting | yes (`Remove NAME? [y/N]`) | no |
| Writes to the audit log | yes, a `remove` record | no |
| Leaves alone | Other secrets, token maps, the audit log | The vault, every secret, other projects, the audit log |
| Can be undone | no: store the value again with `secret set` | no: the map is rebuilt only when zn detects the values in that project again |
| Needs a person at a terminal | yes (exit 77 without one) | the command does not check for one |

Use `secret rm` when you stopped using a credential you stored by name. Use `vault forget` when you are done with a project and want zn to drop what it remembers about that folder.

## What is in the vault folder

The throwaway vault held two named secrets and token maps for two projects. These are the files under `~/.zn` (the file names of the token maps are shortened):

```text
.zn/audit.jsonl
.zn/run/.last-prune
.zn/run/session.key
.zn/vault/<32 hex characters>.age
.zn/vault/<32 hex characters>.age
.zn/vault/identity.age
.zn/vault/keychain.json
.zn/vault/secrets.age
```

The named secrets are inside `secrets.age`. Each project has its own `<32 hex characters>.age` file: the token map. `secret rm` works on the first, `vault forget` on the second.

## `secret rm`: one named secret

```text
$ zn-gate secret list
  DEMO_API_KEY                  env     commands=printenv
  DEMO_DB_PASSWORD              env     commands=printenv
```

Run it in your own terminal: without one it refuses with exit code 77 (`zn secret rm needs an interactive terminal`) and changes nothing. It asks first, and anything but `y` keeps the secret:

```text
$ zn-gate secret rm DEMO_API_KEY
Remove DEMO_API_KEY? [y/N] n
Kept DEMO_API_KEY.
```

The exit code is 1 when you answer no. Answer `y` and it is gone:

```text
$ zn-gate secret rm DEMO_API_KEY
Remove DEMO_API_KEY? [y/N] y
Removed DEMO_API_KEY.
```

The exit code is 0. The other secret is untouched:

```text
$ zn-gate secret list
  DEMO_DB_PASSWORD              env     commands=printenv
```

A name that is not in the vault is an error, with exit code 1:

```text
zn secret: Not found: DEMO_API_KEY is not in the vault
```

The vault audit log keeps a record of the removal, without the value:

```text
$ zn-gate secret log
2026-11-11T14:44:58.152Z  allow  -  unlock  -  -    ttl:480m
2026-11-11T14:44:59.271Z  allow  DEMO_API_KEY  set  -  -    created
2026-11-11T14:45:00.373Z  allow  DEMO_DB_PASSWORD  set  -  -    created
2026-11-11T14:45:02.683Z  allow  DEMO_API_KEY  remove  -  -
chain: valid, 4 records
```

`secret rm` also deletes the first-use approvals the secret had, so a new value stored under the same name asks for approval again. It does not touch the token maps.

The copy of a `.env` file that `zn-gate env shadow` set aside is an entry inside `secrets.age` too, and `secret rm NAME` deletes it. Restore what you need from it first (see [the `.env` round trip](env-file-round-trip.md)).

## `vault forget`: one project's token map

`vault forget` takes a folder, or uses the current folder. With the vault unlocked it refuses, because the running vault may hold the project in memory:

```text
$ zn-gate vault forget ~/projects/demo
Lock the vault first (`zn-gate lock`): the daemon may hold this project in memory.
```

The exit code is 1. Lock the vault and run it again:

```text
$ zn-gate lock
Vault locked.
$ zn-gate vault forget ~/projects/demo
Forgot the token map of ~/projects/demo
```

The exit code is 0, and there is no question first. The `<32 hex characters>.age` file of that project is gone. Run it a second time and it says there is nothing left to forget, still with exit code 0:

```text
No token map stored for ~/projects/demo
```

After the command the vault folder holds one token map fewer (the other project's file is still there), and `secrets.age`, `identity.age`, `keychain.json` and `audit.jsonl` are unchanged. Unlock the vault again and `secret list` still shows the secret you kept:

```text
$ zn-gate secret list
  DEMO_DB_PASSWORD              env     commands=printenv
```

## Which one do I need

- A credential you no longer use: `secret rm NAME`. Also revoke it where it was issued; removing it from the vault does not make it invalid.
- A project you finished with: `vault forget <folder>`. Your named secrets stay.
- Everything, including the audit log: see [`vault purge` or `vault reset`](zn-vault-purge-vs-reset-decision.md).
- The three vault commands that check or remove things, in one page: [vault verify, forget and purge](vault-verify-and-forget.md).

## Further reading

- [Secrets and the vault](../secrets.md)
- [Command line reference: `secret rm`](../cli.md#secret-rm)
- [Command line reference: `vault forget`](../cli.md#vault-forget)
