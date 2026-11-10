# Example: how env shadow reads comments, `export` and quotes

`zn env shadow` moves the sensitive values of a `.env` file into the vault and leaves a marker in their place. It finds the values with a small parser, `lib/broker/dotenv.js`, and that parser decides which lines count at all. This page shows how the parser reads the less common lines: comments, `export`, quoted values, a `#` in a value, and a value that spans two lines.

Everything here is made up. The table and the rewritten file come from running the parser alone on the sample below. They are illustrations, not the output of `zn env shadow`, which asks for your vault and changes files, so run it yourself in your own terminal (see [env shadow in the secrets guide](../secrets.md)).

## The sample file

```text
# Fake values only. This file is an example.
# API_KEY=commented-out-value-123
  # TOKEN=indented-comment-value-456
export STRIPE_SECRET=fake-secret-value-789
DB_PASSWORD="fake pass # with hash"
SERVICE_TOKEN='fake-token-value-42'
SESSION_SECRET=fake-session-12345 # trailing comment
FRAGMENT_KEY=abc#def1234567
SHORT_API_KEY=abc
PUBLIC_NAME=demo-app
MULTI_KEY="first line of a fake value
second line of a fake value"
```

## What the parser sees

| Line | What the file says | What the parser does | Moved by `env shadow`? |
|---|---|---|---|
| 2, 3 | `# API_KEY=...` and `  # TOKEN=...` | A line is read as a variable only when it starts with the name (spaces and tabs allowed, then an optional `export`). A `#` at the start means the line is a comment, so it is not an entry, even when it is indented (`parseDotenv`). | No. It is not an entry. |
| 4 | `export STRIPE_SECRET=...` | The name is `STRIPE_SECRET`. The `export` word is kept as written. | Yes. |
| 5 | `DB_PASSWORD="fake pass # with hash"` | The value is what is inside the double quotes, so the `#` is part of the value. | Yes. The quotes stay. |
| 6 | `SERVICE_TOKEN='...'` | Single quotes work the same way. | Yes. The quotes stay. |
| 7 | `... # trailing comment` | An unquoted value ends before a `#` that has a space or tab in front of it. The value is `fake-session-12345`. | Yes. The comment stays in the file. |
| 8 | `FRAGMENT_KEY=abc#def1234567` | There is no space before the `#`, so it is not a comment. The value is `abc#def1234567`. | Yes. |
| 9 | `SHORT_API_KEY=abc` | The value has 3 characters. | No. Values under 8 characters are not moved (`MIN_SECRET_LEN` in `dotenv.js`; the message in `lib/broker/cli.js`). |
| 10 | `PUBLIC_NAME=demo-app` | The name has no word such as KEY, SECRET, TOKEN or PASS, so it is not sensitive. | Not by default. |
| 11, 12 | `MULTI_KEY="first line ...` and the next line | The quote does not close on its line, so the parser marks the value as multi-line. | No. It stays in the file, and the command says it is "a multi-line value, which zn does not move". |

The parser reads a line that starts with a name followed by `=`. Lines that do not, such as the second line of `MULTI_KEY`, are not entries.

## What the rewrite changes

This is the same sample, with only the values the command would move replaced by a marker. The quotes, the `export` word, the trailing comment and the comment lines stay as they were. The marker names follow the pattern in [the secrets guide](../secrets.md): `__ZN_` and the name, then `__`.

```text
# Fake values only. This file is an example.
# API_KEY=commented-out-value-123
  # TOKEN=indented-comment-value-456
export STRIPE_SECRET=__ZN_STRIPE_SECRET__
DB_PASSWORD="__ZN_DB_PASSWORD__"
SERVICE_TOKEN='__ZN_SERVICE_TOKEN__'
SESSION_SECRET=__ZN_SESSION_SECRET__ # trailing comment
FRAGMENT_KEY=__ZN_FRAGMENT_KEY__
SHORT_API_KEY=abc
PUBLIC_NAME=demo-app
MULTI_KEY="first line of a fake value
second line of a fake value"
```

## What to do with the lines it leaves

- **A commented-out secret.** It is not moved, and it is not replaced. If the comment holds a real value, delete the line by hand.
- **A short value.** It stays in clear text. Store it with `zn secret set NAME`, then put the marker in its place, as the secrets guide describes.
- **A multi-line value.** It stays in the file. The command suggests storing it with `zn secret set NAME`.

After any change, run `zn env shadow` again and read which values it still lists.

## Related

- [Secrets guide](../secrets.md)
- [Keep a secret out of the agent](keep-a-secret-out-of-the-agent.md)
- [Move a .env file into the vault and back](env-file-round-trip.md)
