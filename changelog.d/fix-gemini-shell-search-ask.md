### Fixed
- Recursive shell searches (grep -r, rg, ag, ack, git grep, also inside bash -c, eval and variables) run by Gemini CLI and Copilot CLI are now checked like the Antigravity ones: when the folder holds a plain-text .env or another protected file, the search is stopped (Gemini CLI hooks cannot ask) or confirmed (Copilot CLI) before its output can reach the model.
