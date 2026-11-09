# Scan a single file

`zn-gate scan [path]` takes any path, and the path can be one file instead of a folder. This page scans one file and reads the result. The file and every value in it are made up. Every option is described in [scan](../cli.md#scan).

Run every command in your own terminal, not through your agent.

## The example file

One file named `notes.md` in the current folder. It keeps a made-up credential in plain text, the kind of line `scan` looks for:

```text
# demo notes

aws_access_key_id = AKIAIOSFODNN7EXAMPLE
region = eu-west-1
```

## Run the scan

Pass the file to `scan`:

```bash
zn-gate scan notes.md
```

Only this file is read: the report counts `Files Scanned: 1`, and nothing else in the folder is looked at.

The report (example output):

```text
Findings (1):
  ✖ notes.md:3 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: aws_access_key_id = [REDACTED_AWS_KEY]
    Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.

-----------------------------------------------------------------------------
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 1
Files Skipped: 0
Status       : Move the secrets out of these files (see "Next" for each one)
-----------------------------------------------------------------------------
```

How to read it:

- `Findings (1):` lists what was found, one block per finding: the file and the line, `Secret found`, the rule and the reason.
- The `Line:` row repeats the line with every matched value replaced, so the value itself is never printed.
- `Next:` says what to do with this finding.
- The block at the end counts what was scanned. Only one file was given, so `Files Scanned` is `1`.

Because something was found, this run exits with `1`.

## A clean file

The same command on a file with nothing to find, `plan.md`:

```text
meeting notes

Nothing secret here, just a plan for the demo website.
```

```bash
zn-gate scan plan.md
```

```text
-----------------------------------------------------------------------------
Audit Result : PASSED - NO THREATS DETECTED
Files Scanned: 1
Files Skipped: 0
Status       : Clean workspace
-----------------------------------------------------------------------------
```

Nothing was found and the file was read, so this run exits with `0`.

## A file that does not exist

A path that does not exist is not a clean result: `scan` prints `Error: Target path does not exist` followed by the full path, and exits with `1`.

## A file with any extension

A file found while walking a folder is scanned when its extension is one of the scanned ones (see [scan](../cli.md#scan)). The file you name is read whatever its extension: `zn-gate scan photo.jpg` reads `photo.jpg` even though `.jpg` is not a scanned extension, and reports the key inside it the same way.

## Where to go next

- [Scan walkthrough](scan-walkthrough.md): a whole example project, the four exit codes and `--format github` for CI.
- [scan](../cli.md#scan), the reference with every option.
