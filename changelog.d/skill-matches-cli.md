### Fixed

- The agent skill (`skill/SKILL.md`) describes what `check_tool_call` and `check_tool_result` return as they do: the verdict, confidence, rule and reason are inside `assessment`, with `secrets_redacted` next to it. It also lists the `zn_status` fields and links to the Node.js requirements instead of repeating a version. A test now fails when the skill names a command, flag, tool or field that zn-gate no longer has.
