### Security
- The MCP shield now checks more of what a server sends: `_meta` and `x-*` extension keys of tools, results and list items, prompt argument descriptions, `serverInfo`, and items of an unknown content type, with the same checks, limits and notices as other server text. The text of tool results that imitates a zn-gate notice is now marked as server text.
