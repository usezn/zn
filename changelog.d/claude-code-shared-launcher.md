### Security
- If you use two Claude Code profiles (two `CLAUDE_CONFIG_DIR` folders) with zn-gate, uninstalling the hooks in one profile no longer leaves the other unprotected. The hook script they share is now kept, and the same fix applies to Codex, Cursor, Gemini CLI and Antigravity. Only `zn-gate uninstall` removes it, and `zn-gate check` reports a hook whose script is missing.
