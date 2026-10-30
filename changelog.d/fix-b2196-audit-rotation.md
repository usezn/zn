### Changed
- The local audit log no longer grows without limit. When `~/.zn/audit.jsonl` reaches 128 MiB it is closed as a segment (`audit.1.jsonl`, `audit.2.jsonl`, ...) and a new file continues the same hash chain. `zn vault verify`, `zn vault log`, the OpenTelemetry export and the Team upload read every segment in order. zn keeps all segments; it never deletes one by itself.

### Fixed
- A crash right after a segment was closed no longer leaves the log in an unverifiable state: the chain check and the next record continue from the closed segment.
- `zn vault reset`, `zn vault purge` and uninstall now remove every audit log segment, not only `audit.jsonl`.
