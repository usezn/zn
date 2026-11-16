### Changed

- The next step for a plaintext secret in an MCP server configuration reads as three plain steps: run the commands in a terminal (on Windows, `npx.cmd` and `zn.cmd`), then edit the file and set the server's command to `zn`. On Windows it says that the file keeps `zn`, not `zn.cmd`, because the agent reads that file and nobody types it in a terminal. The Node.js and Python packages print the same text.
