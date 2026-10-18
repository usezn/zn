### Added
- Codex: an optional setting, `hooks.stopTurnOnSecret` in `~/.zn/config.json` (off by default; `{"hooks": {"stopTurnOnSecret": true}}`). When a tool output holds a real secret value, zn still replaces it with tokens and also stops the turn, with a reason that names the kind of secret and never the value. Markers alone do not stop the turn. With the setting off, nothing changes.
