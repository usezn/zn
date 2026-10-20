### Fixed
- `zn audit` now reads instruction files that agents load through another file: `@path` imports in `CLAUDE.md` (nested ones too, up to five hops) and the `instructions` paths and globs of `opencode.json`. Before, a risky instruction moved into an imported file went unseen. Only files inside the audited directory are read.
