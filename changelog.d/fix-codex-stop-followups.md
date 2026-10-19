### Fixed
- An internal error while zn checks a Codex final answer no longer makes Codex continue the answer. zn warns instead and exits with code 0, the same as for an unreadable event.
- zn reads the Codex session transcript in 256 KB chunks when it checks a final answer, and the scan stops as soon as it has the answer. The heap stays small (about 7 MB on a 64 MB transcript), but process memory still grows with the file size. Transcripts larger than 64 MB are still skipped.
- `zn-gate stats` counts a check of a final answer as a stop review, not as a tool call.
