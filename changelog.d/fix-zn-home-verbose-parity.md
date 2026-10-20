### Fixed
- `ZN_HOME` now moves the evidence log too (npm and Python), so the evidence log, the stats and the vault always live in the same folder.
- One rule for `ZN_VERBOSE` in both packages: it is on only for `1`, `true`, `yes` or `on` (any case). `ZN_VERBOSE=0` used to turn debug messages on in some places; it now turns them off, like leaving it unset.
