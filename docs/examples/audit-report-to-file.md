# Save an audit report to a file and compare two runs

By default `zn audit` writes its report to the screen. With `--output` it writes the report to a file instead, in the format you pick. This page saves the report of a repository before and after a change, and compares the two files.

What the report contains and what every rule looks for is in [audit](../audit.md); the options are in [cli](../cli.md#audit). All file names and values here are made up.

Run every command in your own terminal, not through your agent. `audit` only reads files: it runs nothing from the repository and sends nothing anywhere.

## Write the report to a file

From the folder you want to review (a bare `zn audit` reviews the current directory, and `zn-gate audit` is the same command):

```bash
zn audit --format text --output zn-audit.txt
```

The file holds the same report the screen would show. If nothing is written, the command exits with `2`: the option is wrong, the path was not found, or the output file cannot be written.

## The three formats

`--format` picks how the findings are written. [The audit page](../audit.md#formats-of-zn-audit-and-zn-scan) lists the same three for `zn audit`:

| `--format` | When to use | Who reads it |
|---|---|---|
| `text` (default) | A local review before you open the repository | People |
| `json` | Findings consumed by a script or another tool | Scripts and tools |
| `sarif` | Findings uploaded to GitHub code scanning | GitHub code scanning: one alert per finding under Security > Code scanning |

One command for each:

```bash
# text, for people (the default)
zn audit --format text --output zn-audit.txt

# json, for scripts
zn audit --format json --output zn-audit.json

# sarif, for GitHub code scanning
zn audit --format sarif --output zn-audit.sarif
```

Two notes for CI, from [the audit page](../audit.md#sarif): findings from `--include-home` are marked with a `HOME` base that GitHub ignores, so keep that flag off in CI. [The GitHub Action](../github-action.md) takes the same formats in its `format` input, and a job that should only report, never fail, runs the audit with `--fail-on none`.

## What the JSON report contains

The JSON report is the one made for scripts and tools, so it is also the easiest one to compare later. The full example is in [the audit page](../audit.md#json). The parts the comparison below uses:

- `tool` and `toolVersion`: the version that made the report.
- `root`: the directory that was audited.
- `findings`: one object per finding, with its rule `id`, `severity`, `agent`, `file`, `line`, `title`, `detail`, `evidence`, `fix` and `references`.
- `summary`: the counts by severity, the `failOn` threshold, whether the run `failed`, and `agentStatus`, which says for each agent how many files were read and whether anything was checked.

## Compare two runs

Save the report before the change. `--fail-on none` never fails, so the command exits `0` whatever it finds:

```bash
zn audit --format json --output zn-audit-before.json --fail-on none
```

Make your change to the repository — remove a hook, pin a package, move a setting to your user config — and save the report again:

```bash
zn audit --format json --output zn-audit-after.json --fail-on none
```

Then compare the two files with any tool that shows the difference between two files, for example `diff`:

```bash
diff zn-audit-before.json zn-audit-after.json
```

Each finding carries its rule `id`, its `file` and its `line`, so the diff shows exactly which findings appeared and which went away. Rule ids are stable — a rule may get better, but its id never changes meaning — so two runs made with different zn-gate versions can still be compared. Which version made a report: the first line of a text report names it in parentheses, and the JSON report has it under `toolVersion`.

Text reports can be diffed the same way.

## If the file was not written

- Exit code `2`: the audit did not run. The option is wrong, the path was not found, or the output file cannot be written.
- Exit code `1`: a finding met `--fail-on`. Run the same command with `--fail-on none` to get the report without failing.

## Where to go next

- [audit](../audit.md), the report formats and every rule
- [audit-before-adding-a-repo.md](audit-before-adding-a-repo.md), reading a report and deciding what to do
- [ci-step-example.md](ci-step-example.md), the same audit as a pull request check
- [cli](../cli.md#audit), the options
