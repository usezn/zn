### Fixed
- When a check runs out of time or fails, every agent now gets the same next step: try again, and if it keeps happening, run `zn-gate check`. Codex and ZCode said `zn-gate doctor`, and some agents were told to reinstall the hooks.
- ZCode: a post-tool event whose check timed out now gets a notice that the check timed out and the output was NOT withheld (exit 0) instead of a block (exit 2), since the tool had already run.
- ZCode: a post-tool event too large to check (over 32 MiB) now gets a notice that ZCode cannot withhold that output (exit 0),
  not one that says it was withheld.
