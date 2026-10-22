### Fixed
- `zn audit` now reads the Copilot CLI hook files (`.github/hooks/*.json` and, with `--include-home`, `~/.copilot/hooks/*.json`) and the Antigravity hook files (`.agents/hooks.json` and `~/.gemini/config/hooks.json`). A hook there that downloads and runs code used to give "No findings in 0 agent files". `antigravity` is now a value of `--agents`.
