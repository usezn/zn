### Changed
- `zn-gate status` now warns when an installed hook was written by an older zn-gate, naming each agent and the command that refreshes it (`zn hooks install <agent>`, with `--project` for project hooks). It stays quiet when every hook is current, only reads files, and still exits `0`.
