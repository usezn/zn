# Example: running `reach --remember` twice

`zn-gate reach --remember` keeps the counts of one run, so that the next run in the same folder can show them next to the new ones. This page runs it several times on one fake project and shows what changes in the output between runs, and what does not. The options are on the [reach page](../reach.md#--remember) and in the [CLI page](../cli.md#reach).

The output below is from real runs on a fake project in a throwaway home folder, shown as `~`. The project, `my-app`, has a `.env` file with two made-up secrets. The home folder has a made-up AWS credentials file and a Claude Code settings file, with zn not set up for it. To keep the page short, only the lines that carry a finding or a count are shown; the full report is the one on the [reach page](../reach.md#example-output).

## Run 1: nothing to compare with

```bash
zn-gate reach ./my-app --remember
```

```text
  HIGH   Claude Code is on this machine and zn does not protect it
  HIGH   .env in this folder has 2 secrets (OPENAI_API_KEY, DATABASE_URL)
  MEDIUM 1 credential file in your home folder (~/.aws/credentials)
2 high, 1 medium, 0 low.
```

The last line is the count. There is no earlier run in this folder, so there is nothing after it. reach wrote one file, `~/.zn/reach-last.json`:

```text
{"fdced4eec1c31ce427f87bed4b2c94f9":{"high":2,"medium":1,"low":0,"at":"2026-11-11"}}
```

The key is a hash of the absolute folder path, cut to 32 characters, so the file holds no path, file name or value.

## Run 2: nothing changed

Same command again:

```text
2 high, 1 medium, 0 low (last time, 2026-11-11: 2 high, 1 medium, 0 low).
```

Now the count line ends with the counts of run 1. Nothing changed, so both are the same.

## Run 3: one secret removed from `.env`

`DATABASE_URL` was deleted from the `.env` file and the command run again. The finding changed, but the count did not:

```text
  HIGH   .env in this folder has 1 secret (OPENAI_API_KEY)
2 high, 1 medium, 0 low (last time, 2026-11-11: 2 high, 1 medium, 0 low).
```

The counts are the number of findings, not of secrets. The `.env` file is one finding whether it holds two secrets or one, so the line of the last time and the line of this time are equal. What changed is in the text of the finding, and the memory does not keep that.

## Run 4: the `.env` file deleted

With the file gone, the finding for it is gone and the count moves:

```text
  HIGH   Claude Code is on this machine and zn does not protect it
  MEDIUM 1 credential file in your home folder (~/.aws/credentials)
1 high, 1 medium, 0 low (last time, 2026-11-11: 2 high, 1 medium, 0 low).
```

The exit code was 0, because `--fail-on` is `none` by default and the report only reports. What you read here is the difference: one high finding fewer than last time.

## Run 5: the same in JSON

With `--json`, the earlier counts are in the key `previous`:

```bash
zn-gate reach ./my-app --remember --json
```

Two keys of the JSON object, copied out of it:

```text
"counts":   {"high":1,"medium":1,"low":0,"info":0}
"previous": {"high":1,"medium":1,"low":0,"at":"2026-11-11"}
```

`previous` holds the counts of run 4, which that run had written. It has no `info` count; `counts` does. After this run, the memory file held the counts of this run only, in one entry: each `--remember` run replaces the entry of its folder.

## What the memory does and does not do

- Without `--remember`, reach shows no earlier counts. A run without the option ended with the plain count line, with no "last time" part. The reach page says it writes no file either.
- A folder that was never run with `--remember` has no earlier run. With `--json`, `previous` is `null` in that case, as it was for a second folder, `other-app`, that held a copy of the `.env` file.
- The comparison is by folder. The memory file has one entry for each folder you ran it in, so another folder starts from nothing.
- `--fail-on high` makes the exit code 1 when a high finding is present. In the run with `--fail-on high` and no `--remember`, the exit code was 1 with one high finding, the same count as the run before.

## Related

- [What `--remember` stores](../reach.md#--remember)
- [Write the reach report to a file in CI](reach-report-file.md)
- [Read a reach history report](reading-a-reach-history-report.md)
