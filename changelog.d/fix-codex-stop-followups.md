### Fixed
- An internal error while zn checks a Codex final answer no longer makes Codex continue the answer. zn warns instead and exits with code 0, the same as for an unreadable event.
- zn reads the Codex session transcript in pieces when it checks a final answer, not all at once. Memory use stays flat for long sessions, and the check stops as soon as it has the answer. Transcripts larger than 64 MB are still skipped.
- `zn-gate stats` counts a check of a final answer as a stop review, not as a tool call.
