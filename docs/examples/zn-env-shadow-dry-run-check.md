# Example: checking a `.env` file with `env shadow --dry-run`

`zn-gate env shadow --dry-run` lists what `env shadow` would move into the vault, and changes nothing. This page runs it on a fake `.env` file before and after a shadow step, so you can see what each line of the output means. All names and values are made up.

## 1. Run it in a terminal window

`env shadow` needs an interactive terminal, and `--dry-run` does not change that. Run the check yourself in a terminal window. An AI agent is refused, even with `--dry-run`:

```text
zn env: Not allowed: zn env shadow must be run by you in your own terminal, not by an AI agent (detected CLAUDECODE).
```

The text after `(detected` names the agent environment that zn found. Without a terminal, for example in a script, the command refuses with a different sentence:

```text
zn env: Not allowed: zn env shadow needs an interactive terminal. Open a terminal window yourself and run it there.
```

Both refusals exit with code `77`.

## 2. The starting file

Say the `.env` file of a project holds these two lines:

```text
API_KEY=example-not-a-real-key
APP_NAME=demo
```

## 3. Dry run before the shadow step

```bash
npx -y zn-gate env shadow .env --dry-run
```

Only the names that look sensitive are listed. `API_KEY` contains `KEY`, so zn would move it. `APP_NAME` does not look sensitive, so it is not listed at all. The output is:

```text
  API_KEY -> __ZN_API_KEY__
```

Read the line as "this value would move, and the file would hold this marker in its place". The marker has the form `__ZN_<NAME>__`. The command exits with code `0`, and the file is unchanged. Check it with `cat .env`: it still shows the two original lines.

## 4. Dry run with every value and a short value

Add `--all` to list every value, not only the sensitive names:

```bash
npx -y zn-gate env shadow .env --dry-run --all
```

Now `APP_NAME` is listed too. Its value is only four characters long, and zn moves only values of eight characters or more, so it is skipped and stays in clear text:

```text
  API_KEY -> __ZN_API_KEY__
  skipped APP_NAME: stays in clear text in the file. The value is only 4 character(s), and zn moves values of 8 or more because shorter ones cannot be told apart from ordinary settings. To keep it out of the file, run `zn secret set APP_NAME` and put __ZN_APP_NAME__ in its place.
Preview only: no value has moved. If you run this without --dry-run, 1 value(s) would stay in clear text in .env: APP_NAME. Until each one is stored with `zn secret set`, treat it as readable by an agent.
```

The `skipped` lines explain each value that stays in the file. A preview line never means that anything was changed.

## 5. Dry run after the shadow step

After a real `env shadow` run (see [the round trip example](env-file-round-trip.md)), the file holds markers instead of the values. Here is a file in that state, with the sensitive value replaced by its marker:

```text
API_KEY=__ZN_API_KEY__
APP_NAME=demo
```

Run the same check again:

```bash
npx -y zn-gate env shadow .env --dry-run
```

There is nothing left to move, so the output is:

```text
.env: nothing to shadow (already shadowed)
```

If the output also has `skipped` lines after this sentence, some sensitive values are still in clear text. The `(already shadowed)` part does not mean that every value is protected. Read the `skipped` lines before you decide that the file is clean.

## 6. Exit codes

| Exit code | Meaning in this check |
|---|---|
| `0` | The preview ran. This includes the cases where nothing needed to move. |
| `1` | The file could not be read, for example because it does not exist. The message names the path. |
| `77` | You are an AI agent, or there is no interactive terminal. Nothing was changed. |

## Where to read more

- [`env shadow`](../cli.md#env-shadow) in the command line reference, with every option
- [Move a `.env` file into the vault and back](env-file-round-trip.md), the next step after a dry run
- [Move your `.env` values into the vault](../secrets.md#2-move-your-env-values-into-the-vault)
