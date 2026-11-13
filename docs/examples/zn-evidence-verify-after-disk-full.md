# Example: verify the decision log after a disk filled up

The disk of your computer was full for a while. Programs that were writing files at that moment can stop in the middle of a line, and the decision log of zn-gate is one such file. This page shows what `zn-gate evidence --verify` prints when the last record of the log was cut short, how that differs from a log that only lacks its last line, and what to do.

The log is the file `evidence.jsonl` in the `.zn` folder (see [files and folders](../files-and-folders.md)). The check only reads it: nothing is changed and nothing is sent anywhere. For every option, see the [command line reference](../cli.md#evidence).

The output below was printed on a test computer with a temporary home folder, which is shortened to `~`. The log held 8 records, and the cut was made by hand: 61 bytes were removed from the end of the file, which ends in the middle of the last record.

## 1. Run the check

```bash
zn-gate evidence --verify
```

On a whole log it prints:

```text
🔒 Cryptographic Evidence Ledger Verification:
  Ledger Path   : ~/.zn/evidence.jsonl
  Total Records : 8
  Integrity     : ✔ ALL SHA-256 HASHES VERIFIED (IMMUTABLE)
```

After the cut, the same command ends with exit code `1`:

```text
🔒 Cryptographic Evidence Ledger Verification:
  Ledger Path   : ~/.zn/evidence.jsonl
  Total Records : 8
  Integrity     : ✖ TAMPER DETECTED AT RECORD 7

  Details: Malformed JSON at line 8: Unterminated string in JSON at position 537 (line 1 column 538)
  To start a new log and keep the old file for review, move it aside (mv "<home>/.zn/evidence.jsonl" "<home>/.zn/evidence.damaged.jsonl"); the next event starts a new chain.
```

How to read it:

- `Total Records` counts the lines in the file, including the one that is cut short.
- `Integrity` names the first record that does not fit, counting from 0. Here that is record 7, which is line 8 of the file. The heading says "tamper" for every kind of break, but the `Details` line tells you which kind it is.
- `Malformed JSON at line 8` is what a cut-off line looks like: the record starts and never ends. It is not proof that someone changed the file. A record that was edited reads `Tamper detected at line ...` or `Broken chain link at line ...` instead.
- The records before the break are still verified. The check stops at the first problem and does not say anything about the lines after it.
- The last line of the output is the fix. It is the same message zn-gate prints on its own when it meets the damage (see [Troubleshooting](../troubleshooting.md#10-the-evidence-log--is-damaged)).

## 2. See that new decisions are not being recorded

While the last line is cut, zn-gate does not add records after it. It will not start a new chain by accident, so it tells you instead. Any command that writes a decision, such as `zn-gate check`, prints this on the error output:

```text
zn-gate: the evidence log <home>/.zn/evidence.jsonl is damaged (Malformed JSON in the last line: Unterminated string in JSON at position 537 (line 1 column 538)) Events are not being recorded. Run 'zn-gate evidence --verify' for details. To start a new log and keep the old file for review, move it aside (mv "<home>/.zn/evidence.jsonl" "<home>/.zn/evidence.damaged.jsonl"); the next event starts a new chain.
```

The messages show the full path of your log: `<home>` stands for your own home folder.

Your protection keeps working: the hooks still allow and block as before. Only the record of it is not written.

## 3. Move the old file aside

Run the command from the message in your own terminal. It keeps the damaged file for review and lets zn-gate start a new log:

```bash
mv ~/.zn/evidence.jsonl ~/.zn/evidence.damaged.jsonl
```

On Windows the message shows a `move` command instead of `mv`. Then check again:

```bash
zn-gate evidence --verify
```

```text
🔒 Cryptographic Evidence Ledger Verification:
  Ledger Path   : ~/.zn/evidence.jsonl
  Total Records : 0
  Integrity     : ✔ ALL SHA-256 HASHES VERIFIED (IMMUTABLE)
```

There is no log yet, so there are 0 records. The next decision starts a new chain. The old file stays as `evidence.damaged.jsonl`, and you can open it in a text editor: every line before the cut is a complete record.

## When the last line is gone completely

If the whole last line is missing (and not a part of it), the log still verifies. This is the same log with its eighth line removed:

```text
🔒 Cryptographic Evidence Ledger Verification:
  Ledger Path   : ~/.zn/evidence.jsonl
  Total Records : 7
  Integrity     : ✔ ALL SHA-256 HASHES VERIFIED (IMMUTABLE)
```

Each record holds a fingerprint of the one before it, so a log that loses records from its end is still a valid chain, only shorter. The check cannot tell you that something used to be there. If you know the log should hold more records than `Total Records` says, compare it with a copy.

## See also

- [Verify the decision log after a move](evidence-verify-after-restore.md): the same check after you copy the log to a new computer.
- [The decision log](evidence-example.md): what `zn-gate evidence` shows and what the counts mean.
- [Troubleshooting: the evidence log is damaged](../troubleshooting.md#10-the-evidence-log--is-damaged)
- [Command line reference](../cli.md#evidence): all options and exit codes.
- [All examples](README.md)
