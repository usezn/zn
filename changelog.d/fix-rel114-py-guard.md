### Changed
- Python `@guard` now reads the arguments of a guarded function as strictly as `check_tool_call` does, plain application objects included. An object that is nested deeper than ten levels, cannot be read or holds too many values now blocks the call (rules `size:nesting`, `type:unscannable` and `size:items`); before, `@guard` skipped what it could not read. Framework run contexts (pydantic-ai, Google ADK, OpenAI Agents SDK, LangChain) and logging objects are still not checked, so pass those as before.

### Security
- Python `@guard` no longer lets text through that sits more than ten levels deep inside a plain object passed to a guarded function.
