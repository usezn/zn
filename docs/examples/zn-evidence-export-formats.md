# Example: evidence exports in JSON lines and CSV

This page shows what `zn-gate evidence --export` writes in each format, which fields each format has, and how to open the file. The output below was printed on a test computer with a throwaway home folder and made-up values, so the names and times are only examples. For every option, see the [command line reference](../cli.md#evidence). For the exit codes, see [Exit codes](../exit-codes.md#logs-and-reports).

The export reads the local log file, `evidence.jsonl`, in the zn folder of your home folder (`~/.zn`, or the folder named in `ZN_HOME`). Nothing is sent anywhere, as [the decision log example](evidence-example.md) also says.

## Goal

Get a copy of the local decision log in a form that a script, a spreadsheet or an auditor can read.

## The two formats at a glance

| | JSON lines (`jsonl`, the default) | CSV (`csv`) |
|---|---|---|
| Command | `zn-gate evidence --export` | `zn-gate evidence --export --format csv` |
| Layout | One JSON object per line, one line per record | A header line, then one line per record |
| Fields per record | 15 | 11 |
| Values | Typed as in JSON: numbers stay numbers | Text only; every value is in double quotes |
| Best for | Scripts, and keeping the record as it was written | Spreadsheets and tools that read CSV |

Both formats hold the same records in the same order, the oldest first. The difference is only the layout and the set of fields: the CSV leaves out four fields of the JSON lines (see below).

## Export as JSON lines

```bash
zn-gate evidence --export --output evidence.jsonl
```

With `--output`, the command prints a one-line summary. The folder part of the file name is left out here:

```text
Exported 8 audit records to evidence.jsonl (Integrity: VALID).
```

Leave out `--output` to print the lines on the screen instead, for example to pipe them into another command: `zn-gate evidence --export | jq -c .`

One record, as it was printed in the test run (one line in the file):

```json
{"id":"ev_mw9e5m2z_25531b0c","timestamp":"2026-11-09T15:03:36.971Z","agent_environment":"claude-code","phase":"hook-pre_tool","tool_name":"read","payload_sha256":"71a72bc706129dfbaf0d9c596c93762f9ab827181b6880b30630fd5349d23622","payload_preview":"{\"event\":\"pre_tool\",\"tool\":\"read\",\"kinds\":[]}","verdict":"block","rule":"hook-pre_tool-policy","reason":"blocked by the zn hook policy","confidence":1,"latency_us":0,"engine":"zn-hook","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","record_hash":"17685ac4948d702102e5e615f7a8233138cadfe8152a296901f594dd5ec1cef0"}
```

The fields, in the order they are written (the source is `buildRecord` in `packages/zn-gate/lib/evidence.js`):

| Field | What it holds |
|---|---|
| `id` | A record id: `ev_`, a time part and a random part. |
| `timestamp` | When zn wrote the record, in UTC (`2026-11-09T15:03:36.971Z`). |
| `agent_environment` | The agent that made the call, for example `claude-code` or `codex`. `unknown` when zn did not know it. |
| `phase` | The point where zn checked the call, for example `hook-pre_tool`. |
| `tool_name` | The tool the agent tried to use, for example `read` or `bash`. |
| `payload_sha256` | The SHA-256 of the whole payload. The payload itself is not kept. |
| `payload_preview` | The start of the payload, at most 120 characters, with secrets removed before the cut. |
| `verdict` | The decision, for example `block` or `allow`. |
| `rule` | The rule that made the decision, or `null`. |
| `reason` | A short reason, or `null`. |
| `confidence` | A number; `1` in the test run. |
| `latency_us` | How long the check took, in microseconds; `0` in the test run. |
| `engine` | The check that decided, for example `zn-hook`. |
| `prev_hash` | The `record_hash` of the record before this one. The first record has 64 zeros. |
| `record_hash` | The SHA-256 over `prev_hash` and the record. Together these form the chain that `evidence --verify` checks. |

## Export as CSV

```bash
zn-gate evidence --export --format csv --output evidence.csv
```

The one-line summary is the same as for JSON lines, with the same count and integrity word:

```text
Exported 8 audit records to evidence.csv (Integrity: VALID).
```

The first two lines of the file, as printed in the test run:

```csv
timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us
"2026-11-09T15:03:36.971Z","block","hook-pre_tool","read","claude-code","hook-pre_tool-policy","blocked by the zn hook policy","71a72bc706129dfbaf0d9c596c93762f9ab827181b6880b30630fd5349d23622","17685ac4948d702102e5e615f7a8233138cadfe8152a296901f594dd5ec1cef0","0000000000000000000000000000000000000000000000000000000000000000","0"
```

The CSV has these 11 columns, in this order: `timestamp`, `verdict`, `phase`, `tool_name`, `agent_environment`, `rule`, `reason`, `payload_sha256`, `record_hash`, `prev_hash`, `latency_us`.

Compared with JSON lines, the CSV leaves out `id`, `payload_preview`, `confidence` and `engine`. Other rules of the CSV:

- Every value is in double quotes, numbers too (`"0"`).
- A double quote inside a value is written twice, as CSV requires.
- An empty field (for example a `rule` that is `null`) is written as `""`.

Without a log file the CSV still has its header line, and the JSON lines output is empty. A new install that has not recorded anything yet therefore gives a header-only CSV.

## Check the copy

`--output` prints `Integrity: VALID` when the chain in the log is intact. When it is not, the summary says so instead:

```text
Exported 8 audit records to evidence.csv (Integrity: TAMPERED).
```

Exporting to the screen prints no summary line. In that case a broken chain is reported on the error output, for example:

```text
Tamper detected: Tamper detected at line 2 (record ev_mw9e5m3f_dc38c57a): hash mismatch. The content of this log was altered!
```

An export does not stop when the chain is broken. In the test run both forms still wrote the records and the command still ended with exit code `0`, so do not rely on an export to detect a change. To check the log and get exit code `1` for a broken chain, run:

```bash
zn-gate evidence --verify
```

## How to open each format

JSON lines, in a terminal with [`jq`](https://jqlang.org/), count the verdicts (the output of the test run):

```bash
jq -r '.verdict' evidence.jsonl | sort | uniq -c
```

```text
      8 block
```

CSV, in Python, read each row by its column name:

```python
import csv

with open("evidence.csv", newline="") as f:
    for row in csv.DictReader(f):
        print(row["timestamp"], row["verdict"], row["tool_name"])
```

For a spreadsheet, open the `.csv` file in any spreadsheet program and choose comma as the separator if it asks. The timestamps are text in UTC, so sort them as text.

## Which format to use

- Use **JSON lines** when a script or a log tool reads the file, or when you want every field, including `id`, `payload_preview`, `confidence` and `engine`.
- Use **CSV** when a person reads the records in a spreadsheet, or a tool takes a flat table.
- Keep the file as it is. Changing a line breaks the chain, and `evidence --verify` will report it.

## See also

- [Command line reference](../cli.md#evidence): every option of `evidence` and its alias `export`.
- [Decision log example](evidence-example.md): the counts, the `--verify` output and the `--tail` option.
- [Exit codes](../exit-codes.md#logs-and-reports): the codes of `evidence` and `stats`.
- [Glossary](../glossary.md): what a hash chain is.
