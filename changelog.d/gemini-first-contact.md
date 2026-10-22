### Fixed
- `zn hooks install` and `zn hooks uninstall` say what to do when an agent's settings file holds comments (for example Gemini CLI's `settings.json`): remove the comments in that file and run the command again. A file with other syntax errors gets the same next step. The file is still left unchanged.
- `zn-gate init --wrap-mcp --dry-run` (and the real run) now also looks at Gemini CLI (`~/.gemini/settings.json`) and Copilot CLI (`~/.copilot/mcp-config.json`, or `$COPILOT_HOME`), so the dry run lists the same agents as the guided setup.
