# Example: comments and blank lines in a `.env` file

When `zn env shadow` or `zn secret import` reads a `.env` file, it changes only the value of each secret it moves. Comments, blank lines, the `export` word, the spacing before a comment and the line endings stay exactly as they were. This page shows that with a made-up file. It only strings together steps that [Keep secrets out of your coding agent](../secrets.md) and the [command line reference](../cli.md) describe. All names and values are made up.

Run the commands in your own terminal, not through your agent: the `env` commands refuse to run inside an agent.

## 1. The starting file

Say the `.env` of a project looks like this:

```text
# Local development settings (made-up values)
export EXAMPLE_DB_PASSWORD=example-pass-0001   # rotate before production

EXAMPLE_API_KEY="example-key-000001" # from the console
  # an indented comment line
EXAMPLE_TOKEN='example-token-000002'
LOG_LEVEL=debug # a plain setting, not a secret
```

## 2. How zn reads these lines

- A line that starts with a name and `=` is a setting. The word `export` in front of it is allowed.
- A line that starts with `#`, indented or not, is a comment. zn skips it.
- A blank line is skipped too.
- In an unquoted value, the comment starts at a `#` that follows a space or a tab. So `LOG_LEVEL=debug # a note` has the value `debug`. A `#` with no space in front of it is part of the value: `KEY=abc#def` has the value `abc#def`.
- In a value in double or single quotes, the value is what is between the quotes. Anything after the closing quote is a comment that zn keeps.

## 3. Shadow the file

Unlock the vault, then shadow the file:

```bash
npx -y zn-gate unlock
npx -y zn-gate env shadow .env
```

Only the two secret values are replaced with markers. The rest of the file is the same:

```text
# Local development settings (made-up values)
export EXAMPLE_DB_PASSWORD=__ZN_EXAMPLE_DB_PASSWORD__   # rotate before production

EXAMPLE_API_KEY="__ZN_EXAMPLE_API_KEY__" # from the console
  # an indented comment line
EXAMPLE_TOKEN='__ZN_EXAMPLE_TOKEN__'
LOG_LEVEL=debug # a plain setting, not a secret
```

The quotes, the `export` word, the spaces before each comment, the blank line and the comment lines are kept. A Windows file with `CRLF` line endings keeps them too. `env shadow` also prints the name of an encrypted copy of the original, as described in [`env shadow`](../cli.md#env-shadow).

## 4. Two cases to check by hand

- **A commented-out secret is not moved.** A line such as `# OLD_TOKEN=example-old-token-003` is a comment for zn, so `env shadow` and `secret import` leave it as it is, in clear text. Delete the line, or store the value yourself with `zn secret set` and then delete the line.
- **A multi-line quoted value is not moved.** A value that opens a quote and does not close it on the same line stays in clear text, and zn reports it as skipped. Store it with `zn secret set` instead.

## Where to read more

- [Keep secrets out of your coding agent](../secrets.md), the page this walkthrough is built from
- [`env shadow`](../cli.md#env-shadow) and [`secret`](../cli.md#secret) in the command line reference
- [Example: a `.env` file round trip through the vault](env-file-round-trip.md), from the shadowed file back to the original
