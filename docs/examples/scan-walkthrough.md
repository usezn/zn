# Scan walkthrough: run `scan` and read the result

This page runs `zn-gate scan` on a small example project and reads the result: the text report, the four exit codes and `--format github` for CI. The folder, the files and every value in them are made up. Every option is described in [scan](../cli.md#scan).

Run every command in your own terminal, not through your agent.

## The example project

A folder named `example-project` with two files:

```text
example-project/
  README.md
  settings.txt
```

`README.md` is ordinary text:

```markdown
# example-project

A small demo website.
```

`settings.txt` keeps a made-up credential in plain text, the kind of line `scan` looks for:

```text
# deploy settings
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
region = eu-west-1
```

## Run the scan

From inside the folder:

```bash
cd example-project
zn-gate scan .
```

`scan` looks through prompt templates, markdown, skills and configs for injection traps and secrets. `path` defaults to the current folder, so `.` scans the folder you are in. Matched values are never printed.

The text report for this folder (example output):

```text
Findings (1):
  ✖ settings.txt:2 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: aws_access_key_id = [REDACTED_AWS_KEY]
    Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.

-----------------------------------------------------------------------------
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 2
Files Skipped: 0
Status       : Move the secrets out of these files (see "Next" for each one)
-----------------------------------------------------------------------------
```

How to read it:

- `Findings (1):` lists what was found, one block per finding: the file and the line, whether it is a `Threat` (an injection trap) or a `Secret found`, the rule and the reason.
- The `Line:` row repeats the line with every matched value replaced, so the value itself is never printed.
- `Next:` says what to do with this finding.
- The block at the end counts what was scanned and skipped. `Audit Result` says `FAILED - ...` when something was found, `PASSED - NO THREATS DETECTED` when nothing was found and everything was read.

Because something was found, this run exits with `1`.

## The four exit codes

| Code | Meaning |
|---|---|
| `0` | Nothing found and everything that matched was read. |
| `1` | Something was found, or the path does not exist. |
| `2` | An unknown `--format`. |
| `3` | The coverage is incomplete: no file was read, or a file or folder that should have been read was not. |

Findings win: when something was found the exit code is `1`, whether or not anything was skipped. One example per code, with `$?` read on the same line:

Exit `1` — the first scan above found the fake key:

```bash
zn-gate scan .; echo $?
```

Exit `0` — after the key line is removed from `settings.txt`, nothing is found and both files were read:

```bash
zn-gate scan .; echo $?
```

Exit `2` — `yaml` is not a format `scan` knows. The formats are `text`, `json` and `github`:

```bash
zn-gate scan --format yaml; echo $?
```

Exit `3` — a folder with nothing to scan: no file was read at all, so this is not a clean result even though nothing was found. The text report shows `NOTHING SCANNED` instead of `PASSED` (example output):

```bash
zn-gate scan empty-folder; echo $?
```

```text
! No files were scanned in empty-folder

-----------------------------------------------------------------------------
Audit Result : NOTHING SCANNED
Files Scanned: 0
Files Skipped: 0
Status       : No files were read: this is not a clean result
-----------------------------------------------------------------------------
```

`echo $?` prints `3`.

Two options change the exit code:

- `--allow-partial` exits `0` even when some files or folders were not read; they are still listed in the report. It does not apply when no file was read at all. In the Node version, put the path before the options (`scan ./docs --allow-partial`); `scan --allow-partial ./docs` scans the current folder.
- The Python package also has `--no-fail`, which always exits `0`.

## `--format github` for CI

`--format github` prints workflow annotations instead of the text report, so findings show up next to the code in the CI job log:

```bash
zn-gate scan . --format github
```

Example output for the folder with the fake key:

```text
::error file=settings.txt,line=2,title=Secret found (secret:aws_access_key)::Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.

[zn-gate] Scanned 2 files (0 not scanned). Found 1 secrets and 0 security threats.
```

Each finding becomes one `::error` annotation with the file, the line and the rule. Files and folders that were not read become `::notice` annotations. As in the text report, no value is printed.

## Directories not scanned

A scan never reports a clean result for something it could not read. A folder it cannot open is listed at the end of the text report (example output):

```text
Directories not scanned (1):
  old-archive (cannot be read)
```

The scan still reads every other file, but the coverage is now incomplete: with nothing else wrong the exit code is `3`, so a CI job cannot pass on a scan that missed part of the folder. With a finding the exit code is `1`. With `--allow-partial` the exit code is `0` and the folder is still listed.

The same folders appear as `skipped_dirs` in `--format json` and as `::notice` annotations in `--format github`.

Two things do not belong in that list:

- Folders skipped by name, such as `node_modules`, do not count and are not listed.
- Files that were not read (2 MiB or larger, cannot be read, not a regular file, or a binary `.key` file) are listed under `Not scanned` instead.

Links found inside the folder are not followed and are not listed.

## Where to go next

- [Scan a single file](scan-a-single-file.md), one file instead of a folder
- [scan](../cli.md#scan), the reference with every option
- [First project walkthrough](first-project-walkthrough.md), one small example project from install to removal
