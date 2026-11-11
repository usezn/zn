# Example: keep and archive the decision log

zn-gate writes every decision to one file, `evidence.jsonl`, in the zn folder (`~/.zn`, or the folder that `ZN_HOME` names). **zn-gate does not rotate, trim, expire or archive that file.** It adds one line per decision and nothing removes or moves it. If the file grows too large for you, or you want a copy kept for a year, you do that yourself, with the steps below.

This page is about keeping and archiving the file. For what the counts and records mean, see [the decision log](evidence-example.md). For the command options, see the [command line reference](../cli.md#evidence). If the check says the log is damaged, follow [troubleshooting, section 10](../troubleshooting.md#10-the-evidence-log--is-damaged), and for a copy that you moved to a new computer, see [verify the log after a move](evidence-verify-after-restore.md).

All values in this page are made up. The outputs were printed by the code of this version in a temporary folder, so the folder names and the numbers are examples.

## How the file is chained

Each record holds two fingerprints:

- `prev_hash`: the `record_hash` of the record before it. The first record of a file has 64 zeros.
- `record_hash`: a SHA-256 of `prev_hash`, a colon and the record's own JSON (without `record_hash`).

So every line depends on every line before it. `zn-gate evidence --verify` reads the file from the first line, recomputes each fingerprint and stops at the first record that does not fit. It reads only the file `ZN_HOME` points to. The command has no option to check another file, so an archived copy has to be put in a folder of its own to be checked (see below).

Writers take a lock file, `evidence.jsonl.lock`, only while they append a line. A writer that cannot get it within two seconds skips that write and prints a warning, so no record is ever written without the lock.

## What verify does and does not catch

These results were reproduced with the code of this version, using a temporary `ZN_HOME` for each case:

| What happened to the file | What `evidence --verify` says | Exit code |
|---|---|---|
| Nothing changed | `ALL SHA-256 HASHES VERIFIED` with the record count | 0 |
| A copy was made, compressed, decompressed to a folder of its own and checked there | Same as above, with the same record count | 0 |
| No `evidence.jsonl` in the folder (for example, a wrong `ZN_HOME`) | `ALL SHA-256 HASHES VERIFIED`, `Total Records : 0` | 0 |
| The file was moved aside and the next decision wrote a new file | The new file verifies with its own records; the moved file still verifies | 0 |
| The last line was deleted | Still verifies, with one record fewer | 0 |
| The last line was cut in the middle (a copy taken during a write) | `TAMPER DETECTED AT RECORD <n>`, `Malformed JSON` | 1 |
| One line was edited | `TAMPER DETECTED`, `hash mismatch` at that line | 1 |
| The whole file was replaced by another valid log | Verifies | 0 |
| `evidence --export --output` of an edited log | Writes the file and prints `Integrity: TAMPERED` (plus a warning on stderr) | 0 |

Three things follow from this table:

1. **Verify cannot tell you that records were removed from the end.** A shorter file is still a valid chain. The only way to notice is to know the last `record_hash` from earlier and compare it with the file's last line.
2. **An empty or missing file verifies.** If the check passes with `Total Records : 0` when you expected records, the folder is wrong. Check `Ledger Path` in the output first.
3. **The export command exits with 0 even when the log is tampered.** Read the `Integrity` text and the warning, not the exit code, when you export for an audit.

## What this means for archiving

Each file is its own chain that starts at zeros. When you move the live file aside, the next decision starts a new chain with no link to the old one: the new file's first record has `prev_hash` of zeros, and nothing in either file names the other's last record. zn-gate does not keep a list of archived files, and it cannot prove that two files belong to one history.

So archiving is possible and does not break verification of either file. But **continuity between an archived file and the new one is only what you keep yourself.** Keep the last `record_hash` of each archived file (the tip) in your own archive notes, outside the zn folder, next to the file's record count and date.

Do not shrink the live file by hand. Deleting lines, trimming the end or editing a record either goes unnoticed (end of file) or breaks the chain (any other line), and neither is what you want for a record.

## Archive the log

Do this when no coding agent is using zn-gate. zn-gate writes on each tool call of an agent, and there is no command to pause that writing. Close the agent sessions that use zn-gate first.

1. **Read the live state.** Note the record count and the tip:

   ```bash
   zn-gate evidence --verify
   tail -n 1 ~/.zn/evidence.jsonl
   ```

   The last line is one record. Its `record_hash` field is the tip.

2. **Copy the file.** Use a name with the date, and keep the copy in a folder you back up:

   ```bash
   mkdir -p ~/archive
   cp ~/.zn/evidence.jsonl ~/archive/evidence-2026-11-11.jsonl
   ```

3. **Check the copy in a folder of its own.** Verify it with `ZN_HOME` pointing to that folder, so the live file is not used:

   ```bash
   CHECK=$(mktemp -d)
   cp ~/archive/evidence-2026-11-11.jsonl "$CHECK/evidence.jsonl"
   ZN_HOME="$CHECK" zn-gate evidence --verify
   rm -rf "$CHECK"
   ```

   The copy is good when the command says `ALL SHA-256 HASHES VERIFIED` and `Total Records` is the same number as in step 1. If the copy was taken while a write was running, the last line can be cut, and the check says `TAMPER DETECTED` at the last record. Then copy again.

4. **Compress the copy, and check the compressed file.** Only compress a copy that passed step 3:

   ```bash
   gzip -9 ~/archive/evidence-2026-11-11.jsonl
   CHECK=$(mktemp -d)
   gunzip -c ~/archive/evidence-2026-11-11.jsonl.gz > "$CHECK/evidence.jsonl"
   ZN_HOME="$CHECK" zn-gate evidence --verify
   rm -rf "$CHECK"
   ```

   `gzip` removes the uncompressed copy by default. Use `gzip -k` if you want to keep it as well.

5. **Record the archive.** Write the file name, the record count, the date and the tip (the `record_hash` of its last line) in your archive notes.

6. **Start a new log only if you need one.** zn-gate starts a new chain by itself when there is no `evidence.jsonl`: the next decision creates the file. To start fresh, first confirm that the live tip still matches the copy you checked (the agents must be closed, and a new record would mean the copy is out of date). Then move the live file:

   ```bash
   tail -n 1 ~/.zn/evidence.jsonl
   mv ~/.zn/evidence.jsonl ~/archive/evidence-live-2026-11-11.jsonl
   ```

   Do not use `evidence.damaged.jsonl` as the name for a routine archive: that name is the one zn-gate suggests for a broken log, and a file with that name is easy to confuse with a real problem. If the tip differs from the copy, the file grew after step 2. Run steps 2 and 3 again.

   If you do not need a fresh chain, skip this step. The file keeps growing and nothing breaks.

## Verify an archived copy later

Keep the compressed file, its record count and its tip. To check it later:

```bash
CHECK=$(mktemp -d)
gunzip -c ~/archive/evidence-2026-11-11.jsonl.gz > "$CHECK/evidence.jsonl"
ZN_HOME="$CHECK" zn-gate evidence --verify
tail -n 1 "$CHECK/evidence.jsonl"
rm -rf "$CHECK"
```

Compare the result with your notes:

- `ALL SHA-256 HASHES VERIFIED` and the same `Total Records` as in your notes: the chain is intact, and the file has not lost records from the end, as long as the tip on the last line also matches your note.
- The same `Total Records` but a different `record_hash` on the last line: the copy is not the one you archived. Compare with your other copies.
- A smaller `Total Records` than in your notes, with a valid chain: records were removed from the end. Verify cannot show this by itself. Look for another copy.
- `TAMPER DETECTED`: the file was changed or cut after it was written. Keep it as it is, and do not repair it.

The check only reads the file, and it writes nothing else. It does not need a network connection.

## What this page does not cover

- **The vault audit log.** `zn-gate vault verify` checks a different file, `audit.jsonl`, the log of secret use kept by the vault. It has its own chain, and it needs an unlocked vault to check. Its `--acknowledge` option is for your own terminal only. This page does not cover that file or that option; see [vault verify, forget and purge](vault-verify-and-forget.md).
- **Other copies of the file.** A copy of the zn folder for a new computer is covered in [setting up zn-gate on a new computer](moving-to-a-new-computer.md).
- **A rotation feature.** zn-gate has none, and this page does not describe one.

## See also

- [The decision log](evidence-example.md): what the output of `zn-gate evidence` shows.
- [Verify the log after a move](evidence-verify-after-restore.md): the check on a copy that came from another computer.
- [Troubleshooting, section 10](../troubleshooting.md#10-the-evidence-log--is-damaged): what to do when the log is damaged.
- [Files and folders](../files-and-folders.md): where the zn folder is and what each file in it is for.
- [Command line reference](../cli.md#evidence): all options of `evidence`.
