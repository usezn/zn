# Example: shadow several `.env` files in a monorepo

A monorepo often has one `.env` file per package. `zn-gate env shadow` works on one file per run, so you run it once per folder. This page does that for three made-up packages and shows the one case that needs your attention: the same variable name with a different value in two files. It only uses commands from the [command line reference](../cli.md) and the steps of [Keep secrets out of your coding agent](../secrets.md). All names and values are made up.

Run every command in your own terminal, not through your agent: the `env` commands refuse to run inside an agent.

## 1. The three files

```text
shop/
  apps/web/.env
  apps/api/.env
  packages/worker/.env
```

```text
# apps/web/.env
NEXT_PUBLIC_SITE_NAME=Example Shop
EXAMPLE_API_KEY=example-not-a-real-key-web
EXAMPLE_WEBHOOK_SECRET=example-not-a-real-secret

# apps/api/.env
PORT=3000
EXAMPLE_API_KEY=example-not-a-real-key-api
DATABASE_URL=postgres://app:example-password-1@db.example.test:5432/shop

# packages/worker/.env
EXAMPLE_API_KEY=example-not-a-real-key-web
QUEUE_TOKEN=abc
```

Unlock the vault once. All three files use the same vault, because the vault belongs to you, not to a folder:

```bash
npx -y zn-gate unlock
```

## 2. Preview the first folder

```bash
cd apps/web
npx -y zn-gate env shadow .env --dry-run
```

```text
  EXAMPLE_API_KEY -> __ZN_EXAMPLE_API_KEY__
  EXAMPLE_WEBHOOK_SECRET -> __ZN_EXAMPLE_WEBHOOK_SECRET__
```

`--dry-run` only lists what would move. Ordinary settings such as `NEXT_PUBLIC_SITE_NAME` are not listed: `env shadow` moves the values of keys whose name looks sensitive (it contains `KEY`, `SECRET`, `TOKEN`, `PASS`, `AUTH` and a few more words, or ends in `_URL`) and leaves the rest alone. `--all` moves every value and `--keys A,B` only the keys you name.

## 3. Shadow it and check the file

```bash
npx -y zn-gate env shadow .env
```

```text
Shadowed 2 value(s) in .env. The file now holds only markers; the values are in the local vault.
Encrypted copy of the original: ENVBAK_XE0B3FEB6D202611111346 (restore with: zn env unshadow .env --backup ENVBAK_XE0B3FEB6D202611111346)
Next: allow the commands that need them, e.g. zn secret allow EXAMPLE_API_KEY --command "npm run dev"
Run your app with the real values: zn run --secrets EXAMPLE_API_KEY,EXAMPLE_WEBHOOK_SECRET -- <command>
```

Open the file and look at it. This is the check for this folder:

```text
NEXT_PUBLIC_SITE_NAME=Example Shop
EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__
EXAMPLE_WEBHOOK_SECRET=__ZN_EXAMPLE_WEBHOOK_SECRET__
```

Write down the name of the encrypted copy. Each file gets its own name, because the name is made from the path of the file. The restore command of one folder does not fit another. Running `env shadow` on the same file again prints `.env: nothing to shadow (already shadowed)`, which is a quick way to confirm that a file is done.

## 4. The same name with a different value

The vault stores a secret under a name made from the key. In the API folder the key `EXAMPLE_API_KEY` has a different value from the one the web folder stored, so zn does not overwrite it:

```bash
cd ../api
npx -y zn-gate env shadow .env
```

```text
  skip EXAMPLE_API_KEY: a different value is already stored (use --force to replace)
Shadowed 1 value(s) in .env. The file now holds only markers; the values are in the local vault.
Encrypted copy of the original: ENVBAK_X0971731BD202611111346 (restore with: zn env unshadow .env --backup ENVBAK_X0971731BD202611111346)
Next: allow the commands that need them, e.g. zn secret allow DATABASE_URL_PASSWORD --command "npm run dev"
Run your app with the real values: zn run --secrets DATABASE_URL_PASSWORD -- <command>
```

Read the `skip` line. It means that value was not moved. Check the file again, because the summary line above it does not say which values stayed:

```text
PORT=3000
EXAMPLE_API_KEY=example-not-a-real-key-api
DATABASE_URL=postgres://app:__ZN_DATABASE_URL_PASSWORD__@db.example.test:5432/shop
```

`DATABASE_URL` shows the other thing to know about URLs: only the password moved, the rest of the URL stays readable.

The key still holds its value in clear text. You have two ways out:

- **Use another key name in that folder**, and the same name in the code that reads it. After you rename the key to `EXAMPLE_API_KEY_API`, the same command moves it:

  ```text
  PORT=3000
  EXAMPLE_API_KEY_API=__ZN_EXAMPLE_API_KEY_API__
  DATABASE_URL=postgres://app:__ZN_DATABASE_URL_PASSWORD__@db.example.test:5432/shop
  ```

- **Add `--force`** only when you want the new value to replace the stored one. Then every file that holds the marker `__ZN_EXAMPLE_API_KEY__` gets the new value, the web folder included.

Two folders that hold the same value under the same key need nothing special. The worker folder in this example does exactly that: its `EXAMPLE_API_KEY` has the web value, so it moves and both files share one vault secret.

## 5. Short values stay in the file

In the worker folder, `QUEUE_TOKEN=abc` is only three characters. zn moves values of eight or more characters, so this one is left and the output says so:

```text
  skipped QUEUE_TOKEN: stays in clear text in the file. The value is only 3 character(s), and zn moves values of 8 or more because shorter ones cannot be told apart from ordinary settings. To keep it out of the file, run `zn secret set QUEUE_TOKEN` and put __ZN_QUEUE_TOKEN__ in its place.
1 value(s) stay in clear text in .env: QUEUE_TOKEN. Until each one is stored with `zn secret set`, treat it as readable by an agent.
```

## 6. Check every folder, from the root

You can also run the command from the root of the repository with a path, for example `npx -y zn-gate env shadow apps/web/.env`. For a file that is done it prints `.env: nothing to shadow (already shadowed)`. List the secrets that now exist in the vault:

```bash
npx -y zn-gate secret list
```

```text
  DATABASE_URL_PASSWORD         env
  ENVBAK_X0971731BD202611111346  backup
  ENVBAK_XE0B3FEB6D202611111346  backup
  ENVBAK_XF998B20AD202611111346  backup
  EXAMPLE_API_KEY               env
  EXAMPLE_WEBHOOK_SECRET        env
```

There is one `ENVBAK_` copy per folder you shadowed. Keep their names: they are the only way to put a file back with `zn-gate env unshadow FILE --backup NAME`. The vault asks you to confirm before it hands the plain text out. See [`env unshadow`](../cli.md#env-unshadow) and the [example that follows one file in and back out](env-file-round-trip.md).

## Where to read more

- [Move your `.env` values into the vault](../secrets.md#2-move-your-env-values-into-the-vault)
- [`env shadow`](../cli.md#env-shadow) in the command line reference
- [Files that hold secrets, and how to remove each one](../secrets.md#files-that-hold-secrets-and-how-to-remove-each-one)
