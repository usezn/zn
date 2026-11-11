### Fixed
- `zn-gate check` no longer writes its live test records to `~/.zn/evidence.jsonl` when `ZN_HOME` moves zn's folder. Those records now go to the evidence log in `ZN_HOME`, like every other evidence write. With `ZN_HOME` unset nothing changes.
