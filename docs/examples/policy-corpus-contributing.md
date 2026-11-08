# Example: add a case to the destructive-command test corpus

The optional [destructive-command check](../destructive-commands.md) is tested against a list of labeled shell commands: ordinary commands that must be allowed, and risky commands that must be blocked. This page shows how to add one of each. [CONTRIBUTING.md](../../CONTRIBUTING.md#where-to-start) lists other small first tasks, and explains how to open a pull request and how to change a rule; this page covers only this corpus.

The commands in the corpus are test data. They are never run. Use only made-up values: hosts such as `example.com`, `.test` and `.invalid`, and the documentation addresses `192.0.2.x`, `198.51.100.x` and `203.0.113.x`.

## Where the corpus is

The corpus is the file `packages/zn-gate/test/fixtures/destructive_commands.json`. It has four keys:

| Key | What it holds | Example |
| --- | --- | --- |
| `note` | One sentence for readers of the file. | `"Labeled command strings ... Never run them."` |
| `benign` | A list of strings. Ordinary commands. The check must allow every one. | `"git status"` |
| `risky` | A list of objects with `cmd` and `rule`. The check must block every one, under that rule. | `{"cmd": "Format-Volume -DriveLetter D -Force", "rule": "disk_overwrite"}` |
| `not_covered` | A list of objects with `cmd` and `note`. Shapes the check deliberately does not read, so it allows them. The docs say so. | `{"cmd": "rm -rf *", "note": "the current folder: its location is not known"}` |

The `rule` of a `risky` case is the name of a rule without the `destructive:` prefix. The six names are `rm_root_home`, `pipe_to_shell`, `disk_overwrite`, `perm_root`, `fork_bomb` and `rc_download`; the [destructive commands page](../destructive-commands.md#what-it-blocks) says what each one blocks.

## Do not edit the JSON by hand

The JSON file is generated, and it is sorted. The generator is `packages/zn-gate/test/fixtures/make_destructive_corpus.js`. The note in the file says how to rewrite it:

```bash
cd packages/zn-gate
node test/fixtures/make_destructive_corpus.js
```

It prints the counts of each list and rewrites the file. A hand edit would be lost the next time someone runs it, so edit the generator, run it, and commit both files.

## Add an allow case (a benign command)

Use this for a command that people really run and that the check must never block, especially one that looks a little like a blocked shape.

1. Open `make_destructive_corpus.js` and find the `benign` section. Commands are added with `add('...')`, in groups by topic (build output, git, package managers, and so on).
2. Add your command to the group that fits, for example `add('rm -rf dist coverage')`.
3. Run the generator, then the test below.

If the test fails with your command in the list of blocked commands, the check has a false positive. That is a bug in a rule, not a reason to drop your case: mention it in your pull request.

## Add a block case (a risky command)

1. In the generator, find the `risky` section. Commands are added with `addRisk('<rule>', '<command>')`, for example `addRisk('rm_root_home', 'rm -rf ~/')`.
2. Pick the rule the command belongs to. Use a different spelling of a shape the rule already blocks (other flags, other quoting, a different path); do not invent a rule name.
3. Run the generator, then the test below.

The test checks that the command is blocked and that the matching rule is exactly the one you named.

### A new block case needs a matching rule

A `risky` case is only valid when the check really blocks it. If the command is not blocked yet, the test fails, and the fix is in the rule, not in the corpus:

- Change `packages/zn-gate/lib/destructive.js` and its Python twin `packages/zn-gate-py/src/zn_gate/destructive.py` so they agree. Both run the same corpus.
- Raise the version constants as CONTRIBUTING.md describes in [Changing a rule](../../CONTRIBUTING.md#changing-a-rule).
- Add or update the row in the table of the [destructive commands page](../destructive-commands.md#what-it-blocks) when the shape is new.

The test also expects exactly six rule names in `risky`, so a seventh rule means updating that count in the test as well.

If the shape is one the check should not read, put it in `not_covered` instead, with a short `note` that says why. The test then checks that the command is allowed.

## Run the test

From `packages/zn-gate`:

```bash
node --test test/destructive_command.test.js
```

It checks four things about the corpus:

- the corpus is large enough (at least 300 benign and 200 risky cases);
- no `benign` command is blocked;
- every `risky` command is blocked under its own rule;
- no `not_covered` command is blocked.

The Python package runs the same file. From `packages/zn-gate-py`:

```bash
python -m pytest tests/test_destructive_command.py
```

To see the totals of false positives and misses for the whole corpus, run `node bench/destructive_policy.js` from the repository root.

## Other test lists

The destructive-command corpus is one of several. These are separate:

- `packages/zn-gate/test/fixtures/benign-commands.txt` is one everyday command per line, checked by `test/benign_command_corpus.test.js`. That test expects exactly 200 lines, so adding a line also means changing the count in the test.
- `packages/zn-gate/test/fixtures/benign_phrases.json` holds ordinary sentences for the false-positive gate; see task 6 of [CONTRIBUTING.md](../../CONTRIBUTING.md#where-to-start).
- `packages/zn-gate/test/fixtures/rule_spellings_corpus.json` is generated by `test/fixtures/rule_spellings_gen.py`.

## Next steps

- [Destructive commands](../destructive-commands.md): what the check blocks and how to turn rules on or off.
- [CONTRIBUTING.md](../../CONTRIBUTING.md): pull requests, rule changes and version bumps.
