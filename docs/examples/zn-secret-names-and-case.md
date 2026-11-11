# Example: what a secret name can look like

A secret name is the label you store a value under, such as `GITHUB_TOKEN`. The name is what `zn secret set` stores, what `zn run --secrets` asks for, and what the agent sees in its marker (`__ZN_GITHUB_TOKEN__`). This page lists the rules zn checks, with the exact message for each mistake. The names here are made up. For the full picture, read [Keep secrets out of your coding agent](../secrets.md).

## The rules

- Only upper-case letters `A` to `Z`, digits `0` to `9` and underscores `_`.
- The name starts with a letter.
- Underscores separate groups of letters and digits. Two underscores in a row, a leading underscore and a trailing underscore are all refused.
- At most 64 characters.
- The name may not end in an underscore followed by digits, such as `KEY_1` or `AWS_KEY_12`. That form is kept for values that zn's scrubber detects and names itself (for example `AWS_KEY_1`). `KEY1` and `KEY_1A` are fine.

Examples that are accepted: `GITHUB_TOKEN`, `A1`, `K2_X9`, `KEY1`, `A_1_B`.

Examples that are refused: `my_key`, `1A`, `A__B`, `_A`, `A_`, `A-B`, `A B`, `KEY_1`.

## Case: there is no lower-case form

Only upper case is allowed, so there is no case folding: zn does not accept `my_key` and store or look it up as `MY_KEY`. A lower-case name is refused, which means `MY_KEY` and `my_key` can never both exist in the vault. Type the name in upper case in `zn secret set`, `zn run --secrets` and the other commands that take a name.

## What the errors say

Each of these was produced by running the real command in a throwaway home folder. The name is refused before zn asks for a value, so nothing is stored. The commands exit with code 64 (a usage error).

`zn secret set my_key`:

```text
zn secret: invalid name: secret names use upper-case letters, digits and single underscores (e.g. GITHUB_TOKEN)
```

`zn secret set KEY_1`:

```text
zn secret: invalid name: secret names may not end in _<digits>: that form is reserved for values the scrubber detects
```

A name of 65 characters:

```text
zn secret: invalid name: secret names are at most 64 characters
```

`zn run --secrets my_key -- true` gives the same rule, with the name quoted:

```text
zn run: invalid secret name "my_key": secret names use upper-case letters, digits and single underscores (e.g. GITHUB_TOKEN)
```

The same check applies to `zn secret rm`, `zn secret allow`, `zn secret approve` and `zn secret adopt`, and to the `secrets_request` tool of the MCP server.

## What to do

1. Rename the name to upper case with single underscores, for example `my_key` becomes `MY_KEY`.
2. For a name that ends in `_<digits>`, change the suffix, for example `KEY_1` becomes `KEY_PRIMARY` or `KEY1`.
3. For a name longer than 64 characters, shorten it.

Then run the command again. Check the names you have with `zn secret list`, which shows names and policy, never values.
