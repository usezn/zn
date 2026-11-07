### Changed
- Hooks start a little faster: a hook call that does not use the secret vault no longer loads the vault client just to close it, which saves about 2 to 4 ms per call. Decisions, messages and redaction are unchanged.
