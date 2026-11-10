# Compare two scan runs

`zn-gate scan` has no baseline file and no list of accepted findings. Every run reports every finding it still reads, so a second run does not hide the first one's results. To see what changed between two runs, save the JSON output of each run and compare the two files with `diff`. Every value in this page is made up. The option list is in [scan](../cli.md#scan).

Run the commands in your own terminal, not through your agent.

## Save the first run

From the folder you want to check, write the JSON output of `scan` to a file:

```bash
zn-gate scan --format json > scan-before.json
```

The file is one JSON object. These keys matter for a comparison:

- `total_threats` and `total_secrets`: the number of findings, and how many of them are secrets.
- `threats`: one entry per finding, with `file`, `line`, `rule`, `reason` and `type`.
- `skipped` and `skipped_dirs`: the files and folders the scan could not read.
- `incomplete`: `true` when something that should have been read was not.

## Change something, then save the second run

Fix the finding, or remove the file, then run the scan again with the same folder and the same path argument:

```bash
zn-gate scan --format json > scan-after.json
```

The first file now sits in the folder, so the second run counts it as one more file: `total_files` is one higher. Save the files outside the folder, or ignore that line in the diff. Keep the path argument the same in both runs. If it changes, the file names in the two files change too, and `diff` shows every finding as changed.

## Compare the two files

On macOS or Linux:

```bash
diff scan-before.json scan-after.json
```

On Windows, in Command Prompt:

```text
fc scan-before.json scan-after.json
```

A line that starts with `<` is in the first file only, so the finding is gone in the second run. A line that starts with `>` is in the second file only, so it is new. Lines with no mark are the same in both runs.

A finding that moved to another line shows up as two lines in the diff: the old `"line"` value with `<`, and the new one with `>`.

Do not commit the two files to your repository. They list where the findings are, with a redacted copy of each matching line.

## Check the exit code too

The exit code tells you more than the diff does:

- `0`: nothing was found, and everything that matched was read.
- `1`: something was found.
- `2`: the command was used wrongly, for example with an unknown `--format`.
- `3`: the coverage is incomplete. No file was read, or a file or folder that should have been read was not.

Exit code `3` means a clean diff does not prove the folder is clean. Look at the `skipped` and `skipped_dirs` lists first. In a script, check the exit code of each run, for example with `zn-gate scan --format json > scan-after.json` followed by a test of `$?` on POSIX shells.

## Related

- [Scan a single file](scan-a-single-file.md)
- [Scan walkthrough](scan-walkthrough.md)
- [scan in the command reference](../cli.md#scan)
