### Security
- `zn hooks uninstall claude-code` looks up the `claude` command it runs to remove zn's MCP server only in absolute `PATH` entries, as the install already did. Before, a relative or empty `PATH` entry could make it run a `claude` file from the folder it ran in.
