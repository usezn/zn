# Example: reading a scan finding in JSON

[The scan walkthrough](scan-walkthrough.md) explains the text report. This page
explains the fields of a finding in `--format json` and in `--format github`,
which scripts and CI jobs read. The finding is one fake key, and every value
here is made up. The key is the example key from AWS's own documentation.

## The project

A folder called `fixture` with one file, `notes.md`. Line 2 of the file is:

```text
Deploy key for the demo: AKIAIOSFODNN7EXAMPLE
```

## The JSON report

Run this from the folder that contains `fixture`:

```sh
zn-gate scan fixture --format json
```

Output:

```json
{
  "total_files": 1,
  "total_skipped": 0,
  "total_skipped_dirs": 0,
  "total_threats": 1,
  "total_secrets": 1,
  "incomplete": false,
  "threats": [
    {
      "file": "fixture/notes.md",
      "line": 2,
      "rule": "secret:aws_access_key",
      "reason": "Exposed credential detected by DLP filter",
      "type": "secret_leak",
      "content": "Deploy key for the demo: [REDACTED_AWS_KEY]",
      "next_step": "Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared."
    }
  ],
  "skipped": [],
  "skipped_dirs": []
}
```

The command exits with `1` because it found something. A clean scan exits with `0`.

## The summary fields

| Field | Meaning |
|---|---|
| `total_files` | Files that were read |
| `total_skipped` | Files that were not read |
| `total_skipped_dirs` | Folders that were not read |
| `total_threats` | All findings, secrets included |
| `total_secrets` | Findings that are leaked secrets |
| `incomplete` | `true` when something that should have been read was not. The exit code is then `3`, unless you pass `--allow-partial`. |
| `skipped` | Each unread file, with its `file` and a `reason` |
| `skipped_dirs` | Each unread folder, with its `dir` and a `reason` |

If no file was read at all, the report also has a `warning` field.

## The fields of one finding

Each entry in `threats` is one finding. The text report shows the same
information under other labels:

| JSON field | Text report label | Meaning |
|---|---|---|
| `file` | the path before `:2` | The file, as the scan printed it |
| `line` | the number after the colon | The line where the finding is |
| `type` | `Secret found` or `Threat` | `secret_leak` for a leaked secret. Other findings have another type. |
| `rule` | `Rule:` | The rule that matched. The part before the colon is the kind of rule (`secret`); the rest names the kind of credential (`aws_access_key`). |
| `reason` | the text in brackets after the rule | A short reason for the rule |
| `content` | `Line:` | The line, with every matched value replaced by a placeholder such as `[REDACTED_AWS_KEY]`. The value itself is never in the report. |
| `next_step` | `Next:` | What to do. It is present only when zn has a suggestion. |

## The GitHub format

`--format github` prints one annotation per finding, and GitHub shows it on
the file and line in the CI run:

```text
::error file=fixture/notes.md,line=2,title=Secret found (secret%3Aaws_access_key)::Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.

[zn-gate] Scanned 1 files (0 not scanned). Found 1 secrets and 0 security threats.
```

- `file` and `line` give the location.
- `title` gives the kind of finding and its rule. The rule is URL-encoded, so
  the colon in `secret:aws_access_key` shows as `%3A`.
- The text after `::` is the `next_step`.
- The last line is the summary, the same counts as the JSON summary.

## Next steps

- Move the value into the vault with `zn-gate secret set NAME`, and put the
  marker in its place. [The secrets guide](../secrets.md) shows how.
- Rotate the key if it was ever committed, pushed or shared.
- For every option of `scan`, see [the CLI reference](../cli.md#scan).
