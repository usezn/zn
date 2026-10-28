### Fixed
- When a check runs out of time or fails, every agent now gets the same next step: try again, and if it keeps happening, run `zn-gate check`. Codex and ZCode said `zn-gate doctor`, and some agents were told to reinstall the hooks.
- ZCode: a post-tool event whose check ran out of time now gets the notice that the output was withheld (exit 0) instead of a block (exit 2), since the tool had already run.
