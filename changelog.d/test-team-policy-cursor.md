### Changed
- Tests and docs now show that the Team policy applies to Cursor: a blocked secret, a narrowed host, a warning, expiry and an invalid policy behave as for Codex, and Cursor blocks shell commands and MCP calls that carry a secret marker. The docs explain how the policy reaches each agent and that the `secrets` MCP server is added to Cursor by hand.
