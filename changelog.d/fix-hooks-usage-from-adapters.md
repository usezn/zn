### Fixed
- `zn hooks install` and `zn hooks uninstall` list every supported agent in their usage text, gemini included, and the top-level help does too. Agent names such as `__proto__` are refused as unknown agents, and control characters in an agent name are not echoed back.
