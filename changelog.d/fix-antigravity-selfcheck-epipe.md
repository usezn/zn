### Fixed
- `zn hooks install antigravity --project --self-check` and `zn-gate check` no longer report that a hook could not be started when the hook answered (for example with a block) and exited before reading all of its input; they read its answer.
