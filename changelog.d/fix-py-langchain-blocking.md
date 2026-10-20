### Security
- Python, LangChain: `ZnGuardCallbackHandler` now stops the run when it blocks something. Before, LangChain caught the `GuardBlockError` raised inside the callback and only logged a warning, so a blocked tool call still ran and a blocked prompt or tool output still reached the model. The handler now sets `raise_error = True`, which tells LangChain to let the error through.
- Python, LangChain: the handler could not hide secrets or replace an injected tool output, because LangChain ignores what a callback returns, so the secret still reached the model. With `mask_secrets=True` (default) a tool output that contains a secret now stops the run. The new `guard_langchain_tool(tool)` wraps a LangChain tool: it checks the arguments before the tool runs and the output before the model reads it, and hides secrets in that output.
- Python, LangChain: `ZnGuardCallbackHandler(on_block="return")` now raises `ValueError`. It let blocked calls through, like `"ignore"`. Use `guard_langchain_tool(tool, on_block="return")` to give the model a block message instead.

### Fixed
- Python, LlamaIndex: `ZnLlamaGuard(on_block="return")` let a blocked query through, like `"ignore"`. `check_query` and `on_query_start` now return a short block message, or the new `fallback`, in place of the query. `sanitize_response` now also hides secrets in a LlamaIndex `Response` object, not only in text.
