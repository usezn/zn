### Fixed

- A secret split by a control character (such as a NUL byte inside a key) in a tool output is now redacted like one split by a zero-width character, for every agent that rewrites tool output.
- An oversized GitHub Copilot output event named in camelCase (`postToolUse`) is now withheld instead of refused, like the other spellings of the event name.
- A hook event nested more than 64 levels deep is still blocked, and the reason now says it is nested too deeply instead of reporting invalid Unicode text.
- A tool output that is mostly C0 control characters (for example 100,000 NUL bytes) is now blocked by the Node.js package too, as the Python package already did: they count as invisible characters. Tab, line feed, carriage return and ESC are not counted.
