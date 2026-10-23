### Security
- `zn-gate shield` now checks the keys of the structured content a server returns, not only the values, so an instruction written as a key no longer reaches the agent. Large structured results keep every string that passes the check: past the per-message limit of 500 strings, the rest are checked in chunks instead of being replaced by a notice.
