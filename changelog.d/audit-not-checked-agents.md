### Fixed
- `zn audit --agents <name>` no longer says "No findings in 0 agent files" when it found nothing to read for that agent. It now prints `<agent>: not checked` with the places it looked, so a missed location is not mistaken for a clean result. The JSON report lists each agent with `checked` and its file count under `summary.agentStatus`. Exit codes are unchanged.
