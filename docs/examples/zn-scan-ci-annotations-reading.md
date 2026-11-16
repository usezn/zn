# Example: read the GitHub annotations of `scan --format github`

In a CI job, `zn-gate scan` can print its findings as GitHub annotations: one line per finding that GitHub shows on the file and line in the run. This page reads those lines one part at a time, from a folder with made-up files. For the whole job, see [Fail a CI job when `scan` finds a secret](ci-secret-scan-gate.md). For every option, see [scan](../cli.md#scan).

## Where the annotations come from

Two ways print them, and both print the same lines:

- The [zn-gate GitHub Action](../github-action.md) prints them by default (`format: github`).
- The command line prints them with `--format github`:

```bash
npx -y zn-gate scan . --format github
```

The scan does not print a matched value in this format. A CI log can be public, so a line holds only the rule, the reason and the place.

## The example folder

```text
app/
  settings.txt        line 2 holds a made-up key
  fixtures/
    sample.txt        line 2 holds the same made-up key
  big.md              a file of 3 MiB
```

`settings.txt` and `fixtures/sample.txt` both have this second line (the key is the example key from AWS's own documentation):

```text
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
```

## What the job prints

Run from inside `app`, the scan prints this (real output) and exits with `1`:

```text
::error file=fixtures/sample.txt,line=2,title=Secret found (secret%3Aaws_access_key)::Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.
::error file=settings.txt,line=2,title=Secret found (secret%3Aaws_access_key)::Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.
::notice file=big.md,title=Not scanned::2 MiB or larger

[zn-gate] Scanned 3 files (1 not scanned). Found 2 secrets and 0 security threats.
```

## Reading one line

Take the first line:

```text
::error file=settings.txt,line=2,title=Secret found (secret%3Aaws_access_key)::Next: run ...
```

| Part | What it means |
|---|---|
| `::error` | The level. A finding is always an `error`. GitHub shows it in red. |
| `file=settings.txt` | The file, relative to the folder you scanned. GitHub puts the annotation on this file. |
| `line=2` | The line in that file. |
| `title=Secret found (secret%3Aaws_access_key)` | What was found, and the rule that matched. The rule `secret:aws_access_key` shows with `%3A` for the colon: the scan escapes a colon or a comma in the file and the title. |
| `::Next: run ...` | The message. For a secret it is what to do: store the value in the vault, put the marker in its place, and rotate the value if it was ever committed or shared. |

A finding that is not a secret has the title `Security Threat (<rule>)`, and its message is the reason for the rule instead of a next step.

A key in an MCP server config has the rule `secret:mcp_config`, and a longer message that names the variable, for example `SEARCH_API_KEY`. The value is still not printed:

```text
::error file=.mcp.json,line=6,title=Secret found (secret%3Amcp_config)::Next: run npx -y zn-gate secret set SEARCH_API_KEY to store the value in the local vault ...
```

## The other levels

The scan also reports what it did not read, so a quiet result is never taken for a clean one:

| Line | Level | What it means |
|---|---|---|
| `::notice file=big.md,title=Not scanned::2 MiB or larger` | `notice` | A file was skipped, and the message says why. |
| `::notice file=locked,title=Directory not scanned::cannot be read` | `notice` | A folder could not be opened. |
| `::warning title=Nothing scanned::No files were scanned in .` | `warning` | No file was read at all. The exit code is `3`. |
| `::warning title=Incomplete scan::0 file(s) and 1 folder(s) were not read: exit code 3, use --allow-partial to accept` | `warning` | Nothing was found, but part of the folder was not read. |

The last two are real output of a folder with no readable file. The last line, `[zn-gate] Scanned 3 files (1 not scanned). Found 2 secrets and 0 security threats.`, is not an annotation: it is the summary in the log.

The exit code decides whether the job fails. Findings give `1`, even when a notice is printed too. A skipped file or folder with no finding gives `3`, and the job fails unless you add `--allow-partial`. The [exit codes](../cli.md#scan) are listed with the command.

GitHub shows at most 10 error annotations and 10 warning annotations per step. With more findings, open the log of the run to see them all (see [the Action page](../github-action.md#reading-the-result)).

## Silence a fixture

A test fixture may hold a fake key on purpose. `--exclude` skips a folder by name wherever it appears, and what it skips is not reported:

```bash
npx -y zn-gate scan . --exclude fixtures --format github
```

```text
::error file=settings.txt,line=2,title=Secret found (secret%3Aaws_access_key)::Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.
::notice file=big.md,title=Not scanned::2 MiB or larger

[zn-gate] Scanned 2 files (1 not scanned). Found 1 secrets and 0 security threats.
```

The finding in `fixtures/sample.txt` is gone, and the one in `settings.txt` stays. `--exclude` works on folder names, not on single lines or files, so keep fixtures in their own folder. The GitHub Action has no input for it: to use `--exclude`, run the command in a step as in the [`npx` job](ci-secret-scan-gate.md#the-plain-npx-way). To accept skipped files, add `--allow-partial` after the path.

## Where to go next

- [Fail a CI job when `scan` finds a secret](ci-secret-scan-gate.md), the full job and the exit codes
- [Read a scan finding in JSON](reading-a-scan-finding.md), the same fields as JSON
- [GitHub Action](../github-action.md), every input and output
