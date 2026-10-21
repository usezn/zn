### Fixed
- Antigravity on Windows: the hook command that `zn hooks install antigravity` writes no longer relies on quotes. Antigravity splits the command on spaces, so a Node.js path such as `C:\Program Files\nodejs\node.exe` broke it and every tool call was blocked. Run `zn hooks install antigravity` again to replace an existing hook.
