### Changed
- The Python `guarded_tool` decorator now scans a tool's output for prompt injection by default (`check_result=True`), matching `guard_langchain_tool`. A blocked output raises `GuardBlockError`, or with `on_block="return"` returns the fallback or a short notice. To keep the previous behavior for a tool, pass `check_result=False`; secrets in the output are still hidden as before.
