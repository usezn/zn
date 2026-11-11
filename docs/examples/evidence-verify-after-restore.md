# Example: verify the decision log after a move

You moved to a new computer and brought the old decision log with you, so you keep the history of what zn-gate decided there (see [setting up zn-gate on a new computer](moving-to-a-new-computer.md)). One command checks that the copy arrived whole and unchanged:

```bash
zn-gate evidence --verify
```

The log must sit where zn-gate looks for it: `evidence.jsonl` in the `.zn` folder (see [files and folders](../files-and-folders.md)). The check only reads that file: it recomputes the chain of fingerprints and compares each one with what the records hold. Nothing is sent anywhere.

The output below was printed on a test computer with a temporary home folder, so the folder name and the numbers are only examples. For every option, see the [command line reference](../cli.md#evidence).

## When the copy is fine

```text
🔒 Cryptographic Evidence Ledger Verification:
  Ledger Path   : /tmp/demo-home/.zn/evidence.jsonl
  Total Records : 8
  Integrity     : ✔ HASH CHAIN VERIFIED, no truncation found against the last tip
```

How to read it:

- `Ledger Path` is the file that was checked.
- `Total Records` is how many decisions the copied log holds.
- `HASH CHAIN VERIFIED` means every record's fingerprint matched the one before it, so nothing in it was changed. `no truncation found against the last tip` means the log is as long as zn-gate last noted (copy `evidence.tip` from the old computer together with `evidence.jsonl` to get this check; without it you get `Not anchored yet`). The command ends with exit code `0`.

## When the check finds a break

If a line was cut off during the copy, or a record was edited, the fingerprints no longer match. The command ends with exit code `1` and names the first place that does not fit:

```text
🔒 Cryptographic Evidence Ledger Verification:
  Ledger Path   : /tmp/demo-home/.zn/evidence.jsonl
  Total Records : 8
  Integrity     : ✖ TAMPER DETECTED AT RECORD 5

  Details: Tamper detected at line 6 (record ev_example_0a1b2c3d): hash mismatch. The content of this log was altered!
  To start a new log and keep the old file for review, move it aside (mv "/tmp/demo-home/.zn/evidence.jsonl" "/tmp/demo-home/.zn/evidence.damaged.jsonl"); the next event starts a new chain.
```

How to read it:

- `Integrity` names the first record that does not fit the chain, counting from 0. `Details` names the same place as a line in the file (line 6) and what is wrong with it.
- The `Details` text tells you which of the three breaks it found. `Malformed JSON at line ...` means the file was cut short or a line is half written. `Broken chain link at line ...` means a record was edited or removed. `Tamper detected at line ...` means the content of a record was changed after it was written.
- The last line is the fix, and it is the same message zn-gate prints when it finds the damage while writing: keep the old file for review, move it aside with the command shown, and the next decision starts a new log. On Windows the message shows a `move` command instead of `mv`.
- zn does not repair a log, and your protection keeps working: only the record is in doubt. These steps are the ones in [Troubleshooting](../troubleshooting.md#10-the-evidence-log--is-damaged).

## When the end of the log is missing

If the copy stopped early but ended on a whole line, the chain is still fine. The tip notices:

```text
🔒 Cryptographic Evidence Ledger Verification:
  Ledger Path   : /tmp/demo-home/.zn/evidence.jsonl
  Total Records : 6
  Integrity     : ✖ LOG TRUNCATED: 6 records found, the last tip expects at least 8

  Details: The end of the log was removed, or it was replaced by an older copy. The tip was written at 2026-11-10T09:14:02.000Z (record 8). Keep a copy of both files. To accept the log as it is now, run `zn-gate evidence --accept` in your own terminal.
```

The command ends with exit code `1`. Copy the log again. If you meant to keep this shorter log, run `zn-gate evidence --accept` in your own terminal: the tip moves to the end of the log and the old tip stays in the tip file as `previous`. A different history gives `LOG REWRITTEN: record 8 differs from the tip`.

## What the check does not catch

The fingerprints find accidental or partial edits, such as a copy that stopped in the middle. They are not tamper-proof against someone who can write to the `.zn` folder: they can recalculate the whole chain and change the tip. Putting back an older copy of both the log and the tip is not noticed either.

## See also

- [The decision log](evidence-example.md): what `zn-gate evidence` shows and what the counts mean.
- [Setting up zn-gate on a new computer](moving-to-a-new-computer.md): what moves and what does not.
- [Command line reference](../cli.md#evidence): all options and exit codes.
