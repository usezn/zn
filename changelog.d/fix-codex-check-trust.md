### Fixed
- `zn-gate check` no longer reports Codex CLI as protected right after `zn hooks install codex`. Codex skips new or changed hooks until you approve them in `/hooks`, so zn-gate now says "NOT protected" with that next step until zn's hooks are approved and unchanged, or "waiting for your approval" when it cannot read the approval. `zn hooks install codex` and the docs say the same.
