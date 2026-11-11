# Example: review what secret import would do before you run it

`zn-gate secret import` copies the secret values of a `.env` file into the vault. It has no `--dry-run` option. This page shows the real alternative: `env shadow --dry-run` makes the same plan as the import and prints it without touching the vault or the file. All names and values below are made up. The commands are described in the [command reference](../cli.md#secret-import) and in [Keep secrets out of your coding agent](../secrets.md).

Run these commands yourself, in your own terminal. Both commands refuse to run for an AI agent or without a terminal, and the import also needs the vault unlocked.

## 1. The file

A `.env` file in a project folder:

```text
PORT=3000
APP_NAME=notes-demo
STRIPE_API_KEY=sk_test_51ExampleExampleExample0000
DATABASE_URL=postgres://app:example-db-pass-1234@db.example.com:5432/notes
SMTP_PASSWORD=abc
SIGNING_KEY="-----BEGIN EXAMPLE KEY-----
ZmFrZS1rZXktZm9yLWFuLWV4YW1wbGU=
-----END EXAMPLE KEY-----"
```

## 2. There is no dry run for import

`--dry-run` is an option of `env shadow`, not of `secret import`. The import refuses it, in either place:

```bash
npx -y zn-gate secret import .env --dry-run
```

```text
zn secret: --dry-run needs a value
```

The exit code is `64`. `secret import` has no preview of its own, so use the one in the next step.

## 3. Preview the same plan

`env shadow` and `secret import` pick the values to move with the same rules. `env shadow --dry-run` prints that choice and stops. It changes nothing: the file stays as it is, the vault is not opened and nothing is stored.

```bash
npx -y zn-gate env shadow --dry-run
```

```text
  STRIPE_API_KEY -> __ZN_STRIPE_API_KEY__
  DATABASE_URL -> __ZN_DATABASE_URL_PASSWORD__
  skipped SMTP_PASSWORD: stays in clear text in the file. The value is only 3 character(s), and zn moves values of 8 or more because shorter ones cannot be told apart from ordinary settings. To keep it out of the file, run `zn secret set SMTP_PASSWORD` and put __ZN_SMTP_PASSWORD__ in its place.
  skipped SIGNING_KEY: stays in clear text in the file. It is a multi-line value, which zn does not move. Store it with `zn secret set SIGNING_KEY`.
Preview only: no value has moved. If you run this without --dry-run, 2 value(s) would stay in clear text in .env: SMTP_PASSWORD, SIGNING_KEY. Until each one is stored with `zn secret set`, treat it as readable by an agent.
```

The exit code is `0`. How to read it:

- `NAME -> __ZN_NAME__` is a value that would go into the vault. The part after the arrow is the secret name, and it is the marker that `env shadow` would leave in the file. `secret import` stores the same name but leaves the file alone.
- For `DATABASE_URL`, only the password inside the address is moved, and the secret is named `DATABASE_URL_PASSWORD`. The rest of the address stays.
- `skipped` lines are values that stay in clear text, with the reason and the command to store them yourself: a value shorter than 8 characters, or a value over several lines.
- `PORT` and `APP_NAME` are not listed, because their names do not look like secrets. A value is picked by the name of its key unless you say otherwise.

Two options change the choice, and you can preview them too:

```bash
npx -y zn-gate env shadow --dry-run --keys STRIPE_API_KEY
```

```text
  STRIPE_API_KEY -> __ZN_STRIPE_API_KEY__
```

`--keys A,B` takes only the keys you name. `--all` considers every key of the file, not only those that look like secrets. With `--all`, the preview of this file also lists `APP_NAME -> __ZN_APP_NAME__` and says that `PORT` is too short to move.

## 4. Run the import

If the plan is what you want, unlock the vault and import. Without a file name, it reads `.env` in the current folder, and `--keys` and `--all` work as in the preview:

```bash
npx -y zn-gate unlock
npx -y zn-gate secret import .env
```

It prints one line with the names it stored, one line for each skipped value, and a reminder: the file is unchanged. For a name that is already in the vault with a different value, it prints `skip NAME: a different value is already stored (use --force to replace)` and does not replace it, unless you pass `--force`. Without an unlocked vault it stops first:

```text
zn secret: Your secret vault is locked. Unlock it in this terminal with: npx -y zn-gate@<version> unlock. Then run this command again.
```

## 5. Check the result

```bash
npx -y zn-gate secret list
```

`secret list` shows the names and their policy, never the values. The names should be the ones from the preview. The `.env` file still holds the real values: to replace them with markers, run `npx -y zn-gate env shadow` (it needs the unlocked vault too). It first stores an encrypted copy of the original file and prints its name, so you can restore it with `env unshadow`.

## Related

- [`secret import`](../cli.md#secret-import) and [`env shadow`](../cli.md#env-shadow) in the command reference
- [Example: a `.env` file round trip through the vault](env-file-round-trip.md)
- [Example: adopt a secret that zn found in a file](secret-adopt-existing-file.md)
- [All examples](README.md)
