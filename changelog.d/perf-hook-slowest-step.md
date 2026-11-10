### Changed
- Hooks start a little faster: a hook call that does not use the secret vault no longer loads the vault client just to close it. The vault files are still checked on every call, so an edited or missing vault file blocks the hook as before ("zn-gate changed since the hooks were installed"). Decisions, messages and redaction are unchanged.
