### Fixed
- The zn-secrets agent skill now describes refused `secrets_*` tool calls as they arrive (JSON with an `error` code such as `ZN_POLICY_DENIED`, `ZN_NOT_FOUND` or `ZN_LOCKED`, and a `message`), separately from hook denials.
