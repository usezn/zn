# Example: reading a break in the decision log

`zn-gate evidence --verify` checks the hash chain of your decision log. This page shows what it prints for each of the three kinds of break, what the break means, what keeps working while the log is damaged, and what to do. For the same command after you copied the log to a new computer, see [verify the decision log after a move](evidence-verify-after-restore.md).

Run every command in your own terminal. The command only reads the log: nothing is sent anywhere.

## The log used here

The outputs below come from a real run on a test computer, with a temporary home folder and six made-up records (three allowed, three blocked). The folder name in the outputs is shortened to `/tmp/demo-home`, and the record ids are examples. The output is shown as it is printed when it goes to a file or another program. In a terminal it shows the symbols `🔒`, `✔` and `✖` where this page shows `[ok]` and `[x]`; the words are the same.

An intact log looks like this, and the command ends with exit code `0`:

```text
[ok] Cryptographic Evidence Ledger Verification:
  Ledger Path   : /tmp/demo-home/.zn/evidence.jsonl
  Total Records : 6
  Integrity     : [ok] ALL SHA-256 HASHES VERIFIED (IMMUTABLE)
```

## A record was edited

Every record holds a fingerprint of its own content and of the record before it. After one word of record 4 was changed by hand (`allow` to `block`), the check prints:

```text
[ok] Cryptographic Evidence Ledger Verification:
  Ledger Path   : /tmp/demo-home/.zn/evidence.jsonl
  Total Records : 6
  Integrity     : [x] TAMPER DETECTED AT RECORD 3

  Details: Tamper detected at line 4 (record ev_mwccknwn_3fc7437d): hash mismatch. The content of this log was altered!
  To start a new log and keep the old file for review, move it aside (mv "/tmp/demo-home/.zn/evidence.jsonl" "/tmp/demo-home/.zn/evidence.damaged.jsonl"); the next event starts a new chain.
```

The exit code is `1`. `Integrity` counts records from 0 (record 3), and `Details` counts lines from 1 (line 4): both name the same record, the fourth one. The records before it still check out. This kind of break means the content of a record is no longer what was written.

## A record was removed

After line 3 was deleted, the record after it no longer points at the record before it:

```text
  Total Records : 5
  Integrity     : [x] TAMPER DETECTED AT RECORD 2

  Details: Broken chain link at line 3 (record ev_mwccknwn_3fc7437d): expected prev_hash 693c9a1b... but found 4b73936c...
```

The exit code is `1`. `expected` is the fingerprint of the record that is now before it, and `found` is the one the record was written after. A removed, added or reordered record gives this break. The same output also ends with the line about moving the file aside.

## The last line is cut off

A copy that stopped in the middle, or a write that was interrupted, leaves a half line at the end:

```text
  Total Records : 6
  Integrity     : [x] TAMPER DETECTED AT RECORD 5

  Details: Malformed JSON at line 6: Unterminated string in JSON at position 462 (line 1 column 463)
```

The exit code is `1`. The words after the colon come from Node.js and the position number depends on where the file stopped. Nothing was necessarily edited here: the line is only unfinished.

The heading `TAMPER DETECTED` is the same for all three. Read the `Details` line to see which break it is:

| `Details` starts with | What it means |
| --- | --- |
| `Tamper detected at line N` | The content of record N was changed after it was written. |
| `Broken chain link at line N` | Record N does not follow the one before it: a record was removed, added or moved. |
| `Malformed JSON at line N` | Line N is not a whole record, for example a cut-off line. |

## What keeps working

- Your protection does not change. The hooks keep checking and blocking as before; only the record of what they decided is in doubt.
- `zn-gate evidence` with no option still prints the counts and the last records. It shows `Integrity     : CORRUPTED`, then the same `Details` and a `Recovery` line. It exits with `0`.
- If the **last** line is cut off, zn-gate stops adding records and prints one warning on the standard error output (once, then at most every five minutes). The warning names the file and says "Events are not being recorded". Nothing is lost from the file, and your agent is not stopped.
- If a record **in the middle** was edited or removed, new records are still added after the last one. The break stays where it is, and every later `--verify` fails at the same record.

## What to do

1. Do not edit the file to repair it. A hand edit is another change to the chain.
2. Think about what happened. A cut-off last line after a crash or an interrupted copy is the usual cause. An edited or removed record in the middle means that something other than zn-gate wrote to the file.
3. To keep working with a clean chain, move the old file aside with the command in the last line of the output. On Windows, the line shows `move` instead of `mv`:

   ```bash
   mv ~/.zn/evidence.jsonl ~/.zn/evidence.damaged.jsonl
   ```

   The next event starts a new chain. After one more event, a real run printed this, with exit code `0`:

   ```text
     Total Records : 1
     Integrity     : [ok] ALL SHA-256 HASHES VERIFIED (IMMUTABLE)
   ```

4. Keep `evidence.damaged.jsonl` for review. The records before the break are still the ones zn-gate wrote.

If the log is in a different folder because `ZN_HOME` is set, the command shows that folder. More steps are in [Troubleshooting](../troubleshooting.md#10-the-evidence-log--is-damaged).

## What the check does not catch

The fingerprints find accidental or partial edits. They do not stop someone who can write to the file and recalculates the whole chain, so a passing check is not proof that nobody touched the log.

## See also

- [The decision log](evidence-example.md): what `zn-gate evidence` shows and what the counts mean.
- [Verify the decision log after a move](evidence-verify-after-restore.md): the same check after a copy to a new computer.
- [Command line reference](../cli.md#evidence): all options and exit codes.
