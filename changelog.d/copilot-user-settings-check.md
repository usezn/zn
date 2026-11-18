### Fixed
- `zn-gate check` now reports `disableAllHooks` in your own Copilot settings file (`~/.copilot/settings.json`, or `$COPILOT_HOME/settings.json`) as not protected instead of a note, and notes other inline `preToolUse` hooks in that file that run next to zn. The Copilot docs now describe the `userPromptTransformed` event, which can rewrite the text the model receives; zn does not use it.
