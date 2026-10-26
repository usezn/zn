### Security
- The `PATH` that zn-gate gives the programs it starts (the MCP server behind `zn-gate shield`, `git` in the hooks) also leaves out a folder outside the project that holds a program linked into the project (for example a `node` that links to the project's `node_modules/.bin`), so a child process that runs `node` by name cannot reach it.
