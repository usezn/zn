# Example: read an audit SARIF file in your editor

A short walk-through of opening the SARIF file that [`zn-gate audit`](../audit.md#sarif) writes, on your own computer, before you upload it anywhere. For the full format, read the [audit page](../audit.md#sarif); for the command flags, see the [command line reference](../cli.md#audit).

Everything in this example is made up, and it sends nothing: `audit` runs on your machine and reads the files of the folder you give it.

## 1. Write the file

In your own terminal, from the top folder of the repository:

```bash
npx -y zn-gate audit . --format sarif --output zn-audit.sarif --fail-on none
```

- `--format sarif` writes SARIF 2.1.0, the standard JSON format for findings.
- `--output zn-audit.sarif` writes the file to that name in the current folder.
- `--fail-on none` makes the command exit `0` even when it finds something. Leave it out if you want the exit code to tell you that a finding was above the threshold (the default is `high`).

The `scan` command has no SARIF output. Its formats are `text`, `json` and `github`. For SARIF, use `audit`, or [`reach`](../reach.md#sarif-and-ci) with `--sarif`.

## 2. Open the file

SARIF is plain JSON, so any editor opens it. It is much easier to read with a viewer. Many editors have an extension that lists the results, jumps to the line, and shows the rule text. For example, in Visual Studio Code you can install the "SARIF Viewer" extension, then open `zn-audit.sarif` and use its results list. zn-gate does not depend on any editor or extension, and we have not checked every SARIF viewer. Any tool that reads SARIF 2.1.0 works.

If you have no viewer, open the file as text. Each finding is an object in `runs[0].results`, with a `ruleId` (for example `ZNA007`), a `message`, and a `locations` entry with the file.

## 3. Read one result

A result from `audit` has these parts:

| Field | What it holds | Where to look |
|---|---|---|
| `ruleId` | The rule, such as `ZNA007`. The id never changes meaning. | [Rules](../audit.md#rules) |
| `level` and the rule's `security-severity` | How serious the finding is. | Same page, the severity list |
| `message.text` | What is wrong in the file, in one sentence. | The "detail" line of the text report |
| `locations[0].physicalLocation` | The file and line. The path is relative to the repository root. | Open it in the editor |

To check a result, you can run `npx -y zn-gate audit . --format text` in the same folder and find the same rule id and file in the text report. The [audit page](../audit.md#how-to-read-the-output) explains each part of that report.

## 4. Decide what to do

Open the file at the line the result names, and check it against the `fix` text in the [audit page](../audit.md#how-to-read-the-output). Then:

- If the setting is one you did not expect, remove it from the project and run the audit again.
- If the setting is yours and on purpose, you can keep it. Fix the file only when you have decided the finding does not apply.
- Do not commit the SARIF file. It describes your repository's weak points. Keep it on your computer, or upload it only where you intend to, as in the [GitHub Action](../github-action.md) example.

## 5. Clean up

Delete the file when you have finished, so that an old report does not stay in the folder:

```bash
rm zn-audit.sarif
```

On Windows PowerShell, use `Remove-Item zn-audit.sarif`.
