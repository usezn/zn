### Fixed
- The gateway reports its real version from `zn --version` and the MCP server, instead of a hard-coded 1.0.0.
- The SIEM exporter sends events in batches of 10 by default when a SIEM endpoint is set without a `siem` section; a batch size of 0 falls back to the default.
- `zn --config` now fails with an error naming the file when the path does not exist or the file does not parse, instead of silently starting with defaults.
