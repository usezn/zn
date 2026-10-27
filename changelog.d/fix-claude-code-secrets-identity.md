### Security
- Claude Code: the user-scope `secrets` server is no longer taken as zn's when its entry sets `NODE_OPTIONS` or `NODE_PATH`, or a folder inside the project to run in. The MCP server names of the zn-gate plugin are no longer trusted either: the plugin registers no MCP server since 1.14.0, and an older plugin started its servers with `node` from the `PATH`.
