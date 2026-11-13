# Example: import a `.env` file and adopt a key the scrubber found

This page walks through `secret import` and `secret adopt`, with a fake `.env` file and a fake AWS key. All values are made up. For every option, read the [command reference](../cli.md#secrets-and-the-vault) entries for [secret import](../cli.md#secret-import) and [secret adopt](../cli.md#secret-adopt).

Run every command in your own terminal, not through an AI agent. Both commands need a terminal and refuse to run when an agent runs them. The vault must be unlocked first with `npx -y zn-gate unlock`.

## The starting file

Here is the `.env` file. Nothing in it has been changed yet:

```text
APP_NAME=example-shop
DATABASE_URL=postgres://shop_user:fake-db-pass-42@db.example.test:5432/shop
STRIPE_SECRET_KEY=sk_test_fake_0000000000000000
DEBUG=false
```

## 1. Import the secrets

```text
$ npx -y zn-gate secret import
Imported 2 secret(s) from .env: DATABASE_URL_PASSWORD, STRIPE_SECRET_KEY
The file is unchanged. To replace its values with markers run: zn env shadow .env
```

Without `--keys`, zn imports only the values whose names look sensitive. Here that is `STRIPE_SECRET_KEY`, and the password inside `DATABASE_URL`, which is stored as `DATABASE_URL_PASSWORD`. `APP_NAME` and `DEBUG` stay out.

The file is still the same. Import copies the values into the vault and leaves the `.env` file alone. To replace the values in the file with markers, run `zn env shadow .env` as the message says.

Check what the vault now holds. Names and policy are shown, never values:

```text
$ npx -y zn-gate secret list
  DATABASE_URL_PASSWORD         env
  STRIPE_SECRET_KEY             env
```

## 2. Choose the keys yourself

With `--keys`, zn imports exactly the keys you name, even if their names do not look sensitive:

```text
$ npx -y zn-gate secret import --keys DEBUG,APP_NAME
Imported 1 secret(s) from .env: APP_NAME
  skipped DEBUG: the value is only 5 character(s); values under 8 are not moved because they cannot be told apart from ordinary text. It stays in the file in plain text. Use a longer value.
The file is unchanged. To replace its values with markers run: zn env shadow .env
```

Values shorter than 8 characters are never moved to the vault. zn skips them and says so, and they stay in the file in plain text.

## 3. Adopt a key the scrubber found

When a tool output contains a real-looking AWS access key, zn replaces it with a marker such as `__ZN_AWS_KEY_1__`. The agent only ever sees the marker, and the value stays in the vault. Adopting gives that value a name you can use later.

```text
$ npx -y zn-gate secret adopt AWS_KEY_1 --name AWS_PROD --host api.example.test
Adopted __ZN_AWS_KEY_1__ as __ZN_AWS_PROD__ (proxy mode).
```

`--host` says where the secret may be sent. `--command` says which command may use it. Both can be given more than once. Run `secret list` again and the new name appears with its host:

```text
$ npx -y zn-gate secret list
  APP_NAME                      env
  AWS_PROD                      proxy   hosts=api.example.test
  DATABASE_URL_PASSWORD         env
  STRIPE_SECRET_KEY             env
```

Adopting a name that already exists fails and changes nothing:

```text
$ npx -y zn-gate secret adopt AWS_KEY_1 --name AWS_PROD
zn secret: AWS_PROD already exists
```

That run exits with `64`, the code for wrong usage.

## 4. The values never come back out

There is no command that prints a value. `secret get` refuses and points you to `run`, which uses the value without showing it:

```text
$ npx -y zn-gate secret get AWS_PROD
zn secret: Not allowed: zn does not print secret values. To use one in a command, run: npx -y zn-gate@1.15.0 run --secrets NAME -- <command>
```

That run exits with `77`, the code for a refusal on purpose.

The audit log records each import and adoption, with names and no values:

```text
$ npx -y zn-gate secret log --since 1h
2026-11-07T20:45:46.092Z  allow  -  unlock  -  -    ttl:480m
2026-11-07T20:45:46.363Z  allow  DATABASE_URL_PASSWORD  set  -  -    created
2026-11-07T20:45:46.381Z  allow  STRIPE_SECRET_KEY  set  -  -    created
2026-11-07T20:45:46.788Z  allow  APP_NAME  set  -  -    created
2026-11-07T20:45:47.227Z  allow  -  resolve  claude-code  Bash    mask_text
2026-11-07T20:45:47.508Z  allow  AWS_PROD  set  -  -    adopted
chain: valid, 6 records
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Done |
| `1` | Another error |
| `64` | Wrong usage, for example a name that already exists |
| `77` | Refused on purpose, for example `secret get` or a command run by an agent |

## More

The full list is in [Exit codes](../exit-codes.md). For the rules that decide what an agent may read, see [Keep secrets out of your coding agent](../secrets.md).
