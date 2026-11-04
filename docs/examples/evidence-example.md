# Example: the evidence log

A worked example of `zn-gate evidence`, which shows the local hash-chained log of what zn-gate decided. The output below was printed on a test computer with a temporary home folder, so the folder name and the times are only examples. For every option, see the [command line reference](../cli.md#evidence).

The log is a file on your computer (`~/.zn/evidence.jsonl`). Nothing is sent anywhere.

## Goal

See what zn-gate decided recently, and check that nobody changed the record afterwards.

## Show the counts and the latest records

```bash
zn-gate evidence
```

```text
🛡️  zn Evidence Ledger Stats (/tmp/tmp.zLpJGchVnH/.zn/evidence.jsonl)
───────────────────────────────────────────────────
  Total Events  : 8
  Blocked Drops : 8
  Allowed Passes: 0
  Shadow Alerts : 0
  Integrity     : VALID
───────────────────────────────────────────────────
Recent Events (last 8):
  06:37:52 [BLOCK] tool=read rule=hook-pre_tool-policy hash=9063c01163...
  06:37:52 [BLOCK] tool=read rule=hook-pre_tool-policy hash=f669b80bd3...
  06:37:52 [BLOCK] tool=read rule=hook-pre_tool-policy hash=130a457d60...
  06:37:52 [BLOCK] tool=read rule=hook-pre_tool-policy hash=66d2251a39...
  06:37:52 [BLOCK] tool=read rule=hook-pre_tool-policy hash=6576f6b3a6...
  06:37:52 [BLOCK] tool=read rule=hook-pre_tool-policy hash=3d6122b086...
  06:37:52 [BLOCK] tool=bash rule=hook-pre_tool-policy hash=f5a9194510...
  06:37:52 [BLOCK] tool=read rule=hook-pre_tool-policy hash=5d1500fa21...

Tip: Run 'zn-gate evidence --ui' to open interactive dashboard.
```

How to read it:

- The first line says which file the log is kept in.
- `Total Events` is how many decisions the log holds. Here there are 8, and all 8 were `Blocked Drops`: zn-gate stopped the action. `Allowed Passes` and `Shadow Alerts` are 0.
- `Integrity : VALID` means the chain of fingerprints is intact (see the next section).
- Each line under `Recent Events` is one decision: the time, the verdict (`BLOCK`), the tool the agent tried to use (`read` or `bash`), the rule that decided, and the start of that record's fingerprint (`hash`).
- These records came from the [`zn-gate check`](../cli.md) demo, which asks each agent's hook whether it may read a fake secret. That is why every line is a block.

To show fewer records, use `--tail`:

```bash
zn-gate evidence --tail 2
```

This prints the same counts, but lists only the last 2 records.

## Check that the log was not changed

```bash
zn-gate evidence --verify
```

```text
🔒 Cryptographic Evidence Ledger Verification:
  Ledger Path   : /tmp/tmp.zLpJGchVnH/.zn/evidence.jsonl
  Total Records : 8
  Integrity     : ✔ ALL SHA-256 HASHES VERIFIED (IMMUTABLE)
```

How to read it:

- Every record holds a fingerprint (a SHA-256 hash) of the record before it. If someone edits or removes a record, the fingerprints no longer match.
- `ALL SHA-256 HASHES VERIFIED` means every record matched. The command ends with exit code `0`. If the log was changed, it ends with exit code `1`.
- This finds accidental or partial edits. It does not stop someone who can write to the file and recalculates the whole chain.

If the log is damaged, see [Troubleshooting](../troubleshooting.md#10-the-evidence-log--is-damaged).

## Save the records

```bash
zn-gate evidence --export --format csv --output evidence.csv
```

This writes the records to `evidence.csv`. Leave out `--format` to get JSON lines, and leave out `--output` to print them on the screen.

## See also

- [Command line reference](../cli.md#evidence): all options and exit codes.
- [Glossary](../glossary.md): what a hash chain is.
