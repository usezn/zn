### Security
- On Windows, a PSMODULEPATH (or any other spelling) inherited from the parent no longer reaches the PowerShell that zn starts for the process list, the clipboard, the keychain, the confirmation dialog and the browser opening: every spelling is removed and zn's own system module folder is set once.

### Changed
- The notes about `"features.mcp"` in ZCode's settings now say that what ZCode does with it was not tested.
