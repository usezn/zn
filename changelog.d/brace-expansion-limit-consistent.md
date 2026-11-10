### Fixed
- Brace expansion in a shell command is checked the same way in every rule: repeated alternatives are dropped from the expanded words, and every alternative, repeated ones included, still counts toward the size limit, so a command over the limit is still refused.
