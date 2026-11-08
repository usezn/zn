# Example: import a `.env` file's secrets into the vault

`zn secret import` copies the secret values of a `.env` file into the vault and leaves the file as it is. This page walks one import step by step, checks the result with `zn secret list`, and then removes the secrets again. It only strings together steps that [Keep secrets out of your coding agent](../secrets.md) and the [command line reference](../cli.md) describe. All names and values are made up, and nothing on this page touches a real file of yours.

Run every command in your own terminal, not through your agent: the commands that add, change or remove a value need an interactive terminal, and they refuse to run inside an agent.

## 1. The starting file

Say the `.env` of a project holds these lines:

```text
# app config
NODE_ENV=development
EXAMPLE_API_KEY=FAKE_KEY_FOR_DOCS_123456
EXAMPLE_WEBHOOK_SECRET=FAKE_SECRET_FOR_DOCS_654321
EXAMPLE_DATABASE_URL=postgres://app_rw:FAKE_DB_PASSWORD_2026@db.example.test:5432/app
PGPASSWORD=FAKE_PGPASSWORD_2026
PORT=3000
```

## 2. Unlock the vault and import

```bash
npx -y zn-gate unlock
npx -y zn-gate secret import .env
```

The command copies the values it recognizes into the vault and prints:

```text
Imported 4 secret(s) from .env: EXAMPLE_API_KEY, EXAMPLE_WEBHOOK_SECRET, EXAMPLE_DATABASE_URL_PASSWORD, PGPASSWORD
The file is unchanged. To replace its values with markers run: zn env shadow .env
```

Line by line:

- `EXAMPLE_API_KEY`, `EXAMPLE_WEBHOOK_SECRET` and `PGPASSWORD` move whole, under the names they already have.
- From the connection string only the password moves, under the name of the variable plus `_PASSWORD` (here `EXAMPLE_DATABASE_URL_PASSWORD`); the rest of the URL stays in the file.
- `NODE_ENV` and `PORT` are not copied: their names do not read like credentials. A value shorter than 8 characters is not copied either, because it cannot be told apart from an ordinary setting.
- The file is unchanged, so your programs and your agent keep reading it exactly as before.

Useful forms of the same command (all options are in the [CLI reference](../cli.md#secret-import)):

```bash
npx -y zn-gate secret import .env --keys PGPASSWORD,EXAMPLE_API_KEY   # only these two
npx -y zn-gate secret import .env --all                               # every value of 8 characters or more
npx -y zn-gate secret import .env --command psql                      # allow psql for every secret of this run
```

If the vault already holds a name with a different value, the import skips it and says so; `--force` replaces the stored value. With the same value nothing changes.

## 3. Check what is in the vault

```bash
npx -y zn-gate secret list
```

`secret list` shows names and rules, never values. After the import above it prints, in alphabetical order:

```text
  EXAMPLE_API_KEY               env
  EXAMPLE_DATABASE_URL_PASSWORD  env
  EXAMPLE_WEBHOOK_SECRET        env
  PGPASSWORD                    env
```

`env` is the mode: the value is given to allowed programs through their environment, never through an argument.

## 4. Let a command use one

A program that reads its password from `PGPASSWORD`:

```bash
npx -y zn-gate secret allow PGPASSWORD --command psql
npx -y zn-gate run --secrets PGPASSWORD -- psql -h db.example.test -U app_rw -c "select 1"
```

The first command adds `psql` to the allowed commands of the secret; the vault asks you to confirm the change in its dialog or its terminal. The second starts `psql` with the real value in the environment of that process only. The first time, the vault asks you to confirm again, and shows the exact program that will run. The output of the command is masked, so the value cannot leak through it. More: [let a command use a secret](../secrets.md#4-let-a-command-use-a-secret).

## 5. Clean up

One command per secret, and each asks `Remove NAME?` in your terminal:

```bash
npx -y zn-gate secret rm EXAMPLE_API_KEY
npx -y zn-gate secret rm EXAMPLE_WEBHOOK_SECRET
npx -y zn-gate secret rm EXAMPLE_DATABASE_URL_PASSWORD
npx -y zn-gate secret rm PGPASSWORD
```

Each prints `Removed NAME.` and removes the first-use approvals the secret had; a value stored later under the same name asks for approval again.

Check that the vault is empty again:

```bash
npx -y zn-gate secret list
```

```text
No secrets stored. Add one with: zn secret set NAME   or import a .env: zn env shadow .env
```

There is nothing else to clean up: `secret import` never changes the `.env` file and stores no encrypted copy of it, so there is nothing to restore — the file still holds the values it always held. (That is also why removing the secrets is safe.) To have the file rewritten with markers instead, use `env shadow`, which stores an encrypted copy and is undone with `env unshadow`.

If the `.env` was ever committed, synced or shared, rotate the values as well: copying them into the vault does not undo that exposure.

Lock the vault when you are done:

```bash
npx -y zn-gate lock
```

## Where to read more

- [Keep secrets out of your coding agent](../secrets.md), the page this walkthrough is built from
- [`secret import`](../cli.md#secret-import) and [`env shadow`](../cli.md#env-shadow) in the command line reference
