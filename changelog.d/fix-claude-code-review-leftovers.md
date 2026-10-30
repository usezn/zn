### Fixed
- `zn-gate check` reads the plugin version from the pinned launcher file (what the plugin really runs) and says Claude Code's tool calls are "protected by the rules of zn-gate X".
- A Claude Code `secrets` server entry that sets `LD_PRELOAD`, `LD_LIBRARY_PATH` or a `DYLD_*` variable (also `LD_AUDIT` or `OPENSSL_CONF`) is no longer treated as zn's own server (as with `NODE_OPTIONS` and `NODE_PATH`).
