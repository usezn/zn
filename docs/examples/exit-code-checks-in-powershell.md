# Example: checking zn-gate exit codes in PowerShell

A PowerShell script or a Windows CI job often needs to know how a zn-gate command ended: clean, something found, or the command could not read everything. This page shows how to read the exit code in PowerShell for `check` and `scan`, with what `scan` really prints for each code. The meaning of every code is in [Exit codes](../exit-codes.md); the Windows setup is in the [Windows checklist](windows-checklist.md).

The `scan` outputs below are from real runs of zn-gate on a Linux machine, in a throwaway folder with made-up files; the folder is shown as `~/demo`. The PowerShell lines were not run on that machine (it has no PowerShell), so run them once in your own terminal before you rely on them. Commands are written with `npx -y zn-gate`; if you installed zn-gate, use `zn` instead.

## 1. Where PowerShell keeps the code

After a program like `npx` ends, PowerShell puts its exit code in `$LASTEXITCODE`. Save it on the very next line: the next program you run replaces it.

```powershell
npx -y zn-gate scan .
$code = $LASTEXITCODE
```

Two things that surprise people:

- `try` and `catch` do not catch a non-zero exit code of a program. They catch errors that PowerShell itself raises. Read `$LASTEXITCODE`.
- `$?` only says true or false. It cannot tell `scan` exit `1` (something found) from exit `3` (something was not read), so use the number.

## 2. What `scan` ends with

These are the five endings of `zn-gate scan`, each from a real run. Only the lines that decide the result are shown.

**Exit 0, nothing found.**

```text
Audit Result : PASSED - NO THREATS DETECTED
Files Scanned: 1
Files Skipped: 0
Status       : Clean workspace
```

**Exit 1, something found.** A folder with a made-up key:

```text
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 1
Files Skipped: 0
Status       : Move the secrets out of these files (see "Next" for each one)
```

**Exit 1, the path does not exist.**

```text
Error: Target path does not exist: ~/demo/nope-folder
```

**Exit 3, some files were not read.** A folder with a 2.3 MB JSON file and a `dist` folder:

```text
Audit Result : INCOMPLETE - SOME FILES WERE NOT READ
Files Scanned: 1
Files Skipped: 1 (not read: see below)
Status       : Incomplete: 1 file(s) and 0 folder(s) were not read. Exit code 3; use --allow-partial to accept

Not scanned (1):
  big-export.json (2 MiB or larger)

Directories not scanned (1):
  dist (skipped by name: build output)
```

The same folder with `--allow-partial` printed `PASSED - NO THREATS DETECTED (PARTIAL COVERAGE)` and exited `0`. The list of what was not read is still printed. What is skipped, and why, is described in [`scan` in the command reference](../cli.md#scan).

**Exit 2, the command was used wrongly.** For example, a `--format` that does not exist:

```text
Error: --format for scan must be text, json or github
```

## 3. One `switch` for the four cases

```powershell
npx -y zn-gate scan .
$code = $LASTEXITCODE
switch ($code) {
  0 { Write-Output "scan: clean" }
  1 { Write-Output "scan: something was found, or the path does not exist"; exit 1 }
  2 { Write-Output "scan: the command was used wrongly, fix the line"; exit 2 }
  3 { Write-Output "scan: not everything was read, see the list above"; exit 3 }
  default { Write-Output "scan: could not run (exit $code)"; exit $code }
}
```

`exit` inside a script ends the script with that code, so a CI job sees the same number. Code `3` is not a clean result: fix the cause, or add `--allow-partial` only when you accept the files that were not read.

## 4. `check` and `scan` together

`check` exits `0` only when every agent that is set up is protected, and `1` when one is not, or when no agent is set up. A build machine with no coding agent therefore exits `1`; use `check` on a developer machine, and `scan` in CI.

```powershell
npx -y zn-gate check
$checkCode = $LASTEXITCODE
npx -y zn-gate scan .
$scanCode = $LASTEXITCODE

if ($checkCode -ne 0 -or $scanCode -ne 0) {
  Write-Output "zn-gate: check exit $checkCode, scan exit $scanCode"
  exit 1
}
```

Each code is saved right after its own command. If you only want the worst of the two, replace the last line with `exit ([Math]::Max($checkCode, $scanCode))`.

## 5. In a CI step

- GitHub Actions on `windows-latest` runs `run:` steps in PowerShell. A step ends with the exit code of its last command, so a bare `npx -y zn-gate scan .` fails the job on codes `1`, `2` and `3`. Add the `switch` only when you want a message or a different code.
- PowerShell 7.4 and later can also stop on a failing program: set `$PSNativeCommandUseErrorActionPreference = $true` and `$ErrorActionPreference = 'Stop'`. Then a non-zero exit code raises an error that `try` and `catch` can see. Windows PowerShell 5.1 does not have this.
- To see the reports in the GitHub UI, use the [GitHub Action](../github-action.md) instead of scripting the codes yourself.

## See also

- [Exit codes](../exit-codes.md): every command and every code.
- [Scan walkthrough](scan-walkthrough.md): the first run and each exit code.
- [`scan` in the command reference](../cli.md#scan).
