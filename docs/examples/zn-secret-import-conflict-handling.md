# Example: import a `.env` file when some names are already in the vault

`secret import` copies the values of a `.env` file into the vault and leaves the file as it was. Sometimes a name in the file is already in the vault. This page shows what happens to each case, how `--force` changes it, and how to check the result. All names and values are made up. Run the command in your own terminal: it refuses to run inside an agent or from a pipe.

The steps build on [a `.env` file round trip through the vault](env-file-round-trip.md) and on [`secret import` in the command reference](../cli.md#secret-import).

## 1. The starting point

Say the vault already holds two names, and the `.env` file has three lines:

```text
EXAMPLE_API_KEY=example-not-a-real-key
EXAMPLE_WEBHOOK_SECRET=example-not-a-real-secret
EXAMPLE_APP_NAME=demo-project
```

Here `EXAMPLE_API_KEY` is in the vault with a different value, and `EXAMPLE_WEBHOOK_SECRET` is in the vault with the same value as the file. To see which names are there, without printing any value:

```bash
npx -y zn-gate secret list
```

## 2. Import without `--force`

```bash
npx -y zn-gate secret import .env
```

With the starting point above, the output is:

```text
  skip EXAMPLE_API_KEY: a different value is already stored (use --force to replace)
Imported 1 secret(s) from .env: EXAMPLE_WEBHOOK_SECRET
The file is unchanged. To replace its values with markers run: zn env shadow .env
```

What happened, name by name:

- **A name with a different value is skipped.** The vault keeps its value, and zn prints the `skip` line. The command still exits with `0`, so a script cannot see the skip from the exit code.
- **A name with the same value counts as imported.** Nothing is written for it, so its settings in the vault stay as they are. It appears in the `Imported` line.
- **A name that is not in the vault is stored.** A new name is always added.
- **`EXAMPLE_APP_NAME` is not mentioned at all.** Names that do not look like secrets are ignored unless you pass `--all` or name them with `--keys`.

The `Imported` count is the number of names that are now in the vault with the file's value. It does not count the skipped names.

## 3. Import with `--force`

```bash
npx -y zn-gate secret import .env --force
```

```text
Imported 2 secret(s) from .env: EXAMPLE_API_KEY, EXAMPLE_WEBHOOK_SECRET
The file is unchanged. To replace its values with markers run: zn env shadow .env
```

`--force` stores the file's value for every name, including the names that had a different value. Before you use it, know what else it changes:

- **The old value is replaced.** zn stores the new value in place of the old one and does not keep a copy of the old one (`packages/zn-gate/lib/vault/daemon.js`, `setSecret`).
- **Approvals of a changed value are dropped.** If the value is different, the approvals of that name are removed, so the next use asks again (`daemon.js`, `dropApprovalsOf`).
- **The settings of the name are rewritten from this command.** The allowed hosts, commands and mode come from the flags you pass to `secret import`, not from what the name had before (`packages/zn-gate/lib/broker/cli.js`, `metaFromFlags`). If the name was allowed for a command and you do not pass `--command` again, it is no longer allowed for that command. This also happens with `--force` when the value is the same.

So for a name that already has settings, pass the same `--host` and `--command` flags again, or set the policy again afterwards with [`secret allow`](../cli.md#secret-allow).

## 4. Pick the names with `--keys`

To import only some names, list them. Names that are not in the list are ignored:

```bash
npx -y zn-gate secret import .env --keys EXAMPLE_WEBHOOK_SECRET
```

Use this when you want to leave a name alone, for example the `EXAMPLE_API_KEY` line of the example. Then no skip line is printed for it.

## 5. Values zn does not import

Some lines are not stored, and zn says why in the output with a `skipped` line:

- **A multi-line value** stays in the file. zn suggests `secret set` for it.
- **A value that is too short** to be hidden reliably stays in the file.
- **A name that zn does not accept** stays in the file. zn suggests another name.

Store those with [`secret set`](../cli.md#secret-set) under a name zn accepts.

## 6. There is no preview

`secret import` has no `--dry-run`. The flag is refused before anything is read:

```text
zn secret: --dry-run needs a value
exit 64
```

To decide before you import, run `secret list` to see which names already exist, and compare them with the names in the file. Then use `--keys` for the names you want, so only those can be affected.

## 7. Check the result

```bash
npx -y zn-gate secret list
npx -y zn-gate secret log --since 1h
```

`secret list` shows the names in the vault. `secret log` shows who used which secret where, and it checks the log chain. See [`secret list`](../cli.md#secret-list) and [`secret log`](../cli.md#secret-log).

When every name is in the vault with the right value, you can replace the values in the file with markers:

```bash
npx -y zn-gate env shadow .env
```

`env shadow` follows the same rule as the import: a name whose vault value is different is skipped, with the same `skip` line, and its line stays in clear text in the file. Read the output, and check the file after the command runs.

## Related

- [A `.env` file round trip through the vault](env-file-round-trip.md)
- [Adopt a secret that zn found in a file](secret-adopt-existing-file.md)
- [Restore a `.env` file after you rotate its secret](zn-env-unshadow-after-rotation.md)
