### Fixed
- Tool output that is mostly invisible characters, such as a 32 MB result of zero-width spaces, is now blocked in a fraction of a second (rule `size:invisible`) instead of taking about 24 seconds to scan and then passing as clean.
- The MCP shield counts invisible characters over a whole tool result, including embedded resources and structured content, so splitting them across many small items no longer avoids the limit. A tool result whose message is larger than 32 MB is blocked as too large to check (rule `size:truncated`).
