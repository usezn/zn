# Example: zn-gate in a shell script and in a CI job

A short guide to using `zn-gate` from a script or a CI job: which exit code means what, and how to read the JSON output. Paths and text here are fake. For every option and exit code, read the [command line reference](../cli.md). For the GitHub Action, read the [Action page](../github-action.md).

## Exit codes

A script should test the exit code, not search the text. The codes differ a little by command (the tables below come from the [reference](../cli.md#exit-codes)):

| Command | `0` | `1` | `2` |
|---|---|---|---|
| `scan` | nothing found | something found, or the path does not exist | an unknown `--format` |
| `audit` | nothing at or above `--fail-on` | findings at or above it | wrong usage, or a path that is not a folder |
| `analyze` | text allowed | no text given | text blocked |

An empty folder is not an error: `scan` exits `0` and the JSON has a `warning` field ("No files were scanned"), so check that field if an empty result would surprise you.

## Shell script: check a text before using it

`analyze` checks a piece of text for prompt injection, runs locally by default, and prints JSON. The `verdict` field is `allow` or `block`; a block also gives a `reason`. An `allow` can carry an `advisory` (a warning that did not stop anything).

```sh
#!/bin/sh
# Check a text file before it is passed on to an agent.
text=$(cat notes.txt)

result=$(npx -y zn-gate analyze "$text")
code=$?

case "$code" in
  0) echo "allowed" ;;
  1) echo "no text was given" >&2; exit 1 ;;
  2) echo "blocked by zn-gate:" >&2
     echo "$result" >&2
     exit 1 ;;
  *) echo "unexpected exit code $code" >&2; exit 1 ;;
esac
```

For a text that is blocked, the output looks like this (shortened, see [First 5 minutes](../first-5-minutes.md) for a full real output):

```json
{
  "verdict": "block",
  "rule": "...",
  "reason": "Override prior instructions"
}
```

If you have a JSON tool such as `jq`, read a field from `$result`, for example `echo "$result" | jq -r .verdict`. The exit code already tells you the outcome, so the JSON is for the message you show.

## CI job: audit a repository and keep the report

`audit` reviews the agent configs of a folder and runs nothing from it. With `--format json` it prints a report; `--output` writes it to a file. The exit code is `1` when a finding is at or above `--fail-on` (default `high`), so the job fails by itself.

```sh
npx -y zn-gate audit . --format json --output zn-audit.json --fail-on high
```

The report has this shape (shortened, see [audit](../audit.md#json) for the fields):

```json
{
  "version": 1,
  "tool": "zn-gate",
  "findings": [
    {
      "id": "ZNA007",
      "severity": "critical",
      "file": ".claude/settings.json",
      "line": 4,
      "title": "Model API endpoint overridden by the project"
    }
  ],
  "summary": {
    "files": 3,
    "findings": 1,
    "failOn": "high",
    "failed": true
  }
}
```

- `findings` lists each problem with its rule `id`, `severity`, `file` and `line`.
- `summary.findings` is the count, `summary.failOn` the threshold, and `summary.failed` says whether the exit code is `1`.
- `summary.agentStatus` says which agents had files to check, so a missing location is not mistaken for a clean result.

Keep `zn-audit.json` as a build artifact of your CI system if you want to read it after a failed run.

### With the GitHub Action

On GitHub, the [Action](../github-action.md) does the same without a script. It sets `audit-exit-code` (`0` clean, `1` findings at or above the threshold, `2` error) and `scan-exit-code`. With `fail-on-threat: 'false'` the exit codes stay `0`, so do not use them to detect findings in that mode.

## Related

- [Command line reference](../cli.md): every command, option and exit code.
- [GitHub Action](../github-action.md): inputs, outputs and permissions.
- [audit](../audit.md): every audit rule and the JSON report.
