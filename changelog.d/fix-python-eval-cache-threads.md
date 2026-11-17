### Fixed
- The Python package no longer raises `KeyError` or `RuntimeError` when several threads (or `asyncio.to_thread` workers) call `evaluate`, `check_tool_result`, `sanitize_tool_result` or a guarded function at the same time, and a process forked after use no longer starts with a stale evaluation counter or a locked cache.
