### Changed
- Tests and docs now show that the Team policy applies to OpenCode: a blocked secret, a narrowed host, a warning, expiry and an invalid policy behave as for Codex and Cursor, and OpenCode blocks shell commands that carry a secret marker and never gets a value put back into a file. The docs explain that the `secrets` MCP server is added to `opencode.json` by hand.
