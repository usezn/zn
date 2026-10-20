### Changed
- The messages zn shows when it blocks or asks about an agent action are written in plain words: what happened, why, and the exact command to run next. Jargon such as "shell keyword", "git-ignored" and "*** lines" is gone, the web-request tool is explained once, and the raw error code of a failed answer check shows only with `ZN_VERBOSE=1`.

### Fixed
- When a Gemini CLI hook receives no event, the message now names Gemini CLI and the command that sets it up again.
