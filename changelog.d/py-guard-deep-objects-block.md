### Security
- Python `check_tool_call` now blocks plain objects it cannot read in full (nested more than ten levels, unreadable, or past the value budget) with the same rules as the npm package, instead of allowing them. The `@guard` decorator keeps reading application objects such as clients best effort.
