### Fixed
- `zn audit` now reports chat-template tokens such as `<|im_start|>user`, `<|im_end|>` or `[INST]` shown inside backticks or a closed code block in the supporting notes of a skill (any file in a skill folder other than `SKILL.md`) as medium instead of high. `SKILL.md`, instruction files, tokens outside code and a system role token are unchanged. Audit rules version 2026-10-23.7.
