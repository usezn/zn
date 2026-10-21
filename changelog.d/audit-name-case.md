### Fixed
- `zn audit` now finds agent files whose names differ only in letter case, such as `claude.md` or `.Claude/Settings.json`. Windows and macOS agents load those names, so a repository could ship them unseen. Workflow files still have to sit in `.github/workflows`, as GitHub requires.
