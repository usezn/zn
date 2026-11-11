# Example: export the decision log for an incident review

You need to hand the record of what zn-gate decided to someone else, for example after an agent did something unexpected. This page shows the order to work in: check the log first, then export it, then read the fields and narrow it to the time window you need. All values below are made up. For every option, see the [command line reference](../cli.md#evidence).

The log is a file on your computer (`evidence.jsonl` in the `.zn` folder, see [files and folders](../files-and-folders.md)). Nothing is sent anywhere.

## 1. Check the log first

```bash
zn-gate evidence --verify
```

Read the `Integrity` line:

- `ALL SHA-256 HASHES VERIFIED` means every record matches the fingerprint of the one before it. The command exits with `0`.
- `TAMPER DETECTED AT RECORD <n>` means a record was changed, removed or cut short. The command exits with `1`, and the `Details` line names the first record that does not fit.

If the check fails, do not treat the export as a clean copy. Keep the file as it is and read [the verify example for a damaged log](evidence-verify-after-restore.md).

## 2. Export the records

Export a copy in CSV, which opens in a spreadsheet, and in JSON lines, which keeps every field:

```bash
zn-gate evidence --export --format csv --output incident-evidence.csv
zn-gate evidence --export --format jsonl --output incident-evidence.jsonl
```

Leave out `--output` to print the records on the screen, or send them to a file with `>`:

```bash
zn-gate evidence --export --format jsonl > incident-evidence.jsonl
```

When you use `--output`, the export prints one line that ends with the integrity of the log it read:

```text
Exported 2 audit records to incident-evidence.csv (Integrity: VALID).
```

Check that line. If it says `(Integrity: TAMPERED)`, the export still wrote the file, and the command still exits with `0`. Treat that copy as altered, and check the `Integrity` line of step 1 again before you rely on it. When you export to the screen or to `>`, a tampered log prints `Tamper detected:` on the error output and the records on the normal output.

An unknown `--format` value (anything other than `csv` or `jsonl`) stops the export with exit code `2` and writes nothing.

## 3. What the fields mean

Both formats hold one record per decision, in the order they were written.

| Field | What it holds |
|---|---|
| `timestamp` | When zn-gate recorded the decision, in UTC (for example `2026-11-11T12:15:59.350Z`). |
| `verdict` | What zn-gate decided, for example `block` or `allow`. |
| `phase` | Where the decision was taken, for example `tool-call`. |
| `tool_name` | The tool the agent tried to use, for example `bash` or `read`. |
| `agent_environment` | The agent that asked, for example `claude-code`. |
| `rule` | The rule that decided, when one did. Empty when none did. |
| `reason` | The short reason recorded for the rule. Empty when none was recorded. |
| `payload_sha256` | The SHA-256 fingerprint of what the tool call carried. It lets you compare two records without the content. |
| `record_hash` | The fingerprint of this record. |
| `prev_hash` | The `record_hash` of the record before it. The first record holds all zeros. |
| `latency_us` | How long the decision took, in microseconds. `0` when it was not measured. |

The JSON lines export also has three more fields:

- `id`: the record id. Use it with [`zn-gate why <id>`](../cli.md#why) to explain one block.
- `payload_preview`: a short piece of what the tool call carried, with secrets removed.
- `confidence` and `engine`: the confidence of the decision and the engine that made it.

The CSV export has no `id` and no `payload_preview`. If you need to explain a block later, export the JSON lines too.

## 4. Narrow it to a time window

Timestamps are UTC and sort as text, so a date prefix selects one day. These commands use the standard tools of a Linux or macOS shell, or Git Bash on Windows.

For JSON lines, keep the records of 1 to 7 November 2026:

```bash
grep '"timestamp":"2026-11-0[1-7]' incident-evidence.jsonl > week.jsonl
```

For CSV, keep the header line and the matching rows:

```bash
head -n 1 incident-evidence.csv > week.csv
grep '^"2026-11-0[1-7]' incident-evidence.csv >> week.csv
```

To look at one hour, use a longer prefix, such as `"2026-11-11T12:1`.

Filtering a copy leaves the original file untouched. Filtered copies no longer pass the chain check, because the chain runs through every record: say which export and which window you used when you hand over the files, and keep the unfiltered export as the reference.

## See also

- [The decision log](evidence-example.md): what the counts and the recent records mean.
- [Verify the decision log after a move](evidence-verify-after-restore.md): what a failed check looks like.
- [Command line reference](../cli.md#evidence): all options and exit codes.
