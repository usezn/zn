# Example: valid secret names and the error for an invalid one

This page shows which names the vault accepts and the message zn gives for a name it refuses. All names are made up. Run these commands in your own terminal, not through your AI agent.

zn checks the name before it asks for the value. A refused name stops the command at once: nothing is typed and nothing is stored.

## The rule

A secret name must:

- start with an upper-case letter (`A` to `Z`);
- use only upper-case letters, digits (`0` to `9`) and single underscores, such as `GITHUB_TOKEN` or `OPENAI_KEY2`;
- be at most 64 characters long.

Two forms are refused as well:

- two underscores in a row, or an underscore at the start or at the end, such as `GITHUB__TOKEN`, `_TOKEN` or `TOKEN_`;
- an underscore followed by digits at the end, such as `GITHUB_TOKEN_1`. zn keeps that form for the values its scrubber detects, so it is not allowed as a name.

Lower-case letters are refused too, so `github-token` is not a valid name.

## Try a name that is refused

Each of these commands stops before the value prompt:

```bash
npx -y zn-gate secret set github-token
npx -y zn-gate secret set GITHUB__TOKEN
npx -y zn-gate secret set GITHUB_TOKEN_1
```

The first two print the general message (the program is called `zn` in its messages):

```text
zn secret: invalid name: secret names use upper-case letters, digits and single underscores (e.g. GITHUB_TOKEN)
```

The third one prints a more specific message:

```text
zn secret: invalid name: secret names may not end in _<digits>: that form is reserved for values the scrubber detects
```

A name longer than 64 characters prints:

```text
zn secret: invalid name: secret names are at most 64 characters
```

Each refused name exits with code `64`, which means wrong usage (see [Exit codes](../cli.md#exit-codes)).

## Use a valid name

A valid name, such as `GITHUB_TOKEN`, moves on to the hidden prompt for the value:

```bash
npx -y zn-gate secret set GITHUB_TOKEN
```

Type or paste the value at that prompt. The value is never an argument of the command, so it does not reach your shell history. To see the names your vault holds (names only, never values), run:

```bash
npx -y zn-gate secret list
```

If zn says the vault is locked, unlock it in your terminal first.

## Related

- [Store a secret and run a program with it](secret-set-and-run.md)
- [Secrets](../secrets.md)
- [Troubleshooting](../troubleshooting.md)
