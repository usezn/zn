### Changed
- Hook checks on Linux and macOS resolve each path once instead of twice, so each agent tool call waits a little less for zn-gate. Windows checks are unchanged.
