# Reading an evidence CSV

`zn-gate evidence --export --format csv` writes the decision log as a table that a spreadsheet can open. This page explains each column, shows a real file, and lists what the CSV leaves out compared with the log itself. For all options, see the [command line reference](../cli.md#evidence); for the log on screen, see [the decision log](evidence-example.md).

The file below was made on a test computer with a temporary home folder, after running the [`zn-gate check`](../check.md) demo and one blocked hook call. The values are only examples.

Nothing is sent anywhere. The export reads the local log (`~/.zn/evidence.jsonl`).

## 1. Write the file

```bash
zn-gate evidence --export --format csv --output evidence.csv
```

```text
Exported 9 audit records to evidence.csv (Integrity: VALID).
```

`Integrity: VALID` means the chain of fingerprints was checked while exporting and nothing was changed. If it was changed, the line says `TAMPERED` and zn-gate also prints a `Tamper detected` message on the error output. Leave out `--output` to print the CSV on the screen instead.

## 2. Look at the file

The first line is the header, then one line per record:

```text
timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us
"2026-11-08T12:45:03.296Z","block","hook-pre_tool","read","claude-code","hook-pre_tool-policy","blocked by the zn hook policy","71a72bc706129dfbaf0d9c596c93762f9ab827181b6880b30630fd5349d23622","8e80f8e2bfaa57bc759fa2937813bd2b04ab43cf9fe04a4ee171e121dfc63491","0000000000000000000000000000000000000000000000000000000000000000","0"
"2026-11-08T12:45:03.328Z","block","hook-pre_tool","bash","codex","hook-pre_tool-policy","blocked by the zn hook policy","fc93904f0a5d0dfc6d2d9ee81eda87b2ff04c14872352fe1fdec767943096bba","6f0c18cfa85494190f4fd337dbe83dd7d0ccb60c70ec0eaecaecd7671ef0b6db","8e80f8e2bfaa57bc759fa2937813bd2b04ab43cf9fe04a4ee171e121dfc63491","0"
```

These are the first two of the nine lines. Every value except the header is in double quotes, and a double quote inside a value is written twice (`""`), as spreadsheets expect. The file has the oldest record first, while `zn-gate evidence` on the screen lists the newest first.

## 3. What each column means

| Column | What it holds | In the example |
| --- | --- | --- |
| `timestamp` | When zn-gate decided, in UTC. | `2026-11-08T12:45:03.296Z` |
| `verdict` | The decision: `block`, `allow` or `shadow` (recorded only, nothing stopped). | `block` |
| `phase` | What was being checked. For an agent hook it names the hook and the step. | `hook-pre_tool` |
| `tool_name` | The tool the agent tried to use, or `unknown`. | `read`, `bash` |
| `agent_environment` | The agent that asked, or `unknown`. | `claude-code`, `codex` |
| `rule` | The rule that decided. Empty when no rule applied. | `hook-pre_tool-policy` |
| `reason` | A short explanation. Empty when there is none. | `blocked by the zn hook policy` |
| `payload_sha256` | The SHA-256 fingerprint of the text that was checked. The text itself is not stored here. | `71a72bc7...` |
| `record_hash` | The fingerprint of this record. | `8e80f8e2...` |
| `prev_hash` | The `record_hash` of the record before it. The first record has 64 zeros. | `0000...0000` |
| `latency_us` | How long the check took, in microseconds. | `0` |

How to use the three fingerprint columns:

- Two lines with the same `payload_sha256` were the same checked text. In the example, the lines that read the fake secret file share one value, and the two lines that ran the same shell command share another.
- Each `prev_hash` equals the `record_hash` of the line above it. In the second line above, `prev_hash` is `8e80f8e2...`, the `record_hash` of the first. A line whose `prev_hash` does not match the line above it means a record was removed or changed. `zn-gate evidence --verify` checks this for you.
- The first line of a log has 64 zeros in `prev_hash`.

The values `allow` and `shadow` for `verdict` come from the [log field reference](../architecture.md#reading-the-decision-log-by-hand). This demo only produced `block` lines, so they are not shown above.

## 4. What the CSV leaves out

The CSV has 11 columns. The log itself (the JSON lines you get with `zn-gate evidence --export`) also holds `id`, `payload_preview`, `confidence` and `engine`. Here is the first record of the same log, as a JSON line:

```json
{"id":"ev_mw7trkjk_b69ba6ca","timestamp":"2026-11-08T12:45:03.296Z","agent_environment":"claude-code","phase":"hook-pre_tool","tool_name":"read","payload_sha256":"71a72bc706129dfbaf0d9c596c93762f9ab827181b6880b30630fd5349d23622","payload_preview":"{\"event\":\"pre_tool\",\"tool\":\"read\",\"kinds\":[]}","verdict":"block","rule":"hook-pre_tool-policy","reason":"blocked by the zn hook policy","confidence":1,"latency_us":0,"engine":"zn-hook","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","record_hash":"8e80f8e2bfaa57bc759fa2937813bd2b04ab43cf9fe04a4ee171e121dfc63491"}
```

Use the JSON lines when you need the short preview of what was checked or the `id`. Use `zn-gate why <id>` ([why was this blocked](../why-was-this-blocked.md)) to have a record explained.

## 5. Other results of the export

An empty log gives a file with only the header line:

```text
timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us
```

An unknown format is refused with exit code `2`:

```bash
zn-gate evidence --export --format xml
```

```text
zn-gate: unknown --format "xml". The valid formats are jsonl and csv.
```

## What to check

- The line after the export says `Integrity: VALID`. If it says `TAMPERED`, run `zn-gate evidence --verify` and see [Troubleshooting](../troubleshooting.md#10-the-evidence-log--is-damaged).
- The number of lines in the file, minus the header, equals the number in `Exported N audit records`.
- When you open the file in a spreadsheet, set the columns `payload_sha256`, `record_hash` and `prev_hash` to text, so the long fingerprints are not shortened.
- Treat the file like the log: it holds tool names, agent names and fingerprints, but no secret values.

## See also

- [The decision log](evidence-example.md): counts, recent records and the integrity check on screen.
- [Reading the decision log by hand](../architecture.md#reading-the-decision-log-by-hand): every field of the JSON record.
- [Command line reference](../cli.md#evidence): all options and exit codes.
