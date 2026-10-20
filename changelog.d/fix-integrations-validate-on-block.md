### Fixed
- An unknown `on_block` value in the Python package now raises a `ValueError` that lists the accepted values, instead of being treated as "ignore" and silently letting blocked calls through. This covers `guard`, `guarded_tool` (CrewAI), `ZnGuardCallbackHandler` (LangChain) and `ZnLlamaGuard` (LlamaIndex); a typo such as `"rasie"` is caught when the guard is created.
