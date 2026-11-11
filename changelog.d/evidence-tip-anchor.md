### Added
- The decision log now has a tip file, `evidence.tip`, next to `evidence.jsonl`. Each event updates it with the number of records and the fingerprint of the last one, under the lock the log already uses (Node and Python write the same file). `zn-gate evidence --verify` compares the log with it and exits `1` with `LOG TRUNCATED` when the log has fewer records than the tip expects, or `LOG REWRITTEN` when the record at the tip's place is a different one. A log without a tip passes with the note `Not anchored yet`, and the next event creates the tip. The tip finds a log that was cut short or replaced by accident or by a careless script; it does not stop someone who can also change the tip file.
- `zn-gate evidence --accept` accepts the log as it is now: it moves the tip to the end of the log and keeps the old tip as `previous`. It runs only in your own terminal.
- `verifyEvidenceLedger` and `verify_evidence_ledger` also return `truncated`, `rewritten`, `anchored` and `tip`.

### Changed
- `zn-gate evidence --verify` no longer says `IMMUTABLE`. It says what it checked: `HASH CHAIN VERIFIED, no truncation found against the last tip`.
- When the log has fewer records than its tip, writers keep recording and warn at most every 5 minutes.
