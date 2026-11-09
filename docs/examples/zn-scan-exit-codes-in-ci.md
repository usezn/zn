# Example: scan exit codes in a CI step

This page shows a CI step that runs `zn-gate scan` and branches on its exit code, in two forms: a GitHub Actions step and a plain shell script. The folders and files in the test runs were made up, and the fake key is the example key from the AWS documentation. For every option of `scan`, see the [command line reference](../cli.md#scan).

## Goal

Make a CI job fail for the right reason: a finding, a scan that could not read everything, or a wrong command each get their own message.

## The exit codes

`zn-gate scan` returns these codes. The source of each one is `handleScan` and `coverageExit` in `packages/zn-gate/bin/cli.js`.

| Code | Meaning | What to do in CI |
|---|---|---|
| `0` | Nothing found, and every file that matched was read. | Pass the step. |
| `1` | Something was found, or the path does not exist. | Fix the lines the scan lists. |
| `2` | The command was used wrongly, for example an unknown `--format`. | Fix the command in the workflow. |
| `3` | No file was read, or a file or folder that should have been read was not. | Fix the cause, or accept the skipped items with `--allow-partial`. |

The command also returns code `3`, and CI must not treat it as a pass: a scan that read nothing or skipped part of the project is not clean. [Exit codes](../exit-codes.md#scan-and-review) and [Scan walkthrough](scan-walkthrough.md#the-four-exit-codes) list the same four codes.

Findings win over skipped files: when something was found the code is `1`, even if some files were skipped.

## Plain shell script

Save this as `scan-check.sh` in your project and run it with `sh scan-check.sh`. It runs the scan on the current folder and branches on the code:

```sh
#!/bin/sh
# Scan the current folder and branch on the exit code of zn-gate scan.
npx -y zn-gate scan .
code=$?

case "$code" in
  0) echo "Scan clean: nothing found, and every file was read." ;;
  1) echo "Scan found something, or the path does not exist. Fix the lines listed above." ; exit 1 ;;
  2) echo "Scan was used wrongly. Check the command, for example the --format value." ; exit 2 ;;
  3) echo "Scan did not read everything. Fix the cause shown above, or use --allow-partial if you accept the skipped items." ; exit 3 ;;
  *) echo "Scan returned an unexpected code: $code" ; exit "$code" ;;
esac
```

`$?` is read on the line right after the scan, before anything else runs, so it holds the scan's own code. If `npx` fails before zn-gate starts (for example when it cannot download the package), it exits with its own non-zero code. A code of `1` would then look like findings, so read the message above the `case` line when a run ends in an unexpected branch.

The scan prints its report first, and the script's own message is the last line. In the test runs the last line of each case was:

```text
Scan clean: nothing found, and every file was read.
```

A folder with a fake key in a `.env` file:

```text
Findings (1):
  [x] .env:1 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]
```

(the lines of the report after the finding are left out here) followed by the summary, and then `Scan found something, or the path does not exist. Fix the lines listed above.` The scan prints the matched value as `[REDACTED_AWS_KEY]`, never the value itself.

A folder with nothing to read (no file that the scan reads) ends with `Audit Result : NOTHING SCANNED` and the script prints `Scan did not read everything. Fix the cause shown above, ...`. This is the case the code `3` exists for: the folder is not clean, it was not checked.

## GitHub Actions step

This job runs the scan on each pull request and turns the code into the job result. The first step keeps the code in an output, and the second step decides, so that the job log shows both:

```yaml
name: zn-gate scan

on:
  pull_request:

permissions:
  contents: read

jobs:
  zn-gate-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Scan the repository
        id: zn
        run: |
          set +e
          npx -y zn-gate scan . --format github
          code=$?
          echo "exit-code=$code" >> "$GITHUB_OUTPUT"
          exit 0
      - name: Act on the exit code
        if: ${{ !cancelled() }}
        env:
          ZN_EXIT_CODE: ${{ steps.zn.outputs.exit-code }}
        run: |
          case "$ZN_EXIT_CODE" in
            0) echo "Scan clean: nothing found, and every file was read." ;;
            1) echo "::error title=zn-gate::Scan found something. Fix the annotated lines." ; exit 1 ;;
            2) echo "::error title=zn-gate::Scan was used wrongly. Check the zn-gate scan line in this workflow." ; exit 1 ;;
            3) echo "::error title=zn-gate::Scan did not read everything. Fix the access problem, or accept the skipped items with --allow-partial." ; exit 1 ;;
            *) echo "::error title=zn-gate::Scan returned an unexpected code: $ZN_EXIT_CODE" ; exit 1 ;;
          esac
```

Notes on the job:

- `set +e` stops GitHub's default shell from ending the step at the first non-zero code, so the code can be read. `exit 0` at the end of the first step lets the second step run.
- `--format github` prints one annotation per finding, on the file and line. The annotation names the rule and the next step, never the matched value. A skipped file or folder is shown as a notice. The job log for a finding looks like this (from the test run):

```text
::error file=.env,line=1,title=Secret found (secret%3Aaws_access_key)::Next: run npx -y zn-gate env shadow .env to move the values into the local vault, and rotate any value that was ever committed or shared.
```

- `if: ${{ !cancelled() }}` makes the second step run after a failed scan, so the message is always shown.
- A pull request that should only report findings, without blocking, is handled in [GitHub Action](../github-action.md#warn-without-failing-the-build), where the action sets `fail-on-threat: 'false'`. In that mode the action's codes stay `0`, so the code check above does not apply there.

## Using the action instead

The [GitHub Action](../github-action.md) runs the same scan and exposes the code as the `scan-exit-code` output, with the same meanings. Use the step above when you want to see the command line in your workflow. [CI step example](ci-step-example.md) shows the action with the audit output.

## When the code is 3

Code `3` comes from two cases: no file was read at all, or a file (2 MiB or larger, for example) or a folder could not be read. In the test run, an empty folder and a folder with one file of 2 MiB or more both ended with `3`. To accept the skipped items, pass `--allow-partial`, for example `npx -y zn-gate scan . --allow-partial`. That exits `0` when nothing was found, but the skipped items are still listed in the report, and it does not help when no file was read at all.

## See also

- [Exit codes](../exit-codes.md): the exit code of every command.
- [Scan walkthrough](scan-walkthrough.md): one scan of an example project, with each code.
- [GitHub Action](../github-action.md): the action inputs and the `scan-exit-code` output.
- [Command line reference](../cli.md#scan): every option of `scan`.
