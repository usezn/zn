### Fixed
- Node.js: `checkToolCall` and the tool-result guard now return `rules_version` on every result, allowed or blocked, as the Python package already did.
- Node.js: `evaluate` now returns confidence 1.0 for empty or whitespace-only input, matching Python (it returned 0.99).
