### Fixed
- `zn audit` reads the triggers of a workflow from its `on:` block only, so `issues: write` under `permissions:` is no longer reported as an `issues` trigger of an AI agent workflow (ZNA019).
