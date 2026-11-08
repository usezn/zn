# Example: share scan and audit findings with a teammate

You ran `zn-gate scan` or `zn audit` and you want someone else to read the result. Save the output to a file, check the file, then send it. The folder, the files and every value on this page are made up. Run every command in your own terminal, not through your agent.

## Save the scan output

`zn-gate scan` prints the report to standard output, so a shell redirect writes it to a file:

```bash
zn-gate scan . > scan-report.txt
```

Add `--format json` for a file a script can read. Matched values are never printed: the `Line:` row of a finding repeats the line with every matched value replaced, so the value itself is not in the file. What the rest of the report means is explained in the [scan walkthrough](scan-walkthrough.md).

## Save the audit output

`zn-gate audit` writes the report to a file with `--output` (`zn audit` is the same command):

```bash
zn-gate audit --output zn-audit.txt
```

`--format json` is for scripts and `--format sarif` for GitHub code scanning. The report is written so it is safe to share: the `evidence:` line of a finding is the line that matched, cut to 160 characters, with secrets replaced by `[REDACTED:<TYPE>]` and URLs shortened to `scheme://host[:port]`. Every rule and what each fix says is in [audit](../audit.md).

## The weekly report is safe to paste

`zn-gate report` never prints prompts, file contents, folder names or the names of your secrets, and a server is shown only by its name, never by its arguments. Its last line says where it came from: `This report was built from files on your computer. Nothing left it.` You can paste the report into a message as it is. What the numbers mean is in [report](../report.md).

## Check the file before you send it

The reports are written to keep secret values out of them: scan never prints a matched value, and the audit evidence replaces secrets with `[REDACTED:<TYPE>]`. The redaction is not a substitute for a last look. Run a scan on the saved file before you send it: `zn-gate scan` reads a file you name as the path directly, whatever its extension.

```bash
zn-gate scan zn-audit.txt
```

Nothing found exits with code 0. A finding names the file, the line and the rule; remove or fix that line before you send the file.

Two limits, stated on the [audit page](../audit.md), are why this scan is not the whole answer:

- A password written in prose (with password ...) has no format the scrubber recognises, so it is not redacted from the evidence.
- The scrubber finds secrets by format and by sensitive key name. A secret with no known format under an innocent key name is not found.

Read the report yourself before you send it.

## Where to go next

- [audit](../audit.md): what `zn audit` reviews, every rule, and how to read the report.
- [report](../report.md): what the weekly report shows and where its numbers come from.
- [Scan walkthrough](scan-walkthrough.md): run `zn-gate scan` on a small project and read the result, exit codes included.
- [scan](../cli.md#scan) and [audit](../cli.md#audit) in the CLI reference.
