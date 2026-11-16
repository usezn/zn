### Fixed
- Claude Code: zn now also scrubs the output of background-shell output reads (`BashOutput`, `TaskOutput`), subagent results (`Task`, `Agent`), `WebSearch` and `Glob`, in the installed hooks and in the plugin. Before, those tools were outside the `PostToolUse` matcher, so a secret value in their output reached the model. The tool-response shape of these tools has not been confirmed against a live Claude Code yet.
- When a checked tool's output cannot be read (for example because an agent renamed the output field), zn now adds a visible note instead of passing the output on with no sign that it was not checked.
- `docs/threat-model.md` now states that agents can read their own session histories, which zn does not block.
