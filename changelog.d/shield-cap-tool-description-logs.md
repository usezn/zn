### Fixed
- `zn-gate shield` no longer writes one stderr line and one audit event for every blocked tool description in a `tools/list` response. The descriptions share the per-message log limit of blocked server text (first 50 logged one by one, the rest in one summary line and one event). Every description is still checked and replaced.
