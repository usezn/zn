### Added
- The Python `guarded_tool` decorator for CrewAI now also works on async tools. The tool is awaited, and its output gets the same `check_result=True` scan and the same secret masking as a sync tool. Sync tools behave as before.
