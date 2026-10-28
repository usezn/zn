### Fixed
- `zn-gate init --wrap-mcp`: when an agent's config cannot be changed, it now says why in plain words (no permission, the disk is full...) about that config, never the name of a temporary file, says it was left as it was, and gives the next step. The command now exits with code 1 when any config could not be changed; it used to exit 0.
