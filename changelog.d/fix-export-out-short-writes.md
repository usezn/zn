### Fixed
- `zn vault log export --otlp --out FILE` now writes the whole export even when the disk takes it in pieces, and checks the temporary copy against what was generated before it moves it into place. A short or damaged copy is removed and the command fails instead of leaving a partial export.
