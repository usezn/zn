### Fixed
- Brace expansion in a shell command is checked the same way in every rule: a command with repeated alternatives is no longer refused as too large when its distinct expansions fit the limit, and a command that really exceeds the limit is still refused.
