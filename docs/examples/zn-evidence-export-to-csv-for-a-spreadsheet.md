# Example: open the decision log in a spreadsheet

A worked example of getting the local decision log of zn-gate into a spreadsheet: check the log, export it as a CSV file, read what each column means, and decide who may see the file. The output below was printed on a test computer with a temporary home folder, so the times and the fingerprints are only examples. For every option of the command, see the [command line reference](../cli.md#evidence).

The export only reads the log. It changes nothing in it and sends nothing anywhere.

## Goal

Hand a list of what zn-gate decided to someone who works in a spreadsheet, or sort and filter it yourself, without parsing JSON.

## Check the log first

An export is only as good as the log it comes from. Check the chain of fingerprints before you export (the [decision log example](evidence-example.md) explains the output):

```bash
zn-gate evidence --verify
```

Look for `ALL SHA-256 HASHES VERIFIED` and exit code `0`. The export does not stop when the log was changed. It still writes the file, exits with `0`, and says so only in its messages: a line that starts with `Tamper detected:` on the error output and `(Integrity: TAMPERED)` at the end of the summary line. A script or a person who only looks at the exit code will miss it.

## Export as CSV

```bash
zn-gate evidence --export --format csv --output evidence.csv
```

```text
Exported 8 audit records to evidence.csv (Integrity: VALID).
```

The file is written at once and replaces an existing file of the same name without asking. Without `--output`, the same text is printed on the screen. A log with no records gives a file that holds only the header line.

With `--format` left out, you get one JSON record per line. Any other format is refused with exit code `2`:

```text
zn-gate: unknown --format "xml". The valid formats are jsonl and csv.
```

## What is in the file

The first line holds the names of the columns. Each of the next lines is one decision, in the order they were made. These are the first two lines of a file from the test computer, with the first data line shortened:

```text
timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us
"2026-11-11T14:18:40.748Z","block","hook-pre_tool","read","claude-code","hook-pre_tool-policy","blocked by the zn hook policy","71a72bc7...","4a26010c...","0000000000...","0"
```

| Column | What it holds |
| --- | --- |
| `timestamp` | When zn-gate decided, in UTC (the `Z` at the end). |
| `verdict` | What zn-gate did: for example `block`. |
| `phase` | Which moment of the agent session it was, for example `hook-pre_tool`: the check before a tool runs. |
| `tool_name` | The tool the agent tried to use, for example `read` or `bash`. |
| `agent_environment` | Which coding agent made the call, for example `claude-code`. |
| `rule` | The rule that decided. |
| `reason` | A short reason in words. |
| `payload_sha256` | A SHA-256 fingerprint of what was checked. The text itself is not in the file. |
| `record_hash` | The fingerprint of this record. |
| `prev_hash` | The fingerprint of the record before it. For the first record it is 64 zeros. |
| `latency_us` | How long the check took, in microseconds. |

Every data value is in double quotes, and the file is plain UTF-8 text without a byte-order mark. Most spreadsheets read it as it is.

## Open it in a spreadsheet

Use the import of your spreadsheet instead of a double click, so that you choose the format of each column: in Excel the data import for text or CSV files, in Google Sheets `File`, `Import`, in LibreOffice Calc `File`, `Open`. Choose a comma as the separator and UTF-8 as the encoding. Two things are worth doing:

- Set `record_hash`, `prev_hash` and `payload_sha256` to text. A spreadsheet that treats a column as numbers may show the 64 zeros of the first `prev_hash` as `0` and may shorten long values.
- Keep `timestamp` as text, or convert it yourself. It is in UTC, so the hours do not match your local clock.

A good first look is to filter `verdict` for `block` and sort by `tool_name`.

## What the CSV leaves out

The CSV holds 11 columns. The JSON export holds more for each record: an `id`, a short `payload_preview` with secrets already removed, a `confidence`, and the `engine` that decided. That `id` is what `zn-gate why <id>` needs to explain one block (see [allow a blocked action after `zn why`](zn-why-allow-command.md)).

To get a CSV with the `id`, export the JSON lines and choose the columns with `jq`, a separate program that you install yourself:

```bash
zn-gate evidence --export --output evidence.jsonl
jq -r '[.timestamp,.verdict,.tool_name,.rule,.id]|@csv' evidence.jsonl > evidence-with-id.csv
```

The first line of that file looks like this:

```text
"2026-11-11T14:18:40.748Z","block","read","hook-pre_tool-policy","ev_mwc7fizx_2e49f4d7"
```

That file has no header line. Add one in the spreadsheet, or print one before the records.

## Before you share the file

The file does not hold the text of a command, a prompt or a file, and no secret value. It does show which tools your agents used, which agent made each call, which rules fired and when. That is a picture of how you work, so share it on purpose:

- Send it only to people who should know that. Do not post it in a public issue or a public channel.
- Keep it out of a repository. Delete it when the review is over.
- The export is a new ordinary file, made with your computer's default access rights. It is not kept private the way `~/.zn` is, so put it in a folder that only you can open.
- The log in `~/.zn/evidence.jsonl` stays on your computer and is not changed by the export.

## See also

- [Command line reference](../cli.md#evidence): all options and exit codes of `evidence`.
- [Example: the decision log](evidence-example.md): the counts, `--tail` and `--verify`.
- [Troubleshooting](../troubleshooting.md#10-the-evidence-log--is-damaged): when the log is damaged.
