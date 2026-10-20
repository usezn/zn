### Changed
- The Claude Code plugin now needs Node.js 20.19 or later, not 20.12: the dependencies it locks declare 20.19 as their minimum. On an older Node.js, `zn-gate init` sets up zn's hooks instead of the plugin, `zn-gate check` explains the cause, and the plugin launcher refuses to start. zn-gate itself and zn's hooks still run on Node.js 18 and later. The plugin checks in CI now also run on Node.js 20.19.0 exactly.

### Fixed
- The MCP Registry entry is now one file, `packages/zn-gate/server.json`, the one the release workflow publishes. A second, stale `server.json` that described another server under the same name was removed, and a check fails if one comes back.
