### Security
- The Python `ZnGuardCallbackHandler` now stops a LangChain or LangGraph run when it blocks something. It sets `raise_error = True`; before, langchain-core only logged the `GuardBlockError` and the blocked prompt or tool call went ahead.

### Changed
- `@guard(on_block="custom")` now calls your `callback`, returns what it returns, and never runs the blocked function (before, it ran the function after the callback). `callback` is required in this mode. If you relied on the old behaviour, call the function yourself inside the callback or use `on_block="raise"`.
- `ZnGuardCallbackHandler` and `ZnLlamaGuard` no longer accept `on_block="return"`: it cannot work in a callback, so it let blocked input through. It now raises `ValueError`. Use `"raise"` to stop, `"ignore"` to only log, or wrap a tool with `guarded_tool(on_block="return")` to replace a blocked result.
- `on_block="ignore"` in those integrations now logs a warning on the `zn_gate` logger when it lets something through.

### Deprecated
- `ZnGuardCallbackHandler(mask_secrets=...)` is deprecated and has no effect: LangChain ignores what a callback returns, so a handler cannot redact a tool result (it never did). To redact, wrap the tool with `guarded_tool` or call `sanitize_tool_result`. `ZnGuardCallbackHandler.on_tool_end` now returns `None`.
